import fs from 'node:fs';
import os from 'node:os';
import { childIndex, descendants, getHostCpuPct, readMemInfo, scanProcs, type RawProc } from './procs';
import {
  REDACT,
  readAgents,
  readDb,
  readSessions,
  readTranscript,
  type CronRow,
  type SessionMeta,
  type SubagentRow,
  type TaskRow,
} from './store';
import type { AgentNode, Msg, ProcInfo, Res, SessionNode, Snapshot, TaskNode, UnitState } from './types';
import { ZERO_RES } from './types';

function res(pids: number[], procs: Map<number, RawProc>): Res {
  let cpu = 0;
  let rss = 0;
  let n = 0;
  for (const pid of pids) {
    const p = procs.get(pid);
    if (!p) continue;
    cpu += p.cpuPct;
    rss += p.rssMb;
    n++;
  }
  return { cpuPct: Math.round(cpu * 10) / 10, rssMb: Math.round(rss), procs: n };
}

function addRes(a: Res, b: Res): Res {
  return {
    cpuPct: Math.round((a.cpuPct + b.cpuPct) * 10) / 10,
    rssMb: a.rssMb + b.rssMb,
    procs: a.procs + b.procs,
  };
}

const NOISE = [
  /^\[System\][^.]*\.\s*/i,
  /^\s*<@[^>]+>\s*/,
  /^\s*\([A-Z][\p{L}]+\)\s*/u, // « (Neo) », « (Ada) »… ajouté par le pont Slack
];

export function shortTitle(text: string | null | undefined, max = 78): string {
  if (!text) return '—';
  let t = String(text).replace(/\s+/g, ' ').trim();
  // liens Slack <url|libellé> → libellé
  t = t.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2').replace(/<(https?:\/\/[^>]+)>/g, '$1');
  for (const re of NOISE) t = t.replace(re, '');
  t = t.replace(/<@[A-Z0-9]+>/g, '').replace(/^[\s:•\-–]+/, '').trim();
  const stop = t.search(/[.!?\n]\s/);
  if (stop > 24 && stop < max) t = t.slice(0, stop + 1);
  if (t.length > max) t = t.slice(0, max - 1).trimEnd() + '…';
  return t || '—';
}

/** « slack:t0b7…#monitoring » → « #monitoring » */
function prettyName(name: string | null | undefined): string | null {
  if (!name) return null;
  const m = name.match(/^[a-z]+:[a-z0-9]+(#.+)$/i);
  if (m) return m[1];
  return name;
}

/** agentId / kind / cible depuis une clé de session OpenClaw */
function parseKey(key: string) {
  const p = key.split(':');
  const agentId = p[0] === 'agent' ? p[1] : null;
  const surface = p[2] ?? null;
  let kind: SessionNode['kind'] = 'main';
  if (surface === 'subagent') kind = 'subagent';
  else if (surface === 'cron') kind = 'cron';
  return { agentId, surface, kind };
}

// ---------------------------------------------------------------- process → session

type RuntimeProc = { pid: number; agentId: string | null; sessionKey: string | null; model: string | null };

const promptCache = new Map<string, { agentId: string | null; sessionKey: string | null; model: string | null }>();

function resolveFromPrompt(cmd: string) {
  const m = cmd.match(/--append-system-prompt-file\s+(\S+)/);
  if (!m) return null;
  const file = m[1];
  const hit = promptCache.get(file);
  if (hit) return hit;
  let parsed = { agentId: null as string | null, sessionKey: null as string | null, model: null as string | null };
  try {
    const fd = fs.openSync(file, 'r');
    try {
      // la ligne "Runtime:" est en fin de prompt — on lit la queue du fichier
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 16384);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, Math.max(0, size - len));
      const tail = buf.toString('utf8');
      const line = tail.match(/Runtime:\s*agent=([^\s|]+)\s*\|\s*session=([^\s|]+)[^\n]*/);
      if (line) {
        parsed.agentId = line[1];
        parsed.sessionKey = line[2];
        const mm = tail.match(/Runtime:[^\n]*?\bmodel=([^\s|]+)/);
        if (mm) parsed.model = mm[1];
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* fichier temporaire déjà nettoyé */
  }
  promptCache.set(file, parsed);
  if (promptCache.size > 400) promptCache.clear();
  return parsed;
}

function cwdOf(pid: number): string | null {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- tâches

function taskState(t: TaskRow): UnitState {
  const s = (t.status || '').toLowerCase();
  if (s === 'running' || s === 'active' || s === 'in_progress') return 'running';
  if (s === 'succeeded' || s === 'success' || s === 'done' || s === 'completed') return 'done';
  if (s === 'cancelled' || s === 'canceled' || s === 'aborted') return 'killed';
  if (s === 'paused' || s === 'waiting' || s === 'blocked') return 'paused';
  if (s === 'failed' || s === 'error') {
    const e = `${t.error ?? ''} ${t.terminal_outcome ?? ''}`.toLowerCase();
    if (/kill|oom|timeout|sigterm|sigkill|interrupt/.test(e)) return 'killed';
    return 'failed';
  }
  if (!t.ended_at) return 'running';
  return 'unknown';
}

function taskTitle(t: TaskRow): string {
  if (t.label) return shortTitle(t.label, 60);
  if (t.task_kind) return `${t.task_kind.replace(/_/g, ' ')} — ${shortTitle(t.task, 46)}`;
  return shortTitle(t.task);
}

function toTaskNode(t: TaskRow, r: Res): TaskNode {
  const st = taskState(t);
  return {
    id: t.task_id,
    kind: 'task',
    title: taskTitle(t),
    detail: shortTitle(t.task, 220),
    state: st,
    runtime: t.runtime,
    createdAt: t.created_at ?? null,
    startedAt: t.started_at ?? null,
    endedAt: t.ended_at ?? null,
    durationMs: t.started_at ? (t.ended_at ?? Date.now()) - t.started_at : null,
    summary: t.progress_summary || t.terminal_summary || null,
    error: t.error || null,
    res: st === 'running' ? r : ZERO_RES,
    children: [],
  };
}

/** Tour en cours : synthétisé depuis le process vivant + le dernier prompt du transcript. */
function liveTurnNode(
  key: string,
  prompt: string | null,
  pids: number[],
  r: Res,
  procs: Map<number, RawProc>,
): TaskNode {
  const startedAt = pids.reduce((min, pid) => {
    const p = procs.get(pid);
    return p && (min === null || p.startedAt < min) ? p.startedAt : min;
  }, null as number | null);
  return {
    id: `turn:${key}`,
    kind: 'task',
    title: prompt ? shortTitle(prompt, 74) : { k: 'task.liveTurn' },
    detail: prompt ? prompt.slice(0, 600) : { k: 'task.liveTurnDetail' },
    state: 'running',
    runtime: { k: 'runtime.agentTurn' },
    createdAt: startedAt,
    startedAt,
    endedAt: null,
    durationMs: startedAt ? Date.now() - startedAt : null,
    summary: { k: 'task.activeProcs', p: { n: pids.length } },
    error: null,
    res: r,
    children: [],
  };
}

function cronNode(c: CronRow): TaskNode {
  const st: UnitState = c.running_at_ms
    ? 'running'
    : !c.enabled
      ? 'paused'
      : c.last_run_status === 'error' || c.last_run_status === 'failed'
        ? 'failed'
        : 'scheduled';
  const desc = c.description || c.name;
  const detail: Msg = c.every_ms
    ? { k: 'cron.detailEvery', p: { desc, min: Math.round(c.every_ms / 60000) } }
    : { k: 'cron.detailExpr', p: { desc, expr: c.schedule_expr || c.schedule_kind } };
  return {
    id: `cron:${c.job_id}`,
    kind: 'cron',
    title: shortTitle(c.display_name || c.name, 60),
    detail,
    state: st,
    runtime: 'cron',
    createdAt: c.last_run_at_ms ?? null,
    startedAt: c.running_at_ms ?? c.last_run_at_ms ?? null,
    endedAt: null,
    durationMs: c.last_duration_ms ?? null,
    summary: c.next_run_at_ms ? { k: 'cron.next', ts: c.next_run_at_ms } : null,
    error: c.last_error || null,
    res: ZERO_RES,
    children: [],
  };
}

// ---------------------------------------------------------------- collecte

/**
 * Mode démo (MONITOR_REDACT=1) : remplace tout contenu métier — énoncés de tâches,
 * noms de canaux, lignes de commande — par des libellés neutres. La structure de l'arbre
 * et les mesures CPU/RAM restent intactes. À utiliser pour toute capture publique.
 */
function redactSnapshot(snap: Snapshot): Snapshot {
  let sIdx = 0;
  let tIdx = 0;
  const scrubSessions = (nodes: SessionNode[]) => {
    for (const s of nodes) {
      sIdx++;
      s.title = { k: s.kind === 'subagent' ? 'redact.subagent' : 'redact.session', p: { n: sIdx } };
      s.subtitle = s.channel ? { k: 'redact.channel', p: { ch: s.channel } } : { k: 'redact.hidden' };
      s.key = `${s.key.split(':').slice(0, 3).join(':')}:…`;
      s.sessionId = null;
      s.prompt = null;
      for (const t of s.tasks) {
        tIdx++;
        t.title = { k: 'redact.task', p: { n: tIdx } };
        t.detail = { k: 'redact.content' };
        t.summary = t.summary ? { k: 'redact.hidden' } : null;
        t.error = t.error ? { k: 'redact.hidden' } : null;
      }
      scrubSessions(s.children);
    }
  };
  for (const a of snap.agents) {
    a.workspace = a.workspace ? `…/${a.workspace.split('/').pop()}` : null;
    scrubSessions(a.sessions);
  }
  for (const p of snap.procs) p.cmd = p.cmd.split(' ')[0].split('/').pop() ?? '';
  snap.host.hostname = { k: 'redact.hidden' };
  return snap;
}

export function collect(opts: { window?: number } = {}): Snapshot {
  const t0 = Date.now();
  const procs = scanProcs();
  const kids = childIndex(procs);
  const db = readDb(opts.window ?? 72 * 3600 * 1000);
  const agentsCfg = readAgents();
  const warnings: Msg[] = [];
  if (db.error) warnings.push({ k: 'warn.sqlite', p: { err: db.error } });

  // --- gateway + navigateur
  let gatewayPid: number | null = null;
  let gatewayPort: number | null = null;
  let browserRoot: number | null = null;
  for (const p of procs.values()) {
    if (!gatewayPid && /openclaw\/dist\/index\.js\s+gateway/.test(p.cmd)) {
      gatewayPid = p.pid;
      const m = p.cmd.match(/--port\s+(\d+)/);
      gatewayPort = m ? Number(m[1]) : null;
    }
    if (!browserRoot && /chrome\s+--remote-debugging-port/.test(p.cmd)) browserRoot = p.pid;
  }

  // --- process de runtime agent (claude / codex / gemini CLI)
  const runtimeProcs: RuntimeProc[] = [];
  for (const p of procs.values()) {
    const isRuntime =
      /openclaw-cli-system-prompt/.test(p.cmd) ||
      (gatewayPid !== null && p.ppid === gatewayPid && /\/(claude|codex|gemini)\b/.test(p.cmd));
    if (!isRuntime) continue;
    const parsed = resolveFromPrompt(p.cmd);
    let agentId = parsed?.agentId ?? null;
    if (!agentId) {
      const cwd = cwdOf(p.pid);
      if (cwd) agentId = agentsCfg.find((a) => a.workspace && cwd.startsWith(a.workspace))?.id ?? null;
    }
    const model = parsed?.model ?? (p.cmd.match(/--model\s+(\S+)/)?.[1] ?? null);
    runtimeProcs.push({ pid: p.pid, agentId, sessionKey: parsed?.sessionKey ?? null, model });
  }

  const runtimeRoots = new Set(runtimeProcs.map((r) => r.pid));
  const sessionPids = new Map<string, number[]>(); // sessionKey -> pids
  const agentLoosePids = new Map<string, number[]>(); // agentId -> pids sans session identifiée
  const claimed = new Set<number>();

  for (const rp of runtimeProcs) {
    const tree = descendants(rp.pid, kids, new Set([...runtimeRoots].filter((x) => x !== rp.pid)));
    for (const pid of tree) claimed.add(pid);
    if (rp.sessionKey) {
      const arr = sessionPids.get(rp.sessionKey) ?? [];
      arr.push(...tree);
      sessionPids.set(rp.sessionKey, arr);
    } else if (rp.agentId) {
      const arr = agentLoosePids.get(rp.agentId) ?? [];
      arr.push(...tree);
      agentLoosePids.set(rp.agentId, arr);
    }
  }

  // --- navigateur
  const browserPids = browserRoot ? descendants(browserRoot, kids) : [];
  for (const pid of browserPids) claimed.add(pid);

  // --- gateway (hors sous-arbres déjà attribués)
  let gatewayRes: Res = ZERO_RES;
  let gatewayUptime: number | null = null;
  if (gatewayPid !== null) {
    const tree = descendants(gatewayPid, kids, new Set([...runtimeRoots, ...(browserRoot ? [browserRoot] : [])]));
    const own = tree.filter((pid) => !claimed.has(pid));
    for (const pid of own) claimed.add(pid);
    gatewayRes = res(own, procs);
    const gp = procs.get(gatewayPid);
    gatewayUptime = gp ? Math.round((Date.now() - gp.startedAt) / 1000) : null;
  }

  // --- index des données
  const subsByRequester = new Map<string, SubagentRow[]>();
  const subByChild = new Map<string, SubagentRow>();
  for (const s of db.subagents) {
    const arr = subsByRequester.get(s.requester_session_key) ?? [];
    arr.push(s);
    subsByRequester.set(s.requester_session_key, arr);
    subByChild.set(s.child_session_key, s);
  }

  const tasksBySession = new Map<string, TaskRow[]>();
  const tasksByAgent = new Map<string, TaskRow[]>();
  for (const t of db.tasks) {
    const key = t.child_session_key || t.owner_key || t.requester_session_key;
    if (key) {
      const arr = tasksBySession.get(key) ?? [];
      arr.push(t);
      tasksBySession.set(key, arr);
    }
    const aid = t.agent_id || t.requester_agent_id || (key ? parseKey(key).agentId : null);
    if (aid) {
      const arr = tasksByAgent.get(aid) ?? [];
      arr.push(t);
      tasksByAgent.set(aid, arr);
    }
  }

  const cronById = new Map<string, CronRow>();
  for (const c of db.crons) cronById.set(c.job_id, c);
  /** « agent:neo:cron:<jobId>… » → nom lisible du job */
  const cronNameFor = (key: string): string | null => {
    const p = key.split(':');
    if (p[2] !== 'cron') return null;
    const job = cronById.get(p[3] ?? '');
    return job ? `Cron · ${job.display_name || job.name}` : 'Session cron';
  };

  const cronsByAgent = new Map<string, CronRow[]>();
  for (const c of db.crons) {
    const aid = c.agent_id || (c.session_key ? parseKey(c.session_key).agentId : null) || 'main';
    const arr = cronsByAgent.get(aid) ?? [];
    arr.push(c);
    cronsByAgent.set(aid, arr);
  }

  const now = Date.now();
  const RECENT = 24 * 3600 * 1000;

  // --- construction des agents
  const agents: AgentNode[] = [];
  for (const cfg of agentsCfg) {
    const metas = readSessions(cfg.id);
    const built: SessionNode[] = [];
    const subagentKeys = new Set<string>();

    const buildSubagents = (parentKey: string): SessionNode[] => {
      const rows = subsByRequester.get(parentKey) ?? [];
      return rows
        .filter((s) => !s.ended_at || now - (s.ended_at ?? 0) < RECENT)
        .map((s) => {
          subagentKeys.add(s.child_session_key);
          const pids = sessionPids.get(s.child_session_key) ?? [];
          const live = pids.length > 0;
          let st: UnitState;
          if (live) st = 'running';
          else if (s.pause_reason) st = 'paused';
          else if (!s.ended_at) st = now - s.created_at < 12 * 3600 * 1000 ? 'running' : 'unknown';
          else if (/kill|timeout|abort|cancel/i.test(s.ended_reason ?? '')) st = 'killed';
          else if (/error|fail/i.test(s.ended_reason ?? '')) st = 'failed';
          else st = 'done';
          const r = res(pids, procs);
          const tasks = (tasksBySession.get(s.child_session_key) ?? []).map((t) => toTaskNode(t, r));
          if (live && !tasks.some((t) => t.state === 'running')) {
            tasks.unshift(liveTurnNode(s.child_session_key, s.task, pids, r, procs));
          }
          return {
            key: s.child_session_key,
            sessionId: null,
            kind: 'subagent' as const,
            title: shortTitle(s.label || s.task_name || s.task, 62),
            subtitle: {
              k: 'session.subagent',
              p: {
                extra: `${s.spawn_mode ? ` · ${s.spawn_mode}` : ''}${s.model ? ` · ${s.model.split('/').pop()}` : ''}`,
              },
            },
            channel: 'subagent',
            state: st,
            startedAt: s.started_at ?? s.created_at,
            lastActivityAt: s.ended_at ?? s.started_at ?? s.created_at,
            model: s.model,
            prompt: s.task,
            turns: 0,
            res: r,
            pids,
            tasks,
            children: buildSubagents(s.child_session_key),
          } satisfies SessionNode;
        });
    };

    // sessions principales : celles vues récemment, vivantes, ou porteuses de tâches
    const candidates = new Set<string>();
    for (const [key, m] of metas) {
      const last = m.lastInteractionAt ?? m.updatedAt ?? 0;
      if (now - last < RECENT) candidates.add(key);
    }
    for (const key of sessionPids.keys()) if (parseKey(key).agentId === cfg.id) candidates.add(key);
    for (const key of tasksBySession.keys()) if (parseKey(key).agentId === cfg.id) candidates.add(key);
    for (const s of db.subagents) if (parseKey(s.requester_session_key).agentId === cfg.id) candidates.add(s.requester_session_key);

    for (const key of candidates) {
      if (parseKey(key).agentId !== cfg.id) continue;
      if (subByChild.has(key)) continue; // rattaché à son parent
      const meta: SessionMeta | undefined = metas.get(key);
      const { kind, surface } = parseKey(key);
      const pids = sessionPids.get(key) ?? [];
      const live = pids.length > 0;
      const r = res(pids, procs);
      const tr = readTranscript(meta?.sessionFile ?? null);
      const tasks = (tasksBySession.get(key) ?? []).map((t) => toTaskNode(t, r));
      if (live && !tasks.some((t) => t.state === 'running')) {
        tasks.unshift(liveTurnNode(key, tr.prompt, pids, r, procs));
      }
      const children = buildSubagents(key);
      const lastActivity =
        tr.lastMessageAt ??
        meta?.lastInteractionAt ??
        meta?.updatedAt ??
        tasks.reduce((a, t) => Math.max(a, t.endedAt ?? t.startedAt ?? t.createdAt ?? 0), 0) ??
        null;
      const hasRunning = live || tasks.some((t) => t.state === 'running') || children.some((c) => c.state === 'running');
      const st: UnitState = hasRunning ? 'running' : 'idle';
      const label = meta?.groupChannel || meta?.channel || surface || '';
      const named = prettyName(meta?.displayName) || cronNameFor(key) || tr.prompt;
      // à défaut de nom propre, on reprend le titre de la première tâche (déjà tronqué)
      const title: Msg = named ? shortTitle(named, 70) : (tasks[0]?.title ?? shortTitle(key, 70));
      built.push({
        key,
        sessionId: meta?.sessionId ?? null,
        kind: kind === 'cron' ? 'cron' : 'main',
        title,
        subtitle: [label, meta?.chatType].filter(Boolean).join(' · ') || { k: 'session.generic' },
        channel: meta?.channel ?? surface,
        state: st,
        startedAt: meta?.startedAt ?? null,
        lastActivityAt: lastActivity || null,
        model: null,
        prompt: tr.prompt,
        turns: tr.userTurns,
        res: r,
        pids,
        tasks,
        children,
      });
    }

    // tâches de l'agent sans session rattachée (cron sans clé, etc.)
    const orphanTasks = (tasksByAgent.get(cfg.id) ?? []).filter(
      (t) => !(t.child_session_key || t.owner_key || t.requester_session_key),
    );
    const crons = cronsByAgent.get(cfg.id) ?? [];
    if (orphanTasks.length || crons.length) {
      const tasks = [...orphanTasks.map((t) => toTaskNode(t, ZERO_RES)), ...crons.map(cronNode)];
      const running = tasks.some((t) => t.state === 'running');
      built.push({
        key: `agent:${cfg.id}:__scheduler`,
        sessionId: null,
        kind: 'cron',
        title: { k: 'session.scheduler' },
        subtitle: { k: 'session.cronJobs', p: { n: crons.length } },
        channel: 'cron',
        state: running ? 'running' : 'scheduled',
        startedAt: null,
        lastActivityAt: tasks.reduce((a, t) => Math.max(a, t.startedAt ?? 0), 0) || null,
        model: null,
        prompt: null,
        turns: 0,
        res: ZERO_RES,
        pids: [],
        tasks,
        children: [],
      });
    }

    built.sort((a, b) => {
      if (a.state === 'running' && b.state !== 'running') return -1;
      if (b.state === 'running' && a.state !== 'running') return 1;
      return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0);
    });

    const walk = (nodes: SessionNode[], fn: (n: SessionNode) => void) => {
      for (const n of nodes) {
        fn(n);
        walk(n.children, fn);
      }
    };
    let agentRes = res(agentLoosePids.get(cfg.id) ?? [], procs);
    let live = 0;
    let subs = 0;
    let runningTasks = 0;
    let tasks24h = 0;
    let failed24h = 0;
    let lastAct = 0;
    walk(built, (n) => {
      agentRes = addRes(agentRes, n.res);
      if (n.state === 'running') live++;
      if (n.kind === 'subagent') subs++;
      lastAct = Math.max(lastAct, n.lastActivityAt ?? 0);
      for (const t of n.tasks) {
        if (t.state === 'running') runningTasks++;
        if ((t.createdAt ?? 0) > now - RECENT) tasks24h++;
        if ((t.state === 'failed' || t.state === 'killed') && (t.createdAt ?? 0) > now - RECENT) failed24h++;
      }
    });

    const st: UnitState = agentRes.procs > 0 || live > 0 ? 'running' : 'idle';
    agents.push({
      id: cfg.id,
      name: cfg.name,
      workspace: cfg.workspace,
      model: cfg.model,
      state: st,
      res: agentRes,
      lastActivityAt: lastAct || null,
      stats: {
        liveSessions: live,
        sessions: built.length,
        subagents: subs,
        runningTasks,
        tasks24h,
        failed24h,
      },
      sessions: built,
    });
  }

  agents.sort((a, b) => {
    if (a.state === 'running' && b.state !== 'running') return -1;
    if (b.state === 'running' && a.state !== 'running') return 1;
    return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0);
  });

  // --- process bruts (onglet système)
  const procList: ProcInfo[] = [];
  for (const p of procs.values()) {
    if (p.cpuPct < 0.5 && p.rssMb < 60) continue;
    let kind: ProcInfo['kind'] = 'other';
    let label: Msg = p.comm;
    if (p.pid === gatewayPid) {
      kind = 'gateway';
      label = { k: 'proc.gateway' };
    } else if (runtimeRoots.has(p.pid)) {
      kind = 'agent-cli';
      const rp = runtimeProcs.find((r) => r.pid === p.pid);
      label = { k: 'proc.runtime', p: { id: rp?.agentId ?? '?' } };
    } else if (/mcp/i.test(p.cmd)) {
      kind = 'mcp';
      label = { k: 'proc.mcp' };
    } else if (/chrome/.test(p.comm)) {
      kind = 'browser';
      label = { k: 'proc.browser' };
    } else if (claimed.has(p.pid)) {
      kind = 'child';
    }
    procList.push({
      pid: p.pid,
      ppid: p.ppid,
      comm: p.comm,
      cmd: p.cmd.slice(0, 160),
      cpuPct: p.cpuPct,
      rssMb: p.rssMb,
      startedAt: p.startedAt,
      kind,
      label,
    });
  }
  procList.sort((a, b) => b.cpuPct - a.cpuPct || b.rssMb - a.rssMb);

  const otherPids = [...procs.keys()].filter((pid) => !claimed.has(pid));
  const mem = readMemInfo();
  const load = os.loadavg() as [number, number, number];

  let liveSessions = 0;
  let runningTasks = 0;
  let subagentsLive = 0;
  for (const a of agents) {
    liveSessions += a.stats.liveSessions;
    runningTasks += a.stats.runningTasks;
    const walk = (ns: SessionNode[]) => {
      for (const n of ns) {
        if (n.kind === 'subagent' && n.state === 'running') subagentsLive++;
        walk(n.children);
      }
    };
    walk(a.sessions);
  }

  const snapshot: Snapshot = {
    ts: now,
    collectMs: Date.now() - t0,
    host: {
      hostname: os.hostname(),
      cores: os.cpus().length,
      cpuPct: getHostCpuPct(),
      load,
      uptimeSec: Math.round(os.uptime()),
      ...mem,
    },
    gateway: {
      pid: gatewayPid,
      up: gatewayPid !== null,
      uptimeSec: gatewayUptime,
      res: gatewayRes,
      port: gatewayPort,
      version: null,
    },
    agents,
    system: {
      browser: res(browserPids, procs),
      other: res(otherPids, procs),
    },
    totals: {
      agents: agents.length,
      activeAgents: agents.filter((a) => a.state === 'running').length,
      liveSessions,
      runningTasks,
      subagentsLive,
    },
    procs: procList.slice(0, 60),
    warnings,
  };

  return REDACT ? redactSnapshot(snapshot) : snapshot;
}
