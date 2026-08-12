import { collect } from './collect';
import type { Snapshot } from './types';

const MIN_INTERVAL = 1500;

let last: Snapshot | null = null;
let lastAt = 0;

/** snapshot mutualisé entre tous les clients : au plus un scan /proc toutes les 1,5 s */
export function getSnapshot(force = false): Snapshot {
  const now = Date.now();
  if (!force && last && now - lastAt < MIN_INTERVAL) return last;
  last = collect();
  lastAt = now;
  return last;
}
