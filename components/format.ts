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

const NF = new Map<string, Intl.NumberFormat>();

/** `Intl.NumberFormat` mémorisé : une instance par (langue, décimales), pas une par cellule. */
function nf(lang: Lang, digits: number): Intl.NumberFormat {
  const key = `${lang}:${digits}`;
  let f = NF.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale(lang), { maximumFractionDigits: digits });
    NF.set(key, f);
  }
  return f;
}

/**
 * Jetons en notation courte, pour une colonne large de quelques caractères :
 * « 812 », « 12,3k », « 145k », « 1,2M ». Le séparateur décimal suit la langue.
 */
export function tokens(lang: Lang, v: number | null | undefined): string {
  if (v == null) return '—';
  if (v < 1000) return nf(lang, 0).format(Math.round(v));
  if (v < 1_000_000) return t(lang, 'fmt.tokK', { v: nf(lang, v < 100_000 ? 1 : 0).format(v / 1000) });
  return t(lang, 'fmt.tokM', { v: nf(lang, v < 100_000_000 ? 1 : 0).format(v / 1_000_000) });
}

/** Valeur exacte, groupée par milliers — réservée aux infobulles et au panneau de détail. */
export function tokensFull(lang: Lang, v: number | null | undefined): string {
  if (v == null) return '—';
  return nf(lang, 0).format(v);
}

const USD = new Map<string, Intl.NumberFormat>();

/** Montant en dollars : sans décimale à partir de 100 $, au cent en dessous. */
export function usd(lang: Lang, v: number | null | undefined): string {
  if (v == null) return '—';
  const digits = v >= 100 ? 0 : 2;
  const key = `${lang}:${digits}`;
  let f = USD.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale(lang), {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    USD.set(key, f);
  }
  return f.format(v);
}

/** Part en pourcentage : une décimale sous 10 %, « < 0,1 % » pour une part non nulle infime. */
export function share(lang: Lang, ratio: number): string {
  const p = ratio * 100;
  if (p > 0 && p < 0.1) return t(lang, 'fmt.pctTiny', { v: nf(lang, 1).format(0.1) });
  return t(lang, 'fmt.pct', { v: nf(lang, p < 10 ? 1 : 0).format(p) });
}

/** Début d'une fenêtre de consommation : « sam. 07:00 », tronqué à la minute. */
export function weekdayTime(lang: Lang, ts: number): string {
  return new Date(Math.floor(ts / 60_000) * 60_000).toLocaleString(locale(lang), {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function lvl(pct: number): 'ok' | 'warn' | 'err' {
  if (pct >= 90) return 'err';
  if (pct >= 70) return 'warn';
  return 'ok';
}
