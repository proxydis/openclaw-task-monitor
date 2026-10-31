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

/**
 * Jetons consommés par une unité de travail, relevés **sur disque uniquement** : aucun
 * appel réseau, aucun appel modèle, aucun jeton dépensé par la mesure elle-même.
 *
 * Le découpage suit la facturation, pas la nomenclature de l'API. `input_tokens` brut
 * ne veut rien dire seul : sur un tour mesuré il valait 24 pendant que
 * `cache_read_input_tokens` valait 740 822. Afficher l'un sans l'autre fait passer un
 * tour quasi gratuit pour un tour à 780 k jetons.
 *
 * `out` inclut déjà les jetons de raisonnement (`output_tokens_details.thinking_tokens`
 * est une ventilation d'`output_tokens`, pas un supplément) : ne jamais les rajouter.
 */
export type TokenUsage = {
  /** facturé plein tarif : `input_tokens` + `cache_creation_input_tokens` */
  in: number;
  /** `output_tokens`, raisonnement compris */
  out: number;
  /** `cache_read_input_tokens` — relu, facturé ~10 % */
  cache: number;
  /**
   * Valeur incomplète ou dégradée, à signaler comme telle dans l'interface :
   * soit le rattrapage du `.jsonl` n'est pas terminé (budget par cycle), soit elle vient
   * du repli SQLite qui ne voit qu'un message par tour au lieu d'un par appel API.
   */
  approx?: boolean;
};

export const ZERO_TOKENS: TokenUsage = { in: 0, out: 0, cache: 0 };

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
  /** `null` quand la tâche n'est adossée à aucune session CLI (cron, job systemd) */
  usage: TokenUsage | null;
  /**
   * Portée de `usage`, quand elle n'est pas celle de la ligne parente. `'turn'` marque
   * le tour en cours : sa consommation est bornée à l'ouverture du tour, donc plus
   * petite que celle de sa session — l'interface le dit plutôt que de laisser lire deux
   * chiffres différents sur deux lignes voisines comme une incohérence.
   */
  usageScope?: 'turn';
  /** process rattachés à un job (systemd, détaché) ; absent des autres tâches */
  pids?: number[];
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
  prompt: Msg | null;
  turns: number;
  res: Res;
  /** `null` quand aucun transcript n'est lisible : l'interface affiche un tiret, pas un 0 */
  usage: TokenUsage | null;
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
  /** somme des sessions de l'agent, dédupliquée par session CLI (cf. `collect`) */
  usage: TokenUsage | null;
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
  cpuTempC: number | null;
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

/**
 * Une ligne de la carte « limites d'utilisation du forfait ». Reprend telle quelle
 * une entrée de `limits[]` renvoyée par l'API Anthropic : le tableau est générique,
 * une nouvelle limite côté serveur apparaît donc sans modification de code.
 */
export type PlanLimit = {
  /** clé stable pour le rendu (kind + modèle ciblé) */
  id: string;
  /** `session`, `weekly_all`, `weekly_scoped`… (valeur brute de l'API) */
  kind: string;
  /** regroupement d'affichage ; `weekly` est précédé d'un sous-titre de section */
  group: 'session' | 'weekly' | 'other';
  /** « Session actuelle », « Tous les modèles », ou le nom brut du modèle ciblé */
  label: Msg;
  /** entier 0–100 */
  percent: number;
  /** `normal`, `warning`… (valeur brute de l'API) */
  severity: string;
  /** échéance de réinitialisation en ms epoch, `null` si l'API n'en donne pas */
  resetsAt: number | null;
  isActive: boolean;
};

export type PlanUsage = {
  /** ms epoch du dernier relevé réussi, `null` tant qu'aucun n'a abouti */
  fetchedAt: number | null;
  /** « Max (20x) », « Pro »… ; `null` si le forfait n'est pas identifiable */
  planLabel: string | null;
  limits: PlanLimit[];
  /** état dégradé (pas de session locale, jeton expiré, réseau) */
  error: Msg | null;
};

/**
 * Consommation d'un modèle sur une fenêtre, relevée dans les transcripts du CLI Claude.
 * Les quatre compteurs de jetons sont disjoints : leur somme est le volume total traité.
 */
export type ModelShare = {
  /** identifiant API sans suffixe de date (`claude-haiku-4-5`, pas `…-20251001`) */
  model: string;
  /** appels API, doublons retirés */
  calls: number;
  in: number;
  out: number;
  /** `cache_creation_input_tokens`, TTL 5 min et 1 h confondus */
  cacheWrite: number;
  cacheRead: number;
  /** équivalent au tarif public de l'API, en USD ; `null` si le modèle n'a pas de tarif connu */
  cost: number | null;
  /** tarif emprunté à un modèle voisin (`claude-sonnet-5` pour `claude-sonnet-5-5`) */
  priceRef?: string;
};

export type ModelUsageWindow = {
  /** mêmes fenêtres que les limites `session` (5 h) et `weekly_all` (7 j) du forfait */
  id: 'session' | 'weekly';
  /** début de fenêtre, ms epoch */
  since: number;
  /** `true` si `since` est calé sur l'échéance rapportée par Anthropic, `false` si glissant */
  aligned: boolean;
  /** triés par coût décroissant */
  models: ModelShare[];
};

export type ModelUsage = {
  windows: ModelUsageWindow[];
  /** part de l'historique déjà lue, 0–100 ; < 100 tant que le rattrapage du démarrage court */
  readPct: number;
};

export type Snapshot = {
  ts: number;
  collectMs: number;
  host: HostInfo;
  gateway: GatewayInfo;
  /** `null` quand la carte est désactivée (MONITOR_PLAN_USAGE=0) */
  plan: PlanUsage | null;
  /** répartition par modèle (onglet de la carte du forfait) ; `null` avec la carte */
  modelUsage: ModelUsage | null;
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

// ------------------------------------------------------------------ vue Graph

/** Rôle affiché dans le panneau : agent, sous-agent, job séparé, ou infrastructure OpenClaw. */
export type GraphRole = 'infra' | 'agent' | 'subagent' | 'job';

export type GraphKind =
  | 'gateway'
  | 'agent'
  | 'session'
  | 'subagent'
  | 'systemd'
  | 'detached'
  | 'cron'
  | 'service'
  | 'browser'
  | 'other';

export type GraphProc = {
  pid: number;
  ppid: number;
  comm: string;
  cmd: string;
  cpuPct: number;
  rssMb: number;
  startedAt: number;
};

/** Ce que fait l'unité : un prompt (agent), une commande (process), un job (systemd, cron). */
export type GraphActivity = { type: 'prompt' | 'command' | 'job' | 'none'; text: Msg | null };

export type GraphNode = {
  id: string;
  /** `null` pour la racine (la gateway) */
  parent: string | null;
  role: GraphRole;
  kind: GraphKind;
  label: Msg;
  sub: Msg | null;
  state: UnitState;
  startedAt: number | null;
  endedAt: number | null;
  model: string | null;
  /** niveau d'effort (`--effort` du CLI), `null` quand aucun process ne le porte */
  effort: string | null;
  activity: GraphActivity;
  /** jetons depuis la création de la session ; `null` : rien de mesurable (tiret, pas zéro) */
  usage: TokenUsage | null;
  /** jetons du tour en cours, quand il existe */
  turnUsage: TokenUsage | null;
  res: Res;
  /** tous les process de l'unité, sans filtre de seuil CPU/RAM */
  procs: GraphProc[];
  /** couples (clé de catalogue, valeur brute) : canal, clé de session, unité, répertoire… */
  facts: { k: string; v: string }[];
  /** résumé ou erreur de l'unité */
  note: Msg | null;
  noteIsError: boolean;
};

export type GraphData = {
  ts: number;
  nodes: GraphNode[];
  /** process OpenClaw distincts présents dans le graphe */
  procCount: number;
  /** `true` si le graphe contient aussi les unités inactives ou terminées récentes */
  inactive: boolean;
};
