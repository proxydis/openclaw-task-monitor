import { locale, t, type Lang } from '@/lib/i18n';

export function ago(lang: Lang, ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return '—';
  const d = Math.max(0, now - ts);
  if (d < 10_000) return t(lang, 'fmt.justNow');
  if (d < 60_000) return t(lang, 'fmt.sec', { n: Math.floor(d / 1000) });
  if (d < 3_600_000) return t(lang, 'fmt.min', { n: Math.floor(d / 60_000) });
  if (d < 86_400_000) return t(lang, 'fmt.hour', { n: Math.floor(d / 3_600_000) });
  return t(lang, 'fmt.day', { n: Math.floor(d / 86_400_000) });
}

/** Comme `ago`, mais tourné : « 1 min ago » / « il y a 1 min ». */
export function agoRel(lang: Lang, ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return '—';
  if (now - ts < 10_000) return t(lang, 'fmt.justNow');
  return t(lang, 'fmt.ago', { d: ago(lang, ts, now) });
}

export function dur(lang: Lang, ms: number | null | undefined): string {
  if (ms == null) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return t(lang, 'fmt.sec', { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t(lang, 'fmt.minSec', { m, s: s % 60 });
  const h = Math.floor(m / 60);
  if (h < 24) return t(lang, 'fmt.hourMin', { h, m: m % 60 });
  return t(lang, 'fmt.dayHour', { d: Math.floor(h / 24), h: h % 24 });
}

export function clock(lang: Lang, ts: number | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(locale(lang), {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Échéance de réinitialisation d'une limite de forfait, recalculée à chaque rendu
 * (jamais figée au moment de la collecte) :
 *  - moins de 24 h  → « Réinitialisation dans 1 h 50 min »
 *  - au-delà        → « Réinitialisation jeu. 01:59 » (jour abrégé + heure locale)
 */
export function resetIn(lang: Lang, resetsAt: number | null, now = Date.now()): string | null {
  if (!resetsAt) return null;
  const d = resetsAt - now;
  if (d <= 0) return t(lang, 'plan.resetSoon');
  if (d < 86_400_000) {
    const h = Math.floor(d / 3_600_000);
    const min = Math.floor((d % 3_600_000) / 60_000);
    const span = h > 0 ? t(lang, 'fmt.hourMin', { h, m: min }) : t(lang, 'fmt.min', { n: Math.max(1, min) });
    return t(lang, 'plan.resetIn', { d: span });
  }
  // tronqué à la minute : sans ce plancher, Chrome arrondit 01:59:59 en « 02:00 »
  const when = new Date(Math.floor(resetsAt / 60_000) * 60_000).toLocaleString(locale(lang), {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  return t(lang, 'plan.resetAt', { d: when });
}

export function mb(lang: Lang, v: number): string {
  if (v >= 1024) return t(lang, 'fmt.gb', { v: (v / 1024).toFixed(1) });
  return t(lang, 'fmt.mb', { v: Math.round(v) });
}

export function mbShort(lang: Lang, v: number): string {
  if (v >= 1024) return t(lang, 'fmt.gbShort', { v: (v / 1024).toFixed(1) });
  return t(lang, 'fmt.mbShort', { v: Math.round(v) });
}

export function lvl(pct: number): 'ok' | 'warn' | 'err' {
  if (pct >= 90) return 'err';
  if (pct >= 70) return 'warn';
  return 'ok';
}
