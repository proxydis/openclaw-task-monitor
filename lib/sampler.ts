import { collectAll } from './collect';
import { filterGraph } from './graph';
import type { GraphData, Snapshot } from './types';

const MIN_INTERVAL = 1500;

let last: Snapshot | null = null;
let lastGraph: GraphData | null = null;
let lastAt = 0;

function refresh(force: boolean) {
  const now = Date.now();
  if (!force && last && lastGraph && now - lastAt < MIN_INTERVAL) return;
  const r = collectAll();
  last = r.snapshot;
  lastGraph = r.graph;
  lastAt = now;
}

/** snapshot mutualisé entre tous les clients : au plus un scan /proc toutes les 1,5 s */
export function getSnapshot(force = false): Snapshot {
  refresh(force);
  return last!;
}

/** graphe de la vue Graph, issu du même balayage que le snapshot ; `inactive` ajoute les unités au repos */
export function getGraph(inactive: boolean): GraphData {
  refresh(false);
  return filterGraph(lastGraph!, inactive);
}
