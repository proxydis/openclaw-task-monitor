'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { GraphData, GraphNode, GraphProc, TokenUsage, UnitState } from '@/lib/types';
import { stateLabel } from '@/lib/i18n';
import { useI18n } from './LangProvider';
import { ago, clock, dur, mb, mbShort, tokens, tokensFull } from './format';
import './graph.css';

// ------------------------------------------------------------------ flux

const POLL_MS = 2000;

/**
 * Interroge `/api/graph` toutes les 2 s, uniquement tant que la vue est affichée et la
 * page visible. Le graphe est calculé côté serveur à partir du même balayage que le
 * tableau de bord : aucune lecture supplémentaire, aucun appel modèle.
 */
export function useGraph(active: boolean, inactive: boolean) {
  const [data, setData] = useState<GraphData | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (!document.hidden) {
        try {
          const r = await fetch(`/api/graph?inactive=${inactive ? 1 : 0}`, { cache: 'no-store' });
          if (!r.ok) throw new Error('http');
          const j = (await r.json()) as GraphData;
          if (!stopped) {
            setData(j);
            setErr(false);
          }
        } catch {
          if (!stopped) setErr(true);
        }
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, inactive]);
  return { data, err };
}

function useTick(periodMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), periodMs);
    return () => clearInterval(id);
  }, [periodMs]);
  return now;
}

// ------------------------------------------------------------------ disposition

export const CARD_W = 262;
export const CARD_H = 84;
const COL_GAP = 92;
const ROW_GAP = 18;
const COL = CARD_W + COL_GAP;
const ROW = CARD_H + ROW_GAP;

type Placed = { n: GraphNode; x: number; y: number; depth: number };
type Edge = { from: Placed; to: Placed };

const KIND_RANK: Record<GraphNode['kind'], number> = {
  gateway: 0,
  agent: 1,
  session: 2,
  subagent: 3,
  lane: 4,
  systemd: 4,
  detached: 5,
  cron: 6,
  browser: 7,
  service: 8,
  other: 9,
};

/**
 * Arbre en colonnes : un niveau de lignée par colonne, chaque parent centré sur ses
 * enfants. L'ordre des frères ne dépend que de la nature et de l'identifiant du nœud,
 * jamais de l'état ni de l'activité : le graphe ne saute pas d'un rafraîchissement à
 * l'autre quand une unité passe de running à idle.
 */
function layout(nodes: GraphNode[]): { placed: Map<string, Placed>; edges: Edge[]; w: number; h: number } {
  const kids = new Map<string, GraphNode[]>();
  const ids = new Set(nodes.map((n) => n.id));
  const root = nodes.find((n) => n.parent === null);
  for (const n of nodes) {
    if (n.parent === null) continue;
    const p = ids.has(n.parent) ? n.parent : (root?.id ?? n.parent);
    const arr = kids.get(p) ?? [];
    arr.push(n);
    kids.set(p, arr);
  }
  for (const arr of kids.values()) {
    arr.sort(
      (a, b) =>
        Number(a.id.startsWith('cluster:')) - Number(b.id.startsWith('cluster:')) ||
        KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
        (a.kind === 'agent' || a.kind === 'service' ? String(a.label).localeCompare(String(b.label)) : 0) ||
        (a.startedAt ?? 0) - (b.startedAt ?? 0) ||
        a.id.localeCompare(b.id),
    );
  }
  const placed = new Map<string, Placed>();
  const edges: Edge[] = [];
  let cursor = 0;
  let maxDepth = 0;
  const place = (n: GraphNode, depth: number): Placed => {
    maxDepth = Math.max(maxDepth, depth);
    const children = (kids.get(n.id) ?? []).map((c) => place(c, depth + 1));
    const y = children.length ? (children[0].y + children[children.length - 1].y) / 2 : cursor++ * ROW;
    const p: Placed = { n, x: depth * COL, y, depth };
    placed.set(n.id, p);
    for (const c of children) edges.push({ from: p, to: c });
    return p;
  };
  if (root) place(root, 0);
  return { placed, edges, w: (maxDepth + 1) * COL - COL_GAP, h: Math.max(1, cursor) * ROW - ROW_GAP };
}

/** Nœuds affichés : filtres d'état, puis lignée des nœuds retenus (un enfant garde ses parents). */
function visibleNodes(
  g: GraphData,
  f: { runningOnly: boolean; showIdle: boolean; showDone: boolean },
): GraphNode[] {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const keep = new Set<string>();
  const wanted = (n: GraphNode): boolean => {
    if (f.runningOnly) return n.state === 'running';
    if (n.state === 'running') return true;
    if (n.state === 'idle' || n.state === 'scheduled' || n.state === 'paused' || n.state === 'unknown') return f.showIdle;
    return f.showDone;
  };
  for (const n of g.nodes) {
    if (n.parent !== null && !wanted(n)) continue;
    for (let cur: GraphNode | undefined = n; cur && !keep.has(cur.id); cur = cur.parent ? byId.get(cur.parent) : undefined) {
      keep.add(cur.id);
    }
  }
  return g.nodes.filter((n) => keep.has(n.id));
}

/**
 * Regroupement des unités au repos. Une centaine de sessions terminées empilées dans une
 * colonne rendraient le graphe illisible : au-delà de `CLUSTER_MIN` enfants inactifs, un
 * parent n'en montre qu'un nœud-somme, que l'on déplie d'un clic. Ce qui tourne n'est
 * jamais regroupé.
 */
const CLUSTER_MIN = 3;

export type VNode = GraphNode & { cluster?: { hidden: number; open: boolean; parts: string } };

function collapse(
  nodes: GraphNode[],
  expanded: Set<string>,
  label: (state: UnitState, n: number) => string,
): VNode[] {
  const byParent = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    if (n.parent === null || n.state === 'running') continue;
    const arr = byParent.get(n.parent) ?? [];
    arr.push(n);
    byParent.set(n.parent, arr);
  }
  const hide = new Set<string>();
  const clusters: VNode[] = [];
  for (const [parent, idle] of byParent) {
    // un nœud inactif qui porte lui-même des enfants affichés reste visible : il garde sa lignée
    const leaves = idle.filter((n) => !nodes.some((x) => x.parent === n.id));
    if (leaves.length < CLUSTER_MIN) continue;
    const open = expanded.has(parent);
    const counts = new Map<UnitState, number>();
    for (const n of leaves) counts.set(n.state, (counts.get(n.state) ?? 0) + 1);
    const parts = [...counts].map(([st, c]) => label(st, c)).join(' · ');
    if (!open) for (const n of leaves) hide.add(n.id);
    clusters.push({
      ...leaves[0],
      id: `cluster:${parent}`,
      parent,
      role: 'infra',
      kind: 'other',
      state: 'idle',
      startedAt: null,
      endedAt: null,
      model: null,
      effort: null,
      usage: null,
      turnUsage: null,
      procs: [],
      facts: [],
      note: null,
      label: '',
      sub: null,
      cluster: { hidden: leaves.length, open, parts },
    });
  }
  return [...nodes.filter((n) => !hide.has(n.id)), ...clusters];
}

// ------------------------------------------------------------------ rendu d'un nœud

const ROLE_KEY: Record<GraphNode['role'], string> = {
  infra: 'graph.role.infra',
  agent: 'graph.role.agent',
  subagent: 'graph.role.subagent',
  job: 'graph.role.job',
};

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** « slack:openclaw-codeman-#projet-phenix-dev » → « #projet-phenix-dev » : le canal est ce qui distingue les sessions. */
function cardTitle(raw: string): string {
  const m = raw.match(/^[a-z]+:[^#\s]*(#.+)$/i);
  return m ? m[1] : raw;
}

function totalTokens(u: TokenUsage | null): number | null {
  return u ? u.in + u.out : null;
}

function ClusterCard({ p, onToggle }: { p: Placed; onToggle: (parent: string) => void }) {
  const { t } = useI18n();
  const c = (p.n as VNode).cluster!;
  const h = 44;
  return (
    <g
      className="gv-node gv-cluster"
      style={{ transform: `translate(${p.x}px, ${p.y + (CARD_H - h) / 2}px)` }}
      onClick={(e) => {
        e.stopPropagation();
        onToggle(p.n.parent ?? '');
      }}
    >
      <rect className="gv-bg" width={CARD_W} height={h} rx={10} />
      <text className="gv-title" x={14} y={19}>
        {c.open ? '▾' : '▸'} {c.open ? t('graph.cluster.hide', { n: c.hidden }) : t('graph.cluster.show', { n: c.hidden })}
      </text>
      <text className="gv-sub" x={14} y={35}>
        {clip(c.parts, 40)}
      </text>
    </g>
  );
}

function Card({
  p,
  selected,
  dim,
  onSelect,
  wasDrag,
}: {
  p: Placed;
  selected: boolean;
  dim: boolean;
  onSelect: (id: string) => void;
  wasDrag: () => boolean;
}) {
  const { lang, t, m } = useI18n();
  const n = p.n;
  const title = cardTitle(n.kind === 'agent' ? String(n.label) : m(n.label));
  const modelBits = [n.model ? n.model.split('/').pop() : null, n.effort ? (n.effortSrc && n.effortSrc !== 'cli' ? `${n.effort}*` : n.effort) : null].filter(Boolean).join(' · ');
  const sub = modelBits || (n.sub ? m(n.sub) : '');
  const tok = totalTokens(n.turnUsage ?? n.usage);
  const tokMark = (n.turnUsage ?? n.usage)?.approx ? '~' : '';
  return (
    <g
      className={`gv-node ${n.role} ${n.state}${selected ? ' sel' : ''}${dim ? ' dim' : ''}`}
      style={{ transform: `translate(${p.x}px, ${p.y}px)` }}
      onClick={(e) => {
        e.stopPropagation();
        if (!wasDrag()) onSelect(n.id);
      }}
    >
      <rect className="gv-halo" x={-3} y={-3} width={CARD_W + 6} height={CARD_H + 6} rx={15} />
      <rect className="gv-bg" width={CARD_W} height={CARD_H} rx={12} />
      <rect className="gv-bar" x={0} y={10} width={3.5} height={CARD_H - 20} rx={2} />
      <circle className="gv-dot" cx={22} cy={23} r={5} />
      <text className="gv-title" x={36} y={27}>
        {clip(title, 21)}
      </text>
      <text className="gv-role" x={CARD_W - 12} y={26} textAnchor="end">
        {t(ROLE_KEY[n.role])}
      </text>
      <text className="gv-sub" x={16} y={46}>
        {clip(sub, 38)}
      </text>
      <line className="gv-sep" x1={16} x2={CARD_W - 16} y1={56} y2={56} />
      <text className="gv-meta" x={16} y={73}>
        <tspan className="gv-tok">{tok === null ? '— tok' : `${tokMark}${tokens(lang, tok)} tok`}</tspan>
        <tspan dx={12}>{n.res.procs ? `${n.res.cpuPct.toFixed(0)}%` : '—'}</tspan>
        <tspan dx={12}>{n.res.procs ? mbShort(lang, n.res.rssMb) : '—'}</tspan>
        <tspan dx={12} className="gv-dim">
          {n.procs.length ? `${n.procs.length} proc` : ''}
        </tspan>
      </text>
    </g>
  );
}

// ------------------------------------------------------------------ canevas

type View = { x: number; y: number; k: number };
const K_MIN = 0.18;
const K_MAX = 2.2;
const READABLE_K = 0.55;

function curve(a: Placed, b: Placed): string {
  const x1 = a.x + CARD_W;
  const y1 = a.y + CARD_H / 2;
  const x2 = b.x;
  const y2 = b.y + CARD_H / 2;
  const dx = (x2 - x1) * 0.55;
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

export function GraphView({
  data,
  err,
  runningOnly,
  showIdle,
  showDone,
  q,
  selId,
  onSelect,
}: {
  data: GraphData | null;
  err: boolean;
  runningOnly: boolean;
  showIdle: boolean;
  showDone: boolean;
  q: string;
  selId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { t, m, lang } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 560 });
  const [view, setView] = useState<View>({ x: 24, y: 24, k: 1 });
  const touched = useRef(false);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  /** vrai entre la fin d'un glissement et le clic qui le suit : ce clic ne sélectionne rien */
  const dragged = useRef(false);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleCluster = useCallback((parent: string) => {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(parent)) n.delete(parent);
      else n.add(parent);
      return n;
    });
  }, []);
  const stateText = useCallback((st: UnitState, n: number) => `${n} ${stateLabel(lang, st)}`, [lang]);
  const nodes = useMemo<VNode[]>(
    () =>
      data ? collapse(visibleNodes(data, { runningOnly, showIdle, showDone }), expanded, stateText) : [],
    [data, runningOnly, showIdle, showDone, expanded, stateText],
  );
  const lay = useMemo(() => layout(nodes), [nodes]);
  const needle = q.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!needle) return null;
    const hit = new Set<string>();
    for (const n of nodes) {
      const hay = `${m(n.label)} ${n.sub ? m(n.sub) : ''} ${n.model ?? ''} ${n.effort ?? ''} ${n.id} ${n.procs.map((p) => p.cmd).join(' ')}`;
      if (hay.toLowerCase().includes(needle)) hit.add(n.id);
    }
    return hit;
  }, [needle, nodes, m]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const fit = useCallback(() => {
    const pad = 36;
    const whole = Math.min((size.w - pad * 2) / lay.w, (size.h - pad * 2) / lay.h);
    // un graphe très haut n'est pas réduit jusqu'à l'illisible : on garde une échelle de lecture
    // et on part du haut, le glissement fait le reste
    const k = Math.min(1.1, Math.max(whole, READABLE_K));
    setView({ k, x: (size.w - lay.w * k) / 2, y: whole >= READABLE_K ? Math.max(pad, (size.h - lay.h * k) / 2) : pad });
  }, [size, lay.w, lay.h]);

  // tant que l'utilisateur n'a ni déplacé ni zoomé, la vue suit le contenu
  useEffect(() => {
    if (!touched.current && nodes.length) fit();
  }, [fit, nodes.length]);

  // zoom à la molette autour du curseur (écouteur non passif pour pouvoir bloquer le défilement)
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      touched.current = true;
      const r = el.getBoundingClientRect();
      const cx = e.clientX - r.left;
      const cy = e.clientY - r.top;
      setView((v) => {
        const k = Math.min(K_MAX, Math.max(K_MIN, v.k * Math.exp(-e.deltaY * 0.0012)));
        const f = k / v.k;
        return { k, x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const zoomBy = (f: number) => {
    touched.current = true;
    setView((v) => {
      const k = Math.min(K_MAX, Math.max(K_MIN, v.k * f));
      const cx = size.w / 2;
      const cy = size.h / 2;
      const r = k / v.k;
      return { k, x: cx - (cx - v.x) * r, y: cy - (cy - v.y) * r };
    });
  };

  const counts = useMemo(() => {
    const c = { agents: 0, subagents: 0, jobs: 0 };
    for (const n of nodes) {
      if (n.state !== 'running') continue;
      if (n.role === 'subagent') c.subagents++;
      else if (n.role === 'job') c.jobs++;
      else if (n.kind === 'agent') c.agents++;
    }
    return c;
  }, [nodes]);

  return (
    <div className="gv-wrap">
      <div className="gv-hud">
        <span className="gv-chip a">
          <b>{counts.agents}</b> {t('graph.hud.agents')}
        </span>
        <span className="gv-chip s">
          <b>{counts.subagents}</b> {t('graph.hud.subagents')}
        </span>
        <span className="gv-chip j">
          <b>{counts.jobs}</b> {t('graph.hud.jobs')}
        </span>
        <span className="gv-chip p" title={t('graph.hud.procsTip')}>
          <b>{data?.procCount ?? 0}</b> {t('graph.hud.procs')}
        </span>
        {err ? <span className="gv-chip e">{t('graph.err')}</span> : null}
      </div>
      <div className="gv-tools">
        <button type="button" onClick={() => zoomBy(1.25)} aria-label={t('graph.zoomIn')} title={t('graph.zoomIn')}>
          +
        </button>
        <button type="button" onClick={() => zoomBy(0.8)} aria-label={t('graph.zoomOut')} title={t('graph.zoomOut')}>
          −
        </button>
        <button
          type="button"
          onClick={() => {
            touched.current = false;
            fit();
          }}
          aria-label={t('graph.fit')}
          title={t('graph.fit')}
        >
          ⤢
        </button>
      </div>
      <div
        ref={box}
        className="gv"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
          dragged.current = false;
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          if (!d.moved && Math.hypot(dx, dy) < 4) return;
          if (!d.moved) (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          d.moved = true;
          dragged.current = true;
          touched.current = true;
          setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (d?.moved) {
            (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
            // le clic synthétique du relâchement arrive juste après : on le laisse passer avant de réarmer
            setTimeout(() => (dragged.current = false), 0);
          } else if (d && !(e.target as Element).closest('.gv-node, button')) {
            // un simple clic dans le vide désélectionne
            onSelect(null);
          }
        }}
      >
        {!data ? <div className="gv-empty">{t('graph.loading')}</div> : null}
        <svg className="gv-svg" width={size.w} height={size.h}>
          <defs>
            <linearGradient id="gv-grad-edge" x1="0" x2="1" y1="0" y2="0">
              <stop offset="0" stopColor="currentColor" stopOpacity=".15" />
              <stop offset="1" stopColor="currentColor" stopOpacity=".9" />
            </linearGradient>
          </defs>
          <g style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }} className="gv-scene">
            <g className="gv-edges">
              {lay.edges.map((e) => {
                const d = curve(e.from, e.to);
                return (
                  <path
                    key={`${e.from.n.id}>${e.to.n.id}`}
                    className={`gv-edge ${e.to.n.role} ${e.to.n.state}`}
                    d={d}
                    style={{ d: `path("${d}")` } as React.CSSProperties}
                  />
                );
              })}
            </g>
            <g className="gv-nodes">
              {[...lay.placed.values()].map((p) =>
                (p.n as VNode).cluster ? (
                  <ClusterCard key={p.n.id} p={p} onToggle={toggleCluster} />
                ) : (
                <Card
                  key={p.n.id}
                  p={p}
                  selected={selId === p.n.id}
                  dim={!!matches && !matches.has(p.n.id)}
                  onSelect={onSelect}
                  wasDrag={() => dragged.current}
                />
                ),
              )}
            </g>
          </g>
        </svg>
        <div className="gv-legend">
          <span className="lg agent">{t('graph.role.agent')}</span>
          <span className="lg subagent">{t('graph.role.subagent')}</span>
          <span className="lg job">{t('graph.role.job')}</span>
          <span className="lg infra">{t('graph.role.infra')}</span>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ panneau de détail

function TokenRows({ usage, label }: { usage: TokenUsage | null; label: string }) {
  const { lang, t } = useI18n();
  return (
    <>
      <dt>{label}</dt>
      {usage ? (
        <dd title={usage.approx ? t('tok.approxTip') : t('tok.local')} className="gv-toks">
          <span className="in">
            {usage.approx ? '~' : ''}
            {t('tok.in')} {tokensFull(lang, usage.in)}
          </span>
          <span className="out">
            {t('tok.out')} {tokensFull(lang, usage.out)}
          </span>
          <span className="cache">
            {t('tok.cache')} {tokensFull(lang, usage.cache)}
          </span>
        </dd>
      ) : (
        <dd title={t('tok.none')}>—</dd>
      )}
    </>
  );
}

const ACTIVITY_KEY = { prompt: 'graph.act.prompt', command: 'graph.act.command', job: 'graph.act.job', none: 'graph.act.none' } as const;

function ProcTable({ procs }: { procs: GraphProc[] }) {
  const { lang, t } = useI18n();
  if (!procs.length) return <div className="gv-none">{t('graph.noProcs')}</div>;
  return (
    <div className="gv-procs">
      <table>
        <thead>
          <tr>
            <th>{t('th.pid')}</th>
            <th>{t('graph.th.proc')}</th>
            <th>{t('th.cpu')}</th>
            <th>{t('th.rss')}</th>
          </tr>
        </thead>
        <tbody>
          {procs.map((p) => (
            <tr key={p.pid} title={p.cmd}>
              <td className="pid">{p.pid}</td>
              <td className="cmd">{p.comm}</td>
              <td>{p.cpuPct.toFixed(0)}%</td>
              <td>{mbShort(lang, p.rssMb)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function GraphDetail({
  data,
  selId,
  onSelect,
}: {
  data: GraphData | null;
  selId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { lang, t, m } = useI18n();
  const now = useTick(1000);
  const lastSeen = useRef<GraphNode | null>(null);
  const live = data && selId ? (data.nodes.find((n) => n.id === selId) ?? null) : null;
  if (live) lastSeen.current = live;
  const gone = !!selId && !live && lastSeen.current?.id === selId;
  const node = live ?? (gone ? lastSeen.current : null);

  const byId = useMemo(() => new Map((data?.nodes ?? []).map((n) => [n.id, n])), [data]);
  const lineage = useMemo(() => {
    const chain: GraphNode[] = [];
    for (let c = node?.parent ? byId.get(node.parent) : undefined; c; c = c.parent ? byId.get(c.parent) : undefined) {
      chain.unshift(c);
    }
    return chain;
  }, [node, byId]);
  const children = useMemo(() => (node ? (data?.nodes ?? []).filter((n) => n.parent === node.id) : []), [node, data]);

  if (!node) {
    return (
      <div className="panel detail">
        <header>
          <h2>{t('graph.detail.title')}</h2>
        </header>
        <div className="empty">{t('graph.detail.empty')}</div>
      </div>
    );
  }

  const title = node.kind === 'agent' ? String(node.label) : m(node.label);
  const running = node.state === 'running';
  const elapsed = node.startedAt ? (node.endedAt ?? now) - node.startedAt : null;
  const roleLine = [t(ROLE_KEY[node.role]), t(`graph.kind.${node.kind}`)].filter((x, i, a) => a.indexOf(x) === i).join(' · ');
  const stateText = gone ? t('graph.gone') : stateLabel(lang, node.state as UnitState);

  return (
    <div className={`panel detail gv-detail ${node.role}`}>
      <header>
        <h2>{t(ROLE_KEY[node.role])}</h2>
        <span className={`badge ${gone ? 'idle' : node.state}`}>{stateText}</span>
      </header>
      <div className="body">
        <h3>{title}</h3>
        <div className="path">{node.id}</div>
        <dl className="kv">
          <dt>{t('graph.f.status')}</dt>
          <dd>{roleLine}</dd>
          <dt>{t('graph.f.state')}</dt>
          <dd className={`gv-state ${gone ? 'idle' : node.state}`}>{stateText}</dd>
          <dt>{t('graph.f.launched')}</dt>
          <dd>
            {node.startedAt ? `${clock(lang, node.startedAt)} · ${t('fmt.ago', { d: ago(lang, node.startedAt, now) })}` : '—'}
          </dd>
          <dt>{running ? t('graph.f.uptime') : t('f.duration')}</dt>
          <dd>{dur(lang, elapsed)}</dd>
          {node.endedAt ? (
            <>
              <dt>{t('f.ended')}</dt>
              <dd>{clock(lang, node.endedAt)}</dd>
            </>
          ) : null}
          <dt>{t('f.model')}</dt>
          <dd>{node.model ?? '—'}</dd>
          <dt>{t('graph.f.effort')}</dt>
          <dd>
            {node.effort ? (node.effortSrc && node.effortSrc !== 'cli' ? `${node.effort} · ${t(`graph.effortSrc.${node.effortSrc}`)}` : node.effort) : '—'}
          </dd>
          {lineage.length ? (
            <>
              <dt>{t('graph.f.launchedBy')}</dt>
              <dd className="gv-lineage">
                {lineage.map((c, i) => (
                  <span key={c.id}>
                    {i ? <i> › </i> : null}
                    <button type="button" onClick={() => onSelect(c.id)}>
                      {clipTitle(c, m)}
                    </button>
                  </span>
                ))}
              </dd>
            </>
          ) : null}
          <dt>{t('f.cpuRam')}</dt>
          <dd>{node.res.procs ? `${node.res.cpuPct}% · ${mb(lang, node.res.rssMb)}` : '—'}</dd>
          <dt>{t('f.processes')}</dt>
          <dd>{node.procs.length || (node.res.procs ? node.res.procs : '—')}</dd>
          <TokenRows usage={node.usage} label={running ? t('graph.f.tokensLive') : t('f.tokens')} />
          {node.turnUsage ? <TokenRows usage={node.turnUsage} label={t('graph.f.tokensTurn')} /> : null}
          {node.facts.map((f) => (
            <FactRow key={`${f.k}:${f.v}`} k={f.k} v={f.v} />
          ))}
        </dl>

        <div className="section-t">{t(ACTIVITY_KEY[node.activity.type])}</div>
        {node.activity.text ? (
          <div className={`quote long${node.activity.type === 'command' ? ' mono' : ''}`}>{m(node.activity.text)}</div>
        ) : (
          <div className="gv-none">{t('graph.act.empty')}</div>
        )}

        {node.note ? (
          <>
            <div className="section-t">{node.noteIsError ? t('f.error') : t('f.progress')}</div>
            <div className={`quote${node.noteIsError ? ' err' : ''}`}>{m(node.note)}</div>
          </>
        ) : null}

        {children.length ? (
          <>
            <div className="section-t">{t('graph.launched', { n: children.length })}</div>
            <ul className="gv-kids">
              {children.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => onSelect(c.id)}>
                    <span className={`dot ${c.state}`} />
                    <span className="nm">{clipTitle(c, m)}</span>
                    <span className="rl">{t(ROLE_KEY[c.role])}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        <div className="section-t">{t('graph.procsTitle', { n: node.procs.length })}</div>
        <ProcTable procs={node.procs} />
      </div>
    </div>
  );
}

function clipTitle(n: GraphNode, m: (x: GraphNode['label']) => string): string {
  return clip(n.kind === 'agent' ? String(n.label) : m(n.label), 34);
}

function FactRow({ k, v }: { k: string; v: string }) {
  const { t } = useI18n();
  return (
    <>
      <dt>{t(k)}</dt>
      <dd>{v}</dd>
    </>
  );
}
