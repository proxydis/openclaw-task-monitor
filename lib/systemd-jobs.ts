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
import { agentForText, withWorkspaces, type WorkspaceAgent } from './workspaces';

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

export type JobAgent = WorkspaceAgent;

/** Unités d'infrastructure : elles vivent dans un workspace d'agent sans être un job. */
const INFRA = ['openclaw-gateway.service', 'openclaw-monitor.service'];

/** Chemin absolu : résoudre `systemctl` via `PATH` reviendrait à exécuter ce que le PATH du service désigne. */
const SYSTEMCTL = '/usr/bin/systemctl';

const CGROUP_ROOT = '/sys/fs/cgroup';

const PROPS = [
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

function sh(args: string[], timeout = 3000): string {
  try {
    return execFileSync(SYSTEMCTL, args, {
      encoding: 'utf8',
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

const STAMP = /(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/;

/**
 * `ExecMainStartTimestamp=Mon 2026-09-07 21:45:47 CEST` → ms epoch.
 * Le jour de semaine et l'abréviation de fuseau ne sont pas parsables par `Date`; l'heure est
 * donc lue dans le fuseau du process Node. C'est juste tant que le monitor tourne sur l'hôte
 * des jobs et sans `TZ` forcé — condition rappelée dans `openclaw-monitor.service.example`.
 */
function parseStamp(v: string | undefined): number | null {
  if (!v) return null;
  const m = STAMP.exec(v);
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

/**
 * Rattache une unité à un agent. Deux signatures, dans cet ordre : le préfixe de nom
 * (`neo-carte20.service`), puis le workspace cité dans la ligne de commande — un job nommé
 * librement reste attribué.
 */
function attribute(unit: string, haystack: string, agents: JobAgent[]): string | null {
  for (const a of agents) if (unit.startsWith(`${a.id}-`)) return a.id;
  return agentForText(haystack, agents);
}

/** Un bloc `Clé=valeur` de `systemctl show` → l'enregistrement correspondant. */
function parseUnitBlock(block: string, agents: JobAgent[]): SystemdJob | null {
  const kv: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
  }
  const unit = kv.Id;
  if (!unit) return null;
  // `ExecStart={ path=/bin/bash ; argv[]=… }` : la ligne complète suffit à l'attribution
  const execStart = kv.ExecStart || null;
  const agentId = attribute(unit, `${unit} ${kv.Description ?? ''} ${execStart ?? ''}`, agents);
  if (!agentId) return null;
  return {
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
  };
}

/** Unités `--user` candidates : nom ou description rattachable à un agent, hors infrastructure. */
function candidateUnits(agents: JobAgent[]): string[] {
  const raw = sh(['--user', 'list-units', '--type=service', '--all', '--output=json'], 2500);
  if (!raw.trim()) return [];
  let units: Array<{ unit?: string; description?: string }>;
  try {
    units = JSON.parse(raw);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const u of units) {
    const name = u.unit ?? '';
    if (!name.endsWith('.service') || INFRA.includes(name)) continue;
    if (!attribute(name, `${name} ${u.description ?? ''}`, agents)) continue;
    out.push(name);
  }
  return out;
}

/**
 * Toutes les unités `--user` attribuables à un agent, vivantes ou terminées récemment.
 * `systemd-run` laisse l'unité visible après la fin tant qu'elle n'est pas nettoyée :
 * on garde ce qui tourne, et ce qui a échoué (un job mort en silence doit se voir).
 */
export function collectSystemdJobs(rawAgents: JobAgent[], ocHome: string): SystemdJob[] {
  if (!rawAgents.length) return [];
  const agents = withWorkspaces(rawAgents, ocHome);
  const candidates = candidateUnits(agents);
  if (!candidates.length) return [];
  const shown = sh(['--user', 'show', ...candidates, `--property=${PROPS}`], 4000);
  if (!shown.trim()) return [];

  const jobs: SystemdJob[] = [];
  for (const block of shown.split(/\n\s*\n/)) {
    if (!block.trim()) continue;
    const job = parseUnitBlock(block, agents);
    if (job) jobs.push(job);
  }
  return jobs;
}

/**
 * PID principal des services d'infrastructure. Un job `nohup` hérite du cgroup de qui l'a
 * lancé — souvent celui de la gateway — donc le cgroup ne suffit pas à écarter les services
 * eux-mêmes de la détection des jobs détachés ; leur `MainPID`, si.
 */
export function infraMainPids(): Set<number> {
  const out = new Set<number>();
  const shown = sh(['--user', 'show', ...INFRA, '--property=MainPID'], 2000);
  for (const m of shown.matchAll(/MainPID=(\d+)/g)) {
    const pid = Number(m[1]);
    if (pid > 0) out.add(pid);
  }
  return out;
}

/** Ligne de commande lisible extraite d'`ExecStart`, sans le décor systemd. */
export function jobCommand(j: SystemdJob): string {
  const m = /argv\[\]=([^;]+);/.exec(j.execStart ?? '');
  const cmd = (m ? m[1] : (j.execStart ?? '')).trim();
  return cmd || j.description;
}
