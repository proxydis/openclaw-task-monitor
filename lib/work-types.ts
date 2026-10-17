/** Contrat de `/api/work` — importé côté client en `import type` uniquement. */

export type WorkAction = {
  /** ms epoch */
  ts: number;
  tool: string;
  /** argument compact, déjà épuré des secrets */
  arg: string;
  /** dossier de sessions d'origine (worktree), pour distinguer plusieurs sessions */
  project: string;
};

export type WorkJob = {
  unit: string;
  state: string;
  startedAt: number | null;
  lastLine: string | null;
};

export type WorkCommit = { hash: string; subject: string; ts: number };

export type WorkRepo = {
  /** `owner/repo` si l'origin est connue, sinon nom du dossier */
  name: string;
  /** chemin raccourci (`~/…`) */
  path: string;
  branch: string | null;
  isWorktree: boolean;
  head: WorkCommit | null;
  dirty: number;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  commits: WorkCommit[];
  /** dernière activité (commit HEAD ou index), ms epoch */
  activeAt: number;
  pr: WorkPr | null;
};

export type WorkCi = { success: number; failure: number; pending: number; skipped: number };

export type WorkPr = {
  number: number;
  title: string;
  url: string;
  /** OPEN | MERGED | CLOSED */
  state: string;
  isDraft: boolean;
  /** APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | '' */
  reviewDecision: string;
  ci: WorkCi;
  updatedAt: number | null;
};

export type TrelloLabel = { name: string; color: string };

export type TrelloCardView = {
  number: number;
  /** nom Trello, sinon titre lu dans la PR */
  name: string;
  url: string | null;
  /** colonne Trello (Work in progress, Under review…), null sans accès à l'API */
  list: string | null;
  labels: TrelloLabel[];
  part: string | null;
  current: boolean;
};

export type TrelloLot = { version: string; cards: TrelloCardView[] };

export type WorkTrello = {
  /** identifiants présents côté serveur */
  configured: boolean;
  /** l'API a répondu (ou un cache existe) */
  ok: boolean;
  current: TrelloCardView[];
  lots: TrelloLot[];
};

export type WorkAgent = {
  id: string;
  name: string;
  /** ms epoch de la dernière action ou activité git */
  lastActivityAt: number | null;
  /** une session Claude CLI a écrit récemment */
  live: boolean;
  actions: WorkAction[];
  jobs: WorkJob[];
  repos: WorkRepo[];
  trello: WorkTrello;
};

export type WorkState = {
  generatedAt: number;
  redacted: boolean;
  agents: WorkAgent[];
};
