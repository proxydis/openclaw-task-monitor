import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Racine OpenClaw à superviser. Surchargeable via OPENCLAW_HOME. */
export const OC_HOME = process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw');

/** Masque le contenu des demandes utilisateur (captures d'écran, démos publiques). */
export const REDACT = process.env.MONITOR_REDACT === '1';
const DB_PATH = path.join(OC_HOME, 'state', 'openclaw.sqlite');

export type AgentCfg = { id: string; name: string; workspace: string | null; model: string | null };

let cfgCache: { at: number; agents: AgentCfg[] } | null = null;

export function readAgents(): AgentCfg[] {
  const now = Date.now();
  if (cfgCache && now - cfgCache.at < 30_000) return cfgCache.agents;
  const agents: AgentCfg[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(OC_HOME, 'openclaw.json'), 'utf8'));
    const defModel = raw?.agents?.defaults?.model?.primary ?? null;
    const list = Array.isArray(raw?.agents?.list) ? raw.agents.list : [];
    for (const a of list) {
      if (!a?.id) continue;
      agents.push({
        id: a.id,
        name: a.name || a.id,
        workspace: a.workspace ?? null,
        model: a.model?.primary ?? a.model ?? defModel,
      });
    }
  } catch {
    /* noop */
  }
  // agents présents sur disque mais absents de la config
  try {
    for (const d of fs.readdirSync(path.join(OC_HOME, 'agents'), { withFileTypes: true })) {
      if (d.isDirectory() && !agents.some((a) => a.id === d.name)) {
        agents.push({ id: d.name, name: d.name, workspace: null, model: null });
      }
    }
  } catch {
    /* noop */
  }
  cfgCache = { at: now, agents };
  return agents;
}

export type SessionMeta = {
  key: string;
  sessionId: string | null;
  displayName: string | null;
  channel: string | null;
  chatType: string | null;
  groupChannel: string | null;
  updatedAt: number | null;
  startedAt: number | null;
  lastInteractionAt: number | null;
  sessionFile: string | null;
};

const sessCache = new Map<string, { mtime: number; data: Map<string, SessionMeta> }>();

export function readSessions(agentId: string): Map<string, SessionMeta> {
  const file = path.join(OC_HOME, 'agents', agentId, 'sessions', 'sessions.json');
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return new Map();
  }
  const hit = sessCache.get(agentId);
  if (hit && hit.mtime === mtime) return hit.data;

  const data = new Map<string, SessionMeta>();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [key, v] of Object.entries<any>(raw)) {
      data.set(key, {
        key,
        sessionId: v?.sessionId ?? null,
        displayName: v?.displayName ?? null,
        channel: v?.channel ?? v?.lastChannel ?? null,
        chatType: v?.chatType ?? null,
        groupChannel: v?.groupChannel ?? v?.origin?.label ?? null,
        updatedAt: v?.updatedAt ?? null,
        startedAt: v?.sessionStartedAt ?? null,
        lastInteractionAt: v?.lastInteractionAt ?? v?.updatedAt ?? null,
        sessionFile: v?.sessionFile ?? null,
      });
    }
  } catch {
    /* noop */
  }
  sessCache.set(agentId, { mtime, data });
  return data;
}

export type Transcript = {
  prompt: string | null;
  promptAt: number | null;
  lastMessageAt: number | null;
  userTurns: number;
};

const EMPTY_TRANSCRIPT: Transcript = { prompt: null, promptAt: null, lastMessageAt: null, userTurns: 0 };
const trCache = new Map<string, { sig: string; data: Transcript }>();

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (typeof b === 'string' ? b : b?.type === 'text' ? String(b.text ?? '') : ''))
      .join(' ');
  }
  return '';
}

/** Dernier prompt utilisateur d'une session, lu dans la queue du transcript (aucun appel modèle). */
export function readTranscript(file: string | null): Transcript {
  if (!file) return EMPTY_TRANSCRIPT;
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return EMPTY_TRANSCRIPT;
  }
  const sig = `${st.mtimeMs}:${st.size}`;
  const hit = trCache.get(file);
  if (hit && hit.sig === sig) return hit.data;

  const data: Transcript = { ...EMPTY_TRANSCRIPT };
  try {
    const MAX = 512 * 1024;
    const len = Math.min(st.size, MAX);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buf, 0, len, Math.max(0, st.size - len));
    } finally {
      fs.closeSync(fd);
    }
    const lines = buf.toString('utf8').split('\n');
    if (st.size > MAX && lines.length) lines.shift(); // première ligne potentiellement tronquée
    for (let i = lines.length - 1; i >= 0; i--) {
      const raw = lines[i].trim();
      if (!raw.startsWith('{')) continue;
      let o: any;
      try {
        o = JSON.parse(raw);
      } catch {
        continue;
      }
      if (o?.type !== 'message' || !o?.message) continue;
      const ts = o.timestamp ? Date.parse(o.timestamp) : null;
      if (data.lastMessageAt === null && ts) data.lastMessageAt = ts;
      if (o.message.role !== 'user') continue;
      data.userTurns++;
      if (data.prompt) continue;
      let txt = textOf(o.message.content)
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!txt || txt.length < 3) continue;
      data.prompt = REDACT ? `demande masquée (${txt.length} caractères)` : txt.slice(0, 600);
      data.promptAt = ts;
    }
  } catch {
    /* noop */
  }
  trCache.set(file, { sig, data });
  if (trCache.size > 200) trCache.clear();
  return data;
}

export type TaskRow = {
  task_id: string;
  runtime: string;
  task_kind: string | null;
  owner_key: string;
  agent_id: string | null;
  requester_agent_id: string | null;
  parent_task_id: string | null;
  parent_flow_id: string | null;
  child_session_key: string | null;
  requester_session_key: string | null;
  label: string | null;
  task: string;
  status: string;
  delivery_status: string;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  last_event_at: number | null;
  error: string | null;
  progress_summary: string | null;
  terminal_summary: string | null;
  terminal_outcome: string | null;
};

export type SubagentRow = {
  run_id: string;
  child_session_key: string;
  requester_session_key: string;
  task: string;
  task_name: string | null;
  label: string | null;
  model: string | null;
  workspace_dir: string | null;
  spawn_mode: string | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  ended_reason: string | null;
  pause_reason: string | null;
};

export type FlowRow = {
  flow_id: string;
  shape: string | null;
  owner_key: string;
  status: string;
  goal: string;
  current_step: string | null;
  blocked_summary: string | null;
  created_at: number;
  updated_at: number;
  ended_at: number | null;
};

export type CronRow = {
  job_id: string;
  name: string;
  display_name: string | null;
  description: string | null;
  enabled: number;
  agent_id: string | null;
  session_key: string | null;
  schedule_kind: string;
  schedule_expr: string | null;
  every_ms: number | null;
  next_run_at_ms: number | null;
  running_at_ms: number | null;
  last_run_at_ms: number | null;
  last_run_status: string | null;
  last_error: string | null;
  last_duration_ms: number | null;
};

export type DbSnapshot = {
  tasks: TaskRow[];
  subagents: SubagentRow[];
  flows: FlowRow[];
  crons: CronRow[];
  error: string | null;
};

const EMPTY: DbSnapshot = { tasks: [], subagents: [], flows: [], crons: [], error: null };

export function readDb(windowMs = 36 * 3600 * 1000): DbSnapshot {
  if (!fs.existsSync(DB_PATH)) return { ...EMPTY, error: 'base openclaw.sqlite introuvable' };
  const since = Date.now() - windowMs;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(DB_PATH, { readOnly: true });
    const tasks = db
      .prepare(
        `select task_id, runtime, task_kind, owner_key, agent_id, requester_agent_id, parent_task_id,
                parent_flow_id, child_session_key, requester_session_key, label, task, status, delivery_status,
                created_at, started_at, ended_at, last_event_at, error, progress_summary, terminal_summary, terminal_outcome
         from task_runs
         where created_at >= ? or ended_at is null
         order by created_at desc limit 500`,
      )
      .all(since) as unknown as TaskRow[];
    const subagents = db
      .prepare(
        `select run_id, child_session_key, requester_session_key, task, task_name, label, model, workspace_dir,
                spawn_mode, created_at, started_at, ended_at, ended_reason, pause_reason
         from subagent_runs
         where created_at >= ? or ended_at is null
         order by created_at desc limit 300`,
      )
      .all(since) as unknown as SubagentRow[];
    const flows = db
      .prepare(
        `select flow_id, shape, owner_key, status, goal, current_step, blocked_summary, created_at, updated_at, ended_at
         from flow_runs where created_at >= ? or ended_at is null order by created_at desc limit 100`,
      )
      .all(since) as unknown as FlowRow[];
    const crons = db
      .prepare(
        `select job_id, name, display_name, description, enabled, agent_id, session_key, schedule_kind,
                schedule_expr, every_ms, next_run_at_ms, running_at_ms, last_run_at_ms, last_run_status,
                last_error, last_duration_ms
         from cron_jobs order by next_run_at_ms asc limit 100`,
      )
      .all() as unknown as CronRow[];
    return { tasks, subagents, flows, crons, error: null };
  } catch (e: any) {
    return { ...EMPTY, error: String(e?.message ?? e) };
  } finally {
    try {
      db?.close();
    } catch {
      /* noop */
    }
  }
}
