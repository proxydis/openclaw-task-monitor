import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { claudeProjectsDir } from './claude-cli';
import type { TokenUsage } from './types';

/**
 * Jetons consommés par session, relevés sur disque — zéro appel réseau, zéro appel
 * modèle, zéro jeton dépensé par la mesure. On ne fait que remonter une information que
 * le CLI Claude écrit déjà lui-même.
 *
 * Deux sources, jamais additionnées :
 *
 *  1. **`<claudeCliDir>/projects/<slug>/<cliSessionId>.jsonl`** — la bonne. Le CLI y
 *     écrit une ligne par appel API *pendant* le tour, ce qui rend la colonne vivante.
 *     Les sous-agents de l'outil Task ont leur propre fichier sous
 *     `<slug>/<cliSessionId>/subagents/agent-*.jsonl` : ils comptent dans la session.
 *  2. **`transcript_events`** dans la base par agent — le repli, nettement moins fidèle
 *     (cf. `readDbTokens`). Réservé aux sessions dont le `.jsonl` a disparu.
 *
 * Trois pièges, tous mesurés sur des fichiers réels avant d'écrire une ligne de code :
 *
 *  - **Doublons.** Une même réponse assistant réapparaît telle quelle sur plusieurs
 *    lignes : 21 lignes porteuses d'`usage` pour 12 appels API sur un fichier témoin,
 *    soit +75 % sans déduplication. La clé est `message.id` (`requestId` donne le même
 *    compte). Les copies portent des valeurs d'`usage` identiques, ce n'est pas un cumul.
 *  - **Volume.** ~1 400 fichiers, 1 Go au total, jusqu'à 27 Mo pièce, et le collecteur
 *    tourne toutes les 1,5 s. D'où la lecture strictement incrémentale et le budget par
 *    cycle plus bas.
 *  - **Écriture concurrente.** Une lecture pendant le tour tombe au milieu d'une ligne.
 *    Le résidu est conservé d'un cycle à l'autre et `offset` n'avance jamais au-delà de
 *    ce qui a été lu ; une ligne illisible est ignorée sans faire échouer le cycle.
 */

// ------------------------------------------------------------------ réglages

/**
 * Octets lus par cycle de collecte, toutes sessions confondues.
 *
 * Au démarrage il faut rattraper ~180 Mo (136 fichiers effectivement rattachés à une
 * session OpenClaw) : tout lire d'un coup ferait exploser `collectMs` et la mémoire du
 * service, qui tourne avec `--max-old-space-size=320`. Avec 8 Mo par cycle et un cycle
 * toutes les 1,5 s, le rattrapage prend une demi-minute, pendant laquelle les totaux
 * sont marqués `approx` et l'interface les préfixe d'un `~`. En régime établi seuls les
 * octets ajoutés depuis le cycle précédent sont lus, soit quelques kilo-octets.
 */
const BYTES_PER_CYCLE = 8 * 1024 * 1024;

/**
 * Taille de la fenêtre de déduplication, en identifiants, par fichier.
 *
 * Mesuré : les copies d'un même `message.id` sont adjacentes — écart maximal observé
 * **2 lignes porteuses d'`usage`** sur un transcript de 424 lignes / 296 appels. 128
 * laisse deux ordres de grandeur de marge tout en bornant la mémoire à ~15 Ko par
 * fichier, là où mémoriser tous les identifiants d'une session croîtrait sans limite.
 */
const MAX_IDS = 128;

/** Fichiers suivis simultanément. Au-delà, les entrées les moins récemment lues sautent. */
const MAX_FILES = 400;

/** Ligne sans `\n` au-delà de cette taille : abandonnée, le cycle continue. */
const MAX_RESIDUE = 4 * 1024 * 1024;

/** Durée de validité de l'index `cliSessionId → fichier`. */
const INDEX_TTL = 10_000;

/** Durée de validité d'un total issu du repli SQLite (session terminée : valeur figée). */
const DB_TTL = 5 * 60_000;

/** Rejet bon marché : 99 % des lignes d'un transcript ne portent aucun bloc `usage`. */
const NEEDLE = Buffer.from('"usage"');
const NEWLINE = 0x0a;
const EMPTY = Buffer.alloc(0);

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

function add(a: TokenUsage, b: TokenUsage): TokenUsage {
  const approx = a.approx || b.approx;
  const out: TokenUsage = { in: a.in + b.in, out: a.out + b.out, cache: a.cache + b.cache };
  if (approx) out.approx = true;
  return out;
}

/** Somme de plusieurs relevés, `null` si aucun n'existe (l'interface doit afficher un tiret). */
export function sumTokens(parts: Iterable<TokenUsage | null>): TokenUsage | null {
  let acc: TokenUsage | null = null;
  for (const p of parts) {
    if (!p) continue;
    acc = acc ? add(acc, p) : { ...p };
  }
  return acc;
}

// ------------------------------------------------------------------ index des fichiers

/**
 * `cliSessionId → chemin du .jsonl`, plus l'ensemble des sessions qui ont un
 * sous-répertoire (candidates à `<id>/subagents/`).
 *
 * Le slug de répertoire est le `cwd` du run avec les `/` remplacés par des `-`, mais
 * cette règle n'est pas fiable (doubles tirets, chemins avec points) et n'a pas besoin
 * de l'être : l'uuid de session est unique sur tout l'arbre, un simple balayage des
 * noms de fichiers suffit. 36 `readdir`, 2,5 ms mesurés, rafraîchis toutes les 10 s.
 */
type Index = { files: Map<string, string>; withDir: Set<string> };

let indexCache: { at: number; idx: Index } | null = null;

function sessionIndex(): Index {
  const now = Date.now();
  if (indexCache && now - indexCache.at < INDEX_TTL) return indexCache.idx;
  const idx: Index = { files: new Map(), withDir: new Set() };
  const root = claudeProjectsDir();
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    indexCache = { at: now, idx };
    return idx;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) idx.withDir.add(e.name);
      else if (e.name.endsWith('.jsonl')) idx.files.set(e.name.slice(0, -6), path.join(dir, e.name));
    }
  }
  indexCache = { at: now, idx };
  return idx;
}

/** Transcripts des sous-agents de l'outil Task, listés seulement si le répertoire existe. */
const subCache = new Map<string, { at: number; mtimeMs: number; files: string[] }>();

function subagentFiles(sessionFile: string, cliSessionId: string, idx: Index): string[] {
  if (!idx.withDir.has(cliSessionId)) return [];
  const dir = path.join(path.dirname(sessionFile), cliSessionId, 'subagents');
  const now = Date.now();
  const hit = subCache.get(dir);
  let mtimeMs = -1;
  try {
    mtimeMs = fs.statSync(dir).mtimeMs;
  } catch {
    /* pas de sous-agent pour cette session */
  }
  if (hit && hit.mtimeMs === mtimeMs && now - hit.at < INDEX_TTL) return hit.files;
  let files: string[] = [];
  if (mtimeMs >= 0) {
    try {
      files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => path.join(dir, f));
    } catch {
      files = [];
    }
  }
  subCache.set(dir, { at: now, mtimeMs, files });
  if (subCache.size > MAX_FILES) subCache.clear();
  return files;
}

// ------------------------------------------------------------------ lecture incrémentale

type FileAcc = {
  /** taille au dernier `stat` : une taille en baisse signe une rotation */
  size: number;
  mtimeMs: number;
  /** octets déjà consommés ; n'avance que sur des lignes complètes ou du résidu conservé */
  offset: number;
  residue: Buffer;
  total: { in: number; out: number; cache: number };
  seen: Set<string>;
  order: string[];
  /** dernier accès, pour l'éviction LRU */
  at: number;
};

const accs = new Map<string, FileAcc>();

function freshAcc(): FileAcc {
  return {
    size: 0,
    mtimeMs: 0,
    offset: 0,
    residue: EMPTY,
    total: { in: 0, out: 0, cache: 0 },
    seen: new Set(),
    order: [],
    at: Date.now(),
  };
}

function resetAcc(acc: FileAcc): void {
  acc.offset = 0;
  acc.residue = EMPTY;
  acc.total = { in: 0, out: 0, cache: 0 };
  acc.seen.clear();
  acc.order.length = 0;
}

/** Éviction LRU : borne le nombre de fenêtres de déduplication gardées en mémoire. */
function evict(): void {
  if (accs.size <= MAX_FILES) return;
  const victims = [...accs.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, accs.size - MAX_FILES);
  for (const [k] of victims) accs.delete(k);
}

function consume(acc: FileAcc, line: Buffer): void {
  if (line.length < 32 || line.indexOf(NEEDLE) < 0) return;
  let o: any;
  try {
    o = JSON.parse(line.toString('utf8'));
  } catch {
    // ligne tronquée par une écriture concurrente, ou JSON invalide : ignorée
    return;
  }
  if (o?.type !== 'assistant') return;
  const u = o.message?.usage;
  if (!u) return;
  // `isSidechain` n'est pas filtré : un sous-agent consomme pour de vrai, il compte
  const id = str(o.message?.id) ?? str(o.requestId);
  if (id) {
    if (acc.seen.has(id)) return;
    acc.seen.add(id);
    acc.order.push(id);
    if (acc.order.length > MAX_IDS * 2) {
      for (const old of acc.order.splice(0, MAX_IDS)) acc.seen.delete(old);
    }
  }
  acc.total.in += num(u.input_tokens) + num(u.cache_creation_input_tokens);
  acc.total.out += num(u.output_tokens);
  acc.total.cache += num(u.cache_read_input_tokens);
}

let budget = 0;

/** Ouvre un cycle de collecte : remet à zéro le budget de lecture. Appelé par `collect()`. */
export function beginTokenCycle(): void {
  budget = BYTES_PER_CYCLE;
}

/** Totaux d'un fichier, rattrapés dans la limite du budget restant. `null` si illisible. */
function scanFile(file: string): TokenUsage | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    accs.delete(file);
    return null;
  }
  let acc = accs.get(file);
  if (!acc) {
    acc = freshAcc();
    accs.set(file, acc);
    evict();
  }
  acc.at = Date.now();

  // rotation ou réécriture : les totaux accumulés ne valent plus rien
  if (st.size < acc.size) resetAcc(acc);
  acc.size = st.size;
  acc.mtimeMs = st.mtimeMs;
  // court-circuit : taille inchangée depuis la dernière lecture complète, rien à ouvrir
  if (acc.offset >= st.size) return snapshotOf(acc);
  // budget du cycle épuisé : le rattrapage reprend au cycle suivant, valeur marquée `approx`
  if (budget <= 0) return snapshotOf(acc);

  const len = Math.min(st.size - acc.offset, budget);
  budget -= len;
  let read = 0;
  let buf: Buffer;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      buf = Buffer.allocUnsafe(len);
      while (read < len) {
        const n = fs.readSync(fd, buf, read, len - read, acc.offset + read);
        if (n <= 0) break;
        read += n;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return snapshotOf(acc);
  }

  const fresh = buf.subarray(0, read);
  const chunk = acc.residue.length ? Buffer.concat([acc.residue, fresh]) : fresh;
  let start = 0;
  for (;;) {
    const nl = chunk.indexOf(NEWLINE, start);
    if (nl < 0) break;
    consume(acc, chunk.subarray(start, nl));
    start = nl + 1;
  }
  const rest = chunk.subarray(start);
  // copie : garder une vue sur `chunk` retiendrait les 8 Mo du cycle
  acc.residue = rest.length > MAX_RESIDUE ? EMPTY : Buffer.from(rest);
  acc.offset += read;
  return snapshotOf(acc);
}

function snapshotOf(acc: FileAcc): TokenUsage {
  const u: TokenUsage = { ...acc.total };
  if (acc.offset < acc.size) u.approx = true; // rattrapage en cours
  return u;
}

/**
 * Jetons d'une session du CLI Claude : son transcript plus ceux des sous-agents qu'elle
 * a lancés. `null` si aucun fichier ne porte cet identifiant (session purgée, ou trop
 * fraîche pour l'index — le cycle suivant la verra).
 */
export function readSessionTokens(cliSessionId: string): TokenUsage | null {
  const idx = sessionIndex();
  const file = idx.files.get(cliSessionId);
  if (!file) return null;
  const own = scanFile(file);
  if (!own) return null;
  const subs = subagentFiles(file, cliSessionId, idx);
  if (!subs.length) return own;
  return sumTokens([own, ...subs.map(scanFile)]) ?? own;
}

// ------------------------------------------------------------------ repli SQLite

/**
 * Totaux lus dans `transcript_events` de la base par agent, pour les sessions dont le
 * `.jsonl` du CLI a disparu.
 *
 * **C'est un repli, pas une seconde source de vérité, et il sous-estime.** OpenClaw
 * n'archive qu'un message assistant par *tour*, là où le `.jsonl` porte un appel API par
 * aller-retour d'outil : sur une session où les deux existent, le `.jsonl` donne 31
 * appels et 19 529 jetons de sortie quand la base n'en voit que 2 et 3. Les valeurs
 * rendues ici sont donc systématiquement marquées `approx` et l'interface les préfixe
 * d'un `~`. Les noms de champs diffèrent aussi (`input`/`output`/`cacheRead`/`cacheWrite`),
 * et `totalTokens` ignore le cache : il n'est pas utilisé.
 *
 * La base est ouverte en lecture seule, comme partout ailleurs dans `store`.
 */
const dbCache = new Map<string, { at: number; usage: TokenUsage | null }>();

export function readDbTokens(dbFile: string, sessionId: string): TokenUsage | null {
  const key = `${dbFile}#${sessionId}`;
  const now = Date.now();
  const hit = dbCache.get(key);
  // session sans `.jsonl` : terminée, donc figée — un TTL suffit, inutile de sonder max(seq)
  if (hit && now - hit.at < DB_TTL) return hit.usage;

  let usage: TokenUsage | null = null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
    const rows = db
      .prepare('select event_json from transcript_events where session_id = ?')
      .all(sessionId) as unknown as { event_json: string }[];
    if (rows.length) {
      const tot = { in: 0, out: 0, cache: 0 };
      let found = false;
      for (const r of rows) {
        let o: any;
        try {
          o = JSON.parse(r.event_json);
        } catch {
          continue;
        }
        const u = o?.message?.usage;
        if (!u) continue;
        found = true;
        tot.in += num(u.input) + num(u.cacheWrite);
        tot.out += num(u.output);
        tot.cache += num(u.cacheRead);
      }
      if (found) usage = { ...tot, approx: true };
    }
  } catch {
    usage = null;
  } finally {
    try {
      db?.close();
    } catch {
      /* noop */
    }
  }
  dbCache.set(key, { at: now, usage });
  if (dbCache.size > MAX_FILES) dbCache.clear();
  return usage;
}
