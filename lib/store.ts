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
  transcript: TranscriptRef | null;
};

/** Base par agent (OpenClaw >= 2026.9.2) : sessions et transcripts migrés du disque vers SQLite. */
function agentDbPath(agentId: string): string {
  return path.join(OC_HOME, 'agents', agentId, 'agent', 'openclaw-agent.sqlite');
}

/** Où lire le transcript d'une session : base par agent (nouveau) ou fichier `.jsonl` (ancien). */
export type TranscriptRef =
  | { kind: 'sqlite'; db: string; sessionId: string }
  | { kind: 'file'; file: string };

const sessCache = new Map<string, { sig: string; data: Map<string, SessionMeta> }>();

/** `entry_json` de `session_nodes` a la même forme que les anciennes valeurs de `sessions.json`. */
function toSessionMeta(key: string, entry: any, transcript: TranscriptRef | null, sessionId?: string | null): SessionMeta {
  return {
    key,
    sessionId: entry?.sessionId ?? sessionId ?? null,
    displayName: entry?.displayName ?? null,
    // le canal a migré sous `delivery`; les deux anciens emplacements restent en repli
    channel:
      entry?.delivery?.route?.channel ??
      entry?.delivery?.origin?.provider ??
      entry?.channel ??
      entry?.lastChannel ??
      null,
    chatType: entry?.chatType ?? null,
    groupChannel: entry?.groupChannel ?? entry?.origin?.label ?? entry?.delivery?.origin?.label ?? null,
    updatedAt: entry?.updatedAt ?? null,
    startedAt: entry?.sessionStartedAt ?? null,
    lastInteractionAt: entry?.lastInteractionAt ?? entry?.updatedAt ?? null,
    transcript,
  };
}

export function readSessions(agentId: string): Map<string, SessionMeta> {
  const dbFile = agentDbPath(agentId);
  if (fs.existsSync(dbFile)) return readSessionsDb(agentId, dbFile);
  return readSessionsJson(agentId);
}

/** Sessions lues dans `session_nodes`. Cache indexé sur (max `updated_at`, nombre de lignes). */
function readSessionsDb(agentId: string, dbFile: string): Map<string, SessionMeta> {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
    const head = db.prepare('select max(updated_at) as mx, count(*) as n from session_nodes').get() as any;
    const sig = `db:${head?.mx ?? 0}:${head?.n ?? 0}`;
    const hit = sessCache.get(agentId);
    if (hit && hit.sig === sig) return hit.data;

    const data = new Map<string, SessionMeta>();
    const rows = db
      .prepare('select session_key, current_session_id, entry_json from session_nodes')
      .all() as unknown as { session_key: string; current_session_id: string; entry_json: string }[];
    for (const r of rows) {
      let entry: any;
      try {
        entry = JSON.parse(r.entry_json);
      } catch {
        continue;
      }
      const sessionId = entry?.sessionId ?? r.current_session_id ?? null;
      const transcript: TranscriptRef | null = sessionId ? { kind: 'sqlite', db: dbFile, sessionId } : null;
      data.set(r.session_key, toSessionMeta(r.session_key, entry, transcript, sessionId));
    }
    sessCache.set(agentId, { sig, data });
    return data;
  } catch {
    return new Map();
  } finally {
    try {
      db?.close();
    } catch {
      /* noop */
    }
  }
}

/** Ancien emplacement (OpenClaw < 2026.9.2), conservé tant que la base par agent est absente. */
function readSessionsJson(agentId: string): Map<string, SessionMeta> {
  const file = path.join(OC_HOME, 'agents', agentId, 'sessions', 'sessions.json');
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return new Map();
  }
  const sig = `json:${mtime}`;
  const hit = sessCache.get(agentId);
  if (hit && hit.sig === sig) return hit.data;

  const data = new Map<string, SessionMeta>();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [key, v] of Object.entries<any>(raw)) {
      const transcript: TranscriptRef | null = v?.sessionFile ? { kind: 'file', file: v.sessionFile } : null;
      data.set(key, toSessionMeta(key, v, transcript));
    }
  } catch {
    /* noop */
  }
  sessCache.set(agentId, { sig, data });
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
/** Fenêtre de lecture, équivalente aux derniers 512 Ko lus dans l'ancien `.jsonl`. */
const MAX_EVENTS = 200;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (typeof b === 'string' ? b : b?.type === 'text' ? String(b.text ?? '') : ''))
      .join(' ');
  }
  return '';
}

/** Accumule un évènement de transcript, du plus récent au plus ancien. */
function applyEvent(data: Transcript, o: any): void {
  if (o?.type !== 'message' || !o?.message) return;
  const ts = o.timestamp ? Date.parse(o.timestamp) : null;
  if (data.lastMessageAt === null && ts) data.lastMessageAt = ts;
  if (o.message.role !== 'user') return;
  data.userTurns++;
  if (data.prompt) return;
  const txt = textOf(o.message.content)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!txt || txt.length < 3) return;
  // placeholder interne : en mode démo, `redactSnapshot` remet ce champ à null de toute façon
  data.prompt = REDACT ? `redacted prompt (${txt.length} chars)` : txt.slice(0, 600);
  data.promptAt = ts;
}

/** Dernier prompt utilisateur d'une session, lu dans la queue du transcript (aucun appel modèle). */
export function readTranscript(ref: TranscriptRef | null): Transcript {
  if (!ref) return EMPTY_TRANSCRIPT;
  return ref.kind === 'sqlite' ? readTranscriptDb(ref.db, ref.sessionId) : readTranscriptFile(ref.file);
}

/**
 * Transcript lu dans `transcript_events`, restreint à la branche active de la session
 * (`session_transcript_active_events`). Cache indexé sur le max de `seq`.
 */
function readTranscriptDb(dbFile: string, sessionId: string): Transcript {
  const cacheKey = `${dbFile}#${sessionId}`;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
    const head = db.prepare('select max(seq) as mx from transcript_events where session_id = ?').get(sessionId) as any;
    if (head?.mx == null) return EMPTY_TRANSCRIPT;
    const sig = `db:${head.mx}`;
    const hit = trCache.get(cacheKey);
    if (hit && hit.sig === sig) return hit.data;

    let rows = db
      .prepare(
        `select e.event_json as event_json
         from session_transcript_active_events a
         join transcript_events e on e.session_id = a.session_id and e.seq = a.event_seq
         where a.session_id = ?
         order by a.active_position desc limit ?`,
      )
      .all(sessionId, MAX_EVENTS) as unknown as { event_json: string }[];
    // sessions antérieures au suivi de branche : on retombe sur le transcript brut
    if (!rows.length) {
      rows = db
        .prepare('select event_json from transcript_events where session_id = ? order by seq desc limit ?')
        .all(sessionId, MAX_EVENTS) as unknown as { event_json: string }[];
    }

    const data: Transcript = { ...EMPTY_TRANSCRIPT };
    for (const r of rows) {
      let o: any;
      try {
        o = JSON.parse(r.event_json);
      } catch {
        continue;
      }
      applyEvent(data, o);
    }
    trCache.set(cacheKey, { sig, data });
    if (trCache.size > 200) trCache.clear();
    return data;
  } catch {
    return EMPTY_TRANSCRIPT;
  } finally {
    try {
      db?.close();
    } catch {
      /* noop */
    }
  }
}

/** Ancien emplacement (OpenClaw < 2026.9.2) : queue du fichier `.jsonl`. */
function readTranscriptFile(file: string): Transcript {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return EMPTY_TRANSCRIPT;
  }
  const sig = `file:${st.mtimeMs}:${st.size}`;
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
      applyEvent(data, o);
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
