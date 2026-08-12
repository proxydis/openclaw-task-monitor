import type { Msg, UnitState } from './types';

export const LANGS = ['en', 'fr'] as const;
export type Lang = (typeof LANGS)[number];

export const DEFAULT_LANG: Lang = 'en';

export function isLang(v: unknown): v is Lang {
  return typeof v === 'string' && (LANGS as readonly string[]).includes(v);
}

/** Locale utilisée pour les dates et heures de chaque langue. */
const LOCALE: Record<Lang, string> = { en: 'en-GB', fr: 'fr-FR' };

// ------------------------------------------------------------------ catalogues

const EN: Record<string, string> = {
  // états
  'state.running': 'running',
  'state.idle': 'idle',
  'state.paused': 'paused',
  'state.done': 'finished',
  'state.failed': 'failed',
  'state.killed': 'killed',
  'state.scheduled': 'scheduled',
  'state.unknown': 'unknown',
  'agentState.running': 'active',
  'agentState.idle': 'idle',

  // unités produites par la collecte
  'task.liveTurn': 'Current turn',
  'task.liveTurnDetail': 'Current turn — prompt unavailable.',
  'task.activeProcs': '{n} active process(es)',
  'runtime.agentTurn': 'agent turn',
  'cron.detailEvery': '{desc} · every {min} min',
  'cron.detailExpr': '{desc} · {expr}',
  'cron.next': 'next run at {time}',
  'session.scheduler': 'Scheduler & system tasks',
  'session.cronJobs': '{n} cron job(s)',
  'session.subagent': 'subagent{extra}',
  'session.generic': 'session',
  'proc.gateway': 'openclaw gateway',
  'proc.runtime': 'runtime {id}',
  'proc.mcp': 'MCP server',
  'proc.browser': 'chrome (browser tool)',
  'warn.sqlite': 'sqlite: {err}',

  // mode démo
  'redact.session': 'Session {n}',
  'redact.subagent': 'Subagent {n}',
  'redact.task': 'Task {n}',
  'redact.hidden': 'hidden',
  'redact.channel': '{ch} · hidden',
  'redact.content': 'content hidden (MONITOR_REDACT=1)',

  // en-tête
  'ui.connecting': 'connecting to stream…',
  'ui.loading': 'Loading first snapshot…',
  'ui.error': 'Error: {e}',
  'ui.hostLine': '{host} · {cores} cores · uptime {up}',
  'ui.live': 'live',
  'ui.reconnecting': 'reconnecting…',
  'ui.streamLine': '{state} · updated {ago} · scan {ms} ms',
  'ui.gatewayUp': 'gateway pid {pid} · port {port}',
  'ui.gatewayDown': 'gateway stopped',
  'ui.langSwitch': 'Language',

  // KPI
  'kpi.activeAgents': 'Active agents',
  'kpi.liveSessions': '{n} live session(s)',
  'kpi.runningTasks': 'Running tasks',
  'kpi.liveSubagents': '{n} live subagent(s)',
  'kpi.cpu': 'Machine CPU',
  'kpi.load': 'load {v}',
  'kpi.memory': 'Memory',
  'kpi.available': '{v} available',
  'kpi.swap': 'Swap',
  'kpi.swapUsed': '{n} % used',
  'kpi.gateway': 'Gateway',
  'kpi.gatewayFoot': 'browser {v} · {n} process(es)',

  // arbre
  'panel.tree': 'Agent tree',
  'tab.tree': 'Tree',
  'tab.procs': 'Processes ({n})',
  'ui.filter': 'filter…',
  'toggle.idle': 'idle',
  'toggle.done': 'finished',
  'ui.noAgents': 'No agent to display.',
  'badge.subagent': 'subagent',
  'badge.cron': 'cron',
  'badge.tasks': '{n} task(s)',
  'badge.runningTasks': '{n} running',
  'badge.subagents': '{n} subagents',
  'badge.failed': '{n} failure(s)',
  'legend.note': 'CPU = % of one core · RAM = cumulative RSS of the subtree',

  // détail
  'detail.title': 'Details',
  'detail.empty': 'Select an agent, a session or a task in the tree.',
  'detail.agent': 'Agent',
  'detail.task': 'Task',
  'kind.main': 'session',
  'kind.subagent': 'subagent',
  'kind.cron': 'scheduler',
  'f.id': 'Identifier',
  'f.model': 'Model',
  'f.cpu': 'CPU',
  'f.memory': 'Memory',
  'f.lastActivity': 'Last activity',
  'f.counters': 'Counters',
  'f.sessions': 'Sessions',
  'f.subagents': 'Subagents',
  'f.tasks24h': 'Tasks 24 h',
  'f.failed24h': 'Failures 24 h',
  'f.agent': 'Agent',
  'f.session': 'Session',
  'f.channel': 'Channel',
  'f.started': 'Started',
  'f.activity': 'Activity',
  'f.cpuRam': 'CPU / RAM',
  'f.processes': 'Processes',
  'f.runtime': 'Runtime',
  'f.created': 'Created',
  'f.ended': 'Ended',
  'f.duration': 'Duration',
  'f.lastRequest': 'Last request',
  'f.progress': 'Progress',
  'f.prompt': 'Prompt',
  'f.error': 'Error',
  'v.sessionsOf': '{n} incl. {live} active',
  'v.tasksOf': '{n} · {r} running',
  'v.cpuProcs': '{p}% · {n} process(es)',
  'v.noProcs': 'none (idle session)',
  'v.tasksTitle': 'Tasks ({n})',

  // table des process
  'th.pid': 'PID',
  'th.role': 'Role',
  'th.command': 'Command',
  'th.cpu': 'CPU',
  'th.rss': 'RSS',
  'th.age': 'Age',

  // formats
  'fmt.justNow': 'just now',
  'fmt.sec': '{n} s',
  'fmt.min': '{n} min',
  'fmt.hour': '{n} h',
  'fmt.day': '{n} d',
  'fmt.minSec': '{m} min {s} s',
  'fmt.hourMin': '{h} h {m} min',
  'fmt.dayHour': '{d} d {h} h',
  'fmt.gb': '{v} GB',
  'fmt.mb': '{v} MB',
  'fmt.gbShort': '{v}G',
  'fmt.mbShort': '{v}M',
  'fmt.cpuTip': "{p}% of one core · {n} process(es)",
  'fmt.memTip': '{v} of cumulative RSS',
};

const FR: Record<string, string> = {
  'state.running': 'en cours',
  'state.idle': 'inactif',
  'state.paused': 'suspendue',
  'state.done': 'terminée',
  'state.failed': 'échouée',
  'state.killed': 'tuée',
  'state.scheduled': 'planifiée',
  'state.unknown': 'inconnu',
  'agentState.running': 'actif',
  'agentState.idle': 'inactif',

  'task.liveTurn': 'Tour en cours',
  'task.liveTurnDetail': 'Tour en cours — énoncé indisponible.',
  'task.activeProcs': '{n} process actif(s)',
  'runtime.agentTurn': 'tour agent',
  'cron.detailEvery': '{desc} · toutes les {min} min',
  'cron.detailExpr': '{desc} · {expr}',
  'cron.next': 'prochaine exécution à {time}',
  'session.scheduler': 'Planificateur & tâches système',
  'session.cronJobs': '{n} job(s) cron',
  'session.subagent': 'sous-agent{extra}',
  'session.generic': 'session',
  'proc.gateway': 'openclaw gateway',
  'proc.runtime': 'runtime {id}',
  'proc.mcp': 'serveur MCP',
  'proc.browser': 'chrome (outil navigateur)',
  'warn.sqlite': 'sqlite : {err}',

  'redact.session': 'Session {n}',
  'redact.subagent': 'Sous-agent {n}',
  'redact.task': 'Tâche {n}',
  'redact.hidden': 'masqué',
  'redact.channel': '{ch} · masqué',
  'redact.content': 'contenu masqué (MONITOR_REDACT=1)',

  'ui.connecting': 'connexion au flux…',
  'ui.loading': 'Chargement du premier instantané…',
  'ui.error': 'Erreur : {e}',
  'ui.hostLine': '{host} · {cores} cœurs · uptime {up}',
  'ui.live': 'temps réel',
  'ui.reconnecting': 'reconnexion…',
  'ui.streamLine': '{state} · maj {ago} · scan {ms} ms',
  'ui.gatewayUp': 'gateway pid {pid} · port {port}',
  'ui.gatewayDown': 'gateway arrêté',
  'ui.langSwitch': 'Langue',

  'kpi.activeAgents': 'Agents actifs',
  'kpi.liveSessions': '{n} session(s) vivante(s)',
  'kpi.runningTasks': 'Tâches en cours',
  'kpi.liveSubagents': '{n} sous-agent(s) actif(s)',
  'kpi.cpu': 'CPU machine',
  'kpi.load': 'load {v}',
  'kpi.memory': 'Mémoire',
  'kpi.available': '{v} disponibles',
  'kpi.swap': 'Swap',
  'kpi.swapUsed': '{n} % utilisé',
  'kpi.gateway': 'Gateway',
  'kpi.gatewayFoot': 'navigateur {v} · {n} process',

  'panel.tree': 'Arbre des agents',
  'tab.tree': 'Arbre',
  'tab.procs': 'Process ({n})',
  'ui.filter': 'filtrer…',
  'toggle.idle': 'inactifs',
  'toggle.done': 'terminées',
  'ui.noAgents': 'Aucun agent à afficher.',
  'badge.subagent': 'sous-agent',
  'badge.cron': 'cron',
  'badge.tasks': '{n} tâche(s)',
  'badge.runningTasks': '{n} en cours',
  'badge.subagents': '{n} sous-agents',
  'badge.failed': '{n} échec(s)',
  'legend.note': 'CPU = % d’un cœur · RAM = RSS cumulé du sous-arbre',

  'detail.title': 'Détail',
  'detail.empty': 'Sélectionne un agent, une session ou une tâche dans l’arbre.',
  'detail.agent': 'Agent',
  'detail.task': 'Tâche',
  'kind.main': 'session',
  'kind.subagent': 'sous-agent',
  'kind.cron': 'planificateur',
  'f.id': 'Identifiant',
  'f.model': 'Modèle',
  'f.cpu': 'CPU',
  'f.memory': 'Mémoire',
  'f.lastActivity': 'Dernière activité',
  'f.counters': 'Compteurs',
  'f.sessions': 'Sessions',
  'f.subagents': 'Sous-agents',
  'f.tasks24h': 'Tâches 24 h',
  'f.failed24h': 'Échecs 24 h',
  'f.agent': 'Agent',
  'f.session': 'Session',
  'f.channel': 'Canal',
  'f.started': 'Démarrée',
  'f.activity': 'Activité',
  'f.cpuRam': 'CPU / RAM',
  'f.processes': 'Process',
  'f.runtime': 'Runtime',
  'f.created': 'Créée',
  'f.ended': 'Terminée',
  'f.duration': 'Durée',
  'f.lastRequest': 'Dernière demande',
  'f.progress': 'Progression',
  'f.prompt': 'Énoncé',
  'f.error': 'Erreur',
  'v.sessionsOf': '{n} dont {live} active(s)',
  'v.tasksOf': '{n} · {r} en cours',
  'v.cpuProcs': '{p}% · {n} process',
  'v.noProcs': 'aucun (session au repos)',
  'v.tasksTitle': 'Tâches ({n})',

  'th.pid': 'PID',
  'th.role': 'Rôle',
  'th.command': 'Commande',
  'th.cpu': 'CPU',
  'th.rss': 'RSS',
  'th.age': 'Âge',

  'fmt.justNow': 'à l’instant',
  'fmt.sec': '{n} s',
  'fmt.min': '{n} min',
  'fmt.hour': '{n} h',
  'fmt.day': '{n} j',
  'fmt.minSec': '{m} min {s} s',
  'fmt.hourMin': '{h} h {m} min',
  'fmt.dayHour': '{d} j {h} h',
  'fmt.gb': '{v} Go',
  'fmt.mb': '{v} Mo',
  'fmt.gbShort': '{v}G',
  'fmt.mbShort': '{v}M',
  'fmt.cpuTip': '{p}% d’un cœur · {n} process',
  'fmt.memTip': '{v} de RSS cumulé',
};

const DICT: Record<Lang, Record<string, string>> = { en: EN, fr: FR };

// ------------------------------------------------------------------ rendu

function fill(tpl: string, p?: Record<string, string | number>): string {
  if (!p) return tpl;
  return tpl.replace(/\{(\w+)\}/g, (whole, key: string) => (key in p ? String(p[key]) : whole));
}

/** Traduit une clé du catalogue. La clé elle-même sert de repli si elle manque. */
export function t(lang: Lang, key: string, p?: Record<string, string | number>): string {
  const tpl = DICT[lang][key] ?? DICT[DEFAULT_LANG][key] ?? key;
  return fill(tpl, p);
}

/** Rend un `Msg` : chaîne brute telle quelle, message traduisible via le catalogue. */
export function m(lang: Lang, msg: Msg | null | undefined): string {
  if (msg == null) return '';
  if (typeof msg === 'string') return msg;
  const p = { ...(msg.p ?? {}) };
  if (msg.ts != null) p.time = new Date(msg.ts).toLocaleTimeString(LOCALE[lang]);
  return t(lang, msg.k, p);
}

export function stateLabel(lang: Lang, state: UnitState): string {
  return t(lang, `state.${state}`);
}

export function agentStateLabel(lang: Lang, state: UnitState): string {
  return t(lang, state === 'running' ? 'agentState.running' : 'agentState.idle');
}

export function locale(lang: Lang): string {
  return LOCALE[lang];
}
