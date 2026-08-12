'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { DEFAULT_LANG, isLang, LANGS, m as render, t as translate, type Lang } from '@/lib/i18n';
import type { Msg } from '@/lib/types';

const STORAGE_KEY = 'openclaw-monitor.lang';

type Ctx = {
  lang: Lang;
  setLang: (l: Lang) => void;
  /** traduit une clé du catalogue */
  t: (key: string, p?: Record<string, string | number>) => string;
  /** rend un `Msg` venu de l'instantané */
  m: (msg: Msg | null | undefined) => string;
};

const LangCtx = createContext<Ctx | null>(null);

/**
 * Langue de l'interface. Le rendu serveur part toujours de `DEFAULT_LANG` (en) ;
 * la préférence enregistrée est appliquée après hydratation pour éviter toute
 * divergence serveur/client.
 */
export function LangProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(DEFAULT_LANG);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      /* localStorage indisponible (mode privé, iframe) */
    }
    if (isLang(stored)) setLangState(stored);
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      window.localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* préférence non persistée, sans conséquence */
    }
  }, []);

  const value = useMemo<Ctx>(
    () => ({
      lang,
      setLang,
      t: (key, p) => translate(lang, key, p),
      m: (msg) => render(lang, msg),
    }),
    [lang, setLang],
  );

  return <LangCtx.Provider value={value}>{children}</LangCtx.Provider>;
}

export function useI18n(): Ctx {
  const ctx = useContext(LangCtx);
  if (!ctx) throw new Error('useI18n doit être utilisé dans <LangProvider>');
  return ctx;
}

export function LangSwitch() {
  const { lang, setLang, t } = useI18n();
  return (
    <div className="langsw" role="group" aria-label={t('ui.langSwitch')}>
      {LANGS.map((l) => (
        <button
          key={l}
          type="button"
          className={`langsw-b${l === lang ? ' on' : ''}`}
          aria-pressed={l === lang}
          onClick={() => setLang(l)}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
