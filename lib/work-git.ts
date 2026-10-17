/**
 * Dépôts git et pull requests où travaille un agent.
 *
 * Découverte : `.git` aux profondeurs 1 et 2 du workspace, plus les worktrees déclarés par
 * `git worktree list` des dépôts trouvés. Un dépôt est « actif » si son commit HEAD ou son
 * index a bougé depuis moins de 48 h. Toutes les commandes sont asynchrones, bornées en
 * temps et lancées avec `GIT_OPTIONAL_LOCKS=0` pour ne jamais gêner l'agent au travail.
 */
import fs from 'node:fs';
import path from 'node:path';
import { git, run, shortPath } from './work-util';
import type { WorkCi, WorkCommit, WorkPr, WorkRepo } from './work-types';

const ACTIVE_MS = 48 * 3600_000;
export const MAX_REPOS = 6;

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.venv', 'venv', '__pycache__', 'dist', 'build']);

type Found = { dir: string; isWorktree: boolean };

function gitKind(dir: string): 'repo' | 'worktree' | null {
  try {
    const st = fs.statSync(path.join(dir, '.git'));
    return st.isDirectory() ? 'repo' : st.isFile() ? 'worktree' : null;
  } catch {
    return null;
  }
}

/** Dépôts et worktrees aux profondeurs 1-2 du workspace (lecture de répertoires, aucun processus). */
function scanWorkspace(workspace: string): Found[] {
  const out: Found[] = [];
  const isDir = (e: fs.Dirent) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name);
  let top: fs.Dirent[];
  try {
    top = fs.readdirSync(workspace, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of top) {
    if (!isDir(e)) continue;
    const dir = path.join(workspace, e.name);
    const kind = gitKind(dir);
    if (kind) {
      out.push({ dir, isWorktree: kind === 'worktree' });
      continue;
    }
    let kids: fs.Dirent[];
    try {
      kids = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const k of kids.slice(0, 300)) {
      if (!isDir(k)) continue;
      const sub = path.join(dir, k.name);
      const sk = gitKind(sub);
      if (sk) out.push({ dir: sub, isWorktree: sk === 'worktree' });
    }
  }
  // le workspace peut lui-même être un dépôt
  const own = gitKind(workspace);
  if (own) out.push({ dir: workspace, isWorktree: own === 'worktree' });
  return out;
}

async function worktreesOf(repoDir: string): Promise<string[]> {
  const raw = await git(repoDir, ['worktree', 'list', '--porcelain'], 4000);
  if (!raw) return [];
  const out: string[] = [];
  for (const block of raw.split(/\n\s*\n/)) {
    const m = /^worktree (.+)$/m.exec(block);
    if (m && !/^bare$/m.test(block)) out.push(m[1]);
  }
  return out;
}

/** mtime de l'index d'un dépôt ou d'un worktree (le `.git` d'un worktree est un fichier `gitdir: …`). */
function indexMtime(dir: string): number {
  try {
    const dotGit = path.join(dir, '.git');
    let gitDir = dotGit;
    if (fs.statSync(dotGit).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
      if (!m) return 0;
      gitDir = path.resolve(dir, m[1].trim());
    }
    return fs.statSync(path.join(gitDir, 'index')).mtimeMs;
  } catch {
    return 0;
  }
}

const SEP = '\x1f';

async function recentCommits(dir: string, n: number): Promise<WorkCommit[]> {
  const raw = await git(dir, ['log', `-${n}`, `--format=%h${SEP}%ct${SEP}%s`], 5000);
  if (!raw) return [];
  const out: WorkCommit[] = [];
  for (const line of raw.split('\n')) {
    const [hash, ct, ...subject] = line.split(SEP);
    const ts = Number(ct) * 1000;
    if (hash && Number.isFinite(ts)) out.push({ hash, ts, subject: subject.join(SEP).slice(0, 200) });
  }
  return out;
}

export function parseGithubRemote(url: string | null): string | null {
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec((url ?? '').trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

type Status = {
  branch: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  dirty: number;
};

async function statusOf(dir: string): Promise<Status> {
  const raw = (await git(dir, ['status', '--porcelain=v2', '--branch'], 8000)) ?? '';
  const st: Status = { branch: null, upstream: null, ahead: null, behind: null, dirty: 0 };
  for (const line of raw.split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.head ')) {
      const b = line.slice(14).trim();
      st.branch = b === '(detached)' ? null : b;
    } else if (line.startsWith('# branch.upstream ')) st.upstream = line.slice(18).trim();
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) {
        st.ahead = Number(m[1]);
        st.behind = Number(m[2]);
      }
    } else if (!line.startsWith('#')) st.dirty++;
  }
  return st;
}

export type RepoInfo = WorkRepo & {
  /** `owner/repo` GitHub, pour `gh` ; `null` hors GitHub */
  github: string | null;
};

/**
 * Dépôts actifs d'un agent, du plus récent au plus ancien, `MAX_REPOS` au plus.
 * `owns` filtre les worktrees listés par git qui seraient dans le workspace d'un autre agent.
 */
export async function discoverRepos(workspace: string, owns: (p: string) => boolean): Promise<RepoInfo[]> {
  const found = new Map<string, Found>();
  for (const f of scanWorkspace(workspace)) found.set(f.dir, f);
  const mains = [...found.values()].filter((f) => !f.isWorktree);
  for (const list of await Promise.all(mains.map((m) => worktreesOf(m.dir)))) {
    for (const wt of list) if (!found.has(wt) && owns(wt) && gitKind(wt)) found.set(wt, { dir: wt, isWorktree: true });
  }

  const now = Date.now();
  const scored = await Promise.all(
    [...found.values()].map(async (f) => {
      const idx = indexMtime(f.dir);
      const commits = await recentCommits(f.dir, 5);
      const head = commits[0]?.ts ?? 0;
      return { f, commits, activeAt: Math.max(idx, head) };
    }),
  );
  const active = scored
    .filter((s) => now - s.activeAt < ACTIVE_MS)
    .sort((a, b) => b.activeAt - a.activeAt)
    .slice(0, MAX_REPOS);

  return Promise.all(
    active.map(async (s): Promise<RepoInfo> => {
      const [st, url] = await Promise.all([statusOf(s.f.dir), git(s.f.dir, ['config', '--get', 'remote.origin.url'], 3000)]);
      const github = parseGithubRemote(url);
      return {
        name: github ?? path.basename(s.f.dir),
        github,
        path: shortPath(s.f.dir),
        branch: st.branch,
        isWorktree: s.f.isWorktree,
        head: s.commits[0] ?? null,
        dirty: st.dirty,
        upstream: st.upstream,
        ahead: st.ahead,
        behind: st.behind,
        commits: s.commits,
        activeAt: Math.round(s.activeAt),
        pr: null,
      };
    }),
  );
}

// ------------------------------------------------------------------ pull requests

export type PrCard = { number: number; part: string | null; title: string; shortLink: string | null };
export type PrInfo = { pr: WorkPr; cards: PrCard[] };

const PR_TTL_MS = 3 * 60_000;
const PR_FAIL_TTL_MS = 60_000;
const PR_CACHE_MAX = 40;
const prCache = new Map<string, { at: number; ttl: number; value: PrInfo | null }>();
const prInflight = new Map<string, Promise<PrInfo | null>>();

function ciOf(rollup: any[] | null | undefined): WorkCi {
  const ci: WorkCi = { success: 0, failure: 0, pending: 0, skipped: 0 };
  for (const c of rollup ?? []) {
    // CheckRun : status + conclusion ; StatusContext : state
    const status = String(c?.status ?? '').toUpperCase();
    const verdict = String(c?.conclusion || c?.state || '').toUpperCase();
    if (status && status !== 'COMPLETED') ci.pending++;
    else if (['SUCCESS'].includes(verdict)) ci.success++;
    else if (['SKIPPED', 'NEUTRAL'].includes(verdict)) ci.skipped++;
    else if (['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', ''].includes(verdict)) ci.pending++;
    else ci.failure++;
  }
  return ci;
}

/** Cartes d'un lot décrites dans le corps de la PR : `## Carte N (back) : titre` puis un lien trello.com/c/<id>. */
export function cardsOfPrBody(body: string): PrCard[] {
  const cards: PrCard[] = [];
  let cur: PrCard | null = null;
  for (const line of body.split('\n')) {
    const h = /^#{2,4}\s*Carte\s+(\d+)\s*(?:\((back|front)\))?\s*[:：-]?\s*(.*)$/i.exec(line);
    if (h) {
      cur = { number: Number(h[1]), part: h[2]?.toLowerCase() ?? null, title: h[3].trim().slice(0, 200), shortLink: null };
      cards.push(cur);
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      cur = null;
      continue;
    }
    if (cur && !cur.shortLink) {
      const l = /trello\.com\/c\/([A-Za-z0-9]+)/.exec(line);
      if (l) cur.shortLink = l[1];
    }
  }
  return cards;
}

async function queryPr(repo: string, branch: string): Promise<PrInfo | null> {
  const raw = await run(
    'gh',
    [
      'pr', 'list', '-R', repo, '--head', branch, '--state', 'all', '--limit', '5',
      '--json', 'number,title,url,state,isDraft,reviewDecision,statusCheckRollup,updatedAt,body',
    ],
    { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
  );
  if (raw === null) return null;
  let list: any[];
  try {
    list = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(list) || !list.length) return null;
  const ts = (p: any) => Date.parse(p?.updatedAt) || 0;
  const pick = [...list].sort(
    (a, b) => Number(b.state === 'OPEN') - Number(a.state === 'OPEN') || ts(b) - ts(a),
  )[0];
  return {
    pr: {
      number: Number(pick.number),
      title: String(pick.title ?? '').slice(0, 200),
      url: String(pick.url ?? ''),
      state: String(pick.state ?? ''),
      isDraft: !!pick.isDraft,
      reviewDecision: String(pick.reviewDecision ?? ''),
      ci: ciOf(pick.statusCheckRollup),
      updatedAt: ts(pick) || null,
    },
    cards: cardsOfPrBody(String(pick.body ?? '')),
  };
}

/** PR de la branche, mémorisée 3 min (échec : 1 min, pour ne pas marteler `gh`). Ne lève jamais. */
export function getPr(repo: string, branch: string): Promise<PrInfo | null> {
  const key = `${repo}#${branch}`;
  const hit = prCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < hit.ttl) return Promise.resolve(hit.value);
  const pending = prInflight.get(key);
  if (pending) return pending;
  const p = queryPr(repo, branch)
    .catch(() => null)
    .then((value) => {
      // un échec ne chasse pas une valeur plus ancienne encore plausible
      const keep = value === null && hit?.value ? hit.value : value;
      prCache.set(key, { at: Date.now(), ttl: value === null ? PR_FAIL_TTL_MS : PR_TTL_MS, value: keep });
      while (prCache.size > PR_CACHE_MAX) prCache.delete(prCache.keys().next().value as string);
      return keep;
    })
    .finally(() => prInflight.delete(key));
  prInflight.set(key, p);
  return p;
}
