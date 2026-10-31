import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OC_HOME } from './store';

/**
 * Niveau d'effort d'une unité, de la source la plus fiable à la plus faible.
 *
 * Le seul relevé exact est le `--effort` d'un process `claude` vivant : OpenClaw le
 * calcule à chaque lancement et ne l'écrit nulle part (ni base, ni transcript). Dès que
 * le process disparaît, la valeur disparaît avec lui. Pour ne pas laisser un tiret
 * partout où rien ne tourne, des replis, toujours étiquetés pour ne jamais passer
 * pour un relevé direct :
 *
 *  - `live`     — lu sur la ligne de commande du process vivant ;
 *  - `adaptive` — process vivant sans `--effort` : OpenClaw retire le drapeau quand la
 *                 réflexion est « adaptive », le CLI choisit lui-même ;
 *  - `default`  — `claude` d'un job sans drapeau : réglage par défaut du CLI ;
 *  - `last`     — dernière valeur vue en direct pour cette session ;
 *  - `agentLast`— dernière valeur vue en direct sur un autre run du même agent ;
 *  - `config`   — `params.thinking` du modèle dans `openclaw.json`, propre à l'agent
 *                 d'abord, puis commun à tous.
 */
export type EffortSource = 'live' | 'adaptive' | 'default' | 'last' | 'agentLast' | 'config';

export type Effort = { value: string; source: EffortSource; at: number | null };

type Seen = { v: string; at: number };

const KEEP_MS = 30 * 24 * 3600 * 1000;
const MAX_ENTRIES = 600;
const FLUSH_MS = 10_000;

function stateFile(): string {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'openclaw-monitor', 'effort.json');
}

let seen: Map<string, Seen> | null = null;
let dirty = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function load(): Map<string, Seen> {
  if (seen) return seen;
  seen = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as Record<string, Seen>;
    const now = Date.now();
    for (const [k, s] of Object.entries(raw)) {
      if (s && typeof s.v === 'string' && typeof s.at === 'number' && now - s.at < KEEP_MS) seen.set(k, s);
    }
  } catch {
    /* premier démarrage, ou fichier illisible : on repart de zéro, ce n'est qu'un repli */
  }
  return seen;
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (!dirty || !seen) return;
    dirty = false;
    try {
      const file = stateFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const entries = [...seen].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_ENTRIES);
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(entries)), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {
      /* disque en lecture seule : le repli reste en mémoire */
    }
  }, FLUSH_MS);
  flushTimer.unref?.();
}

/** Enregistre une valeur vue en direct ; n'écrit sur disque que si elle a changé. */
export function rememberEffort(key: string, value: string, now: number): void {
  const m = load();
  const prev = m.get(key);
  m.set(key, { v: value, at: now });
  if (!prev || prev.v !== value || now - prev.at > 60_000) {
    dirty = true;
    scheduleFlush();
  }
}

export function recallEffort(key: string, source: 'last' | 'agentLast' = 'last'): Effort | null {
  const s = load().get(key);
  return s ? { value: s.v, source, at: s.at } : null;
}

// ---------------------------------------------------------------- configuration

let cfgCache: { mtime: number; cfg: any } | null = null;

function readConfig(): any {
  const file = path.join(OC_HOME, 'openclaw.json');
  try {
    const mtime = fs.statSync(file).mtimeMs;
    if (cfgCache && cfgCache.mtime === mtime) return cfgCache.cfg;
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    cfgCache = { mtime, cfg };
    return cfg;
  } catch {
    return cfgCache?.cfg ?? {};
  }
}

/** `params.thinking` du modèle de l'agent : réglage propre à l'agent, sinon réglage commun. */
export function configuredEffort(agentId: string, model: string | null): Effort | null {
  if (!model) return null;
  const agents = readConfig()?.agents ?? {};
  const bare = model.includes('/') ? model : `anthropic/${model}`;
  for (const scope of [agents.entries?.[agentId], agents.defaults]) {
    const models = scope?.models;
    const hit = models?.[bare] ?? models?.[model];
    const v = hit?.params?.thinking;
    if (typeof v === 'string' && v) return { value: v, source: 'config', at: null };
  }
  return null;
}
