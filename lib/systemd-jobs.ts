/**
 * Jobs de fond lancés par les agents hors OpenClaw.
 *
 * Un agent qui détache un traitement long le fait avec `systemd-run --user` (voir la
 * consigne « job ≥ 1 h » des AGENTS.md). Ce job ne laisse aucune trace dans le store
 * OpenClaw : ni `subagent_runs`, ni `cron_jobs`, ni session. Il était donc totalement
 * absent du dashboard, alors que c'est précisément le travail le plus long et le plus
 * utile à surveiller. Ce module lit ces unités directement chez systemd et les rattache
 * à leur agent.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type SystemdJob = {
  /** nom d'unité, ex. `neo-temsi1.service` */
  unit: string;
  agentId: string;
  description: string;
  execStart: string | null;
  activeState: string;
  subState: string;
  result: string;
  startedAt: number | null;
  endedAt: number | null;
  pids: number[];
};

export type JobAgent = { id: string; workspace: string | null };

/** Unités d'infrastructure : elles vivent dans un workspace d'agent sans être un job. */
const INFRA = new Set(['openclaw-gateway.service', 'openclaw-monitor.service']);

const CGROUP_ROOT = '/sys/fs/cgroup';

function sh(args: string[], timeout = 3000): string {
  try {
    return execFileSync('systemctl', args, {
      encoding: 'utf8',
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

/**
 * `ExecMainStartTimestamp=Mon 2026-09-07 21:45:47 CEST` → ms epoch.
 * Le jour de semaine et l'abréviation de fuseau ne sont pas parsables par `Date`;
 * le monitor tourne sur l'hôte des jobs, donc l'heure locale est la bonne lecture.
 */
function parseStamp(v: string | undefined): number | null {
  if (!v) return null;
  const m = v.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/);
  if (!m) return null;
  const t = new Date(`${m[1]}T${m[2]}`).getTime();
  return Number.isFinite(t) ? t : null;
}

/** PIDs vivants d'une unité, lus dans son cgroup (sous-arbre inclus). */
function cgroupPids(controlGroup: string | undefined): number[] {
  if (!controlGroup) return [];
  const out: number[] = [];
  const stack = [path.join(CGROUP_ROOT, controlGroup)];
  while (stack.length) {
    const dir = stack.pop()!;
    try {
      for (const line of fs.readFileSync(path.join(dir, 'cgroup.procs'), 'utf8').split('\n')) {
        const pid = Number(line.trim());
        if (Number.isFinite(pid) && pid > 0) out.push(pid);
      }
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) stack.push(path.join(dir, e.name));
      }
    } catch {
      /* unité déjà partie */
    }
  }
  return out;
}

/** Workspace effectif d'un agent : celui de la config, sinon la convention `workspace-<id>`. */
function workspaceOf(a: JobAgent, ocHome: string): string {
  return a.workspace ?? path.join(ocHome, a.id === 'main' ? 'workspace' : `workspace-${a.id}`);
}

/**
 * Rattache une unité à un agent. Deux signatures, dans cet ordre :
 * le préfixe de nom (`neo-carte20.service`), puis le workspace cité dans la ligne de
 * commande (`.../workspace-neo/run-temsi1.sh`) — un job nommé librement reste attribué.
 */
function attribute(unit: string, haystack: string, agents: JobAgent[], ocHome: string): string | null {
  for (const a of agents) if (unit.startsWith(`${a.id}-`)) return a.id;
  let best: { id: string; len: number } | null = null;
  for (const a of agents) {
    const ws = `${workspaceOf(a, ocHome).replace(/\/+$/, '')}/`;
    // le plus long gagne : `/workspace/` ne doit pas rafler ce qui est à `/workspace-neo/`
    if (haystack.includes(ws) && (!best || ws.length > best.len)) best = { id: a.id, len: ws.length };
  }
  return best?.id ?? null;
}

/**
 * Toutes les unités `--user` attribuables à un agent, vivantes ou terminées récemment.
 * `systemd-run` laisse l'unité visible après la fin tant qu'elle n'est pas nettoyée :
 * on garde ce qui tourne, et ce qui a échoué (un job mort en silence doit se voir).
 */
export function collectSystemdJobs(agents: JobAgent[], ocHome: string): SystemdJob[] {
  if (!agents.length) return [];
  const raw = sh(['--user', 'list-units', '--type=service', '--all', '--output=json'], 2500);
  if (!raw.trim()) return [];
  let units: Array<{ unit?: string; active?: string; sub?: string; description?: string }>;
  try {
    units = JSON.parse(raw);
  } catch {
    return [];
  }

  const candidates: string[] = [];
  for (const u of units) {
    const name = u.unit ?? '';
    if (!name.endsWith('.service') || INFRA.has(name)) continue;
    if (!attribute(name, `${name} ${u.description ?? ''}`, agents, ocHome)) continue;
    candidates.push(name);
  }
  if (!candidates.length) return [];

  const props = [
    'Id',
    'Description',
    'ActiveState',
    'SubState',
    'Result',
    'ExecMainStartTimestamp',
    'ExecMainExitTimestamp',
    'ActiveEnterTimestamp',
    'InactiveEnterTimestamp',
    'ControlGroup',
    'ExecStart',
  ].join(',');
  const shown = sh(['--user', 'show', ...candidates, `--property=${props}`], 4000);
  if (!shown.trim()) return [];

  const jobs: SystemdJob[] = [];
  for (const block of shown.split(/\n\s*\n/)) {
    if (!block.trim()) continue;
    const kv: Record<string, string> = {};
    for (const line of block.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
    }
    const unit = kv.Id;
    if (!unit) continue;
    // `ExecStart={ path=/bin/bash ; argv[]=... }` : la ligne complète suffit à l'attribution
    const execStart = kv.ExecStart || null;
    const agentId = attribute(unit, `${unit} ${kv.Description ?? ''} ${execStart ?? ''}`, agents, ocHome);
    if (!agentId) continue;
    jobs.push({
      unit,
      agentId,
      description: kv.Description || unit,
      execStart,
      activeState: kv.ActiveState || 'unknown',
      subState: kv.SubState || '',
      result: kv.Result || '',
      startedAt: parseStamp(kv.ExecMainStartTimestamp) ?? parseStamp(kv.ActiveEnterTimestamp),
      endedAt: parseStamp(kv.ExecMainExitTimestamp) ?? parseStamp(kv.InactiveEnterTimestamp),
      pids: cgroupPids(kv.ControlGroup),
    });
  }
  return jobs;
}

/** Ligne de commande lisible extraite d'`ExecStart`, sans le décor systemd. */
export function jobCommand(j: SystemdJob): string {
  const m = j.execStart?.match(/argv\[\]=([^;]+);/);
  const cmd = (m ? m[1] : j.execStart ?? '').trim();
  return cmd || j.description;
}
