import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Msg, PlanLimit, PlanUsage } from './types';

/**
 * Limites d'utilisation du forfait Anthropic, lues via l'endpoint OAuth du CLI Claude
 * avec le jeton de la session locale.
 *
 * Deux règles structurent ce module :
 *
 *  - **Le fichier de credentials est en lecture seule.** Le CLI Claude renouvelle le
 *    jeton lui-même et réécrit `.credentials.json` ; une écriture concurrente de notre
 *    part corromprait sa session. On relit simplement le fichier à chaque rafraîchissement.
 *  - **Le réseau n'est jamais dans le chemin critique de `collect()`.** L'accesseur
 *    `getPlanUsage()` est synchrone : il rend immédiatement la dernière valeur connue et
 *    déclenche en arrière-plan un rafraîchissement si le cache a dépassé son TTL.
 *
 * Le jeton n'est jamais loggué, sérialisé, ni renvoyé.
 */

/** MONITOR_PLAN_USAGE=0 : aucun appel réseau, la carte n'est pas rendue. */
export const PLAN_USAGE_ENABLED = process.env.MONITOR_PLAN_USAGE !== '0';

const API = 'https://api.anthropic.com/api/oauth';
const USAGE_TTL = 60_000;
const PROFILE_TTL = 15 * 60_000;
const TIMEOUT_MS = 8_000;

// ------------------------------------------------------------------ jeton local

/** Répertoire de configuration du CLI Claude (`CLAUDE_CONFIG_DIR`, sinon `~/.claude`). */
function credentialsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(dir, '.credentials.json');
}

/** Jeton OAuth du CLI local, ou `null` si aucune session exploitable n'est présente. */
function readToken(): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(credentialsPath(), 'utf8'));
    const tok = raw?.claudeAiOauth?.accessToken;
    return typeof tok === 'string' && tok.length > 0 ? tok : null;
  } catch {
    // fichier absent, illisible ou JSON invalide : traité comme « pas de session »
    return null;
  }
}

// ------------------------------------------------------------------ appels HTTP

type Fetched = { ok: true; body: any } | { ok: false; error: Msg };

/**
 * GET authentifié sur l'API OAuth. Ne lève jamais : toute panne est convertie en `Msg`.
 * Le corps de la réponse n'est jamais remonté dans un message d'erreur (il peut contenir
 * des identifiants) — seuls le code HTTP ou le libellé de l'exception le sont.
 */
async function oauthGet(endpoint: string, token: string): Promise<Fetched> {
  try {
    const r = await fetch(`${API}/${endpoint}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
        'User-Agent': 'claude-cli/2.0.0 (external, cli)',
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (r.status === 401 || r.status === 403) return { ok: false, error: { k: 'plan.err.expired' } };
    if (!r.ok) return { ok: false, error: { k: 'plan.err.http', p: { code: r.status } } };
    return { ok: true, body: await r.json() };
  } catch (e: any) {
    return { ok: false, error: { k: 'plan.err.network', p: { err: String(e?.message ?? e).slice(0, 120) } } };
  }
}

// ------------------------------------------------------------------ mapping

/** Libellés dont la carte dispose d'une traduction ; les autres restent bruts. */
const KNOWN_KINDS = new Set(['session', 'weekly_all', 'weekly_scoped']);

function parseDate(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const ts = Date.parse(v);
  return Number.isFinite(ts) ? ts : null;
}

function toGroup(v: unknown): PlanLimit['group'] {
  return v === 'session' || v === 'weekly' ? v : 'other';
}

function toLimit(raw: any, i: number): PlanLimit | null {
  const kind = typeof raw?.kind === 'string' ? raw.kind : null;
  if (!kind) return null;
  const percent = Number(raw?.percent);
  if (!Number.isFinite(percent)) return null;
  const model = typeof raw?.scope?.model?.display_name === 'string' ? raw.scope.model.display_name : null;
  const surface = typeof raw?.scope?.surface === 'string' ? raw.scope.surface : null;
  const label: Msg = model ?? (KNOWN_KINDS.has(kind) ? { k: `plan.limit.${kind}` } : kind.replace(/_/g, ' '));
  return {
    id: `${kind}:${model ?? surface ?? i}`,
    kind,
    group: toGroup(raw?.group),
    label,
    percent: Math.max(0, Math.min(100, Math.round(percent))),
    severity: typeof raw?.severity === 'string' ? raw.severity : 'normal',
    resetsAt: parseDate(raw?.resets_at),
    isActive: raw?.is_active === true,
  };
}

/**
 * `limits[]` est la source générique : une limite supplémentaire côté serveur apparaît
 * dans la carte sans modification. `five_hour` / `seven_day` ne servent que de repli
 * pour les réponses qui n'exposeraient pas encore le tableau.
 */
function toLimits(body: any): PlanLimit[] {
  const rows = Array.isArray(body?.limits) ? body.limits : [];
  const limits = rows.map(toLimit).filter((l: PlanLimit | null): l is PlanLimit => l !== null);
  if (limits.length) return limits;

  const legacy: PlanLimit[] = [];
  for (const [key, kind, group] of [
    ['five_hour', 'session', 'session'],
    ['seven_day', 'weekly_all', 'weekly'],
  ] as const) {
    const w = body?.[key];
    const pct = Number(w?.utilization);
    if (!w || !Number.isFinite(pct)) continue;
    legacy.push({
      id: kind,
      kind,
      group,
      label: { k: `plan.limit.${kind}` },
      percent: Math.max(0, Math.min(100, Math.round(pct))),
      severity: 'normal',
      resetsAt: parseDate(w?.resets_at),
      isActive: kind === 'session',
    });
  }
  return legacy;
}

/** Libellé de forfait. `MONITOR_REDACT` ou non, rien d'autre du profil n'est retenu. */
const TIER_LABEL: Record<string, string> = {
  default_claude_max_20x: 'Max (20x)',
  default_claude_max_5x: 'Max (5x)',
  default_claude_pro: 'Pro',
  default_claude_team: 'Team',
};

function toPlanLabel(body: any): string | null {
  const tier = body?.organization?.rate_limit_tier;
  if (typeof tier === 'string' && TIER_LABEL[tier]) return TIER_LABEL[tier];
  // tier inconnu ou absent : repli sur les drapeaux du compte
  if (body?.account?.has_claude_max === true) return 'Max';
  if (body?.account?.has_claude_pro === true) return 'Pro';
  return null;
}

// ------------------------------------------------------------------ cache module

type UsageState = { fetchedAt: number | null; limits: PlanLimit[]; error: Msg | null };

let usage: UsageState = { fetchedAt: null, limits: [], error: null };
let usageAt = 0;
let usageInflight: Promise<void> | null = null;

let planLabel: string | null = null;
let profileAt = 0;
let profileInflight: Promise<void> | null = null;

async function fetchUsage(): Promise<void> {
  const token = readToken();
  if (!token) {
    usage = { fetchedAt: usage.fetchedAt, limits: [], error: { k: 'plan.err.noSession' } };
    usageAt = Date.now();
    return;
  }
  const r = await oauthGet('usage', token);
  if (!r.ok) {
    // on garde les dernières limites connues : une coupure réseau ne vide pas la carte
    usage = { ...usage, error: r.error };
  } else {
    usage = { fetchedAt: Date.now(), limits: toLimits(r.body), error: null };
  }
  usageAt = Date.now();
}

async function fetchProfile(): Promise<void> {
  const token = readToken();
  if (token) {
    const r = await oauthGet('profile', token);
    // un profil indisponible n'est pas un état dégradé : la carte s'affiche sans forfait
    if (r.ok) planLabel = toPlanLabel(r.body);
  }
  profileAt = Date.now();
}

/** Rafraîchit le relevé d'usage — jamais deux appels en vol simultanément. */
function refreshUsage(): Promise<void> {
  if (!usageInflight) {
    usageInflight = fetchUsage().finally(() => {
      usageInflight = null;
    });
  }
  return usageInflight;
}

function refreshProfile(): Promise<void> {
  if (!profileInflight) {
    profileInflight = fetchProfile().finally(() => {
      profileInflight = null;
    });
  }
  return profileInflight;
}

function snapshot(): PlanUsage {
  return { fetchedAt: usage.fetchedAt, planLabel, limits: usage.limits, error: usage.error };
}

/**
 * Accesseur synchrone appelé par `collect()` : rend immédiatement la dernière valeur
 * connue et déclenche en arrière-plan (fire-and-forget) un rafraîchissement si le cache
 * est périmé. Aucun `await`, donc aucun impact sur la durée du scan.
 */
export function getPlanUsage(): PlanUsage | null {
  if (!PLAN_USAGE_ENABLED) return null;
  const now = Date.now();
  if (now - usageAt >= USAGE_TTL) void refreshUsage().catch(() => {});
  if (now - profileAt >= PROFILE_TTL) void refreshProfile().catch(() => {});
  return snapshot();
}

/** Rafraîchissement forcé, pour le bouton ↻ de la carte (route `/api/plan`). */
export async function refreshPlanUsage(): Promise<PlanUsage | null> {
  if (!PLAN_USAGE_ENABLED) return null;
  usageAt = 0;
  profileAt = 0;
  await Promise.all([refreshUsage().catch(() => {}), refreshProfile().catch(() => {})]);
  return snapshot();
}
