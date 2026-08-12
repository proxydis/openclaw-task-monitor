export function ago(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return '—';
  const d = Math.max(0, now - ts);
  if (d < 10_000) return 'à l’instant';
  if (d < 60_000) return `${Math.floor(d / 1000)} s`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} min`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} h`;
  return `${Math.floor(d / 86_400_000)} j`;
}

export function dur(ms: number | null | undefined): string {
  if (ms == null) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} j ${h % 24} h`;
}

export function clock(ts: number | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function mb(v: number): string {
  if (v >= 1024) return `${(v / 1024).toFixed(1)} Go`;
  return `${Math.round(v)} Mo`;
}

export function lvl(pct: number): 'ok' | 'warn' | 'err' {
  if (pct >= 90) return 'err';
  if (pct >= 70) return 'warn';
  return 'ok';
}
