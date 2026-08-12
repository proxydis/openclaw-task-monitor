'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentNode, ProcInfo, Res, SessionNode, Snapshot, TaskNode, UnitState } from '@/lib/types';
import { ago, clock, dur, lvl, mb } from './format';

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

const KIND_LABEL: Record<SessionNode['kind'], string> = {
  main: 'session',
  subagent: 'sous-agent',
  cron: 'planificateur',
};

function Bars({ res, cores }: { res: Res; cores: number }) {
  const cpuW = Math.min(100, (res.cpuPct / (cores * 100)) * 100 * 4);
  const memW = Math.min(100, (res.rssMb / 4096) * 100);
  const zero = res.procs === 0;
  return (
    <div className="metrics">
      <div className={`metric${zero ? ' zero' : ''}`} title={`${res.cpuPct}% d'un cœur · ${res.procs} process`}>
        <span className="bar">
          <i style={{ width: `${cpuW}%` }} />
        </span>
        <span>{res.cpuPct.toFixed(0)}%</span>
      </div>
      <div className={`metric mem${zero ? ' zero' : ''}`} title={`${mb(res.rssMb)} de RSS cumulé`}>
        <span className="bar">
          <i style={{ width: `${memW}%` }} />
        </span>
        <span>{res.rssMb >= 1024 ? `${(res.rssMb / 1024).toFixed(1)}G` : `${res.rssMb}M`}</span>
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
      <span className="age">{age ? ago(age) : ''}</span>
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
  const visible = tasks.filter((t) => match(`${t.title} ${t.detail} ${t.runtime}`));
  if (!visible.length) return null;
  return (
    <div className="kids">
      {visible.map((t) => (
        <Row
          key={t.id}
          depth={depth}
          state={t.state}
          title={t.title}
          subtitle={t.runtime}
          badges={[
            { text: t.stateLabel, cls: t.state },
            ...(t.kind === 'cron' ? [{ text: 'cron', cls: 'scheduled' }] : []),
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
}) {
  return (
    <div className="kids">
      {sessions.map((s) => {
        const tasks = showDone ? s.tasks : s.tasks.filter((t) => t.state !== 'done');
        const kids = s.children.length + tasks.length;
        const id = `s:${s.key}`;
        const isOpen = open.has(id);
        const deep = `${s.title} ${s.subtitle} ${s.key} ${s.tasks.map((t) => t.title).join(' ')}`;
        const selfMatch = match(deep);
        const kidMatch = s.children.some((c) => match(`${c.title} ${c.subtitle}`));
        if (!selfMatch && !kidMatch) return null;
        return (
          <div className="node" key={id}>
            <Row
              depth={depth}
              state={s.state}
              title={s.title}
              subtitle={s.subtitle}
              badges={[
                ...(s.kind === 'subagent' ? [{ text: 'sous-agent', cls: 'sub' }] : []),
                ...(s.kind === 'cron' ? [{ text: 'cron', cls: 'scheduled' }] : []),
                ...(s.state === 'running' ? [{ text: 'en cours', cls: 'running' }] : []),
                ...(tasks.length ? [{ text: `${tasks.length} tâche${tasks.length > 1 ? 's' : ''}`, cls: '' }] : []),
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
                {s.children.length ? (
                  <SessionRows
                    sessions={s.children}
                    agent={agent}
                    depth={depth + 1}
                    cores={cores}
                    open={open}
                    toggle={toggle}
                    sel={sel}
                    setSel={setSel}
                    match={match}
                    showDone={showDone}
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

function Detail({ sel, snap }: { sel: Sel | null; snap: Snapshot }) {
  if (!sel) {
    return (
      <div className="panel detail">
        <header>
          <h2>Détail</h2>
        </header>
        <div className="empty">Sélectionne un agent, une session ou une tâche dans l’arbre.</div>
      </div>
    );
  }

  if (sel.type === 'agent') {
    const a = sel.node;
    return (
      <div className="panel detail">
        <header>
          <h2>Agent</h2>
          <span className={`badge ${a.state}`}>{a.stateLabel}</span>
        </header>
        <div className="body">
          <h3>{a.name}</h3>
          <div className="path">{a.workspace ?? '—'}</div>
          <dl className="kv">
            <dt>Identifiant</dt>
            <dd>{a.id}</dd>
            <dt>Modèle</dt>
            <dd>{a.model ?? '—'}</dd>
            <dt>CPU</dt>
            <dd>{a.res.cpuPct}% · {a.res.procs} process</dd>
            <dt>Mémoire</dt>
            <dd>{mb(a.res.rssMb)}</dd>
            <dt>Dernière activité</dt>
            <dd>{clock(a.lastActivityAt)}</dd>
          </dl>
          <div className="section-t">Compteurs</div>
          <dl className="kv">
            <dt>Sessions</dt>
            <dd>{a.stats.sessions} dont {a.stats.liveSessions} active(s)</dd>
            <dt>Sous-agents</dt>
            <dd>{a.stats.subagents}</dd>
            <dt>Tâches 24 h</dt>
            <dd>{a.stats.tasks24h} · {a.stats.runningTasks} en cours</dd>
            <dt>Échecs 24 h</dt>
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
          <h2>{KIND_LABEL[s.kind]}</h2>
          <span className={`badge ${s.state}`}>{s.stateLabel}</span>
        </header>
        <div className="body">
          <h3>{s.title}</h3>
          <div className="path">{s.key}</div>
          <dl className="kv">
            <dt>Agent</dt>
            <dd>{sel.agent.name}</dd>
            <dt>Canal</dt>
            <dd>{s.subtitle}</dd>
            <dt>Modèle</dt>
            <dd>{s.model ?? sel.agent.model ?? '—'}</dd>
            <dt>Démarrée</dt>
            <dd>{clock(s.startedAt)}</dd>
            <dt>Activité</dt>
            <dd>{clock(s.lastActivityAt)}</dd>
            <dt>CPU / RAM</dt>
            <dd>{s.res.cpuPct}% · {mb(s.res.rssMb)}</dd>
            <dt>Process</dt>
            <dd>{s.pids.length ? s.pids.slice(0, 12).join(', ') : 'aucun (session au repos)'}</dd>
          </dl>
          {s.prompt ? (
            <>
              <div className="section-t">Dernière demande</div>
              <div className="quote">{s.prompt}</div>
            </>
          ) : null}
          {s.tasks.length ? (
            <>
              <div className="section-t">Tâches ({s.tasks.length})</div>
              <div className="quote">
                {s.tasks.map((t) => `[${t.stateLabel}] ${t.title}`).join('\n')}
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
        <h2>Tâche</h2>
        <span className={`badge ${t.state}`}>{t.stateLabel}</span>
      </header>
      <div className="body">
        <h3>{t.title}</h3>
        <div className="path">{t.id}</div>
        <dl className="kv">
          <dt>Agent</dt>
          <dd>{sel.agent.name}</dd>
          <dt>Session</dt>
          <dd>{sel.session?.title ?? '—'}</dd>
          <dt>Runtime</dt>
          <dd>{t.runtime}</dd>
          <dt>Créée</dt>
          <dd>{clock(t.createdAt)}</dd>
          <dt>Démarrée</dt>
          <dd>{clock(t.startedAt)}</dd>
          <dt>Terminée</dt>
          <dd>{t.endedAt ? clock(t.endedAt) : '—'}</dd>
          <dt>Durée</dt>
          <dd>{dur(t.durationMs)}</dd>
          <dt>CPU / RAM</dt>
          <dd>{t.res.procs ? `${t.res.cpuPct}% · ${mb(t.res.rssMb)}` : '—'}</dd>
        </dl>
        {t.summary ? (
          <>
            <div className="section-t">Progression</div>
            <div className="quote">{t.summary}</div>
          </>
        ) : null}
        <div className="section-t">Énoncé</div>
        <div className="quote">{t.detail}</div>
        {t.error ? (
          <>
            <div className="section-t">Erreur</div>
            <div className="quote err">{t.error}</div>
          </>
        ) : null}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ process

function Procs({ procs }: { procs: ProcInfo[] }) {
  return (
    <div className="body" style={{ overflow: 'auto', maxHeight: '70vh' }}>
      <table className="procs">
        <thead>
          <tr>
            <th>PID</th>
            <th>Rôle</th>
            <th>Commande</th>
            <th style={{ textAlign: 'right' }}>CPU</th>
            <th style={{ textAlign: 'right' }}>RSS</th>
            <th style={{ textAlign: 'right' }}>Âge</th>
          </tr>
        </thead>
        <tbody>
          {procs.map((p) => (
            <tr key={p.pid}>
              <td className="n">{p.pid}</td>
              <td>
                <span className={`tag ${p.kind === 'agent-cli' ? 'agentcli' : p.kind}`}>{p.label}</span>
              </td>
              <td title={p.cmd} style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.cmd}
              </td>
              <td className="n">{p.cpuPct.toFixed(1)}%</td>
              <td className="n">{mb(p.rssMb)}</td>
              <td className="n">{ago(p.startedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ page

export default function Dashboard() {
  const { snap, live, err } = useSnapshot();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [selRef, setSelRef] = useState<SelRef | null>(null);
  const [tab, setTab] = useState<'tree' | 'procs'>('tree');
  const [q, setQ] = useState('');
  const [showIdle, setShowIdle] = useState(true);
  const [showDone, setShowDone] = useState(true);
  const bootstrapped = useRef(false);

  // ouvre automatiquement les agents actifs au premier chargement
  useEffect(() => {
    if (!snap || bootstrapped.current) return;
    bootstrapped.current = true;
    const next = new Set<string>();
    let first: Sel | null = null;
    for (const a of snap.agents) {
      if (a.state === 'running') {
        next.add(`a:${a.id}`);
        for (const s of a.sessions)
          if (s.state === 'running') {
            next.add(`s:${s.key}`);
            if (!first) first = { type: 'session', node: s, agent: a };
          }
      }
    }
    setOpen(next);
    if (first) setSelRef({ type: 'session', id: (first as any).node.key });
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
              <div className="sub">connexion au flux…</div>
            </div>
          </div>
        </div>
        <div className="panel">
          <div className="empty">{err ? `Erreur : ${err}` : 'Chargement du premier instantané…'}</div>
        </div>
      </div>
    );
  }

  const h = snap.host;
  const memPct = h.memTotalMb ? (h.memUsedMb / h.memTotalMb) * 100 : 0;
  const swapPct = h.swapTotalMb ? (h.swapUsedMb / h.swapTotalMb) * 100 : 0;
  const agents = snap.agents.filter((a) => showIdle || a.state === 'running');

  return (
    <div className="shell">
      <div className="topbar">
        <div className="brand">
          <span className="logo">◈</span>
          <div>
            <h1>OpenClaw Monitor</h1>
            <div className="sub">
              {h.hostname} · {h.cores} cœurs · uptime {dur(h.uptimeSec * 1000)}
            </div>
          </div>
        </div>
        <div className="live">
          <span className={`pulse${live ? '' : ' off'}`} />
          {live ? 'temps réel' : 'reconnexion…'} · maj {ago(snap.ts)} · scan {snap.collectMs} ms
        </div>
        <div className="live">
          <span className={`dot ${snap.gateway.up ? 'running' : 'failed'}`} />
          gateway {snap.gateway.up ? `pid ${snap.gateway.pid} · port ${snap.gateway.port ?? '?'}` : 'arrêté'}
          {snap.gateway.uptimeSec ? ` · ${dur(snap.gateway.uptimeSec * 1000)}` : ''}
        </div>
      </div>

      {snap.warnings.length ? <div className="warn-banner">{snap.warnings.join(' · ')}</div> : null}

      <div className="kpis">
        <div className="kpi">
          <div className="k">Agents actifs</div>
          <div className="v">
            {snap.totals.activeAgents}
            <span className="u">/ {snap.totals.agents}</span>
          </div>
          <div className="foot">{snap.totals.liveSessions} session(s) vivante(s)</div>
        </div>
        <div className="kpi">
          <div className="k">Tâches en cours</div>
          <div className="v">{snap.totals.runningTasks}</div>
          <div className="foot">{snap.totals.subagentsLive} sous-agent(s) actif(s)</div>
        </div>
        <div className={`kpi${h.cpuPct >= 90 ? ' alert' : ''}`}>
          <div className="k">CPU machine</div>
          <div className="v">
            {h.cpuPct.toFixed(0)}
            <span className="u">%</span>
          </div>
          <div className="meter">
            <i className={lvl(h.cpuPct)} style={{ width: `${h.cpuPct}%` }} />
          </div>
          <div className="foot">load {h.load.map((x) => x.toFixed(2)).join(' · ')}</div>
        </div>
        <div className={`kpi${memPct >= 90 ? ' alert' : ''}`}>
          <div className="k">Mémoire</div>
          <div className="v">
            {(h.memUsedMb / 1024).toFixed(1)}
            <span className="u">/ {(h.memTotalMb / 1024).toFixed(1)} Go</span>
          </div>
          <div className="meter">
            <i className={lvl(memPct)} style={{ width: `${memPct}%` }} />
          </div>
          <div className="foot">{mb(h.memAvailMb)} disponibles</div>
        </div>
        <div className={`kpi${swapPct >= 85 ? ' alert' : ''}`}>
          <div className="k">Swap</div>
          <div className="v">
            {(h.swapUsedMb / 1024).toFixed(1)}
            <span className="u">/ {(h.swapTotalMb / 1024).toFixed(1)} Go</span>
          </div>
          <div className="meter">
            <i className={lvl(swapPct)} style={{ width: `${swapPct}%` }} />
          </div>
          <div className="foot">{swapPct.toFixed(0)} % utilisé</div>
        </div>
        <div className="kpi">
          <div className="k">Gateway</div>
          <div className="v">
            {snap.gateway.res.cpuPct.toFixed(0)}
            <span className="u">% · {mb(snap.gateway.res.rssMb)}</span>
          </div>
          <div className="foot">
            navigateur {mb(snap.system.browser.rssMb)} · {snap.gateway.res.procs} process
          </div>
        </div>
      </div>

      <div className="cols">
        <div className="panel">
          <header>
            <h2>Arbre des agents</h2>
            <div className="tabs">
              <button className={`tab${tab === 'tree' ? ' on' : ''}`} onClick={() => setTab('tree')}>
                Arbre
              </button>
              <button className={`tab${tab === 'procs' ? ' on' : ''}`} onClick={() => setTab('procs')}>
                Process ({snap.procs.length})
              </button>
            </div>
            <input className="search" placeholder="filtrer…" value={q} onChange={(e) => setQ(e.target.value)} />
            <label className="toggle">
              <input type="checkbox" checked={showIdle} onChange={(e) => setShowIdle(e.target.checked)} />
              inactifs
            </label>
            <label className="toggle">
              <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
              terminées
            </label>
          </header>

          {tab === 'procs' ? (
            <Procs procs={snap.procs} />
          ) : (
            <div className="body">
              {agents.length === 0 ? <div className="empty">Aucun agent à afficher.</div> : null}
              {agents.map((a) => {
                const id = `a:${a.id}`;
                const isOpen = open.has(id);
                const sessions = a.sessions.filter((s) => showIdle || s.state === 'running');
                return (
                  <div className="node" key={id}>
                    <Row
                      depth={0}
                      state={a.state}
                      title={a.name}
                      subtitle={a.model ?? undefined}
                      badges={[
                        { text: a.stateLabel, cls: a.state === 'running' ? 'running' : '' },
                        ...(a.stats.runningTasks ? [{ text: `${a.stats.runningTasks} en cours`, cls: 'kind' }] : []),
                        ...(a.stats.subagents ? [{ text: `${a.stats.subagents} sous-agents`, cls: 'sub' }] : []),
                        ...(a.stats.failed24h ? [{ text: `${a.stats.failed24h} échec(s)`, cls: 'failed' }] : []),
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
                        showDone={showDone}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}

          <div className="legend">
            <span>
              <i className="dot running" /> en cours
            </span>
            <span>
              <i className="dot idle" /> inactif
            </span>
            <span>
              <i className="dot paused" /> suspendue
            </span>
            <span>
              <i className="dot done" /> terminée
            </span>
            <span>
              <i className="dot failed" /> échouée
            </span>
            <span>
              <i className="dot killed" /> tuée
            </span>
            <span>
              <i className="dot scheduled" /> planifiée
            </span>
            <span>CPU = % d’un cœur · RAM = RSS cumulé du sous-arbre</span>
          </div>
        </div>

        <Detail sel={sel} snap={snap} />
      </div>
    </div>
  );
}
