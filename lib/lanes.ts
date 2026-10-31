import fs from 'node:fs';
import path from 'node:path';
import { childIndex, descendants, type RawProc } from './procs';

/**
 * Voies parallèles d'un job `run-lot.sh`, et passes `claude` d'un job en général.
 *
 * `run-lot.sh <lot> impl` lance deux sous-shells en parallèle, `phase A &` et `phase B &`,
 * qui déroulent chacun leurs étapes l'une après l'autre. Pour l'unité systemd, ce n'est
 * qu'un job : les deux voies, pourtant indépendantes (autre branche, autre dossier de
 * travail, autre créneau Claude), se confondaient dans un seul nœud.
 *
 * Ce qui permet de les séparer, mesuré sur les process vivants :
 *
 *  - le lanceur écrit `E2E_PORT=3123 phase A` / `E2E_PORT=3124 phase B` : la variable est
 *    exportée à tout ce que la voie exécute (`claude`, `sleep`, `git`…). Le sous-shell
 *    lui-même ne la montre pas (son `/proc/<pid>/environ` est celui de son parent, figé à
 *    l'exec), mais n'importe lequel de ses descendants exécutés la porte ;
 *  - le prompt de la passe est son entrée standard et son journal sa sortie : les
 *    descripteurs 0 et 1 donnent le nom de l'étape (`neo-099-B16b.prompt.md`) ;
 *  - le répertoire de travail donne le dépôt et la branche (worktree `…-vB` pour la voie B).
 *
 * Une voie sans passe en cours (attente de créneau, préparation de branche, fusion) reste
 * visible : son sous-shell est vivant, c'est elle qu'on cherche.
 */

/** Port e2e de chaque voie, tel que le fixe `run-lot.sh` (`E2E_PORT=3123 phase A`, `3124 phase B`). */
const LANE_BY_PORT: Record<string, string> = { '3123': 'A', '3124': 'B' };

export type Pass = {
  pid: number;
  startedAt: number;
  cmd: string;
  cwd: string | null;
  /** nom court de l'étape (`B16b`), `null` hors convention de nommage */
  step: string | null;
  promptFile: string | null;
  logFile: string | null;
  branch: string | null;
};

export type Lane = {
  /** `A`, `B`, ou `?` quand aucun descendant exécuté ne permet de trancher */
  letter: string;
  root: number;
  startedAt: number;
  /** tous les process de la voie, sous-shell compris */
  pids: number[];
  pass: Pass | null;
};

export type JobSplit = {
  lanes: Lane[];
  /** passes `claude` du job qui ne sont dans aucune voie (phase PRE, FIN, job sans lanceur de lot) */
  passes: Pass[];
  /** ce qui reste au job lui-même : lanceur, veilleurs, scripts */
  rest: number[];
};

/** `E2E_PORT` par pid : l'environnement d'un process ne change plus après son exec, on ne le relit pas. */
const portCache = new Map<number, string | null>();

function e2ePortOf(pid: number): string | null {
  const hit = portCache.get(pid);
  if (hit !== undefined) return hit;
  let port: string | null = null;
  try {
    for (const kv of fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      if (kv.startsWith('E2E_PORT=')) port = kv.slice('E2E_PORT='.length);
    }
  } catch {
    return null; // process disparu ou illisible : pas de mise en cache, il peut être relu
  }
  portCache.set(pid, port);
  if (portCache.size > 4000) portCache.clear();
  return port;
}

function link(pid: number, what: string): string | null {
  try {
    return fs.readlinkSync(`/proc/${pid}/${what}`);
  } catch {
    return null;
  }
}

const isClaude = (p: RawProc) => path.basename(p.cmd.split(/\s+/)[0] ?? '') === 'claude';

/** Branche d'un dépôt ou d'un worktree, lue dans `HEAD` ; l'empreinte courte si la tête est détachée. */
function branchOf(cwd: string | null): string | null {
  if (!cwd) return null;
  try {
    let gitDir = path.join(cwd, '.git');
    const st = fs.statSync(gitDir);
    if (st.isFile()) {
      const m = fs.readFileSync(gitDir, 'utf8').match(/^gitdir:\s*(.+)$/m);
      if (!m) return null;
      gitDir = path.resolve(cwd, m[1].trim());
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    return ref ? ref[1] : head.slice(0, 8);
  } catch {
    return null;
  }
}

/** `neo-099-B16b.prompt.md` → `B16b` : on retire le préfixe du lot (`<agent>-<numéro>-`) et l'extension. */
function stepName(file: string | null): string | null {
  if (!file) return null;
  const base = path.basename(file).replace(/\.prompt\.md$|\.log$/, '');
  return base.replace(/^[a-z]+-\d+-/i, '') || base;
}

function passOf(p: RawProc): Pass {
  const prompt = link(p.pid, 'fd/0');
  const log = link(p.pid, 'fd/1');
  const cwd = link(p.pid, 'cwd');
  const named = prompt && /\.prompt\.md$/.test(prompt) ? prompt : log && /\.log$/.test(log) ? log : null;
  return {
    pid: p.pid,
    startedAt: p.startedAt,
    cmd: p.cmd,
    cwd,
    step: stepName(named),
    promptFile: prompt && /\.md$/.test(prompt) ? prompt : null,
    logFile: log && /\.log$/.test(log) ? log : null,
    branch: branchOf(cwd),
  };
}

const MAIN_RE = /run-lot\.sh\s+\S+\s+impl\b/;

/**
 * Sépare un job en voies, passes isolées et reste. Ne lit que `/proc` : aucune dépendance au
 * contenu du lot, et un job qui n'est pas un lanceur de lot sort simplement sans voie.
 */
export function splitJob(pids: number[], procs: Map<number, RawProc>): JobSplit {
  const inJob = new Set(pids.filter((pid) => procs.has(pid)));
  const kids = childIndex(procs);
  const taken = new Set<number>();

  // process principal du lanceur : celui de la famille `run-lot.sh … impl` dont le parent n'en est pas
  const family = [...inJob].filter((pid) => MAIN_RE.test(procs.get(pid)!.cmd));
  const mains = family.filter((pid) => !MAIN_RE.test(procs.get(procs.get(pid)!.ppid)?.cmd ?? ''));
  const lanes: Lane[] = [];
  for (const main of mains) {
    // voies : les enfants directs du principal qui sont de la même famille et vivent depuis plus de
    // quelques secondes (les sous-shells éphémères d'une substitution ne sont pas des voies)
    const roots = (kids.get(main) ?? []).filter((pid) => {
      const p = procs.get(pid);
      return p && MAIN_RE.test(p.cmd) && Date.now() - p.startedAt > 5_000;
    });
    for (const root of roots) {
      const subtree = descendants(root, kids).filter((pid) => inJob.has(pid));
      let letter: string | null = null;
      for (const pid of subtree) {
        const port = e2ePortOf(pid);
        if (port && LANE_BY_PORT[port]) {
          letter = LANE_BY_PORT[port];
          break;
        }
      }
      const claude = subtree.map((pid) => procs.get(pid)!).filter(isClaude).sort((a, b) => a.startedAt - b.startedAt)[0];
      lanes.push({
        letter: letter ?? '?',
        root,
        startedAt: procs.get(root)!.startedAt,
        pids: subtree,
        pass: claude ? passOf(claude) : null,
      });
      for (const pid of subtree) taken.add(pid);
    }
  }
  // lettre inconnue : par élimination quand l'autre voie est identifiée, sinon l'ordre de lancement
  const known = new Set(lanes.map((l) => l.letter).filter((l) => l !== '?'));
  for (const l of lanes.sort((a, b) => a.root - b.root)) {
    if (l.letter !== '?') continue;
    l.letter = ['A', 'B'].find((x) => !known.has(x)) ?? '?';
    known.add(l.letter);
  }
  lanes.sort((a, b) => a.letter.localeCompare(b.letter) || a.root - b.root);

  // passes `claude` hors voies : une par racine, sans compter les `claude` fils d'un `claude`
  const passes: Pass[] = [];
  const claudeRoots = [...inJob]
    .filter((pid) => !taken.has(pid))
    .map((pid) => procs.get(pid)!)
    .filter(isClaude)
    .filter((p) => !isClaude(procs.get(p.ppid) ?? ({ cmd: '' } as RawProc)));
  for (const p of claudeRoots) {
    passes.push(passOf(p));
    for (const pid of descendants(p.pid, kids)) if (inJob.has(pid)) taken.add(pid);
  }
  passes.sort((a, b) => a.startedAt - b.startedAt);

  return { lanes, passes, rest: [...inJob].filter((pid) => !taken.has(pid)) };
}
