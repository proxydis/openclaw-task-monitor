/**
 * Cartes Trello du tableau « Projet phénix », via l'API REST.
 *
 * Les identifiants viennent de `TRELLO_API_KEY` / `TRELLO_TOKEN` (environnement du service) ou,
 * à défaut, du fichier `~/.config/openclaw-monitor/trello.env`. Ils restent dans ce module :
 * ils partent dans l'en-tête `Authorization` (jamais dans l'URL, donc jamais dans une erreur),
 * ne sont ni journalisés ni renvoyés au navigateur. Le cache garde une forme réduite des cartes
 * (nom, colonne, étiquettes, lien) : 5 minutes, et la dernière valeur connue en cas d'échec.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TrelloLabel } from './work-types';

const BOARD = process.env.MONITOR_TRELLO_BOARD || 'PkapJ6oP';
const TTL_MS = 5 * 60_000;
const FAIL_TTL_MS = 60_000;
const TIMEOUT_MS = 8000;
/** garde-fou mémoire : un tableau de ce projet compte ~600 cartes */
const MAX_CARDS = 3000;

export type TrelloCard = {
  shortLink: string;
  url: string;
  name: string;
  list: string | null;
  labels: TrelloLabel[];
  /** `0.9.5` */
  version: string | null;
  /** n° dans le lot : `[V0.9.5-Back] 6. …` → 6 */
  number: number | null;
  /** `Back`, `Front`, `Back/Front` */
  scope: string | null;
};

type Creds = { key: string; token: string };

let envFileCache: { at: number; creds: Creds | null } | null = null;

function credentials(): Creds | null {
  const key = process.env.TRELLO_API_KEY;
  const token = process.env.TRELLO_TOKEN;
  if (key && token) return { key, token };
  const now = Date.now();
  if (envFileCache && now - envFileCache.at < 60_000) return envFileCache.creds;
  let creds: Creds | null = null;
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.config', 'openclaw-monitor', 'trello.env'), 'utf8');
    const kv: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Z_]+)=(.*)$/.exec(line);
      if (m) kv[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
    if (kv.TRELLO_API_KEY && kv.TRELLO_TOKEN) creds = { key: kv.TRELLO_API_KEY, token: kv.TRELLO_TOKEN };
  } catch {
    /* fichier absent : pas d'identifiants */
  }
  envFileCache = { at: now, creds };
  return creds;
}

export const trelloConfigured = (): boolean => credentials() !== null;

async function api(pathAndQuery: string, c: Creds): Promise<unknown> {
  const res = await fetch(`https://api.trello.com/1${pathAndQuery}`, {
    headers: { Authorization: `OAuth oauth_consumer_key="${c.key}", oauth_token="${c.token}"`, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`trello http ${res.status}`);
  return res.json();
}

/** `[V0.9.5-Back/Front] 2. Titre` → version, portée, numéro. */
export function parseCardName(name: string): Pick<TrelloCard, 'version' | 'number' | 'scope'> {
  const m = /^\s*\[V(\d+\.\d+(?:\.\d+)?)(?:-([^\]]+))?\]\s*(\d+)\./i.exec(name);
  return m ? { version: m[1], scope: m[2] ?? null, number: Number(m[3]) } : { version: null, scope: null, number: null };
}

async function fetchCards(c: Creds): Promise<TrelloCard[]> {
  const [lists, cards] = (await Promise.all([
    api(`/boards/${BOARD}/lists?fields=name`, c),
    api(`/boards/${BOARD}/cards?fields=name,idList,shortUrl,shortLink,labels,dateLastActivity`, c),
  ])) as [Array<{ id: string; name: string }>, Array<any>];
  const listName = new Map(lists.map((l) => [l.id, l.name]));
  return cards.slice(0, MAX_CARDS).map((k) => ({
    shortLink: String(k.shortLink ?? ''),
    url: String(k.shortUrl ?? ''),
    name: String(k.name ?? '').slice(0, 240),
    list: listName.get(k.idList) ?? null,
    labels: (Array.isArray(k.labels) ? k.labels : [])
      .map((l: any) => ({ name: String(l?.name ?? ''), color: String(l?.color ?? '') }))
      .filter((l: TrelloLabel) => l.name || l.color),
    ...parseCardName(String(k.name ?? '')),
  }));
}

let cache: { at: number; ttl: number; cards: TrelloCard[] | null } | null = null;
let inflight: Promise<TrelloCard[] | null> | null = null;

/** Cartes du tableau, ou `null` sans identifiants / sans valeur connue. Ne lève jamais. */
export function getTrelloCards(): Promise<TrelloCard[] | null> {
  const creds = credentials();
  if (!creds) return Promise.resolve(null);
  if (cache && Date.now() - cache.at < cache.ttl) return Promise.resolve(cache.cards);
  if (inflight) return inflight;
  inflight = fetchCards(creds)
    .then((cards): TrelloCard[] | null => {
      cache = { at: Date.now(), ttl: TTL_MS, cards };
      return cards;
    })
    .catch((): TrelloCard[] | null => {
      // dernière valeur connue conservée, nouvel essai dans 1 min
      cache = { at: Date.now(), ttl: FAIL_TTL_MS, cards: cache?.cards ?? null };
      return cache.cards;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
