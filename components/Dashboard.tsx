'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentNode, PlanLimit, PlanUsage, ProcInfo, Res, SessionNode, Snapshot, TaskNode, UnitState } from '@/lib/types';
import { agentStateLabel, stateLabel } from '@/lib/i18n';
import { LangProvider, LangSwitch, useI18n } from './LangProvider';
import { ago, agoRel, clock, dur, lvl, mb, mbShort, resetIn } from './format';

// ------------------------------------------------------------------ flux

function useSnapshot() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [live, setLive] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let stopped = false;
    let poll: ReturnType<typeof setInterval> | null = null;

    const startPolling = () => {
      if (poll) return;
      const tick = async () => {
        try {
          const r = await fetch('/api/state', { cache: 'no-store' });
          const j = await r.json();
          if (!stopped) {
            setSnap(j);
            setLive(true);
            setErr(null);
          }
        } catch (e: any) {
          if (!stopped) {
            setLive(false);
            setErr(String(e?.message ?? e));
          }
        }
      };
      tick();
      poll = setInterval(tick, 2500);
    };

    try {
      const es = new EventSource('/api/stream');
      esRef.current = es;
      es.onmessage = (ev) => {
        if (stopped) return;
        try {
          setSnap(JSON.parse(ev.data));
          setLive(true);
          setErr(null);
        } catch {
          /* trame partielle */
        }
      };
      es.onerror = () => {
        if (stopped) return;
        setLive(false);
        // EventSource retente seul ; filet de sécurité en polling
        startPolling();
      };
    } catch {
      startPolling();
    }

    return () => {
      stopped = true;
      esRef.current?.close();
      if (poll) clearInterval(poll);
    };
  }, []);

  return { snap, live, err };
}

// ------------------------------------------------------------------ limites du forfait

/** Horloge locale, pour que compte à rebours et « dernière mise à jour » restent vivants. */
function useNow(periodMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), periodMs);
    return () => clearInterval(id);
  }, [periodMs]);
  return now;
}

/**
 * Rafraîchissement forcé via `/api/plan`. La valeur obtenue est conservée localement
 * jusqu'à ce que le flux rapporte un relevé au moins aussi récent.
 */
function usePlan(snapPlan: PlanUsage | null) {
  const [forced, setForced] = useState<PlanUsage | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const r = await fetch('/api/plan', { cache: 'no-store' });
      const j = (await r.json()) as PlanUsage | null;
      if (j) setForced(j);
    } catch {
      /* la carte garde le dernier relevé connu */
    } finally {
      setBusy(false);
    }
  }, []);

  const plan = useMemo(() => {
    if (!forced) return snapPlan;
    if (!snapPlan) return forced;
    return (snapPlan.fetchedAt ?? 0) >= (forced.fetchedAt ?? 0) ? snapPlan : forced;
  }, [snapPlan, forced]);

  return { plan, refresh, busy };
}

function PlanRow({ limit, now }: { limit: PlanLimit; now: number }) {
  const { lang, t: tr, m } = useI18n();
  const name = m(limit.label);
  // limite propre à un modèle et rien de consommé : le modèle n'a pas encore servi.
  // L'échéance existe malgré tout côté API, mais claude.ai affiche bien ce libellé-là.
  const unused = limit.kind === 'weekly_scoped' && limit.percent === 0;
  const sub = unused
    ? tr('plan.notUsedYet', { model: name })
    : resetIn(lang, limit.resetsAt, now);
  return (
    <div className="plan-row">
      <div className="plan-name">{name}</div>
      {sub ? <div className="plan-sub">{sub}</div> : null}
      <div className="plan-gauge">
        <span className="meter">
          <i className={lvl(limit.percent)} style={{ width: `${limit.percent}%` }} />
        </span>
        <span className="plan-pct">{tr('plan.percentUsed', { n: limit.percent })}</span>
      </div>
    </div>
  );
}

function PlanCard({ plan, refresh, busy }: { plan: PlanUsage; refresh: () => void; busy: boolean }) {
  const { lang, t: tr, m } = useI18n();
  const now = useNow(20_000);
  const session = plan.limits.filter((l) => l.group === 'session');
  const weekly = plan.limits.filter((l) => l.group === 'weekly');
  const other = plan.limits.filter((l) => l.group === 'other');
  const throttled = typeof plan.error === 'object' && plan.error?.k === 'plan.err.throttled';

  return (
    <div className="panel plan">
      <header>
        <h2>{tr('plan.title')}</h2>
        {plan.planLabel ? <span className="plan-tier">{plan.planLabel}</span> : null}
      </header>
      <div className="body">
        {plan.error ? (
          // un throttle est un état de fonctionnement normal, pas une panne : les jauges
          // restent affichées, la note explique seulement pourquoi elles ne bougent plus.
          <div className={throttled ? 'plan-note' : 'plan-err'}>{m(plan.error)}</div>
        ) : null}
        {!plan.limits.length && !plan.error ? (
          <div className="empty">{plan.fetchedAt ? tr('plan.empty') : tr('plan.loading')}</div>
        ) : null}
        {session.map((l) => (
          <PlanRow key={l.id} limit={l} now={now} />
        ))}
        {weekly.length ? <div className="section-t">{tr('plan.weekly')}</div> : null}
        {weekly.map((l) => (
          <PlanRow key={l.id} limit={l} now={now} />
        ))}
        {other.map((l) => (
          <PlanRow key={l.id} limit={l} now={now} />
        ))}
      </div>
      <div className="plan-foot">
        <span>{tr('plan.updated', { ago: agoRel(lang, plan.fetchedAt, now) })}</span>
        <button
          type="button"
          className={`plan-refresh${busy ? ' busy' : ''}`}
          title={tr('plan.refresh')}
          aria-label={tr('plan.refresh')}
          disabled={busy || throttled}
          onClick={refresh}
        >
          ↻
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ arbre générique

type Sel =
  | { type: 'agent'; node: AgentNode }
  | { type: 'session'; node: SessionNode; agent: AgentNode }
  | { type: 'task'; node: TaskNode; agent: AgentNode; session: SessionNode | null };

type SelRef = { type: Sel['type']; id: string };

/** Re-résout la sélection dans le dernier instantané pour que le détail reste vivant. */
function resolveSel(snap: Snapshot, ref: SelRef | null): Sel | null {
  if (!ref) return null;
  for (const a of snap.agents) {
    if (ref.type === 'agent') {
      if (a.id === ref.id) return { type: 'agent', node: a };
      continue;
    }
    const stack: SessionNode[] = [...a.sessions];
    while (stack.length) {
      const s = stack.pop()!;
      if (ref.type === 'session' && s.key === ref.id) return { type: 'session', node: s, agent: a };
      if (ref.type === 'task') {
        const t = s.tasks.find((x) => x.id === ref.id);
        if (t) return { type: 'task', node: t, agent: a, session: s };
      }
      stack.push(...s.children);
    }
  }
  return null;
}

const KIND_KEY: Record<SessionNode['kind'], string> = {
  main: 'kind.main',
  subagent: 'kind.subagent',
  cron: 'kind.cron',
};

function Bars({ res, cores }: { res: Res; cores: number }) {
  const { lang, t } = useI18n();
  const cpuW = Math.min(100, (res.cpuPct / (cores * 100)) * 100 * 4);
  const memW = Math.min(100, (res.rssMb / 4096) * 100);
  const zero = res.procs === 0;
  return (
    <div className="metrics">
      <div
        className={`metric${zero ? ' zero' : ''}`}
        title={t('fmt.cpuTip', { p: res.cpuPct, n: res.procs })}
      >
        <span className="bar">
          <i style={{ width: `${cpuW}%` }} />
        </span>
        <span>{res.cpuPct.toFixed(0)}%</span>
      </div>
      <div className={`metric mem${zero ? ' zero' : ''}`} title={t('fmt.memTip', { v: mb(lang, res.rssMb) })}>
        <span className="bar">
          <i style={{ width: `${memW}%` }} />
        </span>
        <span>{mbShort(lang, res.rssMb)}</span>
      </div>
    </div>
  );
}

function Row(props: {
  depth: number;
  state: UnitState;
  title: string;
  subtitle?: string;
  badges?: { text: string; cls?: string }[];
  res?: Res;
  cores: number;
  age?: number | null;
  hasKids: boolean;
  open: boolean;
  selected: boolean;
  onToggle: () => void;
  onSelect: () => void;
}) {
  const { lang } = useI18n();
  const { state, title, subtitle, badges = [], res, cores, age, hasKids, open, selected } = props;
  return (
    <div
      className={`row${selected ? ' sel' : ''}`}
      onClick={() => {
        props.onSelect();
        if (hasKids) props.onToggle();
      }}
    >
      <span className={`caret${hasKids ? (open ? ' open' : '') : ' leaf'}`}>▶</span>
      <span className={`dot ${state}`} />
      <span className="title">
        <span className="t">{title}</span>
        {subtitle ? <span className="s">{subtitle}</span> : null}
      </span>
      {badges.map((b, i) => (
        <span key={i} className={`badge ${b.cls ?? ''}`}>
          {b.text}
        </span>
      ))}
      {res ? <Bars res={res} cores={cores} /> : <div className="metrics" />}
      <span className="age">{age ? ago(lang, age) : ''}</span>
    </div>
  );
}

function TaskRows({
  tasks,
  depth,
  cores,
  sel,
  onSelect,
  match,
}: {
  tasks: TaskNode[];
  depth: number;
  cores: number;
  sel: Sel | null;
  onSelect: (t: TaskNode) => void;
  match: (s: string) => boolean;
}) {
  const { lang, t: tr, m } = useI18n();
  const visible = tasks.filter((t) => match(`${m(t.title)} ${m(t.detail)} ${m(t.runtime)}`));
  if (!visible.length) return null;
  return (
    <div className="kids">
      {visible.map((t) => (
        <Row
          key={t.id}
          depth={depth}
          state={t.state}
          title={m(t.title)}
          subtitle={m(t.runtime)}
          badges={[
            { text: stateLabel(lang, t.state), cls: t.state },
            ...(t.kind === 'cron' ? [{ text: tr('badge.cron'), cls: 'scheduled' }] : []),
          ]}
          res={t.res}
          cores={cores}
          age={t.endedAt ?? t.startedAt ?? t.createdAt}
          hasKids={false}
          open={false}
          selected={sel?.type === 'task' && sel.node.id === t.id}
          onToggle={() => {}}
          onSelect={() => onSelect(t)}
        />
      ))}
    </div>
  );
}

function SessionRows({
  sessions,
  agent,
  depth,
  cores,
  open,
  toggle,
  sel,
  setSel,
  match,
  showDone,
  runningOnly,
}: {
  sessions: SessionNode[];
  agent: AgentNode;
  depth: number;
  cores: number;
  open: Set<string>;
  toggle: (id: string) => void;
  sel: Sel | null;
  setSel: (s: Sel) => void;
  match: (s: string) => boolean;
  showDone: boolean;
  runningOnly: boolean;
}) {
  const { lang, t: tr, m } = useI18n();
  return (
    <div className="kids">
      {sessions.map((s) => {
        const tasks = runningOnly
          ? s.tasks.filter((t) => t.state === 'running')
          : showDone
            ? s.tasks
            : s.tasks.filter((t) => t.state !== 'done');
        const children = runningOnly ? s.children.filter((c) => c.state === 'running') : s.children;
        const kids = children.length + tasks.length;
        const id = `s:${s.key}`;
        const isOpen = open.has(id);
        const deep = `${m(s.title)} ${m(s.subtitle)} ${s.key} ${s.tasks.map((t) => m(t.title)).join(' ')}`;
        const selfMatch = match(deep);
        const kidMatch = children.some((c) => match(`${m(c.title)} ${m(c.subtitle)}`));
        if (!selfMatch && !kidMatch) return null;
        return (
          <div className="node" key={id}>
            <Row
              depth={depth}
              state={s.state}
              title={m(s.title)}
              subtitle={m(s.subtitle)}
              badges={[
                ...(s.kind === 'subagent' ? [{ text: tr('badge.subagent'), cls: 'sub' }] : []),
                ...(s.kind === 'cron' ? [{ text: tr('badge.cron'), cls: 'scheduled' }] : []),
                ...(s.state === 'running' ? [{ text: stateLabel(lang, 'running'), cls: 'running' }] : []),
                ...(tasks.length ? [{ text: tr('badge.tasks', { n: tasks.length }), cls: '' }] : []),
              ]}
              res={s.res}
              cores={cores}
              age={s.lastActivityAt}
              hasKids={kids > 0}
              open={isOpen}
              selected={sel?.type === 'session' && sel.node.key === s.key}
              onToggle={() => toggle(id)}
              onSelect={() => setSel({ type: 'session', node: s, agent })}
            />
            {isOpen ? (
              <>
                {children.length ? (
                  <SessionRows
                    sessions={children}
                    agent={agent}
                    depth={depth + 1}
                    cores={cores}
                    open={open}
                    toggle={toggle}
                    sel={sel}
                    setSel={setSel}
                    match={match}
                    showDone={showDone}
                    runningOnly={runningOnly}
                  />
                ) : null}
                <TaskRows
                  tasks={tasks}
                  depth={depth + 1}
                  cores={cores}
                  sel={sel}
                  onSelect={(t) => setSel({ type: 'task', node: t, agent, session: s })}
                  match={match}
                />
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ détail

function Detail({ sel }: { sel: Sel | null }) {
  const { lang, t: tr, m } = useI18n();

  if (!sel) {
    return (
      <div className="panel detail">
        <header>
          <h2>{tr('detail.title')}</h2>
        </header>
        <div className="empty">{tr('detail.empty')}</div>
      </div>
    );
  }

  if (sel.type === 'agent') {
    const a = sel.node;
    return (
      <div className="panel detail">
        <header>
          <h2>{tr('detail.agent')}</h2>
          <span className={`badge ${a.state}`}>{agentStateLabel(lang, a.state)}</span>
        </header>
        <div className="body">
          <h3>{a.name}</h3>
          <div className="path">{a.workspace ?? '—'}</div>
          <dl className="kv">
            <dt>{tr('f.id')}</dt>
            <dd>{a.id}</dd>
            <dt>{tr('f.model')}</dt>
            <dd>{a.model ?? '—'}</dd>
            <dt>{tr('f.cpu')}</dt>
            <dd>{tr('v.cpuProcs', { p: a.res.cpuPct, n: a.res.procs })}</dd>
            <dt>{tr('f.memory')}</dt>
            <dd>{mb(lang, a.res.rssMb)}</dd>
            <dt>{tr('f.lastActivity')}</dt>
            <dd>{clock(lang, a.lastActivityAt)}</dd>
          </dl>
          <div className="section-t">{tr('f.counters')}</div>
          <dl className="kv">
            <dt>{tr('f.sessions')}</dt>
            <dd>{tr('v.sessionsOf', { n: a.stats.sessions, live: a.stats.liveSessions })}</dd>
            <dt>{tr('f.subagents')}</dt>
            <dd>{a.stats.subagents}</dd>
            <dt>{tr('f.tasks24h')}</dt>
            <dd>{tr('v.tasksOf', { n: a.stats.tasks24h, r: a.stats.runningTasks })}</dd>
            <dt>{tr('f.failed24h')}</dt>
            <dd>{a.stats.failed24h}</dd>
          </dl>
        </div>
      </div>
    );
  }

  if (sel.type === 'session') {
    const s = sel.node;
    return (
      <div className="panel detail">
        <header>
          <h2>{tr(KIND_KEY[s.kind])}</h2>
          <span className={`badge ${s.state}`}>{stateLabel(lang, s.state)}</span>
        </header>
        <div className="body">
          <h3>{m(s.title)}</h3>
          <div className="path">{s.key}</div>
          <dl className="kv">
            <dt>{tr('f.agent')}</dt>
            <dd>{sel.agent.name}</dd>
            <dt>{tr('f.channel')}</dt>
            <dd>{m(s.subtitle)}</dd>
            <dt>{tr('f.model')}</dt>
            <dd>{s.model ?? sel.agent.model ?? '—'}</dd>
            <dt>{tr('f.started')}</dt>
            <dd>{clock(lang, s.startedAt)}</dd>
            <dt>{tr('f.activity')}</dt>
            <dd>{clock(lang, s.lastActivityAt)}</dd>
            <dt>{tr('f.cpuRam')}</dt>
            <dd>
              {s.res.cpuPct}% · {mb(lang, s.res.rssMb)}
            </dd>
            <dt>{tr('f.processes')}</dt>
            <dd>{s.pids.length ? s.pids.slice(0, 12).join(', ') : tr('v.noProcs')}</dd>
          </dl>
          {s.prompt ? (
            <>
              <div className="section-t">{tr('f.lastRequest')}</div>
              <div className="quote">{s.prompt}</div>
            </>
          ) : null}
          {s.tasks.length ? (
            <>
              <div className="section-t">{tr('v.tasksTitle', { n: s.tasks.length })}</div>
              <div className="quote">
                {s.tasks.map((t) => `[${stateLabel(lang, t.state)}] ${m(t.title)}`).join('\n')}
              </div>
            </>
          ) : null}
        </div>
      </div>
    );
  }

  const t = sel.node;
  return (
    <div className="panel detail">
      <header>
        <h2>{tr('detail.task')}</h2>
        <span className={`badge ${t.state}`}>{stateLabel(lang, t.state)}</span>
      </header>
      <div className="body">
        <h3>{m(t.title)}</h3>
        <div className="path">{t.id}</div>
        <dl className="kv">
          <dt>{tr('f.agent')}</dt>
          <dd>{sel.agent.name}</dd>
          <dt>{tr('f.session')}</dt>
          <dd>{sel.session ? m(sel.session.title) : '—'}</dd>
          <dt>{tr('f.runtime')}</dt>
          <dd>{m(t.runtime)}</dd>
          <dt>{tr('f.created')}</dt>
          <dd>{clock(lang, t.createdAt)}</dd>
          <dt>{tr('f.started')}</dt>
          <dd>{clock(lang, t.startedAt)}</dd>
          <dt>{tr('f.ended')}</dt>
          <dd>{t.endedAt ? clock(lang, t.endedAt) : '—'}</dd>
          <dt>{tr('f.duration')}</dt>
          <dd>{dur(lang, t.durationMs)}</dd>
          <dt>{tr('f.cpuRam')}</dt>
          <dd>{t.res.procs ? `${t.res.cpuPct}% · ${mb(lang, t.res.rssMb)}` : '—'}</dd>
        </dl>
        {t.summary ? (
          <>
            <div className="section-t">{tr('f.progress')}</div>
            <div className="quote">{m(t.summary)}</div>
          </>
        ) : null}
        <div className="section-t">{tr('f.prompt')}</div>
        <div className="quote">{m(t.detail)}</div>
        {t.error ? (
          <>
            <div className="section-t">{tr('f.error')}</div>
            <div className="quote err">{m(t.error)}</div>
          </>
        ) : null}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ process

function Procs({ procs }: { procs: ProcInfo[] }) {
  const { lang, t: tr, m } = useI18n();
  return (
    <div className="body" style={{ overflow: 'auto', maxHeight: '70vh' }}>
      <table className="procs">
        <thead>
          <tr>
            <th>{tr('th.pid')}</th>
            <th>{tr('th.role')}</th>
            <th>{tr('th.command')}</th>
            <th style={{ textAlign: 'right' }}>{tr('th.cpu')}</th>
            <th style={{ textAlign: 'right' }}>{tr('th.rss')}</th>
            <th style={{ textAlign: 'right' }}>{tr('th.age')}</th>
          </tr>
        </thead>
        <tbody>
          {procs.map((p) => (
            <tr key={p.pid}>
              <td className="n">{p.pid}</td>
              <td>
                <span className={`tag ${p.kind === 'agent-cli' ? 'agentcli' : p.kind}`}>{m(p.label)}</span>
              </td>
              <td title={p.cmd} style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.cmd}
              </td>
              <td className="n">{p.cpuPct.toFixed(1)}%</td>
              <td className="n">{mb(lang, p.rssMb)}</td>
              <td className="n">{ago(lang, p.startedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ légende

function Legend() {
  const { lang, t: tr } = useI18n();
  const states: UnitState[] = ['running', 'idle', 'paused', 'done', 'failed', 'killed', 'scheduled'];
  return (
    <div className="legend">
      {states.map((s) => (
        <span key={s}>
          <i className={`dot ${s}`} /> {stateLabel(lang, s)}
        </span>
      ))}
      <span>{tr('legend.note')}</span>
    </div>
  );
}

// ------------------------------------------------------------------ page

function DashboardInner() {
  const { lang, t: tr, m } = useI18n();
  const { snap, live, err } = useSnapshot();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [selRef, setSelRef] = useState<SelRef | null>(null);
  const [tab, setTab] = useState<'tree' | 'procs'>('tree');
  const [q, setQ] = useState('');
  const [runningOnly, setRunningOnly] = useState(false);
  const [showIdle, setShowIdle] = useState(true);
  const [showDone, setShowDone] = useState(true);
  const bootstrapped = useRef(false);
  const { plan, refresh: refreshPlan, busy: planBusy } = usePlan(snap?.plan ?? null);

  // ouvre automatiquement les agents actifs au premier chargement
  useEffect(() => {
    if (!snap || bootstrapped.current) return;
    bootstrapped.current = true;
    const next = new Set<string>();
    let first: SessionNode | null = null;
    for (const a of snap.agents) {
      if (a.state === 'running') {
        next.add(`a:${a.id}`);
        for (const s of a.sessions)
          if (s.state === 'running') {
            next.add(`s:${s.key}`);
            if (!first) first = s;
          }
      }
    }
    setOpen(next);
    if (first) setSelRef({ type: 'session', id: first.key });
  }, [snap]);

  const setSel = useCallback((s: Sel) => {
    setSelRef({ type: s.type, id: s.type === 'session' ? s.node.key : s.node.id });
  }, []);
  const sel = snap ? resolveSel(snap, selRef) : null;

  const toggle = useCallback((id: string) => {
    setOpen((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }, []);

  const match = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (s: string) => (needle ? s.toLowerCase().includes(needle) : true);
  }, [q]);

  if (!snap) {
    return (
      <div className="shell">
        <div className="topbar">
          <div className="brand">
            <span className="logo">◈</span>
            <div>
              <h1>OpenClaw Monitor</h1>
              <div className="sub">{tr('ui.connecting')}</div>
            </div>
          </div>
          <LangSwitch />
        </div>
        <div className="panel">
          <div className="empty">{err ? tr('ui.error', { e: err }) : tr('ui.loading')}</div>
        </div>
      </div>
    );
  }

  const h = snap.host;
  const memPct = h.memTotalMb ? (h.memUsedMb / h.memTotalMb) * 100 : 0;
  const swapPct = h.swapTotalMb ? (h.swapUsedMb / h.swapTotalMb) * 100 : 0;
  // « en cours seulement » subsume les deux autres bascules : elles sont neutralisées tant qu'elle est active
  const idleVisible = showIdle && !runningOnly;
  const doneVisible = showDone && !runningOnly;
  const agents = snap.agents.filter((a) => idleVisible || a.state === 'running');

  return (
    <div className="shell">
      <div className="topbar">
        <div className="brand">
          <span className="logo">◈</span>
          <div>
            <h1>OpenClaw Monitor</h1>
            <div className="sub">
              {tr('ui.hostLine', {
                host: m(h.hostname),
                cores: h.cores,
                up: dur(lang, h.uptimeSec * 1000),
              })}
            </div>
          </div>
        </div>
        <div className="live">
          <span className={`pulse${live ? '' : ' off'}`} />
          {tr('ui.streamLine', {
            state: live ? tr('ui.live') : tr('ui.reconnecting'),
            ago: ago(lang, snap.ts),
            ms: snap.collectMs,
          })}
        </div>
        <div className="live">
          <span className={`dot ${snap.gateway.up ? 'running' : 'failed'}`} />
          {snap.gateway.up
            ? tr('ui.gatewayUp', { pid: snap.gateway.pid ?? '?', port: snap.gateway.port ?? '?' })
            : tr('ui.gatewayDown')}
          {snap.gateway.uptimeSec ? ` · ${dur(lang, snap.gateway.uptimeSec * 1000)}` : ''}
        </div>
        <LangSwitch />
      </div>

      {snap.warnings.length ? <div className="warn-banner">{snap.warnings.map(m).join(' · ')}</div> : null}

      <div className="kpis">
        <div className="kpi">
          <div className="k">{tr('kpi.activeAgents')}</div>
          <div className="v">
            {snap.totals.activeAgents}
            <span className="u">/ {snap.totals.agents}</span>
          </div>
          <div className="foot">{tr('kpi.liveSessions', { n: snap.totals.liveSessions })}</div>
        </div>
        <div className="kpi">
          <div className="k">{tr('kpi.runningTasks')}</div>
          <div className="v">{snap.totals.runningTasks}</div>
          <div className="foot">{tr('kpi.liveSubagents', { n: snap.totals.subagentsLive })}</div>
        </div>
        <div className={`kpi${h.cpuPct >= 90 ? ' alert' : ''}`}>
          <div className="k">{tr('kpi.cpu')}</div>
          <div className="v">
            {h.cpuPct.toFixed(0)}
            <span className="u">%</span>
          </div>
          <div className="meter">
            <i className={lvl(h.cpuPct)} style={{ width: `${h.cpuPct}%` }} />
          </div>
          <div className="foot">{tr('kpi.load', { v: h.load.map((x) => x.toFixed(2)).join(' · ') })}</div>
        </div>
        <div className={`kpi${memPct >= 90 ? ' alert' : ''}`}>
          <div className="k">{tr('kpi.memory')}</div>
          <div className="v">
            {(h.memUsedMb / 1024).toFixed(1)}
            <span className="u">/ {mb(lang, h.memTotalMb)}</span>
          </div>
          <div className="meter">
            <i className={lvl(memPct)} style={{ width: `${memPct}%` }} />
          </div>
          <div className="foot">{tr('kpi.available', { v: mb(lang, h.memAvailMb) })}</div>
        </div>
        <div className={`kpi${swapPct >= 85 ? ' alert' : ''}`}>
          <div className="k">{tr('kpi.swap')}</div>
          <div className="v">
            {(h.swapUsedMb / 1024).toFixed(1)}
            <span className="u">/ {mb(lang, h.swapTotalMb)}</span>
          </div>
          <div className="meter">
            <i className={lvl(swapPct)} style={{ width: `${swapPct}%` }} />
          </div>
          <div className="foot">{tr('kpi.swapUsed', { n: swapPct.toFixed(0) })}</div>
        </div>
        <div className="kpi">
          <div className="k">{tr('kpi.gateway')}</div>
          <div className="v">
            {snap.gateway.res.cpuPct.toFixed(0)}
            <span className="u">% · {mb(lang, snap.gateway.res.rssMb)}</span>
          </div>
          <div className="foot">
            {tr('kpi.gatewayFoot', {
              v: mb(lang, snap.system.browser.rssMb),
              n: snap.gateway.res.procs,
            })}
          </div>
        </div>
      </div>

      <div className="cols">
        <div className="panel">
          <header>
            <h2>{tr('panel.tree')}</h2>
            <div className="tabs">
              <button className={`tab${tab === 'tree' ? ' on' : ''}`} onClick={() => setTab('tree')}>
                {tr('tab.tree')}
              </button>
              <button className={`tab${tab === 'procs' ? ' on' : ''}`} onClick={() => setTab('procs')}>
                {tr('tab.procs', { n: snap.procs.length })}
              </button>
            </div>
            <input className="search" placeholder={tr('ui.filter')} value={q} onChange={(e) => setQ(e.target.value)} />
            <label className="toggle">
              <input type="checkbox" checked={runningOnly} onChange={(e) => setRunningOnly(e.target.checked)} />
              {tr('toggle.running')}
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={idleVisible}
                disabled={runningOnly}
                onChange={(e) => setShowIdle(e.target.checked)}
              />
              {tr('toggle.idle')}
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={doneVisible}
                disabled={runningOnly}
                onChange={(e) => setShowDone(e.target.checked)}
              />
              {tr('toggle.done')}
            </label>
          </header>

          {tab === 'procs' ? (
            <Procs procs={snap.procs} />
          ) : (
            <div className="body">
              {agents.length === 0 ? <div className="empty">{tr('ui.noAgents')}</div> : null}
              {agents.map((a) => {
                const id = `a:${a.id}`;
                const isOpen = open.has(id);
                const sessions = a.sessions.filter((s) => idleVisible || s.state === 'running');
                return (
                  <div className="node" key={id}>
                    <Row
                      depth={0}
                      state={a.state}
                      title={a.name}
                      subtitle={a.model ?? undefined}
                      badges={[
                        { text: agentStateLabel(lang, a.state), cls: a.state === 'running' ? 'running' : '' },
                        ...(a.stats.runningTasks
                          ? [{ text: tr('badge.runningTasks', { n: a.stats.runningTasks }), cls: 'kind' }]
                          : []),
                        ...(a.stats.subagents
                          ? [{ text: tr('badge.subagents', { n: a.stats.subagents }), cls: 'sub' }]
                          : []),
                        ...(a.stats.failed24h
                          ? [{ text: tr('badge.failed', { n: a.stats.failed24h }), cls: 'failed' }]
                          : []),
                      ]}
                      res={a.res}
                      cores={h.cores}
                      age={a.lastActivityAt}
                      hasKids={sessions.length > 0}
                      open={isOpen}
                      selected={sel?.type === 'agent' && sel.node.id === a.id}
                      onToggle={() => toggle(id)}
                      onSelect={() => setSel({ type: 'agent', node: a })}
                    />
                    {isOpen ? (
                      <SessionRows
                        sessions={sessions}
                        agent={a}
                        depth={1}
                        cores={h.cores}
                        open={open}
                        toggle={toggle}
                        sel={sel}
                        setSel={setSel}
                        match={match}
                        showDone={doneVisible}
                        runningOnly={runningOnly}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}

          <Legend />
        </div>

        <div className="side">
          {plan ? <PlanCard plan={plan} refresh={refreshPlan} busy={planBusy} /> : null}
          <Detail sel={sel} />
        </div>
      </div>
    </div>
  );
}

export default function Dashboard() {
  return (
    <LangProvider>
      <DashboardInner />
    </LangProvider>
  );
}
