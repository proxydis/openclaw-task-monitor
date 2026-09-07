/**
 * Rattachement d'un chemin à un agent, par son workspace.
 *
 * Règle unique, partagée par toutes les pistes de détection : **le workspace le plus long
 * gagne**. `…/workspace` est un préfixe de `…/workspace-neo` sans en être le parent, donc un
 * simple `startsWith` attribuerait à `main` le travail de `neo`.
 */
import path from 'node:path';

export type WorkspaceAgent = { id: string; workspace: string | null };

/** Racine sans slash final. Boucle plutôt que `/\/+$/` : cette regex est un cas de backtracking. */
function trimTrailingSlashes(p: string): string {
  let end = p.length;
  while (end > 1 && p[end - 1] === '/') end--;
  return p.slice(0, end);
}

/**
 * Workspace effectif de chaque agent : celui de la config, sinon la convention
 * `<ocHome>/workspace-<id>` (`workspace` tout court pour l'agent par défaut). Les agents
 * découverts sur disque n'ont pas de workspace en config et seraient sinon inattribuables.
 */
export function withWorkspaces<T extends WorkspaceAgent>(agents: T[], ocHome: string): T[] {
  return agents.map((a) => ({
    ...a,
    workspace: a.workspace ?? path.join(ocHome, a.id === 'main' ? 'workspace' : `workspace-${a.id}`),
  }));
}

/** Agent dont le workspace contient `target` (ou l'est). */
export function agentForPath(target: string | null, agents: WorkspaceAgent[]): string | null {
  if (!target) return null;
  let best: { id: string; len: number } | null = null;
  for (const a of agents) {
    if (!a.workspace) continue;
    const root = trimTrailingSlashes(a.workspace);
    if (target !== root && !target.startsWith(`${root}/`)) continue;
    if (!best || root.length > best.len) best = { id: a.id, len: root.length };
  }
  return best?.id ?? null;
}

/** Agent dont le workspace est cité quelque part dans un texte (ligne de commande, description d'unité). */
export function agentForText(text: string, agents: WorkspaceAgent[]): string | null {
  let best: { id: string; len: number } | null = null;
  for (const a of agents) {
    if (!a.workspace) continue;
    const marker = `${trimTrailingSlashes(a.workspace)}/`;
    if (!text.includes(marker)) continue;
    if (!best || marker.length > best.len) best = { id: a.id, len: marker.length };
  }
  return best?.id ?? null;
}
