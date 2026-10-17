/**
 * Onglet « Travail » : ce que font les agents qui codent, sans aucun appel de modèle.
 *
 * Assemble quatre sources locales ou distantes bornées : transcripts Claude CLI (étape en
 * cours), git (dépôts et worktrees), `gh` (pull request) et l'API Trello (cartes). Le résultat
 * est mémorisé 20 s et rafraîchi en tâche de fond : un client ne déclenche jamais lui-même
 * un calcul lent, et `/api/state` n'est jamais concerné.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OC_HOME, REDACT, readAgents } from './store';
import { collectSystemdJobsAsync, type SystemdJob } from './systemd-jobs';
import { readAgentActions } from './work-actions';
import { discoverRepos, getPr, type PrCard, type PrInfo, type RepoInfo } from './work-git';
import { getTrelloCards, trelloConfigured, type TrelloCard } from './work-trello';
import { oneLine } from './work-util';
import type {
  TrelloCardView,
  TrelloLot,
  WorkAgent,
  WorkJob,
  WorkRepo,
  WorkState,
  WorkTrello,
} from './work-types';
import { agentForPath, withWorkspaces } from './workspaces';

const TTL_MS = 20_000;
const JOB_FAILED_KEEP_MS = 6 * 3600_000;
const MAX_LOT_CARDS = 30;

// ------------------------------------------------------------------ cartes

/** `type(scope): carte 6 de la 0.9.5 (back), …` */
export const CARD_RE = /carte (\d+) de la (\d+\.\d+(?:\.\d+)?)(?: \((back|front)\))?/i;

type CardRef = { number: number; version: string; part: string | null };

function cardRefOf(repo: WorkRepo): CardRef | null {
  for (const c of repo.commits) {
    const m = CARD_RE.exec(c.subject);
    if (m) return { number: Number(m[1]), version: m[2], part: m[3]?.toLowerCase() ?? null };
  }
  return null;
}

function findTrello(cards: TrelloCard[] | null, ref: { version: string; number: number; part: string | null }, shortLink?: string | null) {
  if (!cards) return null;
  if (shortLink) {
    const bySl = cards.find((c) => c.shortLink === shortLink);
    if (bySl) return bySl;
  }
  const same = cards.filter((c) => c.version === ref.version && c.number === ref.number);
  if (!same.length) return null;
  const wanted = ref.part;
  return (wanted && same.find((c) => c.scope?.toLowerCase().includes(wanted))) || same[0];
}

function view(
  t: TrelloCard | null,
  fallback: { number: number; title?: string; part: string | null; shortLink?: string | null },
  current: boolean,
): TrelloCardView {
  if (t) {
    return { number: t.number ?? fallback.number, name: t.name, url: t.url || null, list: t.list, labels: t.labels, part: fallback.part, current };
  }
  return {
    number: fallback.number,
    name: fallback.title || `Carte ${fallback.number}`,
    url: fallback.shortLink ? `https://trello.com/c/${fallback.shortLink}` : null,
    list: null,
    labels: [],
    part: fallback.part,
    current,
  };
}

/** Clé d'unicité d'une carte dans un lot : son lien court Trello, sinon numéro + partie. */
const lotKey = (v: TrelloCardView): string => v.url?.split('/c/')[1]?.split('/')[0] ?? `n${v.number}${v.part ?? ''}`;

function buildTrello(repos: RepoInfo[], prs: Map<RepoInfo, PrInfo | null>, cards: TrelloCard[] | null): WorkTrello {
  const out: WorkTrello = { configured: trelloConfigured(), ok: cards !== null, current: [], lots: [] };
  const seenCurrent = new Set<string>();
  const lots = new Map<string, Map<string, TrelloCardView>>();

  for (const repo of repos) {
    const ref = cardRefOf(repo);
    const prCards: PrCard[] = prs.get(repo)?.cards ?? [];
    // version du lot : celle de la dernière carte citée en commit, sinon celle du nom de branche
    const version = ref?.version ?? /(\d+\.\d+(?:\.\d+)?)/.exec(repo.branch ?? '')?.[1] ?? null;
    if (!version) continue;
    const lot = lots.get(version) ?? new Map<string, TrelloCardView>();
    lots.set(version, lot);

    // cartes du lot connues de Trello
    for (const t of cards ?? []) {
      if (t.version !== version || t.number == null) continue;
      const v = view(t, { number: t.number, part: null }, false);
      if (!lot.has(lotKey(v))) lot.set(lotKey(v), v);
    }
    // cartes décrites dans la PR : seul recours sans Trello, complément sinon
    for (const pc of prCards) {
      const t = findTrello(cards, { version, number: pc.number, part: pc.part }, pc.shortLink);
      const v = view(t, pc, false);
      if (!lot.has(lotKey(v))) lot.set(lotKey(v), v);
    }

    if (ref) {
      const pc = prCards.find((c) => c.number === ref.number && (!ref.part || !c.part || c.part === ref.part));
      const t = findTrello(cards, ref, pc?.shortLink);
      const cur = view(t, { number: ref.number, title: pc?.title, part: ref.part, shortLink: pc?.shortLink }, true);
      const id = `${version}#${lotKey(cur)}`;
      if (!seenCurrent.has(id)) {
        seenCurrent.add(id);
        out.current.push(cur);
        const inLot = lot.get(lotKey(cur));
        if (inLot) inLot.current = true;
        else lot.set(lotKey(cur), cur);
      }
    }
  }

  out.lots = [...lots.entries()].map(
    ([version, m]): TrelloLot => ({
      version,
      cards: [...m.values()].sort((a, b) => a.number - b.number).slice(0, MAX_LOT_CARDS),
    }),
  );
  return out;
}

// ------------------------------------------------------------------ jobs

function lastLogLine(file: string | null): string | null {
  if (!file) return null;
  const home = os.homedir();
  const real = path.resolve(file);
  if (!real.startsWith(`${home}/`) && !real.startsWith('/tmp/')) return null;
  let fd: number | null = null;
  try {
    fd = fs.openSync(real, 'r');
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    const len = Math.min(st.size, 4096);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    const lines = buf.toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    const last = lines[lines.length - 1];
    return last ? oneLine(last, 160) : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function jobsView(jobs: SystemdJob[]): WorkJob[] {
  const now = Date.now();
  return jobs
    .filter((j) => {
      if (['active', 'activating', 'reloading'].includes(j.activeState)) return true;
      const failed = j.activeState === 'failed' || (j.result && j.result !== 'success');
      return !!failed && j.endedAt != null && now - j.endedAt < JOB_FAILED_KEEP_MS;
    })
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
    .slice(0, 6)
    .map((j) => ({
      unit: j.unit,
      state: ['active', 'activating', 'reloading'].includes(j.activeState) ? 'running' : 'failed',
      startedAt: j.startedAt,
      lastLine: lastLogLine(j.logFile),
    }));
}

// ------------------------------------------------------------------ assemblage

async function build(): Promise<WorkState> {
  const generatedAt = Date.now();
  if (REDACT) return { generatedAt, redacted: true, agents: [] };

  const cfg = withWorkspaces(readAgents(), OC_HOME);
  const [jobs, cards] = await Promise.all([
    collectSystemdJobsAsync(cfg, OC_HOME).catch((): SystemdJob[] => []),
    getTrelloCards(),
  ]);
  const actions = readAgentActions(cfg);
  const jobsBy = new Map<string, SystemdJob[]>();
  for (const j of jobs) jobsBy.set(j.agentId, [...(jobsBy.get(j.agentId) ?? []), j]);

  const agents = await Promise.all(
    cfg.map(async (a): Promise<WorkAgent | null> => {
      const repos = a.workspace
        ? await discoverRepos(a.workspace, (p) => agentForPath(p, cfg) === a.id).catch((): RepoInfo[] => [])
        : [];
      const prs = new Map<RepoInfo, PrInfo | null>();
      await Promise.all(
        repos.map(async (r) => {
          if (r.github && r.branch && !['main', 'master'].includes(r.branch)) {
            const info = await getPr(r.github, r.branch);
            prs.set(r, info);
            r.pr = info?.pr ?? null;
          }
        }),
      );
      const act = actions.get(a.id);
      const jobList = jobsView(jobsBy.get(a.id) ?? []);
      if (!act?.actions.length && !repos.length && !jobList.length) return null;
      const lastActivityAt = Math.round(Math.max(act?.lastAt ?? 0, ...repos.map((r) => r.activeAt))) || null;
      return {
        id: a.id,
        name: a.name,
        lastActivityAt,
        live: act?.live ?? false,
        actions: act?.actions ?? [],
        jobs: jobList,
        repos: repos.map(({ github: _g, ...r }) => r),
        trello: buildTrello(repos, prs, cards),
      };
    }),
  );

  const list = agents.filter((x): x is WorkAgent => x !== null);
  // Neo (l'agent qui code) en premier, les autres par activité décroissante
  list.sort((x, y) => Number(y.id === 'neo') - Number(x.id === 'neo') || (y.lastActivityAt ?? 0) - (x.lastActivityAt ?? 0));
  return { generatedAt, redacted: false, agents: list };
}

let cache: { at: number; value: WorkState } | null = null;
let inflight: Promise<WorkState> | null = null;

function refresh(): Promise<WorkState> {
  if (!inflight) {
    inflight = build()
      .then((value) => {
        cache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** Instantané mutualisé : valeur fraîche si elle existe, sinon l'ancienne tout de suite et un recalcul en fond. */
export async function getWork(): Promise<WorkState> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  if (cache) {
    refresh().catch(() => {});
    return cache.value;
  }
  return refresh();
}
