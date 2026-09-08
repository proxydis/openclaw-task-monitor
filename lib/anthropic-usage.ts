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

/**
 * Requête d'usage telle que l'émet le CLI Claude : `skip_spend` évite au serveur le
 * calcul de dépense, qui n'alimente aucune des jauges affichées ici.
 */
const USAGE_PATH = 'usage?at_wall=1&skip_spend=1';

/**
 * L'endpoint d'usage est fortement limité en débit côté Anthropic : mesuré sur un compte
 * Max 20x, il n'accorde qu'environ une requête toutes les cinq minutes, et un 429 consomme
 * lui aussi du quota. Interroger toutes les minutes — la valeur d'origine — suffisait à
 * rester bloqué en permanence.
 *
 * Dix minutes laissent de la marge sous le seuil observé, y compris pour le CLI Claude qui
 * puise dans le même quota, sans nuire à l'affichage : la limite de session porte sur 5 h
 * et les limites hebdomadaires sur 7 jours.
 */
const USAGE_TTL = envMs('MONITOR_PLAN_TTL_MS', 10 * 60_000);
const PROFILE_TTL = 15 * 60_000;
const TIMEOUT_MS = 8_000;

/** Paliers d'attente après un 429 : 5, 10, 20, 40 min, puis plafond à 1 h. */
const THROTTLE_BASE = 5 * 60_000;
const THROTTLE_MAX = 60 * 60_000;

function envMs(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

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

type Fetched =
  | { ok: true; body: any }
  | { ok: false; status: number; retryAfterMs: number; error: Msg };

/** `Retry-After` en millisecondes (secondes ou date HTTP), 0 si absent ou nul. */
function retryAfterMs(h: string | null): number {
  if (!h) return 0;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const ts = Date.parse(h);
  return Number.isFinite(ts) ? Math.max(0, ts - Date.now()) : 0;
}

/**
 * GET authentifié sur l'API OAuth. Ne lève jamais : toute panne est convertie en `Msg`.
 * Le corps de la réponse n'est jamais remonté dans un message d'erreur (il peut contenir
 * des identifiants) — seuls le code HTTP ou le libellé de l'exception le sont.
 *
 * **Arbitrage assumé sur le `User-Agent`.** On se présente comme le CLI Claude sur un
 * endpoint OAuth non documenté. Ce qui le justifie : le jeton est celui de l'utilisateur,
 * les données lues sont les siennes, la lecture est strictement passive, et l'endpoint
 * n'est pas exposé autrement. Ce qu'il faut savoir en contrepartie : cette surface peut
 * changer sans préavis, et la panne sera silencieuse — la carte se dégradera sans que rien
 * d'autre ne casse. Si un jour l'API refuse ce `User-Agent` ou si Anthropic publie un
 * endpoint officiel, c'est ici qu'il faut basculer, pas ailleurs.
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
    if (!r.ok) {
      const err: Msg =
        r.status === 401 || r.status === 403
          ? { k: 'plan.err.expired' }
          : { k: 'plan.err.http', p: { code: r.status } };
      return {
        ok: false,
        status: r.status,
        retryAfterMs: retryAfterMs(r.headers.get('retry-after')),
        error: err,
      };
    }
    return { ok: true, body: await r.json() };
  } catch (e: any) {
    return {
      ok: false,
      status: 0,
      retryAfterMs: 0,
      error: { k: 'plan.err.network', p: { err: String(e?.message ?? e).slice(0, 120) } },
    };
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
  const label: Msg = model ?? (KNOWN_KINDS.has(kind) ? { k: `plan.limit.${kind}` } : kind.replaceAll('_', ' '));
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

/** Fenêtre d'abstention après un 429, et rang du palier atteint. */
let throttledUntil = 0;
let throttleStep = 0;

/** Plancher entre deux rafraîchissements forcés (bouton ↻ / `GET /api/plan`). */
const FORCE_MIN_INTERVAL = envMs('MONITOR_PLAN_FORCE_MIN_MS', 30_000);
let lastForcedAt = 0;

async function fetchUsage(): Promise<void> {
  const token = readToken();
  if (!token) {
    usage = { fetchedAt: usage.fetchedAt, limits: [], error: { k: 'plan.err.noSession' } };
    usageAt = Date.now();
    return;
  }
  const r = await oauthGet(USAGE_PATH, token);
  if (r.ok) {
    throttledUntil = 0;
    throttleStep = 0;
    usage = { fetchedAt: Date.now(), limits: toLimits(r.body), error: null };
  } else if (r.status === 429) {
    // Un 429 consomme du quota : on se tait pendant tout le palier plutôt que d'insister,
    // sinon le compteur ne redescend jamais. Les dernières limites connues restent affichées.
    throttleStep = Math.min(throttleStep + 1, 4);
    const backoff = Math.min(THROTTLE_BASE * 2 ** (throttleStep - 1), THROTTLE_MAX);
    throttledUntil = Date.now() + Math.max(backoff, r.retryAfterMs);
    usage = { ...usage, error: { k: 'plan.err.throttled', ts: throttledUntil } };
  } else {
    // on garde les dernières limites connues : une coupure réseau ne vide pas la carte
    usage = { ...usage, error: r.error };
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
  usageInflight ??= fetchUsage().finally(() => {
    usageInflight = null;
  });
  return usageInflight;
}

function refreshProfile(): Promise<void> {
  profileInflight ??= fetchProfile().finally(() => {
    profileInflight = null;
  });
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
  if (now >= throttledUntil && now - usageAt >= USAGE_TTL) void refreshUsage().catch(() => {});
  if (now - profileAt >= PROFILE_TTL) void refreshProfile().catch(() => {});
  return snapshot();
}

/**
 * Rafraîchissement forcé, pour le bouton ↻ de la carte (route `/api/plan`).
 * Le bouton ne perce pas la fenêtre d'abstention : pendant un throttle, il rend le
 * dernier relevé et l'heure de la prochaine tentative, sans appel réseau.
 */
export async function refreshPlanUsage(): Promise<PlanUsage | null> {
  if (!PLAN_USAGE_ENABLED) return null;
  const now = Date.now();
  if (now < throttledUntil) return snapshot();
  // `/api/plan` n'est pas authentifiée et le service peut écouter au-delà de la loopback :
  // sans plancher, une boucle sur la route viderait le quota d'usage du compte, alors même
  // que le backoff sur 429 n'existe qu'*après* le premier 429 que ce module cherche à éviter.
  if (now - lastForcedAt < FORCE_MIN_INTERVAL) return snapshot();
  lastForcedAt = now;
  usageAt = 0;
  profileAt = 0;
  await Promise.all([refreshUsage().catch(() => {}), refreshProfile().catch(() => {})]);
  return snapshot();
}
