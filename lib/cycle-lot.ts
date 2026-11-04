import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Msg, UnitState } from './types';

/**
 * Cycle de lot Phénix (`cycle-lot`, relais `phenix-relais`, décision de CodeMan du 04/11/2026) :
 * un état par lot, `cycles/<version>/etat.json`, et le pouls du relais, `cycles/.veille.json`.
 *
 * Le relais tient les attentes GitHub du cycle (déploiement de revue, CI de la release, CI des
 * PR de livraison, mise en production) dans un service oneshot lancé toutes les 2 min : aucun
 * process ne vit pendant ces attentes. Sans ce module, rien n'en paraîtrait dans le graphe,
 * alors que les veilleurs que les agents écrivaient avant le cycle y apparaissaient comme jobs.
 *
 * Lecture seule de fichiers locaux, aucun appel réseau : les runs suivis et leurs liens sont
 * ceux que la veille a écrits dans `attente.suivi`. `cycleView` et `relayView` sont pures
 * (`scripts/verif-cycle-lot.mts`) ; ce module n'importe que des modules `node:` et des types.
 */

export const CYCLES_DIR =
  process.env.PHENIX_CYCLES_DIR || path.join(os.homedir(), '.openclaw', 'shared', 'phenix-lot', 'cycles');

/** Un lot livré reste visible ce temps-là, puis quitte le graphe. */
const LIVRE_VISIBLE_MS = 24 * 3_600_000;
/** Timer toutes les 2 min après la fin du passage précédent, plus la durée d'un passage. */
const POULS_MAX_MS = 6 * 60_000;

/** Étapes où personne n'agit : le relais attend GitHub. */
const ATTENTES = new Set(['deploiement-revue', 'ci-release', 'ci-livraison', 'deploiement']);

const MAINS: Record<string, string> = { neo: 'Neo', ada: 'Ada', codeman: 'CodeMan' };

export type CycleFact = { k: string; v: string; fmt?: 'clock' };

export type CycleRun = {
  /** identifiant stable sous le nœud du lot */
  key: string;
  repo: string;
  label: Msg;
  state: UnitState;
  startedAt: number | null;
  /** résumé de la veille : `run 123 vert`, `run 124 failure, jobs rouges : quality`… */
  note: string;
  facts: CycleFact[];
};

export type CycleView = {
  version: string;
  etape: string;
  state: UnitState;
  since: number | null;
  label: Msg;
  sub: Msg;
  /** ce qui se passe maintenant, en une ligne */
  activity: string;
  note: Msg | null;
  noteIsError: boolean;
  facts: CycleFact[];
  runs: CycleRun[];
};

export type RelayView = {
  state: UnitState;
  last: number | null;
  sub: Msg;
  note: Msg | null;
  noteIsError: boolean;
  facts: CycleFact[];
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const tsOf = (v: unknown): number | null => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};
const ghUrl = (v: unknown): string | null => (typeof v === 'string' && /^https:\/\/github\.com\/[^\s"<>]+$/.test(v) ? v : null);
const short = (sha: unknown): string => str(sha).slice(0, 7);
const clock = (t: number | null): string => (t === null ? '' : String(t));

/** Verdict de la veille (`bilan_run`) → état d'un nœud. */
function runState(verdict: string): UnitState {
  if (verdict === 'en cours') return 'running';
  if (verdict === 'vert') return 'done';
  if (verdict === 'rouge') return 'failed';
  return 'scheduled'; // « absent » : le run n'est pas encore créé
}

/** Runs que le relais attend à l'étape en cours, tels que la dernière veille les a lus. */
function cycleRuns(e: Obj): CycleRun[] {
  const att = obj(e.attente);
  const out: CycleRun[] = [];
  const dep = obj(att.deploiement);
  if (str(e.etape) === 'deploiement-revue' && str(dep.branche)) {
    const verdict = str(dep.verdict) || (dep.erreur ? 'rouge' : dep.run ? 'en cours' : 'absent');
    const url = ghUrl(dep.url);
    out.push({
      key: 'deploy:back',
      repo: 'back',
      label: { k: 'graph.cycle.runDeploy', p: { branch: str(dep.branche) } },
      state: runState(verdict),
      startedAt: tsOf(dep.lance),
      note: str(dep.resume) || str(dep.erreur) || (dep.run ? `run ${dep.run}` : ''),
      facts: [
        { k: 'graph.f.branch', v: str(dep.branche) },
        ...(url ? [{ k: 'graph.f.runUrl', v: url }] : []),
        ...(dep.vert_a ? [{ k: 'graph.f.cycleDeployGreen', v: clock(tsOf(dep.vert_a)), fmt: 'clock' as const }] : []),
      ],
    });
  }
  const livraison = arr(e.prs_livraison);
  for (const s of arr(att.suivi)) {
    const repo = str(s.depot);
    const sha = str(s.sha);
    const pr = livraison.find((p) => str(p.depot) === repo && str(p.sha) === sha && str(p.base) === 'master');
    const label: Msg =
      str(s.event) === 'pull_request'
        ? { k: 'graph.cycle.runPr', p: { repo, n: num(pr?.num) ?? '?', base: str(pr?.base) || 'master' } }
        : { k: 'graph.cycle.runPush', p: { repo, branch: str(s.branche) } };
    const url = ghUrl(s.url);
    const prUrl = ghUrl(pr?.url);
    out.push({
      key: `${str(s.event)}:${repo}:${str(s.branche) || sha}`,
      repo,
      label,
      state: runState(str(s.verdict)),
      startedAt: tsOf(s.debut),
      note: str(s.resume),
      facts: [
        { k: 'graph.f.cycleCommit', v: short(sha) },
        ...(url ? [{ k: 'graph.f.runUrl', v: url }] : []),
        ...(prUrl ? [{ k: 'graph.f.prUrl', v: prUrl }] : []),
        { k: 'graph.f.verdict', v: str(s.resume) || str(s.verdict) },
      ],
    });
  }
  return out;
}

/** Vue d'un lot ; `null` pour un état illisible ou un lot livré depuis plus de 24 h. */
export function cycleView(etat: unknown, now: number): CycleView | null {
  const e = obj(etat);
  const version = str(e.version);
  const etape = str(e.etape);
  if (!version || !etape) return null;
  const since = tsOf(e.depuis);
  if (etape === 'livre' && since !== null && now - since > LIVRE_VISIBLE_MS) return null;
  const tour = str(e.tour);
  const rounds = `${num(e.aller_retours) ?? 0}/${num(e.max_aller_retours) ?? 3}`;
  const runs = cycleRuns(e);
  const arret = obj(e.arret);
  const reveil = obj(e.a_reveiller);
  const reveils = arr(e.reveils);
  const dernier = reveils.at(-1);

  let state: UnitState = 'running';
  let sub: Msg;
  let activity: string;
  let note: Msg | null = null;
  let noteIsError = false;
  if (etape === 'livre') {
    state = 'done';
    sub = { k: 'graph.cycle.subDone' };
    activity = str(obj(e.dernier_message).texte);
  } else if (etape === 'arret') {
    state = 'paused';
    sub = { k: 'graph.cycle.subStop', p: { motif: str(arret.motif) || '?' } };
    activity = str(arret.message);
    note = { k: 'graph.cycle.stopNote', p: { motif: str(arret.motif) || '?', message: str(arret.message) } };
    noteIsError = true;
  } else if (ATTENTES.has(etape)) {
    sub = { k: 'graph.cycle.subWait', p: { step: etape } };
    activity = runs.map((r) => `${r.repo} : ${r.note || '…'}`).join(' · ');
  } else {
    sub = { k: 'graph.cycle.subHand', p: { step: etape, hand: MAINS[tour] ?? (tour || '—') } };
    activity = str(obj(e.dernier_message).texte);
  }
  if (!noteIsError && str(reveil.agent) && (num(reveil.essais) ?? 0) >= 2) {
    note = { k: 'graph.cycle.wakeFailing', p: { agent: MAINS[str(reveil.agent)] ?? str(reveil.agent), n: num(reveil.essais) ?? 0 } };
    noteIsError = true;
  } else if (!noteIsError && obj(e.relances).alerte) {
    note = { k: 'graph.cycle.silent', p: { agent: MAINS[tour] ?? tour } };
    noteIsError = true;
  }

  const facts: CycleFact[] = [
    { k: 'graph.f.cycleStep', v: etape },
    { k: 'graph.f.cycleHand', v: tour === 'veille' ? 'relais' : (MAINS[tour] ?? (tour || '—')) },
    ...(since !== null ? [{ k: 'graph.f.cycleSince', v: clock(since), fmt: 'clock' as const }] : []),
    { k: 'graph.f.cycleRounds', v: rounds },
  ];
  for (const p of arr(e.prs_lot)) {
    const url = ghUrl(p.url);
    if (url) facts.push({ k: 'graph.f.cyclePr', v: url });
  }
  for (const p of arr(e.prs_livraison)) {
    const url = ghUrl(p.url);
    if (url) facts.push({ k: 'graph.f.cycleDelivery', v: url });
  }
  if (str(reveil.agent)) {
    facts.push({
      k: 'graph.f.cycleWake',
      v: `${MAINS[str(reveil.agent)] ?? str(reveil.agent)} (${str(reveil.motif)}), ${num(reveil.essais) ?? 0} essai(s)`,
    });
  }
  if (dernier) {
    facts.push({ k: 'graph.f.cycleLastWakeAt', v: clock(tsOf(dernier.heure)), fmt: 'clock' });
    facts.push({
      k: 'graph.f.cycleLastWake',
      v: `${MAINS[str(dernier.agent)] ?? str(dernier.agent)} · ${str(dernier.motif)} · ${dernier.ok ? 'accepté' : `échec : ${str(dernier.erreur)}`}`,
    });
  }
  const dossierLot = str(e.dossier_lot);
  if (dossierLot) facts.push({ k: 'graph.f.cycleDir', v: dossierLot });

  return {
    version,
    etape,
    state,
    since,
    label: { k: 'graph.cycle.lot', p: { v: version } },
    sub,
    activity: activity.split('\n')[0].slice(0, 300),
    note,
    noteIsError,
    facts,
    runs,
  };
}

/** Vue du relais à partir de son pouls ; `null` si le relais n'a jamais tourné. */
export function relayView(pouls: unknown, visibleCycles: number, now: number): RelayView | null {
  const p = obj(pouls);
  const last = tsOf(p.derniere);
  if (last === null) return null;
  const errors = (Array.isArray(p.erreurs) ? p.erreurs : []).map(str).filter(Boolean);
  const stale = now - last > POULS_MAX_MS;
  const facts: CycleFact[] = [
    { k: 'graph.f.relayLast', v: clock(last), fmt: 'clock' },
    { k: 'graph.f.relayLots', v: String(visibleCycles) },
    { k: 'graph.f.unit', v: 'phenix-relais.timer' },
  ];
  for (const err of errors) facts.push({ k: 'graph.f.relayError', v: err });
  return {
    state: stale ? 'failed' : 'running',
    last,
    sub: { k: 'graph.cycle.relaySub', p: { n: visibleCycles } },
    note: stale
      ? { k: 'graph.cycle.relayStale', p: { min: Math.round((now - last) / 60_000) } }
      : errors.length
        ? { k: 'graph.cycle.relayErrors', p: { n: errors.length } }
        : null,
    noteIsError: stale || errors.length > 0,
    facts,
  };
}

/** Lecture mise en cache par `mtime` et taille : le flux du graphe repasse toutes les 2 s. */
const fileCache = new Map<string, { sig: string; v: unknown }>();
function readJson(file: string): unknown {
  try {
    const st = fs.statSync(file);
    const sig = `${st.mtimeMs}:${st.size}`;
    const hit = fileCache.get(file);
    if (hit && hit.sig === sig) return hit.v;
    const v: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    fileCache.set(file, { sig, v });
    return v;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      fileCache.delete(file);
      return null;
    }
    // JSON illisible : la veille écrit par `rename`, donc un vrai défaut ; on garde la dernière lecture
    return fileCache.get(file)?.v ?? null;
  }
}

/** Lots à afficher (en cours, arrêtés, livrés depuis moins de 24 h) et relais. */
export function readCycles(now: number): { relay: RelayView | null; cycles: CycleView[] } {
  let dirs: string[] = [];
  try {
    dirs = fs
      .readdirSync(CYCLES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return { relay: null, cycles: [] };
  }
  const cycles: CycleView[] = [];
  for (const d of dirs) {
    const v = cycleView(readJson(path.join(CYCLES_DIR, d, 'etat.json')), now);
    if (v) cycles.push({ ...v, facts: [...v.facts, { k: 'graph.f.cycleJournal', v: path.join(CYCLES_DIR, d, 'journal.log') }] });
  }
  const relay = relayView(readJson(path.join(CYCLES_DIR, '.veille.json')), cycles.length, now);
  return { relay, cycles };
}
