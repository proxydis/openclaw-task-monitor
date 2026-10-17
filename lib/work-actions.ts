/**
 * Dernières actions (tool calls) des sessions Claude CLI d'un agent.
 *
 * Les transcripts sont `<claudeProjectsDir>/<slug>/<cliSessionId>.jsonl`, où `<slug>` est le
 * répertoire de travail du CLI avec `/` et `.` remplacés par `-`. Un agent a donc un dossier
 * par workspace (`…-workspace-neo`) et un par worktree de code (`…-workspace-neo-phenix-back-wt-x`).
 * Seule la fin des fichiers est lue (≤ 256 Ko) : un transcript peut peser des dizaines de Mo.
 */
import fs from 'node:fs';
import path from 'node:path';
import { claudeProjectsDir } from './claude-cli';
import { oneLine, shortPath } from './work-util';
import type { WorkAction } from './work-types';
import type { WorkspaceAgent } from './workspaces';

const TAIL_BYTES = 256 * 1024;
const MAX_FILES_PER_AGENT = 3;
/** au-delà, un transcript n'est plus « actif » : on n'en montre que les actions si rien de plus récent */
const ACTIVE_MS = 15 * 60_000;
const RECENT_MS = 24 * 3600_000;

export const slugOfPath = (p: string): string => p.replace(/[^A-Za-z0-9]/g, '-');

type Candidate = { file: string; mtime: number; project: string };

/** Dossier de sessions → agent : le slug de workspace le plus long, suivi d'une fin de nom ou d'un `-`. */
function agentOfProjectDir(
  dir: string,
  slugs: Array<{ id: string; slug: string }>,
): { id: string; rest: string } | null {
  let best: { id: string; len: number } | null = null;
  for (const s of slugs) {
    if (dir !== s.slug && !dir.startsWith(`${s.slug}-`)) continue;
    if (!best || s.slug.length > best.len) best = { id: s.id, len: s.slug.length };
  }
  return best ? { id: best.id, rest: dir.slice(best.len).replace(/^-/, '') } : null;
}

function candidatesByAgent(agents: WorkspaceAgent[]): Map<string, Candidate[]> {
  const slugs = agents.filter((a) => a.workspace).map((a) => ({ id: a.id, slug: slugOfPath(a.workspace!) }));
  const out = new Map<string, Candidate[]>();
  const root = claudeProjectsDir();
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return out;
  }
  const now = Date.now();
  for (const dir of dirs) {
    const owner = agentOfProjectDir(dir, slugs);
    if (!owner) continue;
    const id = owner.id;
    let files: string[];
    try {
      files = fs.readdirSync(path.join(root, dir));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(root, dir, f);
      try {
        const mtime = fs.statSync(file).mtimeMs;
        if (now - mtime > RECENT_MS) continue;
        const arr = out.get(id) ?? [];
        arr.push({ file, mtime, project: owner.rest });
        out.set(id, arr);
      } catch {
        /* fichier disparu entre deux lectures */
      }
    }
  }
  return out;
}

function tailLines(file: string): string[] {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    // le premier fragment est coupé quand on n'a pas lu depuis le début
    if (size > len) lines.shift();
    return lines;
  } catch {
    return [];
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Argument compact et épuré d'un appel d'outil. */
export function compactArg(tool: string, input: Record<string, unknown> | null | undefined): string {
  const i = input ?? {};
  switch (tool) {
    case 'Bash':
      return oneLine(str(i.command), 140);
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return shortPath(str(i.file_path || i.notebook_path));
    case 'Grep':
    case 'Glob':
      return oneLine(str(i.pattern), 100);
    case 'Agent':
    case 'Task':
      return oneLine(str(i.description || i.prompt), 120);
    case 'Skill':
      return oneLine(str(i.skill), 80);
    case 'WebFetch': {
      try {
        const u = new URL(str(i.url));
        return `${u.host}${u.pathname}`.slice(0, 120);
      } catch {
        return '';
      }
    }
    case 'WebSearch':
      return oneLine(str(i.query), 100);
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return oneLine(str(i.subject || i.description || i.activeForm), 100);
    default:
      return '';
  }
}

function actionsOf(c: Candidate, max: number): WorkAction[] {
  const out: WorkAction[] = [];
  const lines = tailLines(c.file);
  for (let k = lines.length - 1; k >= 0 && out.length < max; k--) {
    const line = lines[k];
    if (!line || !line.includes('"tool_use"')) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const content = o?.message?.content;
    if (o?.type !== 'assistant' || !Array.isArray(content)) continue;
    const ts = Date.parse(o.timestamp);
    if (!Number.isFinite(ts)) continue;
    for (let b = content.length - 1; b >= 0; b--) {
      const blk = content[b];
      if (blk?.type !== 'tool_use' || typeof blk.name !== 'string') continue;
      out.push({ ts, tool: blk.name, arg: compactArg(blk.name, blk.input), project: c.project });
      if (out.length >= max) break;
    }
  }
  return out;
}

export type AgentActions = { actions: WorkAction[]; live: boolean; lastAt: number | null };

/** Actions récentes de chaque agent : au plus `limit`, les plus récentes d'abord. */
export function readAgentActions(agents: WorkspaceAgent[], limit = 8): Map<string, AgentActions> {
  const now = Date.now();
  const res = new Map<string, AgentActions>();
  for (const [id, cands] of candidatesByAgent(agents)) {
    cands.sort((a, b) => b.mtime - a.mtime);
    const actions: WorkAction[] = [];
    for (const c of cands.slice(0, MAX_FILES_PER_AGENT)) actions.push(...actionsOf(c, limit));
    actions.sort((a, b) => b.ts - a.ts);
    res.set(id, {
      actions: actions.slice(0, limit),
      live: now - cands[0].mtime < ACTIVE_MS,
      lastAt: Math.round(cands[0].mtime),
    });
  }
  return res;
}
