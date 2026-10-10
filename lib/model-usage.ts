import fs from 'node:fs';
import path from 'node:path';
import { PLAN_USAGE_ENABLED } from './anthropic-usage';
import { claudeProjectsDir } from './claude-cli';
import type { ModelShare, ModelUsage, ModelUsageWindow, PlanUsage } from './types';

/**
 * Répartition de la consommation par modèle, pour l'onglet « Par modèle » de la carte du
 * forfait. Même principe que `token-usage` : on relit ce que le CLI Claude écrit déjà
 * (`message.model` + `message.usage` de chaque appel API), sans appel réseau.
 *
 * Différence de périmètre avec `token-usage`, qui ne suit que les sessions rattachées à
 * un agent OpenClaw : ici, **tous** les transcripts de l'hôte comptent, puisque tous
 * consomment le même forfait — CLI lancé à la main et sous-agents compris.
 *
 * Volume mesuré le 2026-10-10 : 1 534 transcripts modifiés sur 7 jours, ~1 Go, 34 082
 * appels uniques. Aucun `message.id` n'apparaît dans deux fichiers différents (vérifié
 * sur les 34 082) : la déduplication reste locale au fichier, et la plus grande distance
 * observée entre deux copies d'un même appel est d'une ligne porteuse d'`usage`.
 *
 * Le rattrapage du démarrage est borné par cycle (`BYTES_PER_CYCLE`) et lit les fichiers
 * les plus récents d'abord : la fenêtre de 5 h est juste en quelques cycles, la semaine
 * en ~1 min 30. Pendant ce temps `readPct` < 100 et l'interface le signale.
 */

// ------------------------------------------------------------------ réglages

const HOUR = 3_600_000;
const SESSION_MS = 5 * HOUR;
const WEEK_MS = 7 * 24 * HOUR;
/** Historique conservé : la semaine du forfait, plus une marge pour une échéance en retard. */
const HORIZON = WEEK_MS + 2 * HOUR;
/** Granularité des cumuls : 5 min, soit 2 040 cases au plus sur l'horizon. */
const BUCKET = 5 * 60_000;
/** Octets lus par cycle de collecte (un cycle toutes les 1,5 s). */
const BYTES_PER_CYCLE = 16 * 1024 * 1024;
/** Re-découverte de l'arbre des transcripts (nouveaux fichiers, sous-agents). */
const DISCOVER_TTL = 30_000;
/**
 * Fichiers hors horizon (~3 400 sur 4 945 mesurés) : re-`stat`és toutes les 10 min
 * seulement. La découverte complète coûtait 45 ms toutes les 30 s ; un vieux transcript
 * repris par `--resume` est ainsi vu avec 10 min de retard au plus.
 */
const COLD_TTL = 10 * 60_000;
/** Fichiers re-`stat`és à chaque cycle : ceux modifiés depuis moins d'une heure. */
const HOT_MS = HOUR;
/** Fenêtre de déduplication par fichier : écart maximal observé 1, large marge. */
const MAX_IDS = 32;
const MAX_RESIDUE = 4 * 1024 * 1024;

const NEEDLE = Buffer.from('"usage"');
const NEWLINE = 0x0a;
const EMPTY = Buffer.alloc(0);

// ------------------------------------------------------------------ tarifs

/**
 * Tarif public de l'API en USD par million de jetons (relevé le 2026-10-10). Il ne sert
 * qu'à **pondérer** le camembert : le forfait ne facture rien au jeton, mais ses limites
 * pèsent un appel Opus plus lourd qu'un appel Haiku, et un jeton relu en cache bien moins
 * qu'un jeton d'entrée. En jetons bruts, le cache-read écrase tout le reste (4,7 Md sur
 * 4,9 Md la semaine mesurée) et le graphique ne dit plus rien de la consommation.
 *
 * Écriture en cache : ×1,25 du tarif d'entrée en TTL 5 min, ×2 en TTL 1 h — le CLI écrit
 * en TTL 1 h, d'où la ventilation lue dans `usage.cache_creation`.
 */
type Price = { in: number; out: number; cacheRead: number };

const PRICES: Record<string, Price> = {
  'claude-fable-5-1': { in: 10, out: 50, cacheRead: 0.25 },
  'claude-fable-5': { in: 10, out: 50, cacheRead: 1 },
  'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.2 },
  'claude-opus-5': { in: 5, out: 25, cacheRead: 0.5 },
  'claude-opus-4-8': { in: 5, out: 25, cacheRead: 0.5 },
  'claude-opus-4-7': { in: 5, out: 25, cacheRead: 0.5 },
  'claude-opus-4-6': { in: 5, out: 25, cacheRead: 0.5 },
  'claude-sonnet-5': { in: 2, out: 10, cacheRead: 0.2 },
  'claude-sonnet-4-6': { in: 3, out: 15, cacheRead: 0.3 },
  'claude-haiku-4-5': { in: 1, out: 5, cacheRead: 0.1 },
};

/**
 * Tarif d'un modèle : exact, sinon celui du plus long identifiant connu dont il est une
 * déclinaison (`claude-sonnet-5-5` → `claude-sonnet-5`), signalé par `ref`. `null` si
 * aucun ne correspond : le modèle reste dans la vue « jetons » mais sort du coût.
 */
function priceOf(model: string): { price: Price; ref?: string } | null {
  const exact = PRICES[model];
  if (exact) return { price: exact };
  let best: string | null = null;
  for (const k of Object.keys(PRICES)) {
    if (model.startsWith(`${k}-`) && (!best || k.length > best.length)) best = k;
  }
  return best ? { price: PRICES[best], ref: best } : null;
}

/** `claude-haiku-4-5-20251001` → `claude-haiku-4-5` : un même modèle, une seule part. */
function normModel(id: string): string {
  return id.replace(/-\d{8}$/, '');
}

// ------------------------------------------------------------------ cumuls

/** Compteurs d'une case : appels, entrée, sortie, écriture cache 5 min, 1 h, lecture cache. */
const N = 6;
const buckets = new Map<number, Map<string, Float64Array>>();

function addCall(ts: number, model: string, u: any): void {
  const key = Math.floor(ts / BUCKET);
  let b = buckets.get(key);
  if (!b) buckets.set(key, (b = new Map()));
  let v = b.get(model);
  if (!v) b.set(model, (v = new Float64Array(N)));
  const cw = num(u.cache_creation_input_tokens);
  // ventilation par TTL quand elle existe ; sans elle, tout est compté au tarif 5 min
  const cw1h = Math.min(cw, num(u.cache_creation?.ephemeral_1h_input_tokens));
  v[0] += 1;
  v[1] += num(u.input_tokens);
  v[2] += num(u.output_tokens);
  v[3] += cw - cw1h;
  v[4] += cw1h;
  v[5] += num(u.cache_read_input_tokens);
}

function pruneBuckets(now: number): void {
  const min = Math.floor((now - HORIZON) / BUCKET);
  for (const k of buckets.keys()) if (k < min) buckets.delete(k);
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// ------------------------------------------------------------------ lecture incrémentale

type FileState = {
  size: number;
  mtimeMs: number;
  offset: number;
  residue: Buffer;
  /** derniers `message.id` vus, dans l'ordre */
  ids: string[];
};

const files = new Map<string, FileState>();
/** fichier hors horizon → dernier `stat` */
const cold = new Map<string, number>();
let discoveredAt = 0;

/** Tous les `.jsonl` sous `projects/`, sous-agents compris (`<slug>/<uuid>/subagents/`). */
function walk(dir: string, depth: number, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < 3) walk(p, depth + 1, out);
    } else if (e.name.endsWith('.jsonl')) out.push(p);
  }
}

function discover(now: number): void {
  discoveredAt = now;
  const found: string[] = [];
  walk(claudeProjectsDir(), 0, found);
  const live = new Set<string>();
  for (const f of found) {
    const seenCold = cold.get(f);
    if (seenCold !== undefined && now - seenCold < COLD_TTL) continue;
    let st: fs.Stats;
    try {
      st = fs.statSync(f);
    } catch {
      continue;
    }
    // modifié avant l'horizon : aucune de ses lignes ne tombe dans une fenêtre
    if (st.mtimeMs < now - HORIZON) {
      cold.set(f, now);
      continue;
    }
    cold.delete(f);
    live.add(f);
    observe(f, st);
  }
  const present = new Set(found);
  for (const f of files.keys()) if (!live.has(f)) files.delete(f);
  for (const f of cold.keys()) if (!present.has(f)) cold.delete(f);
  pruneBuckets(now);
}

/** Enregistre la taille courante d'un fichier ; le met en file s'il a grossi. */
function observe(file: string, st: fs.Stats): void {
  let s = files.get(file);
  if (!s) {
    s = { size: 0, mtimeMs: 0, offset: 0, residue: EMPTY, ids: [] };
    files.set(file, s);
  }
  if (st.size < s.size) {
    // réécriture : ses appels sont déjà dans les cumuls, les relire les compterait deux
    // fois. On saute à la fin — perte bornée à ce fichier, jamais de double comptage.
    s.offset = st.size;
    s.residue = EMPTY;
  }
  s.size = st.size;
  s.mtimeMs = st.mtimeMs;
}

function consume(s: FileState, line: Buffer, minTs: number): void {
  if (line.length < 32 || line.indexOf(NEEDLE) < 0) return;
  let o: any;
  try {
    o = JSON.parse(line.toString('utf8'));
  } catch {
    return;
  }
  if (o?.type !== 'assistant') return;
  const u = o.message?.usage;
  const model = o.message?.model;
  // `<synthetic>` : message fabriqué par le CLI (interruption, erreur), aucun appel API
  if (!u || typeof model !== 'string' || !model || model.startsWith('<')) return;
  const id = o.message?.id ?? o.requestId;
  if (typeof id === 'string' && id) {
    if (s.ids.includes(id)) return;
    s.ids.push(id);
    if (s.ids.length > MAX_IDS) s.ids.shift();
  }
  const ts = Date.parse(typeof o.timestamp === 'string' ? o.timestamp : '');
  if (!Number.isFinite(ts) || ts < minTs) return;
  addCall(ts, normModel(model), u);
}

/** Lit au plus `max` octets neufs d'un fichier ; rend le nombre d'octets consommés. */
function readFile(file: string, s: FileState, max: number, minTs: number): number {
  const len = Math.min(s.size - s.offset, max);
  if (len <= 0) return 0;
  let read = 0;
  const buf = Buffer.allocUnsafe(len);
  try {
    const fd = fs.openSync(file, 'r');
    try {
      while (read < len) {
        const n = fs.readSync(fd, buf, read, len - read, s.offset + read);
        if (n <= 0) break;
        read += n;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return 0;
  }
  const fresh = buf.subarray(0, read);
  const chunk = s.residue.length ? Buffer.concat([s.residue, fresh]) : fresh;
  let start = 0;
  for (;;) {
    const nl = chunk.indexOf(NEWLINE, start);
    if (nl < 0) break;
    consume(s, chunk.subarray(start, nl), minTs);
    start = nl + 1;
  }
  const rest = chunk.subarray(start);
  // copie : garder une vue sur `chunk` retiendrait tout le tampon du cycle
  s.residue = rest.length > MAX_RESIDUE ? EMPTY : Buffer.from(rest);
  s.offset += read;
  return read;
}

/**
 * Un cycle de lecture, appelé par `collect()`. Synchrone et borné : au plus
 * `BYTES_PER_CYCLE` octets lus, une re-découverte de l'arbre toutes les 30 s, et entre
 * deux un `stat` des seuls fichiers récemment modifiés.
 */
export function scanModelUsage(): void {
  if (!PLAN_USAGE_ENABLED) return;
  const now = Date.now();
  if (now - discoveredAt >= DISCOVER_TTL) {
    discover(now);
  } else {
    for (const [f, s] of files) {
      if (now - s.mtimeMs > HOT_MS) continue;
      try {
        observe(f, fs.statSync(f));
      } catch {
        files.delete(f);
      }
    }
  }
  // fichiers en retard de lecture, les plus récents d'abord
  const queue = [...files.entries()]
    .filter(([, s]) => s.offset < s.size)
    .sort((a, b) => b[1].mtimeMs - a[1].mtimeMs)
    .map(([f]) => f);
  let budget = BYTES_PER_CYCLE;
  const minTs = now - HORIZON;
  for (const f of queue) {
    if (budget <= 0) break;
    const s = files.get(f);
    if (s) budget -= readFile(f, s, budget, minTs);
  }
}

// ------------------------------------------------------------------ fenêtres

/**
 * Début de fenêtre : calé sur l'échéance que rapporte Anthropic pour la limite
 * correspondante (`resetsAt − durée`), pour que le camembert couvre exactement ce que la
 * jauge de l'onglet voisin mesure. Glissant si l'échéance est inconnue ou déjà passée.
 */
function windowStart(plan: PlanUsage | null, kind: string, span: number, now: number) {
  const r = plan?.limits.find((l) => l.kind === kind)?.resetsAt ?? null;
  if (r && r > now && r - span <= now) return { since: r - span, aligned: true };
  return { since: now - span, aligned: false };
}

function sumSince(since: number): ModelShare[] {
  const acc = new Map<string, Float64Array>();
  const min = Math.floor(since / BUCKET);
  for (const [k, b] of buckets) {
    // case à cheval sur le début de fenêtre : comptée entière (5 min d'imprécision au plus)
    if (k < min) continue;
    for (const [model, v] of b) {
      let a = acc.get(model);
      if (!a) acc.set(model, (a = new Float64Array(N)));
      for (let i = 0; i < N; i++) a[i] += v[i];
    }
  }
  const out: ModelShare[] = [];
  for (const [model, a] of acc) {
    const p = priceOf(model);
    const cost = p
      ? (a[1] * p.price.in + a[2] * p.price.out + a[3] * p.price.in * 1.25 + a[4] * p.price.in * 2 + a[5] * p.price.cacheRead) / 1e6
      : null;
    const share: ModelShare = {
      model,
      calls: a[0],
      in: a[1],
      out: a[2],
      cacheWrite: a[3] + a[4],
      cacheRead: a[5],
      cost,
    };
    if (p?.ref) share.priceRef = p.ref;
    out.push(share);
  }
  return out.sort((x, y) => (y.cost ?? -1) - (x.cost ?? -1) || y.calls - x.calls);
}

export function getModelUsage(plan: PlanUsage | null): ModelUsage | null {
  if (!PLAN_USAGE_ENABLED) return null;
  const now = Date.now();
  let total = 0;
  let done = 0;
  for (const s of files.values()) {
    total += s.size;
    done += s.offset;
  }
  const windows: ModelUsageWindow[] = [
    { id: 'session', ...windowStart(plan, 'session', SESSION_MS, now), models: [] },
    { id: 'weekly', ...windowStart(plan, 'weekly_all', WEEK_MS, now), models: [] },
  ];
  for (const w of windows) w.models = sumSince(w.since);
  return {
    windows,
    // rien de découvert encore : 0, pas 100 — l'interface affiche « lecture en cours »
    readPct: discoveredAt === 0 ? 0 : total ? Math.min(100, Math.floor((done / total) * 100)) : 100,
  };
}
