import path from 'node:path';

/**
 * Journaux de chaîne du cycle de lot, lus hors de tout process : voies d'un lot `run-lot.sh`
 * (A, B, C, FIN ou ses files parallèles `FIN-<dépôt>`, partie mécanique de la fin) et passes
 * de preuves en réel de `run-reel.sh`.
 *
 * Fonctions pures : `scripts/essai-voies.mts` les rejoue sur de vrais journaux. Ce module
 * n'importe que des modules `node:` (et aucun module du dépôt), pour rester exécutable tel
 * quel par Node (suppression de types native).
 */

const tsOf = (s: string): number | null => {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
};

// ------------------------------------------------------------------ voies de run-lot.sh

/** Ce que le journal dit d'une voie (`[voie X]`), X = A, B, C, FIN, FIN-back, FIN-front… */
export type LaneInfo = {
  phase: string;
  firstTs: number | null;
  stepTs: number | null;
  endTs: number | null;
  /** étape en cours ou dernière étape commencée (`FINB`, `FINB-c1` pour une passe de correction) */
  step: string | null;
  /** passe Claude, partie mécanique sans Claude, ou rien de commencé */
  mode: 'claude' | 'meca' | null;
  /** journal de la passe Claude en cours (`(log …)`) */
  log: string | null;
  /** numéro de la passe de correction (`<étape>-c<n>`) */
  correction: number | null;
  /** passage de la partie mécanique (1 à MAX_TOURS_FIN) */
  mecaPass: number | null;
  /** passage allégé : commandes longues déjà vertes non rejouées */
  mecaLight: boolean;
  /** répertoire des journaux de la partie mécanique */
  mecaDir: string | null;
  /** la partie mécanique attend celle de l'autre file (verrou du lot) */
  mecaWait: boolean;
  /** dernière partie mécanique rouge, tant qu'aucune verte ne l'a suivie */
  red: { step: string; pass: number | null; verdict: string; report: string | null } | null;
  /** dernier `ÉCHEC …` de la voie (une étape peut échouer sans que la phase s'arrête) */
  error: string | null;
  slot: number | null;
  /** étapes distinctes réussies (une fin d'appli ne compte qu'une fois : passe Claude + partie mécanique) */
  okCount: number;
  finished: boolean;
  failed: string;
  stopped: boolean;
  waiting: boolean;
  last: string;
};

export type LaneChain = {
  lanes: Map<string, LaneInfo>;
  /** files de la phase FIN en parallèle (`back front`), `null` en une seule file */
  finFiles: string[] | null;
  /** `##### phase FIN terminée (files parallèles), rc=N` */
  finEnd: { ts: number | null; rc: number } | null;
};

/** Étape d'etapes.txt d'une passe : `FINB-c2` (correction) est une passe de `FINB`. */
export function baseStep(name: string, known?: { has(k: string): boolean }): string {
  if (known?.has(name)) return name;
  const m = name.match(/^(.+)-c\d+$/);
  if (m && (!known || known.has(m[1]))) return m[1];
  return name;
}

/** `<LOGS>/<PREFIX>-<étape>.log` → étape ; `null` si le fichier n'est pas un journal d'étape du lot. */
export function stepOfLog(file: string, prefix: string): string | null {
  const b = path.basename(file);
  if (!b.startsWith(`${prefix}-`) || !b.endsWith('.log')) return null;
  return b.slice(prefix.length + 1, -'.log'.length) || null;
}

/** `<LOGS>/<PREFIX>-<étape>-meca` (journaux de la partie mécanique) → étape. */
export function stepOfMecaDir(dir: string, prefix: string): string | null {
  const b = path.basename(dir.replace(/\/+$/, ''));
  if (!b.startsWith(`${prefix}-`) || !b.endsWith('-meca')) return null;
  return b.slice(prefix.length + 1, -'-meca'.length) || null;
}

/**
 * Voie d'une étape : sa phase d'etapes.txt, sauf en FIN à files parallèles où elle va dans la
 * file de son dépôt (`FIN-back`, `FIN-front`) quand le journal en a une. Une FIN à une file reste `FIN`.
 */
export function laneOfStep(
  step: string,
  steps: Map<string, { phase: string; repo: string }>,
  laneNames: Iterable<string>,
): string | null {
  const st = steps.get(baseStep(step, steps));
  if (!st) return null;
  if (st.phase !== 'FIN') return st.phase;
  const names = [...laneNames];
  if (names.includes(`FIN-${st.repo}`)) return `FIN-${st.repo}`;
  return names.some((n) => n.startsWith('FIN-')) && !names.includes('FIN') ? `FIN-${st.repo}` : 'FIN';
}

export const isFinLane = (ph: string): boolean => ph === 'FIN' || ph.startsWith('FIN-');

/** Voie FIN qui porte une PR de l'étape CI : la file du dépôt (`phenix-back` → `FIN-back`), sinon la première. */
export function ciLaneOf(dir: string, finLanes: string[]): string | null {
  const base = dir.split('/').pop() ?? dir;
  const short = /^.+-(back|front)$/.exec(base)?.[1] ?? base;
  return finLanes.includes(`FIN-${short}`) ? `FIN-${short}` : (finLanes[0] ?? null);
}

const newLane = (ph: string): LaneInfo => ({
  phase: ph,
  firstTs: null,
  stepTs: null,
  endTs: null,
  step: null,
  mode: null,
  log: null,
  correction: null,
  mecaPass: null,
  mecaLight: false,
  mecaDir: null,
  mecaWait: false,
  red: null,
  error: null,
  slot: null,
  okCount: 0,
  finished: false,
  failed: '',
  stopped: false,
  waiting: false,
  last: '',
});

/**
 * Voies d'un lancement, lues dans le journal de chaîne (déjà tronqué au dernier `##### <PREFIX>
 * <mode> lancée` par l'appelant). `stepNames` : étapes d'etapes.txt, pour rattacher une passe de
 * correction (`FINB-c1`) à son étape.
 */
export function parseLaneLines(text: string, stepNames?: { has(k: string): boolean }): LaneChain {
  const lanes = new Map<string, LaneInfo>();
  const oks = new Map<string, Set<string>>();
  /** étapes dont une partie mécanique a commencé : seule sa fin verte les fait */
  const mecaSeen = new Set<string>();
  let finFiles: string[] | null = null;
  let finEnd: LaneChain['finEnd'] = null;
  const lane = (ph: string): LaneInfo => {
    let x = lanes.get(ph);
    if (!x) {
      x = newLane(ph);
      lanes.set(ph, x);
      oks.set(ph, new Set());
    }
    return x;
  };
  for (const line of text.split('\n')) {
    const m = line.match(/^(\S+) \[voie ([\w-]+)\] (.*)$/);
    if (!m) {
      const g = line.match(/^(\S+) ##### phase FIN (?:en \d+ files parallèles : (.*?)\s*\(|terminée \(files parallèles\), rc=(\d+))/);
      if (g?.[2] !== undefined) finFiles = g[2].split(/\s+/).filter(Boolean);
      else if (g?.[3] !== undefined) finEnd = { ts: tsOf(g[1]), rc: Number(g[3]) };
      continue;
    }
    const ts = tsOf(m[1]);
    const x = lane(m[2]);
    const ok = oks.get(m[2])!;
    const msg = m[3];
    x.last = msg.slice(0, 240);
    let r: RegExpMatchArray | null;
    const begin = (step: string) => {
      x.step = step;
      x.stepTs = ts;
      x.waiting = false;
      x.mecaWait = false;
      x.firstTs ??= ts;
    };
    if ((r = msg.match(/^=== étape (\S+) : run Claude Code(?:, créneau (\d+))?.*?(?:\(log (.+)\))?$/))) {
      begin(r[1]);
      x.mode = 'claude';
      x.log = r[3] ?? null;
      if (r[2]) x.slot = Number(r[2]);
      const c = r[1].match(/-c(\d+)$/);
      x.correction = c && baseStep(r[1], stepNames) !== r[1] ? Number(c[1]) : null;
    } else if ((r = msg.match(/^=== étape (\S+) : partie mécanique sans Claude \((.*)\)$/))) {
      begin(r[1]);
      x.mode = 'meca';
      x.log = null;
      x.correction = null;
      const d = r[2];
      x.mecaPass = Number(d.match(/passage (\d+)/)?.[1]) || null;
      x.mecaLight = /allégé/.test(d);
      x.mecaDir = d.match(/journaux (.+)$/)?.[1] ?? null;
      const s = d.match(/créneau (\d+)/);
      if (s) x.slot = Number(s[1]);
      // la fin d'appli n'est faite qu'une fois sa partie mécanique verte
      ok.delete(baseStep(r[1], stepNames));
      mecaSeen.add(baseStep(r[1], stepNames));
    } else if ((r = msg.match(/^OK étape (\S+) : partie mécanique verte/))) {
      ok.add(baseStep(r[1], stepNames));
      if (x.red && baseStep(x.red.step, stepNames) === baseStep(r[1], stepNames)) x.red = null;
    } else if ((r = msg.match(/^OK (?:étape )?(\S+) : /))) {
      // passe de relecture ou de correction d'une fin d'appli : faite quand sa partie mécanique sera verte
      if (!mecaSeen.has(baseStep(r[1], stepNames))) ok.add(baseStep(r[1], stepNames));
    } else if ((r = msg.match(/^étape (\S+) : partie mécanique ROUGE (?:en \d+s)?,?\s*(.*?)\s*(?:\(rapport (.+)\))?$/))) {
      x.red = { step: r[1], pass: x.mecaPass, verdict: r[2].replace(/\*\*/g, '').replace(/^ROUGE,\s*/, '').trim(), report: r[3] ?? null };
    } else if ((r = msg.match(/^(\S+) : partie mécanique en attente de celle de l'autre file/))) {
      x.step = r[1];
      x.mecaWait = true;
    } else if ((r = msg.match(/^étape (\S+) : pas de step-/))) {
      x.step = r[1];
    } else if (/^ÉCHEC /.test(msg)) {
      x.error = msg.slice(0, 240);
      x.mecaWait = false;
    } else if ((r = msg.match(/^##### phase [\w-]+ terminée : (\d+) étapes OK, en échec :(.*)$/))) {
      x.finished = true;
      x.endTs = ts;
      x.okCount = Number(r[1]);
      x.failed = /aucune/.test(r[2]) ? '' : r[2].trim();
      x.waiting = false;
      x.mecaWait = false;
      if (!x.failed) x.red = null;
      continue;
    } else if (/^##### phase [\w-]+ arrêtée/.test(msg)) {
      x.stopped = true;
    } else if ((r = msg.match(/^créneau (\d+) pris/))) {
      x.slot = Number(r[1]);
      x.waiting = false;
      x.mecaWait = false;
    } else if (/attente d'un créneau|^attente mémoire/.test(msg)) {
      x.waiting = true;
    }
    if (!x.finished) x.okCount = ok.size;
  }
  return { lanes, finFiles, finEnd };
}

/** Arguments de `fin-mecanique.sh <back|front> <dépôt> <base> <journaux> [<liste>]` sur une ligne de commande. */
export function mecaArgs(cmd: string): { repo: string; dir: string } | null {
  const m = cmd.match(/(?:^|\s|\/)fin-mecanique\.sh\s+(\S+)\s+\S+\s+\S+\s+(\S+)/);
  return m ? { repo: m[1], dir: m[2] } : null;
}

// ------------------------------------------------------------------ preuves en réel (run-reel.sh)

export type ReelPass = {
  /** consigne : `step-REEL-a-designations.md` */
  md: string;
  /** `a-designations` (vide pour `step-REEL.md`) */
  name: string;
  log: string | null;
  section: string | null;
  state: 'running' | 'done' | 'failed';
  reason: string | null;
  startTs: number | null;
  endTs: number | null;
};

export type ReelRun = {
  startTs: number | null;
  passes: ReelPass[];
  /** fichier des preuves où les sections ont été ajoutées */
  proofs: string | null;
  end: { ts: number | null; rc: number } | null;
  abort: string | null;
};

export const reelName = (md: string): string => path.basename(md).replace(/^step-REEL/, '').replace(/\.md$/, '').replace(/^[-_.]/, '');

/** Arguments de `run-reel.sh <dossier> [<preuves>]` sur une ligne de commande. */
export function reelArgs(cmd: string): { dir: string; proofs: string | null } | null {
  const m = cmd.match(/(?:^|\s|\/)run-reel\.sh\s+(\S+)(?:\s+(\S+))?/);
  return m ? { dir: m[1], proofs: m[2] ?? null } : null;
}

/**
 * Dernier lancement de `run-reel.sh` dans `reel-chain.log` (les lancements s'ajoutent au même
 * fichier) : un lancement commence à la première ligne `passe … lancée` qui suit une fin
 * (`##### preuves en réel terminées`, `ABANDON`). `null` si le journal n'a aucune ligne reconnue.
 */
export function parseReelChain(text: string): ReelRun | null {
  let run: ReelRun | null = null;
  let closed = true;
  const fresh = (ts: number | null): ReelRun => ({ startTs: ts, passes: [], proofs: null, end: null, abort: null });
  const pass = (md: string): ReelPass | undefined => run?.passes.find((p) => p.md === md);
  for (const line of text.split('\n')) {
    const m = line.match(/^(\S+) (.*)$/);
    if (!m) continue;
    const ts = tsOf(m[1]);
    const msg = m[2];
    let r: RegExpMatchArray | null;
    if ((r = msg.match(/^passe (\S+) lancée \(journal (.+?), section (.+)\)$/))) {
      if (closed || !run) {
        run = fresh(ts);
        closed = false;
      }
      run.passes.push({ md: r[1], name: reelName(r[1]), log: r[2], section: r[3], state: 'running', reason: null, startTs: ts, endTs: null });
    } else if ((r = msg.match(/^ABANDON : (.*)$/))) {
      if (closed || !run) run = fresh(ts);
      run.abort = r[1];
      closed = true;
    } else if (!run) {
      continue;
    } else if ((r = msg.match(/^OK passe (\S+)$/))) {
      const p = pass(r[1]);
      if (p) Object.assign(p, { state: 'done', endTs: ts });
    } else if ((r = msg.match(/^ÉCHEC passe (\S+) : (.*)$/))) {
      const p = pass(r[1]);
      if (p) Object.assign(p, { state: 'failed', reason: r[2], endTs: ts });
    } else if ((r = msg.match(/^sections ajoutées à (.+)$/))) {
      run.proofs = r[1];
    } else if ((r = msg.match(/^##### preuves en réel terminées : rc=(\d+)/))) {
      run.end = { ts, rc: Number(r[1]) };
      closed = true;
    }
  }
  return run;
}
