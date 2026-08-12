/**
 * Chaîne prête à afficher, ou message traduisible : `k` est une clé du catalogue
 * (`lib/i18n.ts`), `p` les paramètres du gabarit, `ts` un horodatage rendu en heure
 * locale et exposé au gabarit sous `{time}`.
 *
 * La collecte n'émet jamais de texte d'interface en dur : tout ce que le produit
 * fabrique lui-même passe par une clé, tout ce qui vient des données OpenClaw
 * (titres de tâches, noms de canaux, lignes de commande) reste une chaîne brute.
 */
export type Msg = string | { k: string; p?: Record<string, string | number>; ts?: number };

export type UnitState =
  | 'running'   // travail en cours (process vivant)
  | 'idle'      // session connue, rien en cours
  | 'paused'    // suspendue (pause_reason / flow bloqué)
  | 'done'      // terminée avec succès
  | 'failed'    // échouée
  | 'killed'    // tuée (timeout, OOM, cancel)
  | 'scheduled' // planifiée (cron)
  | 'unknown';

export type Res = {
  /** % d'un cœur (comme top). 100 = 1 cœur saturé */
  cpuPct: number;
  /** RSS en Mo */
  rssMb: number;
  /** nombre de process rattachés */
  procs: number;
};

export const ZERO_RES: Res = { cpuPct: 0, rssMb: 0, procs: 0 };

export type ProcInfo = {
  pid: number;
  ppid: number;
  comm: string;
  cmd: string;
  cpuPct: number;
  rssMb: number;
  startedAt: number;
  kind: 'gateway' | 'agent-cli' | 'mcp' | 'browser' | 'child' | 'other';
  label: Msg;
};

export type TaskNode = {
  id: string;
  kind: 'task' | 'cron' | 'flow';
  title: Msg;
  detail: Msg;
  state: UnitState;
  runtime: Msg;
  createdAt: number | null;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  summary: Msg | null;
  error: Msg | null;
  res: Res;
  children: TaskNode[];
};

export type SessionNode = {
  key: string;
  sessionId: string | null;
  kind: 'main' | 'subagent' | 'cron';
  title: Msg;
  subtitle: Msg;
  channel: string | null;
  state: UnitState;
  startedAt: number | null;
  lastActivityAt: number | null;
  model: string | null;
  /** dernier prompt utilisateur, lu dans le transcript (aucun appel modèle) */
  prompt: string | null;
  turns: number;
  res: Res;
  pids: number[];
  tasks: TaskNode[];
  children: SessionNode[];
};

export type AgentNode = {
  id: string;
  name: string;
  workspace: string | null;
  model: string | null;
  state: UnitState;
  res: Res;
  lastActivityAt: number | null;
  stats: {
    liveSessions: number;
    sessions: number;
    subagents: number;
    runningTasks: number;
    tasks24h: number;
    failed24h: number;
  };
  sessions: SessionNode[];
};

export type HostInfo = {
  hostname: Msg;
  cores: number;
  cpuPct: number;
  load: [number, number, number];
  memTotalMb: number;
  memUsedMb: number;
  memAvailMb: number;
  swapTotalMb: number;
  swapUsedMb: number;
  uptimeSec: number;
};

export type GatewayInfo = {
  pid: number | null;
  up: boolean;
  uptimeSec: number | null;
  res: Res;
  port: number | null;
  version: string | null;
};

export type Snapshot = {
  ts: number;
  collectMs: number;
  host: HostInfo;
  gateway: GatewayInfo;
  agents: AgentNode[];
  system: {
    browser: Res;
    other: Res;
  };
  totals: {
    agents: number;
    activeAgents: number;
    liveSessions: number;
    runningTasks: number;
    subagentsLive: number;
  };
  procs: ProcInfo[];
  warnings: Msg[];
};
