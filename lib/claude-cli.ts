import os from 'node:os';
import path from 'node:path';

/**
 * Répertoire de configuration du CLI Claude (`CLAUDE_CONFIG_DIR`, sinon `~/.claude`).
 *
 * Deux modules en dépendent pour des raisons opposées — `anthropic-usage` y lit le jeton
 * OAuth, `token-usage` y lit les transcripts `.jsonl` — et la règle de résolution doit
 * rester unique : si l'utilisateur déplace sa configuration, les deux doivent suivre
 * ensemble, sinon la carte du forfait et les colonnes de jetons désignent deux
 * installations différentes sans que rien ne le signale.
 *
 * Tout ce qui est sous ce répertoire est lu, jamais écrit.
 */
export function claudeCliDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** Racine des transcripts du CLI : `<claudeCliDir>/projects/<slug>/<cliSessionId>.jsonl`. */
export function claudeProjectsDir(): string {
  return path.join(claudeCliDir(), 'projects');
}
