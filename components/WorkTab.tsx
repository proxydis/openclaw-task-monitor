'use client';

import { useEffect, useState } from 'react';
import type { TrelloCardView, WorkAgent, WorkCi, WorkJob, WorkPr, WorkRepo, WorkState } from '@/lib/work-types';
import { useI18n } from './LangProvider';
import { ago } from './format';
import './work.css';

const POLL_MS = 30_000;

/** Interroge `/api/work` toutes les 30 s, uniquement tant que l'onglet est affiché et la page visible. */
function useWork() {
  const [data, setData] = useState<WorkState | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (!document.hidden) {
        try {
          const r = await fetch('/api/work', { cache: 'no-store' });
          if (!r.ok) throw new Error('http');
          const j = (await r.json()) as WorkState;
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
    const onVisible = () => {
      if (!document.hidden && timer) {
        clearTimeout(timer);
        tick();
      }
    };
    tick();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return { data, err };
}

function useNow(ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

const LABEL_COLORS: Record<string, string> = {
  red: '#f87171',
  orange: '#fb923c',
  yellow: '#fbbf24',
  green: '#34d399',
  blue: '#38bdf8',
  purple: '#a78bfa',
  pink: '#f472b6',
  sky: '#7dd3fc',
  lime: '#a3e635',
  black: '#94a3b8',
};

/** Lien sûr : seuls les liens https:// de l'API sont rendus cliquables. */
const safeUrl = (u: string | null | undefined): string | null => (u && /^https:\/\//.test(u) ? u : null);

function CiLine({ ci }: { ci: WorkCi }) {
  const { t } = useI18n();
  const parts: Array<[keyof WorkCi, string]> = [
    ['success', 'ok'],
    ['failure', 'err'],
    ['pending', 'warn'],
    ['skipped', 'dim'],
  ];
  const shown = parts.filter(([k]) => ci[k] > 0);
  if (!shown.length) return <span className="wk-dim">{t('work.ci.none')}</span>;
  return (
    <span className="wk-ci">
      {shown.map(([k, cls]) => (
        <span key={k} className={`wk-ci-${cls}`}>
          {t(`work.ci.${k}`, { n: ci[k] })}
        </span>
      ))}
    </span>
  );
}

function PrLine({ pr }: { pr: WorkPr | null }) {
  const { t } = useI18n();
  if (!pr) return <div className="wk-pr wk-dim">{t('work.noPr')}</div>;
  const url = safeUrl(pr.url);
  const stateCls = pr.state === 'OPEN' ? 'running' : pr.state === 'MERGED' ? 'scheduled' : 'killed';
  const review = pr.reviewDecision || 'none';
  return (
    <div className="wk-pr">
      <span className="wk-lbl">{t('work.pr')}</span>
      {url ? (
        <a href={url} target="_blank" rel="noopener noreferrer">
          #{pr.number}
        </a>
      ) : (
        <span>#{pr.number}</span>
      )}
      <span className="wk-pr-title" title={pr.title}>
        {pr.title}
      </span>
      <span className={`badge ${stateCls}`}>{t(`work.pr.${pr.state}`)}</span>
      {pr.isDraft ? <span className="badge paused">{t('work.draft')}</span> : null}
      <span className={`badge ${pr.reviewDecision === 'APPROVED' ? 'running' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'failed' : ''}`}>
        {t(`work.review.${review}`)}
      </span>
      <CiLine ci={pr.ci} />
    </div>
  );
}

function Repo({ r, now }: { r: WorkRepo; now: number }) {
  const { lang, t } = useI18n();
  return (
    <div className="wk-repo">
      <div className="wk-repo-head">
        <b>{r.name}</b>
        <span className="badge kind">{r.branch ?? t('work.detached')}</span>
        {r.isWorktree ? <span className="badge">{t('work.worktree')}</span> : null}
        <span className="wk-dim wk-path" title={r.path}>
          {r.path}
        </span>
      </div>
      {r.head ? (
        <div className="wk-head">
          <code>{r.head.hash}</code>
          <span className="wk-subj" title={r.head.subject}>
            {r.head.subject}
          </span>
          <span className="wk-dim">{ago(lang, r.head.ts, now)}</span>
        </div>
      ) : null}
      <div className="wk-meta">
        <span className={r.dirty ? 'wk-warn' : 'wk-dim'}>{r.dirty ? t('work.dirty', { n: r.dirty }) : t('work.clean')}</span>
        {r.upstream ? (
          <>
            {r.ahead ? <span>{t('work.ahead', { n: r.ahead })}</span> : null}
            {r.behind ? <span className="wk-warn">{t('work.behind', { n: r.behind })}</span> : null}
            <span className="wk-dim">{r.upstream}</span>
          </>
        ) : (
          <span className="wk-dim">{t('work.noUpstream')}</span>
        )}
      </div>
      {r.commits.length > 1 ? (
        <details className="wk-commits">
          <summary>{r.commits.length}</summary>
          <ul>
            {r.commits.map((c) => (
              <li key={c.hash}>
                <code>{c.hash}</code>
                <span className="wk-subj" title={c.subject}>
                  {c.subject}
                </span>
                <span className="wk-dim">{ago(lang, c.ts, now)}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <PrLine pr={r.pr} />
    </div>
  );
}

function Card({ c }: { c: TrelloCardView }) {
  const url = safeUrl(c.url);
  return (
    <li className={`wk-card${c.current ? ' cur' : ''}`}>
      <span className="wk-card-n">{c.number}</span>
      {url ? (
        <a href={url} target="_blank" rel="noopener noreferrer" className="wk-card-name" title={c.name}>
          {c.name}
        </a>
      ) : (
        <span className="wk-card-name" title={c.name}>
          {c.name}
        </span>
      )}
      {c.list ? <span className="badge kind">{c.list}</span> : null}
      {c.labels.map((l, i) => (
        <span key={i} className="wk-label" style={{ borderColor: LABEL_COLORS[l.color] ?? 'var(--line)', color: LABEL_COLORS[l.color] ?? 'var(--txt-dim)' }}>
          {l.name || l.color}
        </span>
      ))}
    </li>
  );
}

function Trello({ a }: { a: WorkAgent }) {
  const { t } = useI18n();
  const tr = a.trello;
  if (!tr.current.length && !tr.lots.length) return <div className="wk-dim">{t('work.trelloNone')}</div>;
  return (
    <div>
      {!tr.ok ? <div className="wk-note">{t(tr.configured ? 'work.trelloOff' : 'work.trelloNoKey')}</div> : null}
      {tr.current.length ? (
        <>
          <div className="wk-sub">{t('work.trelloCurrent')}</div>
          <ul className="wk-cards">
            {tr.current.map((c, i) => (
              <Card key={i} c={c} />
            ))}
          </ul>
        </>
      ) : null}
      {tr.lots.map((lot) => (
        <div key={lot.version}>
          <div className="wk-sub">{t('work.trelloLot', { v: lot.version })}</div>
          <ul className="wk-cards">
            {lot.cards.map((c, i) => (
              <Card key={i} c={c} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function Jobs({ jobs, now }: { jobs: WorkJob[]; now: number }) {
  const { lang, t } = useI18n();
  if (!jobs.length) return null;
  return (
    <>
      <div className="wk-sub">{t('work.jobs')}</div>
      <ul className="wk-actions">
        {jobs.map((j) => (
          <li key={j.unit}>
            <span className="wk-when">{ago(lang, j.startedAt, now)}</span>
            <span className={`badge ${j.state === 'running' ? 'running' : 'failed'}`}>
              {t(j.state === 'running' ? 'work.jobRunning' : 'work.jobFailed')}
            </span>
            <span className="wk-arg" title={j.lastLine ?? j.unit}>
              <b>{j.unit}</b>
              {j.lastLine ? <span className="wk-dim"> · {j.lastLine}</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

function AgentWork({ a, now }: { a: WorkAgent; now: number }) {
  const { lang, t } = useI18n();
  return (
    <section className="wk-agent">
      <header>
        <h3>{a.name}</h3>
        <span className={`badge ${a.live ? 'running' : ''}`}>{t(a.live ? 'work.live' : 'work.quiet')}</span>
        <span className="wk-dim">{t('work.updated', { ago: ago(lang, a.lastActivityAt, now) })}</span>
      </header>

      <div className="wk-block">
        <div className="wk-sub">{t('work.step')}</div>
        {a.actions.length ? (
          <ul className="wk-actions">
            {a.actions.map((x, i) => (
              <li key={`${x.ts}-${i}`}>
                <span className="wk-when">{ago(lang, x.ts, now)}</span>
                <span className="badge kind">{x.tool}</span>
                <span className="wk-arg" title={x.arg}>
                  {x.arg}
                  {x.project ? <span className="wk-dim"> · {x.project}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="wk-dim">{t('work.noActions')}</div>
        )}
        <Jobs jobs={a.jobs} now={now} />
      </div>

      <div className="wk-block">
        <div className="wk-sub">{t('work.git')}</div>
        {a.repos.length ? a.repos.map((r) => <Repo key={r.path} r={r} now={now} />) : <div className="wk-dim">{t('work.noRepos')}</div>}
      </div>

      <div className="wk-block">
        <div className="wk-sub">{t('work.trello')}</div>
        <Trello a={a} />
      </div>
    </section>
  );
}

export default function WorkTab() {
  const { t } = useI18n();
  const { data, err } = useWork();
  const now = useNow();

  if (!data) return <div className="body"><div className="empty">{t(err ? 'work.error' : 'work.loading')}</div></div>;
  if (data.redacted) return <div className="body"><div className="empty">{t('work.redacted')}</div></div>;
  return (
    <div className="body wk">
      {err ? <div className="wk-note">{t('work.error')}</div> : null}
      {data.agents.length ? data.agents.map((a) => <AgentWork key={a.id} a={a} now={now} />) : <div className="empty">{t('work.empty')}</div>}
    </div>
  );
}
