/**
 * Outils communs de l'onglet « Travail » : exécution bornée de git/gh et épuration des textes.
 * Rien ici n'écrit ni ne journalise : tout ce qui sort peut finir dans le navigateur.
 */
import { execFile } from 'node:child_process';
import os from 'node:os';

const MAX_PARALLEL = 6;
let running = 0;
const waiting: Array<() => void> = [];

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** Sortie standard, ou `null` en cas d'échec / de dépassement du délai. Jamais d'exception. */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeout?: number; maxBuffer?: number } = {},
): Promise<string | null> {
  return slot(
    () =>
      new Promise<string | null>((resolve) => {
        execFile(
          cmd,
          args,
          {
            cwd: opts.cwd,
            encoding: 'utf8',
            timeout: opts.timeout ?? 5000,
            maxBuffer: opts.maxBuffer ?? 2 * 1024 * 1024,
            // GIT_OPTIONAL_LOCKS=0 : `git status` ne doit jamais prendre le verrou d'index d'un agent au travail
            env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
            windowsHide: true,
          },
          (err, stdout) => resolve(err ? null : String(stdout)),
        );
      }),
  );
}

export const git = (cwd: string, args: string[], timeout = 5000) => run('git', ['-C', cwd, ...args], { timeout });

/** `/home/me/x` → `~/x` : le chemin reste lisible sans révéler le nom d'utilisateur. */
export function shortPath(p: string): string {
  const home = os.homedir();
  return p === home ? '~' : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

/**
 * Efface ce qui ressemble à un secret dans une ligne de commande ou de journal :
 * affectations `CLE=…`, en-têtes d'autorisation, jetons à préfixe connu, longues suites opaques.
 */
export function scrub(text: string): string {
  return text
    .replace(/\b([A-Za-z0-9_.-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL)[A-Za-z0-9_.-]*)\s*([=:])\s*("[^"]*"|'[^']*'|\S+)/gi, '$1$2***')
    .replace(/(authorization|bearer|basic)(\s*:?\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1$2***')
    .replace(/\b(?:sk|pk|xox[abprs]|gh[pousr]|github_pat|glpat|AKIA|AIza|ATTA)[-_A-Za-z0-9]{10,}/g, '***')
    .replace(/([?&](?:key|token|access_token|api_key|apikey|secret|password|sig|signature)=)[^&\s"']+/gi, '$1***')
    .replace(/\b[A-Fa-f0-9]{40,}\b/g, '***')
    .replace(/\b(?=[A-Za-z0-9+]*\d)(?=[A-Za-z0-9+]*[A-Za-z])[A-Za-z0-9+]{40,}={0,2}/g, '***');
}

/** Une ligne, épurée, tronquée. */
export function oneLine(text: string, max: number): string {
  const first = (text.split('\n').find((l) => l.trim()) ?? '').replace(/\s+/g, ' ').trim();
  const s = scrub(first).split(os.homedir()).join('~');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
