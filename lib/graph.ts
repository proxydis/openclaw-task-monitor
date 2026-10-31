import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeProjectsDir } from './claude-cli';
import { splitJob, type Pass } from './lanes';
import { unitOfPid, type RawProc } from './procs';
import { OC_HOME, REDACT } from './store';
import { readSessionTokens, sumTokens } from './token-usage';
import type {
  AgentNode,
  GraphActivity,
  GraphData,
  GraphKind,
  GraphNode,
  GraphProc,
  Msg,
  Res,
  SessionNode,
  TaskNode,
  TokenUsage,
} from './types';
import { ZERO_RES } from './types';

/**
 * Données de la vue Graph : *qui a lancé qui*, pour tout ce qui tourne sur la machine.
 *
 * Aucune source nouvelle. Le graphe est assemblé à partir de ce que `collect()` a déjà
 * lu — arbre agents → sessions → sous-agents, tâches, process de `/proc` — plus deux
 * informations que l'arbre ne gardait pas : le niveau d'effort et le modèle portés par la
 * ligne de commande de chaque process d'exécution. Aucun appel réseau, aucun appel
 * modèle, aucun jeton dépensé.
 *
 * Invariant de couverture : chaque process OpenClaw vivant apparaît dans exactement un
 * nœud. Ceux que ni une session, ni un job, ni la gateway ne revendiquent tombent dans
 * un nœud de service (unité systemd `openclaw-*`) ou dans « autres process OpenClaw » —
 * jamais dans le vide. Le panneau de chaque nœud liste ses process sans seuil CPU/RAM,
 * contrairement à l'onglet Process qui ne garde que les plus gourmands.
 */

/** Process d'exécution agent (`claude`, `codex`, `gemini`) et ce qu'on en sait. */
export type GraphRuntime = {
  pid: number;
  agentId: string | null;
  sessionKey: string | null;
  model: string | null;
  effort: string | null;
  cliSessionId: string | null;
  startedAt: number | null;
  /** le process et tout son sous-arbre (serveurs MCP, serveurs de langage, shells) */
  pids: number[];
};

export type GraphCtx = {
  now: number;
  agents: AgentNode[];
  procs: Map<number, RawProc>;
  gateway: { pid: number | null; ownPids: number[]; res: Res; port: number | null; uptimeSec: number | null };
  browserPids: number[];
  runtimes: GraphRuntime[];
  looseByAgent: Map<string, number[]>;
};

/** Niveau d'effort du CLI (`--effort <niveau>`), `null` quand le drapeau est absent. */
export function effortOfCmd(cmd: string): string | null {
  return cmd.match(/--effort[\s=]+(\S+)/)?.[1] ?? null;
}

function modelOfCmd(cmd: string): string | null {
  return cmd.match(/--model[\s=]+(\S+)/)?.[1] ?? null;
}

// ---------------------------------------------------------------- niveau d'effort

type EffortSrc = NonNullable<GraphNode['effortSrc']>;
const EFFORT_FILE = path.join(
  process.env.MONITOR_STATE_DIR || path.join(os.homedir(), '.cache', 'openclaw-monitor'),
  'effort.json',
);
const EFFORT_MAX = 2000;
let lastEffort: Map<string, string> | null = null;
let effortDirty = false;

function loadLastEffort(): Map<string, string> {
  if (lastEffort) return lastEffort;
  lastEffort = new Map();
  try {
    for (const [k, v] of Object.entries<any>(JSON.parse(fs.readFileSync(EFFORT_FILE, 'utf8')))) {
      if (typeof v === 'string') lastEffort.set(k, v);
    }
  } catch {
    /* premier lancement */
  }
  return lastEffort;
}

function saveLastEffort(): void {
  if (!effortDirty || !lastEffort) return;
  effortDirty = false;
  try {
    while (lastEffort.size > EFFORT_MAX) lastEffort.delete(lastEffort.keys().next().value as string);
    fs.mkdirSync(path.dirname(EFFORT_FILE), { recursive: true });
    fs.writeFileSync(EFFORT_FILE, JSON.stringify(Object.fromEntries(lastEffort)));
  } catch {
    /* le repli est un confort, jamais une cause d'échec */
  }
}

/** Effort fixé dans la configuration (`agents.entries.<id>.models.<modèle>.params.thinking`). */
function configuredEffort(agentId: string, model: string | null): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(OC_HOME, 'openclaw.json'), 'utf8'));
    const a = raw?.agents?.entries?.[agentId] ?? (raw?.agents?.list ?? []).find((x: any) => x?.id === agentId);
    const t = (model && a?.models?.[model]?.params?.thinking) || a?.params?.thinking;
    return typeof t === 'string' && t ? t : null;
  } catch {
    return null;
  }
}

/**
 * Complète l'effort des nœuds qui n'en portent pas : un process `claude` vivant le dit
 * (`--effort`), mais une session au repos n'a plus de process, et un job `claude --print`
 * lancé sans drapeau tourne au défaut du CLI. Ordre : explicite, dernier connu, configuration,
 * parent (un sous-agent hérite de son lanceur), défaut du CLI.
 */
function resolveEfforts(nodes: GraphNode[]): void {
  const last = loadLastEffort();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const llm = (n: GraphNode) => n.kind === 'agent' || n.kind === 'session' || n.kind === 'subagent';
  for (const n of nodes) {
    if (n.effort && n.effortSrc !== 'default') {
      n.effortSrc = 'cli';
      if (last.get(n.id) !== n.effort) {
        last.delete(n.id);
        last.set(n.id, n.effort);
        effortDirty = true;
      }
    }
  }
  // du parent vers l'enfant : l'ordre d'insertion place toujours le lanceur avant le lancé
  for (const n of nodes) {
    if (n.effort) continue;
    const remembered = last.get(n.id);
    if (remembered && (llm(n) || n.kind === 'systemd' || n.kind === 'detached' || n.kind === 'cron')) {
      n.effort = remembered;
      n.effortSrc = 'last';
      continue;
    }
    if (n.kind === 'agent' || n.role === 'agent') {
      const agentId = n.id.startsWith('a:') ? n.id.slice(2) : null;
      const cfg = agentId ? configuredEffort(agentId, n.model) : null;
      if (cfg) {
        n.effort = cfg;
        n.effortSrc = 'config';
        continue;
      }
    }
    const parent = n.parent ? byId.get(n.parent) : undefined;
    if ((n.kind === 'session' || n.kind === 'subagent') && parent?.effort) {
      n.effort = parent.effort;
      n.effortSrc = parent.effortSrc === 'cli' ? 'last' : parent.effortSrc;
    }
  }
  saveLastEffort();
}

const CMD_MAX = 320;

/** Heure de lancement du plus ancien process d'une voie, quand elle n'a pas de passe en cours. */
function lanes0Start(pids: number[], procs: Map<number, RawProc>): number | null {
  let min: number | null = null;
  for (const pid of pids) {
    const p = procs.get(pid);
    if (p && (min === null || p.startedAt < min)) min = p.startedAt;
  }
  return min;
}

/** Début d'un fichier texte (prompt d'une passe) ; `null` si illisible. */
function readHead(file: string, max: number): string | null {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(max);
      const n = fs.readSync(fd, buf, 0, max, 0);
      const size = fs.fstatSync(fd).size;
      return buf.toString('utf8', 0, n) + (size > max ? `\n\n[… ${size - max} more bytes]` : '');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- jetons d'un job

/**
 * Un job détaché qui lance `claude --print` consomme des jetons sans que la base
 * OpenClaw en sache rien : son transcript n'est rattaché à aucune session. On le retrouve
 * par son répertoire de travail — le CLI range ses transcripts sous
 * `projects/<cwd avec tout caractère non alphanumérique remplacé par « - »>` — en prenant le
 * fichier touché depuis le lancement du process. C'est une inférence, pas une jointure :
 * deux `claude` lancés ensemble dans le même répertoire se confondraient. Le résultat est
 * donc toujours marqué `approx`.
 */
const jobSessionCache = new Map<number, string>();
const jobSessionTried = new Map<number, number>();
const JOB_LOOKUP_EVERY_MS = 5_000;

function claudeSessionOfProc(p: RawProc, now: number): string | null {
  const hit = jobSessionCache.get(p.pid);
  if (hit) return hit;
  if (now - (jobSessionTried.get(p.pid) ?? 0) < JOB_LOOKUP_EVERY_MS) return null;
  jobSessionTried.set(p.pid, now);
  let cwd: string;
  try {
    cwd = fs.readlinkSync(`/proc/${p.pid}/cwd`);
  } catch {
    return null;
  }
  const dir = path.join(claudeProjectsDir(), cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  let best: { id: string; fresh: boolean; mtime: number; born: number } | null = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const st = fs.statSync(path.join(dir, f));
      if (st.mtimeMs < p.startedAt - 5_000) continue;
      // un fichier né juste après le process est son transcript ; à défaut le plus récent
      const c = { id: f.slice(0, -'.jsonl'.length), fresh: st.birthtimeMs >= p.startedAt - 60_000, mtime: st.mtimeMs, born: st.birthtimeMs };
      if (!best || (c.fresh && !best.fresh) || (c.fresh === best.fresh && c.mtime > best.mtime)) best = c;
    }
  } catch {
    return null;
  }
  if (!best) return null;
  if (best.fresh) jobSessionCache.set(p.pid, best.id);
  return best.id;
}

function jobTokens(pids: number[], procs: Map<number, RawProc>, now: number): TokenUsage | null {
  const seen = new Set<string>();
  const parts: TokenUsage[] = [];
  for (const pid of pids) {
    const p = procs.get(pid);
    if (!p || !/(^|\/)claude(\s|$)/.test(p.cmd.split(' --')[0] ?? '')) continue;
    const id = claudeSessionOfProc(p, now);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const u = readSessionTokens(id);
    if (u) parts.push(u);
  }
  const total = sumTokens(parts);
  return total ? { ...total, approx: true } : null;
}

// ---------------------------------------------------------------- assemblage

const JOB_PSEUDO = /:__(jobs|scheduler)$/;

function turnUsageOf(s: SessionNode): TokenUsage | null {
  const turn = s.tasks.find((t) => t.usageScope === 'turn' && t.state === 'running');
  return turn?.usage ?? null;
}

function activityOfTask(t: TaskNode, type: GraphActivity['type']): GraphActivity {
  return { type, text: t.detail };
}

export function buildGraph(ctx: GraphCtx): GraphData {
  const { now, procs } = ctx;
  const nodes: GraphNode[] = [];
  /** process déjà rangés dans un nœud : un pid ne compte qu'une fois */
  const placed = new Set<number>();
  const ids = new Set<string>();

  const toProc = (pid: number): GraphProc | null => {
    const p = procs.get(pid);
    if (!p) return null;
    return {
      pid,
      ppid: p.ppid,
      comm: p.comm,
      cmd: REDACT ? (p.cmd.split(' ')[0].split('/').pop() ?? '') : p.cmd.slice(0, CMD_MAX),
      cpuPct: p.cpuPct,
      rssMb: p.rssMb,
      startedAt: p.startedAt,
    };
  };
  const procsOf = (pids: number[]): GraphProc[] => {
    const out: GraphProc[] = [];
    const seen = new Set<number>();
    for (const pid of pids) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      const p = toProc(pid);
      if (p) out.push(p);
    }
    for (const p of out) placed.add(p.pid);
    return out.sort((a, b) => a.pid - b.pid);
  };
  const resOf = (list: GraphProc[]): Res =>
    list.length
      ? {
          cpuPct: Math.round(list.reduce((a, p) => a + p.cpuPct, 0) * 10) / 10,
          rssMb: Math.round(list.reduce((a, p) => a + p.rssMb, 0) * 10) / 10,
          procs: list.length,
        }
      : ZERO_RES;

  const push = (n: Omit<GraphNode, 'noteIsError'> & { noteIsError?: boolean }) => {
    let id = n.id;
    for (let i = 2; ids.has(id); i++) id = `${n.id}#${i}`;
    ids.add(id);
    nodes.push({ noteIsError: false, ...n, id });
    return id;
  };
  const NONE: GraphActivity = { type: 'none', text: null };

  // runtime vivant par session : le plus récent l'emporte
  const runtimeByKey = new Map<string, GraphRuntime>();
  for (const r of ctx.runtimes) {
    if (!r.sessionKey) continue;
    const prev = runtimeByKey.get(r.sessionKey);
    if (!prev || (r.startedAt ?? 0) > (prev.startedAt ?? 0)) runtimeByKey.set(r.sessionKey, r);
  }

  // --- racine : la gateway
  const gwProcs = procsOf(ctx.gateway.ownPids);
  const gwUp = ctx.gateway.pid !== null;
  const gwProc = ctx.gateway.pid !== null ? procs.get(ctx.gateway.pid) : undefined;
  push({
    id: 'gw',
    parent: null,
    role: 'infra',
    kind: 'gateway',
    label: { k: 'graph.gateway' },
    sub: gwUp ? { k: 'graph.gatewaySub', p: { port: ctx.gateway.port ?? '—' } } : { k: 'graph.gatewayDown' },
    state: gwUp ? 'running' : 'failed',
    startedAt: gwProc?.startedAt ?? null,
    endedAt: null,
    model: null,
    effort: null,
    activity: gwProc ? { type: 'command', text: REDACT ? null : gwProc.cmd.slice(0, CMD_MAX) } : NONE,
    usage: null,
    turnUsage: null,
    res: ctx.gateway.res.procs ? ctx.gateway.res : resOf(gwProcs),
    procs: gwProcs,
    facts: ctx.gateway.port ? [{ k: 'graph.f.port', v: String(ctx.gateway.port) }] : [],
    note: gwUp ? null : { k: 'graph.gatewayDown' },
    noteIsError: !gwUp,
  });

  // --- navigateur de l'outil browser
  if (ctx.browserPids.length) {
    const list = procsOf(ctx.browserPids);
    const root = list.find((p) => !ctx.browserPids.includes(p.ppid)) ?? list[0];
    push({
      id: 'browser',
      parent: 'gw',
      role: 'infra',
      kind: 'browser',
      label: { k: 'graph.browser' },
      sub: { k: 'graph.browserSub', p: { n: list.length } },
      state: 'running',
      startedAt: root?.startedAt ?? null,
      endedAt: null,
      model: null,
      effort: null,
      activity: root ? { type: 'command', text: REDACT ? null : root.cmd } : NONE,
      usage: null,
      turnUsage: null,
      res: resOf(list),
      procs: list,
      facts: [],
      note: null,
    });
  }

  // --- agents, sessions, sous-agents, jobs
  const jobNode = (t: TaskNode, agent: AgentNode): void => {
    const sysd = t.id.startsWith('systemd:');
    const det = t.id.startsWith('detached:');
    const kind: GraphKind = sysd ? 'systemd' : det ? 'detached' : 'cron';
    const live = t.state === 'running';
    const all = procsOf(t.pids ?? []);
    // voies parallèles et passes `claude` : chacune devient un nœud sous le job, qui garde le reste
    const split = live ? splitJob(t.pids ?? [], procs) : { lanes: [], passes: [], rest: [] as number[] };
    const hasSplit = split.lanes.length > 0 || split.passes.length > 0;
    const restSet = new Set(split.rest);
    const list = hasSplit ? all.filter((p) => restSet.has(p.pid)) : all;
    const claudeCmd =
      split.lanes.find((l) => l.pass)?.pass?.cmd ??
      split.passes[0]?.cmd ??
      list.find((p) => /(^|\/)claude(\s|$)/.test(p.cmd.split(' --')[0] ?? ''))?.cmd ??
      null;
    const facts: GraphNode['facts'] = [];
    if (sysd) facts.push({ k: 'graph.f.unit', v: t.id.slice('systemd:'.length) });
    if (det) facts.push({ k: 'graph.f.pid', v: t.id.slice('detached:'.length) });
    if (t.kind === 'cron') facts.push({ k: 'graph.f.schedule', v: '' });
    const jobId = push({
      id: `j:${t.id}`,
      parent: `a:${agent.id}`,
      role: 'job',
      kind,
      label: t.title,
      sub: split.lanes.length ? { k: 'graph.job.lanes', p: { n: split.lanes.length } } : t.runtime,
      state: t.state,
      startedAt: t.startedAt ?? t.createdAt,
      endedAt: t.endedAt,
      model: claudeCmd ? modelOfCmd(claudeCmd) : null,
      effort: claudeCmd ? (effortOfCmd(claudeCmd) ?? 'default') : null,
      effortSrc: claudeCmd && !effortOfCmd(claudeCmd) ? 'default' : undefined,
      activity: activityOfTask(t, kind === 'cron' ? 'job' : 'command'),
      usage: live ? jobTokens(t.pids ?? [], procs, now) : null,
      turnUsage: null,
      res: live ? resOf(all) : ZERO_RES,
      procs: list,
      facts: facts.filter((f) => f.v !== ''),
      note: t.error ?? t.summary,
      noteIsError: !!t.error,
    });

    const passNode = (
      id: string,
      label: Msg,
      sub: Msg | null,
      pass: Pass | null,
      pids: number[],
      lane: boolean,
      port: string | null,
    ): void => {
      const mine = all.filter((p) => pids.includes(p.pid));
      const running = !!pass;
      const f: GraphNode['facts'] = [];
      if (pass?.step) f.push({ k: 'graph.f.step', v: pass.step });
      if (pass?.branch) f.push({ k: 'graph.f.branch', v: pass.branch });
      if (pass?.cwd) f.push({ k: 'graph.f.dir', v: pass.cwd });
      if (pass?.promptFile) f.push({ k: 'graph.f.promptFile', v: pass.promptFile });
      if (pass?.logFile) f.push({ k: 'graph.f.logFile', v: pass.logFile });
      if (pass) f.push({ k: 'graph.f.pid', v: String(pass.pid) });
      if (port) f.push({ k: 'graph.f.e2ePort', v: port });
      push({
        id,
        parent: jobId,
        role: 'subagent',
        kind: lane ? 'lane' : 'pass',
        label,
        sub,
        // une voie vivante est « en cours » même entre deux passes : sinon, le filtre « en cours seulement »
        // la ferait disparaître pendant qu'elle attend un créneau — précisément ce qu'on veut voir
        state: lane || running ? 'running' : 'paused',
        startedAt: pass?.startedAt ?? (lane ? lanes0Start(pids, procs) : null),
        endedAt: null,
        model: pass ? modelOfCmd(pass.cmd) : null,
        effort: pass ? (effortOfCmd(pass.cmd) ?? 'default') : null,
        effortSrc: pass && !effortOfCmd(pass.cmd) ? 'default' : undefined,
        activity: pass?.promptFile
          ? { type: 'prompt', text: REDACT ? { k: 'redact.content' } : readHead(pass.promptFile, 6000) }
          : NONE,
        usage: pass ? jobTokens([pass.pid], procs, now) : null,
        turnUsage: null,
        res: resOf(mine),
        procs: mine,
        facts: f,
        note: running ? null : { k: 'graph.lane.waiting' },
        noteIsError: false,
      });
    };
    for (const l of split.lanes) {
      const sub = l.pass ? [l.pass.step, l.pass.branch].filter(Boolean).join(' · ') : '';
      passNode(
        `l:${jobId}:${l.letter === '?' ? l.root : l.letter}`,
        { k: 'graph.lane', p: { id: l.letter } },
        sub || { k: 'graph.lane.waitingSub' },
        l.pass,
        l.pids,
        true,
        l.letter === 'A' ? '3123' : l.letter === 'B' ? '3124' : null,
      );
    }
    for (const ps of split.passes) {
      const sub = [ps.branch, ps.cwd ? path.basename(ps.cwd) : null].filter(Boolean).join(' · ');
      passNode(`p:${jobId}:${ps.pid}`, ps.step ?? { k: 'graph.pass' }, sub || null, ps, [ps.pid], false, null);
    }
  };

  const sessionNode = (s: SessionNode, agent: AgentNode, parentId: string): void => {
    const rt = runtimeByKey.get(s.key);
    const list = procsOf(s.pids);
    const isSub = s.kind === 'subagent';
    const failNote = s.tasks.find((t) => t.error)?.error ?? null;
    const facts: GraphNode['facts'] = [{ k: 'graph.f.session', v: s.key }];
    if (s.channel) facts.push({ k: 'graph.f.channel', v: s.channel });
    if (s.turns) facts.push({ k: 'graph.f.turns', v: String(s.turns) });
    if (rt) facts.push({ k: 'graph.f.pid', v: String(rt.pid) });
    const runningTask = s.tasks.find((t) => t.state === 'running');
    const id = push({
      id: `s:${s.key}`,
      parent: parentId,
      role: isSub ? 'subagent' : 'agent',
      kind: isSub ? 'subagent' : 'session',
      label: s.title,
      sub: s.subtitle,
      state: s.state,
      startedAt: rt?.startedAt ?? s.startedAt,
      endedAt: null,
      model: rt?.model ?? s.model ?? agent.model,
      effort: rt?.effort ?? null,
      activity: s.prompt
        ? { type: 'prompt', text: s.prompt }
        : runningTask
          ? { type: 'prompt', text: runningTask.detail }
          : NONE,
      // le process vivant porte l'uuid CLI sur sa ligne de commande : lien direct vers le
      // transcript, là où la base OpenClaw ne l'écrit qu'à la fin du tour
      usage: (rt?.cliSessionId ? readSessionTokens(rt.cliSessionId) : null) ?? s.usage,
      turnUsage: turnUsageOf(s),
      res: s.res,
      procs: list,
      facts,
      note: failNote,
      noteIsError: !!failNote,
    });
    for (const c of s.children) sessionNode(c, agent, id);
  };

  const looseByAgent = new Map<string, GraphRuntime[]>();
  for (const r of ctx.runtimes) {
    if (r.sessionKey || !r.agentId) continue;
    const arr = looseByAgent.get(r.agentId) ?? [];
    arr.push(r);
    looseByAgent.set(r.agentId, arr);
  }

  for (const a of ctx.agents) {
    const agentId = `a:${a.id}`;
    const live = ctx.runtimes.filter((r) => r.agentId === a.id);
    const loose = looseByAgent.get(a.id) ?? [];
    const looseCovered = new Set(loose.flatMap((r) => r.pids));
    // process de l'agent que ni une session ni un run non identifié ne porte
    const rest = (ctx.looseByAgent.get(a.id) ?? []).filter((pid) => !looseCovered.has(pid));
    const list = procsOf(rest);
    push({
      id: agentId,
      parent: 'gw',
      role: 'agent',
      kind: 'agent',
      label: a.name,
      sub: a.model,
      state: a.state,
      startedAt: live.reduce<number | null>(
        (m, r) => (r.startedAt !== null && (m === null || r.startedAt < m) ? r.startedAt : m),
        null,
      ),
      endedAt: null,
      model: a.model,
      effort: live.length && live.every((r) => r.effort === live[0].effort) ? live[0].effort : null,
      activity: NONE,
      usage: a.usage,
      turnUsage: null,
      res: a.res,
      procs: list,
      facts: [
        ...(a.workspace ? [{ k: 'graph.f.workspace', v: a.workspace }] : []),
        { k: 'graph.f.agentId', v: a.id },
      ],
      note: null,
    });

    for (const r of loose) {
      const list2 = procsOf(r.pids);
      push({
        id: `r:${r.pid}`,
        parent: agentId,
        role: 'agent',
        kind: 'session',
        label: { k: 'graph.looseRun' },
        sub: { k: 'graph.looseRunSub' },
        state: 'running',
        startedAt: r.startedAt,
        endedAt: null,
        model: r.model ?? a.model,
        effort: r.effort,
        activity: NONE,
        usage: r.cliSessionId ? readSessionTokens(r.cliSessionId) : null,
        turnUsage: null,
        res: resOf(list2),
        procs: list2,
        facts: [{ k: 'graph.f.pid', v: String(r.pid) }],
        note: null,
      });
    }

    for (const s of a.sessions) {
      if (JOB_PSEUDO.test(s.key)) {
        // les tâches orphelines terminées (des centaines d'échecs et de succès passés) restent
        // dans l'arbre ; le graphe garde les jobs, les crons déclarés et tout ce qui tourne
        for (const t of s.tasks) {
          if (t.state === 'running' || /^(systemd|detached|cron):/.test(t.id)) jobNode(t, a);
        }
        continue;
      }
      sessionNode(s, a, agentId);
    }
  }

  // --- tout le reste d'OpenClaw : services systemd `openclaw-*`, puis process isolés
  const services = new Map<string, number[]>();
  const strays: number[] = [];
  for (const p of procs.values()) {
    if (placed.has(p.pid)) continue;
    const unit = unitOfPid(p.pid);
    if (unit && /openclaw/i.test(unit)) {
      const arr = services.get(unit) ?? [];
      arr.push(p.pid);
      services.set(unit, arr);
    } else if (/openclaw/i.test(p.cmd)) {
      strays.push(p.pid);
    }
  }
  for (const [unit, pids] of [...services].sort((a, b) => a[0].localeCompare(b[0]))) {
    const list = procsOf(pids);
    // le gateway est déjà la racine : son unité n'est pas un second nœud
    const main = list.find((p) => !pids.includes(p.ppid)) ?? list[0];
    push({
      id: `svc:${unit}`,
      parent: 'gw',
      role: 'infra',
      kind: 'service',
      label: unit.replace(/\.service$/, ''),
      sub: { k: 'graph.serviceSub', p: { n: list.length } },
      state: 'running',
      startedAt: main?.startedAt ?? null,
      endedAt: null,
      model: null,
      effort: null,
      activity: main ? { type: 'command', text: REDACT ? null : main.cmd } : NONE,
      usage: null,
      turnUsage: null,
      res: resOf(list),
      procs: list,
      facts: [{ k: 'graph.f.unit', v: unit }],
      note: null,
    });
  }
  if (strays.length) {
    const list = procsOf(strays);
    push({
      id: 'other',
      parent: 'gw',
      role: 'infra',
      kind: 'other',
      label: { k: 'graph.other' },
      sub: { k: 'graph.otherSub', p: { n: list.length } },
      state: 'running',
      startedAt: list.reduce<number | null>((m, p) => (m === null || p.startedAt < m ? p.startedAt : m), null),
      endedAt: null,
      model: null,
      effort: null,
      activity: NONE,
      usage: null,
      turnUsage: null,
      res: resOf(list),
      procs: list,
      facts: [],
      note: null,
    });
  }

  resolveEfforts(nodes);

  if (REDACT) {
    let n = 0;
    for (const g of nodes) {
      if (g.kind === 'session' || g.kind === 'subagent' || g.kind === 'systemd' || g.kind === 'detached' || g.kind === 'cron') {
        n++;
        g.label = { k: g.kind === 'subagent' ? 'redact.subagent' : 'redact.session', p: { n } };
        g.sub = null;
        g.note = g.note ? { k: 'redact.hidden' } : null;
        g.facts = [];
      }
      if (g.activity.text) g.activity = { type: g.activity.type, text: { k: 'redact.content' } };
    }
  }

  return { ts: now, nodes, procCount: placed.size, inactive: true };
}

// ---------------------------------------------------------------- filtrage

const INACTIVE_TEXT_MAX = 600;

function clipMsg(m: Msg | null): Msg | null {
  return typeof m === 'string' && m.length > INACTIVE_TEXT_MAX ? `${m.slice(0, INACTIVE_TEXT_MAX)}…` : m;
}

/**
 * Réduit le graphe à ce qui tourne (`inactive` faux), ancêtres compris pour que chaque
 * nœud garde sa lignée. Avec `inactive`, tout reste ; les textes longs des unités au repos
 * sont tronqués : le flux est rafraîchi toutes les 2 s, inutile d'y rejouer 4 000
 * caractères de prompt par session terminée.
 */
export function filterGraph(g: GraphData, inactive: boolean): GraphData {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const keep = new Set<string>(['gw']);
  for (const n of g.nodes) {
    if (!inactive && n.state !== 'running') continue;
    for (let cur: GraphNode | undefined = n; cur && !keep.has(cur.id); cur = cur.parent ? byId.get(cur.parent) : undefined) {
      keep.add(cur.id);
    }
  }
  const nodes = g.nodes
    .filter((n) => keep.has(n.id))
    .map((n) => (n.state === 'running' ? n : { ...n, activity: { ...n.activity, text: clipMsg(n.activity.text) }, procs: [] }));
  return { ...g, nodes, inactive };
}
