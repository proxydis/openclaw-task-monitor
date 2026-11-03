import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Msg, UnitState } from './types';

/**
 * CI locale du mini PC : les runners GitHub Actions auto-hébergés (`gh-runner-*.service`) et
 * l'étape CI qui suit la phase FIN d'un lot `run-lot.sh`.
 *
 * Trois sources, toutes locales : le journal de chaîne du lot (lignes `CI : …` écrites par
 * `ci_fin`), les fichiers d'état tenus par les hooks du runner (`etat-job.sh` :
 * `<runner>.json`, `historique.jsonl`), et le cgroup de chaque unité de runner (process,
 * mémoire). Aucun appel réseau : les liens GitHub sont fabriqués à partir des identifiants
 * déjà écrits dans ces fichiers, le navigateur de l'utilisateur fait le reste.
 *
 * Les fonctions d'analyse (`parseCiChain`, `parseCiJob`, `ciPrView`, `ciLaneView`,
 * `ciJobSub`) sont pures : `scripts/verif-ci-local.ts` les exerce hors du serveur. Ce module
 * n'importe donc que des modules `node:` et des types, pour rester exécutable tel quel par
 * Node (suppression de types native).
 */

// ------------------------------------------------------------------ journal de chaîne

/** Ce que le journal dit d'une PR du lot pendant l'étape CI. */
export type CiPrLog = {
  n: number;
  /** nom du répertoire du dépôt dans le journal (`app-back`) */
  dir: string;
  status: 'expected' | 'reopenFail' | 'conflict' | 'verdict';
  /** conclusion GitHub du run (`success`, `failure`, `skipped`…) */
  verdict: string | null;
  runId: number | null;
  /** jobs rouges listés par `ci_fin` ; `null` sur un vert */
  red: string | null;
  skipped: boolean;
  /** branche de release, connue quand la PR est en conflit */
  rel: string | null;
  /** horodatage de la relance unique d'un rouge « sans rapport avec le code » */
  rerunTs: number | null;
  ts: number | null;
  endTs: number | null;
};

export type CiStep = {
  /** première ligne de l'étape (réouverture des PR) */
  startTs: number | null;
  prs: CiPrLog[];
  /** `aucune PR ouverte vers <REL>` : étape vide, branche de release citée */
  noPr: string | null;
  /** `pas de verdict en 3 h pour toutes les PR` */
  timeout: boolean;
  /** ligne `##### <PREFIX> terminé : …, CI rc=<n>` */
  end: { ts: number | null; rc: number | null } | null;
};

const tsOf = (s: string): number | null => {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
};

/**
 * Étape CI d'un lot, lue dans le journal de chaîne (déjà tronqué au dernier lancement par
 * `readLot`). L'étape commence après la dernière ligne `##### phase FIN terminée` quand il y
 * en a une (sinon au début du texte : journal d'essai du lanceur), et seules comptent les
 * lignes `CI :` sans voie ou en `[voie FIN]` : celles de `ci_pause` pendant les phases portent
 * `[voie A|B|FIN]` et précèdent la fin de FIN. `null` tant que l'étape n'a pas commencé.
 */
export function parseCiChain(text: string, prefix?: string): CiStep | null {
  let body = text;
  const finIdx = text.lastIndexOf('##### phase FIN terminée');
  if (finIdx >= 0) body = text.slice(text.indexOf('\n', finIdx) + 1 || text.length);
  const step: CiStep = { startTs: null, prs: [], noPr: null, timeout: false, end: null };
  let started = false;
  const pr = (n: number, dir: string): CiPrLog => {
    let x = step.prs.find((p) => p.n === n && (p.dir === dir || !dir || !p.dir));
    if (!x) {
      x = { n, dir, status: 'expected', verdict: null, runId: null, red: null, skipped: false, rel: null, rerunTs: null, ts: null, endTs: null };
      step.prs.push(x);
    } else if (!x.dir && dir) x.dir = dir;
    return x;
  };
  for (const line of body.split('\n')) {
    const end = line.match(/^(\S+) ##### (\S+) terminé : .*?CI rc=(\d+)/);
    if (end && (!prefix || end[2] === prefix)) {
      if (started) step.end = { ts: tsOf(end[1]), rc: Number(end[3]) };
      continue;
    }
    const m = line.match(/^(\S+) (?:\[voie FIN\] )?CI : (.*)$/);
    if (!m) continue;
    const ts = tsOf(m[1]);
    const msg = m[2];
    let r: RegExpMatchArray | null;
    if ((r = msg.match(/^PR (\d+) \(([^)]*)\) rouverte\b/))) {
      started = true;
      const x = pr(Number(r[1]), r[2]);
      x.status = 'expected';
      x.ts ??= ts;
    } else if ((r = msg.match(/^réouverture de la PR (\d+) impossible \(([^)]*)\)/))) {
      started = true;
      const x = pr(Number(r[1]), path.basename(r[2]));
      x.status = 'reopenFail';
      x.ts ??= ts;
      x.endTs = ts;
    } else if ((r = msg.match(/^aucune PR ouverte vers (\S+) pour ce lot/))) {
      started = true;
      step.noPr = r[1];
    } else if (!started) {
      continue;
    } else if ((r = msg.match(/^PR (\d+) \(([^)]*)\) en conflit avec (\S+?),/))) {
      const x = pr(Number(r[1]), r[2]);
      x.status = 'conflict';
      x.rel = r[3];
      x.endTs = ts;
    } else if ((r = msg.match(/^PR (\d+), rouge sans rapport avec le code \(run (\d+)/))) {
      const x = pr(Number(r[1]), '');
      x.rerunTs = ts;
      x.runId = Number(r[2]);
    } else if ((r = msg.match(/^PR (\d+) \(([^)]*)\) : (\S+), run (\d+)(?:, jobs rouges : (.*))?$/))) {
      const x = pr(Number(r[1]), r[2]);
      x.status = 'verdict';
      x.verdict = r[3];
      x.runId = Number(r[4]);
      x.skipped = r[3] === 'skipped' || /jobs sautés/.test(r[5] ?? '');
      x.red = x.skipped ? null : r[5]?.trim() || null;
      x.endTs = ts;
    } else if (/^pas de verdict en 3 h/.test(msg)) {
      step.timeout = true;
    } else {
      continue;
    }
    step.startTs ??= ts;
  }
  return started ? step : null;
}

// ------------------------------------------------------------------ fichiers d'état du runner

/** Un job de CI tel que décrit par `etat-job.sh`, dates converties en ms epoch. */
export type CiJob = {
  runner: string;
  repo: string;
  workflow: string;
  job: string;
  event: string;
  ref: string;
  pr: number | null;
  headRef: string;
  baseRef: string;
  sha: string;
  runId: number | null;
  runAttempt: number;
  runUrl: string | null;
  jobUrl: string | null;
  prUrl: string | null;
  state: 'attente' | 'en_cours' | 'termine' | 'refuse' | 'inconnu';
  wait: 'ci_locale' | 'creneau' | 'memoire' | null;
  slot: number | null;
  note: string | null;
  queuedAt: number | null;
  startedAt: number | null;
  endedAt: number | null;
  updatedAt: number | null;
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);
const sec = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : n * 1000;
};
/** seuls les liens GitHub en `https` sont gardés : la valeur finit dans un `href` */
const ghUrl = (v: unknown): string | null => (typeof v === 'string' && /^https:\/\/github\.com\/[^\s"<>]+$/.test(v) ? v : null);

/** Fiche JSON d'un job (fichier d'état ou ligne d'historique) ; `null` si illisible. Ne lève jamais. */
export function parseCiJob(raw: unknown): CiJob | null {
  let o: any = raw;
  if (typeof raw === 'string') {
    try {
      o = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!o || typeof o !== 'object' || !str(o.runner)) return null;
  const state = ['attente', 'en_cours', 'termine', 'refuse'].includes(o.state) ? o.state : 'inconnu';
  const wait = ['ci_locale', 'creneau', 'memoire'].includes(o.wait) ? o.wait : null;
  return {
    runner: str(o.runner),
    repo: str(o.repo),
    workflow: str(o.workflow),
    job: str(o.job) || '?',
    event: str(o.event),
    ref: str(o.ref),
    pr: num(o.pr),
    headRef: str(o.head_ref),
    baseRef: str(o.base_ref),
    sha: str(o.sha),
    runId: num(o.run_id),
    runAttempt: num(o.run_attempt) ?? 1,
    runUrl: ghUrl(o.run_url),
    jobUrl: ghUrl(o.job_url),
    prUrl: ghUrl(o.pr_url),
    state,
    wait,
    slot: num(o.slot),
    note: str(o.note) || null,
    queuedAt: sec(o.queued_at),
    startedAt: sec(o.started_at),
    endedAt: sec(o.ended_at),
    updatedAt: sec(o.updated_at),
  };
}

/** Job en attente ou en cours d'après sa fiche (sans juger s'il tourne vraiment). */
export const ciJobOpen = (j: CiJob): boolean => j.state === 'attente' || j.state === 'en_cours';

/**
 * Ce que fait un job, en une ligne. `workerAlive` : un `Runner.Worker` vit dans le cgroup du
 * runner. Une fiche « en attente » ou « en cours » sans lui décrit un job interrompu (runner
 * redémarré, job annulé avant le hook de fin) : il n'est pas montré comme vivant.
 */
export function ciJobSub(j: CiJob, workerAlive: boolean): { live: boolean; interrupted: boolean; sub: Msg } {
  const p = { job: j.job, runner: j.runner };
  if (ciJobOpen(j) && !workerAlive) return { live: false, interrupted: true, sub: { k: 'graph.ci.job.interrupted', p } };
  if (j.state === 'en_cours') {
    return {
      live: true,
      interrupted: false,
      sub: j.slot !== null ? { k: 'graph.ci.job.run', p: { ...p, slot: j.slot } } : { k: 'graph.ci.job.runNoSlot', p },
    };
  }
  if (j.state === 'attente') {
    const k = j.wait === 'memoire' ? 'graph.ci.job.waitMem' : j.wait === 'ci_locale' ? 'graph.ci.job.waitCi' : 'graph.ci.job.waitSlot';
    return { live: true, interrupted: false, sub: { k, p } };
  }
  if (j.state === 'refuse') return { live: false, interrupted: false, sub: { k: 'graph.ci.job.refused', p: { note: j.note ?? '—' } } };
  if (j.state === 'termine') return { live: false, interrupted: false, sub: { k: 'graph.ci.job.ended', p } };
  return { live: false, interrupted: false, sub: { k: 'graph.ci.job.unknown', p } };
}

// ------------------------------------------------------------------ fusion journal + fiches

/** Ce qu'un nœud de PR a besoin de savoir d'un runner. */
export type CiRunnerLite = { name: string; repo: string | null; state: CiJob | null; history: CiJob[]; workerAlive: boolean };

export type CiFact = { k: string; v: string; fmt?: 'mb' | 'dur' | 'clock' };

export type CiPrView = {
  repo: string;
  /** partie courte du dépôt : `back` pour `app-back` */
  short: string;
  n: number;
  state: UnitState;
  sub: Msg;
  /** runner dont le job en attente ou en cours appartient à cette PR : ses process vont dans le nœud */
  attached: string | null;
  job: CiJob | null;
  startedAt: number | null;
  endedAt: number | null;
  facts: CiFact[];
  note: Msg | null;
  noteIsError: boolean;
};

/** Marge entre la réouverture de la PR et la mise en file du job : horloges du lanceur et du hook. */
const QUEUE_SLACK_MS = 120_000;

/** `app-back` → `back`, `proxydis/app-front` → `front` */
export function shortRepo(repo: string): string {
  const base = repo.split('/').pop() ?? repo;
  return base.replace(/^app-/, '') || base;
}

/** Dépôt GitHub d'un répertoire du journal : celui d'un runner dont le nom de dépôt correspond, sinon `<owner>/<dir>`. */
export function ghRepoOf(dir: string, runners: CiRunnerLite[], owner: string): string {
  if (dir.includes('/')) return dir;
  const hit = runners.map((r) => r.repo ?? r.state?.repo ?? '').find((r) => r.split('/').pop() === dir);
  return hit || `${owner}/${dir}`;
}

/** Liens GitHub d'un job, d'un run et d'une PR, valeurs prêtes pour `facts`. */
export function ciLinks(repo: string, pr: number | null, job: CiJob | null, runId: number | null): CiFact[] {
  const out: CiFact[] = [];
  if (job?.jobUrl) out.push({ k: 'graph.f.jobUrl', v: job.jobUrl });
  const run = (runId !== null && job?.runId !== runId ? null : job?.runUrl) ?? (runId !== null && repo ? `https://github.com/${repo}/actions/runs/${runId}` : null);
  if (run) out.push({ k: 'graph.f.runUrl', v: run });
  if (pr !== null && repo) {
    const base = job?.prUrl ?? `https://github.com/${repo}/pull/${pr}`;
    out.push({ k: 'graph.f.prUrl', v: base }, { k: 'graph.f.checksUrl', v: `${base}/checks` });
  }
  return out;
}

/** Faits d'un job : nom, créneau, branche, heures et durées (attente du créneau, exécution). */
export function ciJobFacts(j: CiJob, now: number): CiFact[] {
  const out: CiFact[] = [{ k: 'graph.f.ciJob', v: j.workflow ? `${j.job} (${j.workflow})` : j.job }];
  if (j.slot !== null) out.push({ k: 'graph.f.slot', v: String(j.slot) });
  if (j.headRef || j.ref) out.push({ k: 'graph.f.branch', v: j.headRef || j.ref });
  if (j.queuedAt) out.push({ k: 'graph.f.queuedAt', v: String(j.queuedAt), fmt: 'clock' });
  if (j.queuedAt) {
    const until = j.startedAt ?? (j.state === 'attente' ? now : j.endedAt);
    if (until) out.push({ k: 'graph.f.waited', v: String(Math.max(0, until - j.queuedAt)), fmt: 'dur' });
  }
  if (j.startedAt) {
    out.push({ k: 'graph.f.jobStarted', v: String(j.startedAt), fmt: 'clock' });
    const until = j.endedAt ?? (j.state === 'en_cours' ? now : null);
    if (until) out.push({ k: 'graph.f.ranFor', v: String(Math.max(0, until - j.startedAt)), fmt: 'dur' });
  }
  if (j.endedAt) out.push({ k: 'graph.f.jobEnded', v: String(j.endedAt), fmt: 'clock' });
  if (j.note) out.push({ k: 'graph.f.ciNote', v: j.note });
  return out;
}

/**
 * Nœud d'une PR du lot pendant l'étape CI : verdict du journal d'abord (il fait foi), puis,
 * tant qu'il manque, le job du runner qui porte cette PR (même dépôt, même numéro, mis en
 * file après la réouverture). Un job plus ancien de la même PR — refusé pendant les phases du
 * lot, par exemple — n'est jamais rattaché.
 */
export function ciPrView(p: CiPrLog, step: CiStep, runners: CiRunnerLite[], now: number, owner = 'proxydis'): CiPrView {
  const repo = ghRepoOf(p.dir, runners, owner);
  const since = (p.ts ?? step.startTs ?? 0) - QUEUE_SLACK_MS;
  const mine = (j: CiJob | null): j is CiJob => !!j && j.repo === repo && j.pr === p.n && (j.queuedAt ?? j.updatedAt ?? 0) >= since;

  // job courant : la fiche d'un runner si elle est à cette PR, sinon la dernière ligne d'historique
  let job: CiJob | null = null;
  let runner: CiRunnerLite | null = null;
  for (const r of runners) {
    if (mine(r.state) && (!job || (r.state.updatedAt ?? 0) > (job.updatedAt ?? 0))) {
      job = r.state;
      runner = r;
    }
  }
  const done = runners.flatMap((r) => r.history.filter(mine));
  if (!job) {
    job = done.reduce<CiJob | null>((a, j) => (!a || (j.updatedAt ?? 0) > (a.updatedAt ?? 0) ? j : a), null);
    runner = job ? (runners.find((r) => r.name === job!.runner) ?? null) : null;
  }
  const js = job ? ciJobSub(job, !!runner?.workerAlive && runner.state === job) : null;
  const attached = js?.live && runner ? runner.name : null;

  let state: UnitState = 'running';
  let sub: Msg;
  let note: Msg | null = null;
  if (p.status === 'verdict') {
    state = p.verdict === 'success' && !p.skipped ? 'done' : 'failed';
    sub = p.skipped
      ? { k: 'graph.ci.pr.skipped' }
      : p.red
        ? { k: 'graph.ci.pr.red', p: { v: p.verdict ?? '?', red: p.red } }
        : (p.verdict ?? '?');
  } else if (p.status === 'conflict') {
    state = 'failed';
    sub = { k: 'graph.ci.pr.conflict', p: { rel: p.rel ?? '?' } };
  } else if (p.status === 'reopenFail') {
    state = 'failed';
    sub = { k: 'graph.ci.pr.reopenFail' };
  } else if (step.end || step.timeout) {
    state = 'failed';
    sub = { k: 'graph.ci.pr.noVerdict' };
  } else if (js && job) {
    sub = js.sub;
    if (js.interrupted) state = 'killed';
    else if (job.state === 'refuse') {
      // le rouge d'un refus de ressources est relancé une fois par `ci_fin` : la PR repart
      const rerun = p.rerunTs !== null && (job.endedAt ?? 0) <= p.rerunTs;
      state = rerun ? 'running' : 'failed';
      if (rerun) sub = { k: 'graph.ci.pr.rerun' };
    }
  } else {
    sub = p.rerunTs ? { k: 'graph.ci.pr.rerun' } : { k: 'graph.ci.pr.expected' };
  }
  if (job?.state === 'refuse' && job.note) note = job.note;
  if (js?.interrupted) note = { k: 'graph.ci.job.interruptedNote', p: { job: job!.job, runner: job!.runner } };

  const facts: CiFact[] = [
    { k: 'graph.f.repo', v: repo },
    { k: 'graph.f.pr', v: `#${p.n}` },
  ];
  if (p.verdict) facts.push({ k: 'graph.f.verdict', v: p.red ? `${p.verdict} · ${p.red}` : p.verdict });
  if (job) facts.push({ k: 'graph.f.runner', v: job.runner }, ...ciJobFacts(job, now));
  const names = [...new Set(done.map((j) => j.job))];
  if (names.length) facts.push({ k: 'graph.f.jobsDone', v: names.join(', ') });
  facts.push(...ciLinks(repo, p.n, job, p.runId));

  return {
    repo,
    short: shortRepo(repo),
    n: p.n,
    state,
    sub,
    attached,
    job,
    startedAt: p.ts,
    endedAt: state === 'running' || state === 'killed' ? null : (p.endTs ?? step.end?.ts ?? null),
    facts,
    note,
    noteIsError: state === 'failed' || state === 'killed',
  };
}

/** Voie FIN pendant et après l'étape CI. */
export function ciLaneView(step: CiStep): { state: UnitState; sub: Msg; note: Msg | null; endedAt: number | null } {
  const n = step.prs.length;
  const done = step.prs.filter((p) => p.status !== 'expected').length;
  if (step.end) {
    const rc = step.end.rc ?? '?';
    const red = step.prs.filter((p) => p.status !== 'verdict' || p.verdict !== 'success' || p.skipped).map((p) => `#${p.n}`);
    // raison de l'échec : délai dépassé, sinon les PR pas vertes, sinon le seul code de retour
    const note: Msg | null =
      step.end.rc === 0
        ? null
        : step.timeout
          ? { k: 'graph.ci.pr.noVerdict' }
          : red.length
            ? { k: 'graph.lane.ciFailed', p: { prs: red.join(', ') } }
            : { k: 'graph.lane.ciRc', p: { rc } };
    return {
      state: step.end.rc === 0 ? 'done' : 'failed',
      sub: step.noPr ? { k: 'graph.lane.ciNone', p: { rel: step.noPr } } : { k: 'graph.lane.ciEnd', p: { rc, done, n } },
      note,
      endedAt: step.end.ts,
    };
  }
  if (step.noPr) return { state: 'running', sub: { k: 'graph.lane.ciNone', p: { rel: step.noPr } }, note: null, endedAt: null };
  return { state: 'running', sub: { k: 'graph.lane.ci', p: { done, n } }, note: null, endedAt: null };
}

// ------------------------------------------------------------------ runners vivants (lectures)

export type CiMem = {
  /** Mo */
  current: number | null;
  swap: number | null;
  peak: number | null;
  /** fois où le cgroup a buté sur `memory.high` (compteur depuis le démarrage de l'unité) */
  highEvents: number | null;
  high: number | null;
  max: number | null;
};

export type CiRunner = CiRunnerLite & {
  unit: string;
  dir: string | null;
  /** tous les process de l'unité */
  pids: number[];
  /** socle du runner (`runsvc.sh`, `RunnerService.js`, `Runner.Listener`) */
  base: number[];
  /** le job : sous-arbre de `Runner.Worker`, plus les orphelins de l'unité (le `sleep` qui tient le créneau) */
  jobPids: number[];
  workers: number[];
  mem: CiMem;
  /** dernier job connu (fiche du runner, sinon dernière ligne d'historique) */
  last: CiJob | null;
  startedAt: number | null;
};

export type ProcLite = { pid: number; ppid: number; cmd: string; comm: string; startedAt: number };

export const CI_STATE_DIR = process.env.MONITOR_CI_STATE_DIR || path.join(os.homedir(), 'ci-runner', 'etat');

function unitRe(): RegExp {
  try {
    return new RegExp(process.env.MONITOR_CI_UNIT_RE || '^gh-runner-[\\w.-]+\\.service$');
  } catch {
    return /^gh-runner-[\w.-]+\.service$/;
  }
}
const UNIT_RE = unitRe();

const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
const APP_SLICE = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/app.slice`;

/** Lecture mise en cache par `mtime` et taille : le flux du graphe repasse toutes les 2 s. */
const fileCache = new Map<string, { sig: string; v: unknown }>();
function cached<T>(file: string, parse: (f: string) => T, fallback: T): T {
  try {
    const st = fs.statSync(file);
    const sig = `${st.mtimeMs}:${st.size}`;
    const hit = fileCache.get(file);
    if (hit && hit.sig === sig) return hit.v as T;
    const v = parse(file);
    fileCache.set(file, { sig, v });
    return v;
  } catch {
    fileCache.delete(file);
    return fallback;
  }
}

const HISTORY_TAIL = 256 * 1024;
const HISTORY_MAX = 300;

function readHistory(): CiJob[] {
  return cached(
    path.join(CI_STATE_DIR, 'historique.jsonl'),
    (f) => {
      const fd = fs.openSync(f, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        const len = Math.min(size, HISTORY_TAIL);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        const lines = buf.toString('utf8').split('\n');
        if (len < size) lines.shift(); // première ligne coupée
        return lines.slice(-HISTORY_MAX).map((l) => parseCiJob(l.trim())).filter((j): j is CiJob => !!j);
      } finally {
        fs.closeSync(fd);
      }
    },
    [],
  );
}

/** `.runner` du répertoire d'installation : nom du runner et dépôt GitHub (fichier écrit avec BOM). */
function readRunnerConf(dir: string): { name: string | null; repo: string | null } {
  return cached(
    path.join(dir, '.runner'),
    (f) => {
      const o = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
      const repo = str(o.gitHubUrl).match(/^https:\/\/github\.com\/([^/\s]+\/[^/\s]+?)\/?$/)?.[1] ?? null;
      return { name: str(o.agentName) || null, repo };
    },
    { name: null, repo: null },
  );
}

function readNum(file: string): number | null {
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    return /^\d+$/.test(s) ? Number(s) : null;
  } catch {
    return null;
  }
}
const toMb = (b: number | null): number | null => (b === null ? null : Math.round((b / 1048576) * 10) / 10);

function readMem(dir: string): CiMem {
  let highEvents: number | null = null;
  try {
    const m = fs.readFileSync(path.join(dir, 'memory.events'), 'utf8').match(/^high (\d+)$/m);
    highEvents = m ? Number(m[1]) : null;
  } catch {
  }
  return {
    current: toMb(readNum(path.join(dir, 'memory.current'))),
    swap: toMb(readNum(path.join(dir, 'memory.swap.current'))),
    peak: toMb(readNum(path.join(dir, 'memory.peak'))),
    highEvents,
    high: toMb(readNum(path.join(dir, 'memory.high'))),
    max: toMb(readNum(path.join(dir, 'memory.max'))),
  };
}

function cgroupPids(dir: string): number[] {
  const out: number[] = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    try {
      for (const line of fs.readFileSync(path.join(d, 'cgroup.procs'), 'utf8').split('\n')) {
        const pid = Number(line.trim());
        if (pid > 0) out.push(pid);
      }
      for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) stack.push(path.join(d, e.name));
    } catch {
    }
  }
  return out;
}

const WORKER = /(^|\/)Runner\.Worker(\s|$)/;
const BASE = /(^|\/)(runsvc\.sh|Runner\.Listener|RunnerService\.js)(\s|$)/;

/**
 * Sépare le socle du runner de son job. Le socle part des process de l'unité qui en sont
 * la racine (`runsvc.sh`, ou un `Runner.Listener`/`RunnerService.js` dont le parent est
 * hors de l'unité) et descend jusqu'aux `Runner.Worker` exclus ; tout le reste de l'unité est
 * le job, y compris le `sleep 10800` du créneau, rattaché au gestionnaire de l'utilisateur
 * dès que le hook qui l'a lancé se termine.
 */
export function splitRunnerPids(pids: number[], procs: Map<number, ProcLite>): { base: number[]; job: number[]; workers: number[] } {
  const inUnit = new Set(pids.filter((p) => procs.has(p)));
  const kids = new Map<number, number[]>();
  for (const pid of inUnit) {
    const pp = procs.get(pid)!.ppid;
    kids.set(pp, [...(kids.get(pp) ?? []), pid]);
  }
  const workers = [...inUnit].filter((pid) => WORKER.test(procs.get(pid)!.cmd) || procs.get(pid)!.comm === 'Runner.Worker');
  const workerSet = new Set(workers);
  const base = new Set<number>();
  const roots = [...inUnit].filter((pid) => !inUnit.has(procs.get(pid)!.ppid) && BASE.test(procs.get(pid)!.cmd));
  const stack = [...roots];
  while (stack.length) {
    const pid = stack.pop()!;
    if (base.has(pid) || workerSet.has(pid)) continue;
    base.add(pid);
    stack.push(...(kids.get(pid) ?? []));
  }
  return { base: [...base], job: [...inUnit].filter((p) => !base.has(p)), workers };
}

/**
 * Runners vivants (unité `gh-runner-*` avec au moins un process), lus dans leur cgroup.
 * Une unité arrêtée n'apparaît pas : elle ne fait rien tourner et n'a rien à mesurer.
 */
export function readCiRunners(procs: Map<number, ProcLite>): CiRunner[] {
  let units: string[];
  try {
    units = fs.readdirSync(APP_SLICE).filter((u) => UNIT_RE.test(u.replaceAll('\\x2d', '-')));
  } catch {
    return [];
  }
  const history = readHistory();
  const out: CiRunner[] = [];
  for (const u of units.sort()) {
    const cg = path.join(APP_SLICE, u);
    const pids = cgroupPids(cg);
    if (!pids.length) continue;
    const unit = u.replaceAll('\\x2d', '-');
    const { base, job, workers } = splitRunnerPids(pids, procs);
    let dir: string | null = null;
    for (const pid of pids) {
      // `runsvc.sh` passe par son interpréteur (`/bin/bash …/runsvc.sh`) : le chemin n'est pas forcément en tête
      const m = procs.get(pid)?.cmd.match(/(?:^|\s)(\/\S+?)\/(?:runsvc\.sh|bin\/Runner\.(?:Listener|Worker))(\s|$)/);
      if (m) {
        dir = m[1];
        break;
      }
    }
    const conf = dir ? readRunnerConf(dir) : { name: null, repo: null };
    const name = conf.name ?? unit.replace(/^gh-runner-/, '').replace(/\.service$/, '');
    const state = cached(path.join(CI_STATE_DIR, `${name}.json`), (f) => parseCiJob(fs.readFileSync(f, 'utf8')), null);
    const mineHist = history.filter((j) => j.runner === name);
    const lastHist = mineHist.at(-1) ?? null;
    const last = state && (!lastHist || (state.updatedAt ?? 0) >= (lastHist.updatedAt ?? 0)) ? state : lastHist;
    const root = base.map((p) => procs.get(p)!).sort((a, b) => a.startedAt - b.startedAt)[0];
    out.push({
      unit,
      name,
      repo: conf.repo ?? (state?.repo || null),
      dir,
      pids,
      base,
      jobPids: job,
      workers,
      workerAlive: workers.length > 0,
      mem: readMem(cg),
      state,
      history: mineHist,
      last,
      startedAt: root?.startedAt ?? null,
    });
  }
  return out;
}

/** Mémoire du cgroup d'un runner, en faits du panneau. */
export function ciMemFacts(m: CiMem): CiFact[] {
  const out: CiFact[] = [];
  if (m.current !== null) out.push({ k: 'graph.f.cgMem', v: String(m.current), fmt: 'mb' });
  if (m.swap !== null) out.push({ k: 'graph.f.cgSwap', v: String(m.swap), fmt: 'mb' });
  if (m.peak !== null) out.push({ k: 'graph.f.cgPeak', v: String(m.peak), fmt: 'mb' });
  if (m.high !== null) out.push({ k: 'graph.f.cgHigh', v: String(m.high), fmt: 'mb' });
  if (m.max !== null) out.push({ k: 'graph.f.cgMax', v: String(m.max), fmt: 'mb' });
  if (m.highEvents !== null) out.push({ k: 'graph.f.cgHighEvents', v: String(m.highEvents) });
  return out;
}
