import fs from 'node:fs';
import os from 'node:os';

const HZ = 100; // USER_HZ sous Linux
const PAGE_MB = 4096 / (1024 * 1024);

export type RawProc = {
  pid: number;
  ppid: number;
  comm: string;
  cmd: string;
  ticks: number;
  rssMb: number;
  startedAt: number;
  cpuPct: number;
};

let bootTimeMs = 0;
function bootTime(): number {
  if (bootTimeMs) return bootTimeMs;
  try {
    const stat = fs.readFileSync('/proc/stat', 'utf8');
    const m = stat.match(/^btime\s+(\d+)/m);
    if (m) bootTimeMs = Number(m[1]) * 1000;
  } catch {
    /* noop */
  }
  if (!bootTimeMs) bootTimeMs = Date.now() - os.uptime() * 1000;
  return bootTimeMs;
}

// état précédent pour le calcul du delta CPU
const prevTicks = new Map<number, number>();
let prevAt = 0;
let prevCpuTotal = 0;
let prevCpuIdle = 0;
let hostCpuPct = 0;

function readCmd(pid: number): string {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`);
    return raw.toString('utf8').replace(/\0/g, ' ').trim();
  } catch {
    return '';
  }
}

/** Scanne /proc et renvoie les process de l'utilisateur courant, avec le %CPU calculé sur l'intervalle. */
export function scanProcs(): Map<number, RawProc> {
  const now = Date.now();
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  const dt = prevAt ? (now - prevAt) / 1000 : 0;
  const out = new Map<number, RawProc>();
  const seen = new Set<number>();

  let entries: string[] = [];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return out;
  }

  for (const e of entries) {
    if (e.charCodeAt(0) < 48 || e.charCodeAt(0) > 57) continue;
    const pid = Number(e);
    if (!Number.isFinite(pid)) continue;
    let stat: string;
    try {
      if (uid >= 0 && fs.statSync(`/proc/${e}`).uid !== uid) continue;
      stat = fs.readFileSync(`/proc/${e}/stat`, 'utf8');
    } catch {
      continue;
    }
    const close = stat.lastIndexOf(')');
    if (close < 0) continue;
    const comm = stat.slice(stat.indexOf('(') + 1, close);
    const rest = stat.slice(close + 2).split(' ');
    // rest[0]=state, rest[1]=ppid ... indices décalés de 4 par rapport à proc(5)
    const ppid = Number(rest[1]);
    const utime = Number(rest[11]);
    const stime = Number(rest[12]);
    const starttime = Number(rest[19]);
    const rssPages = Number(rest[21]);
    const ticks = utime + stime;

    let cpuPct = 0;
    const prev = prevTicks.get(pid);
    if (prev !== undefined && dt > 0.2) {
      cpuPct = Math.max(0, ((ticks - prev) / HZ / dt) * 100);
    }
    prevTicks.set(pid, ticks);
    seen.add(pid);

    out.set(pid, {
      pid,
      ppid,
      comm,
      cmd: readCmd(pid),
      ticks,
      rssMb: Math.round(rssPages * PAGE_MB * 10) / 10,
      startedAt: bootTime() + (starttime / HZ) * 1000,
      cpuPct: Math.round(cpuPct * 10) / 10,
    });
  }

  for (const pid of prevTicks.keys()) if (!seen.has(pid)) prevTicks.delete(pid);
  prevAt = now;

  // CPU global de la machine
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const v = line.split(/\s+/).slice(1).map(Number).filter((n) => Number.isFinite(n));
    const total = v.reduce((a, b) => a + b, 0);
    const idle = (v[3] ?? 0) + (v[4] ?? 0);
    if (prevCpuTotal && total > prevCpuTotal) {
      const dTotal = total - prevCpuTotal;
      const dIdle = idle - prevCpuIdle;
      hostCpuPct = Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100));
    }
    prevCpuTotal = total;
    prevCpuIdle = idle;
  } catch {
    /* noop */
  }

  return out;
}

export function getHostCpuPct(): number {
  return Math.round(hostCpuPct * 10) / 10;
}

export function readMemInfo() {
  const info: Record<string, number> = {};
  try {
    for (const line of fs.readFileSync('/proc/meminfo', 'utf8').split('\n')) {
      const m = line.match(/^(\w+):\s+(\d+) kB/);
      if (m) info[m[1]] = Number(m[2]) / 1024; // Mo
    }
  } catch {
    /* noop */
  }
  const memTotal = Math.round(info.MemTotal ?? 0);
  const memAvail = Math.round(info.MemAvailable ?? 0);
  const swapTotal = Math.round(info.SwapTotal ?? 0);
  const swapFree = Math.round(info.SwapFree ?? 0);
  return {
    memTotalMb: memTotal,
    memAvailMb: memAvail,
    memUsedMb: Math.max(0, memTotal - memAvail),
    swapTotalMb: swapTotal,
    swapUsedMb: Math.max(0, swapTotal - swapFree),
  };
}

/**
 * Unité systemd d'un process, lue dans son cgroup. Seul lien fiable vers l'unité pour un
 * job dont l'ancêtre commun est mort ; `null` pour un process hors unité (nohup depuis un
 * terminal, où le cgroup est un `.scope` de session).
 */
export function unitOfPid(pid: number): string | null {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8').split('\n')[0];
    // le dernier segment `.service` est l'unité du process : `…/user@1000.service/app.slice/
    // neo-temsi2.service` appartient à `neo-temsi2`, pas au gestionnaire de session
    const services = raw.split('/').filter((s) => s.endsWith('.service'));
    const last = services.at(-1);
    return last ? last.replace(/\\x2d/g, '-') : null;
  } catch {
    return null;
  }
}

/** index pid -> enfants directs */
export function childIndex(procs: Map<number, RawProc>): Map<number, number[]> {
  const idx = new Map<number, number[]>();
  for (const p of procs.values()) {
    const arr = idx.get(p.ppid);
    if (arr) arr.push(p.pid);
    else idx.set(p.ppid, [p.pid]);
  }
  return idx;
}

/** tous les descendants (inclus) d'un pid */
export function descendants(root: number, kids: Map<number, number[]>, stop?: Set<number>): number[] {
  const out: number[] = [];
  const stack = [root];
  const seen = new Set<number>();
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    for (const c of kids.get(pid) ?? []) {
      if (stop?.has(c)) continue;
      stack.push(c);
    }
  }
  return out;
}
