import { getSnapshot } from '@/lib/sampler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TICK_MS = 2000;

/**
 * Flux SSE ouverts, fermés d'office à l'arrêt du service.
 *
 * En production, le SIGTERM de Next (`start-server.js`) appelle `server.close()` et
 * attend que **toutes** les connexions se terminent avant `process.exit(0)` — il ne force
 * `closeAllConnections()` qu'en dev. Un flux SSE ne se termine jamais de lui-même : tant
 * qu'un navigateur avait le tableau de bord ouvert, chaque `systemctl restart` attendait
 * les 90 s de `TimeoutStopSec` puis finissait en SIGKILL (`Failed with result 'timeout'`).
 *
 * Fermer nos flux ne suffit pas à lui seul, mesuré avec un navigateur connecté : le
 * gestionnaire de Next passe avant le nôtre, et `server.close()` ne ferme les connexions
 * inactives qu'**à l'instant de l'appel**. La connexion keep-alive libérée juste après
 * reste ouverte jusqu'à `keepAliveTimeout` (5 s), et `EventSource` peut même y renvoyer
 * sa reconnexion. D'où trois mesures :
 *
 *  - notre gestionnaire passe en tête (`prependListener`) ;
 *  - chaque flux reçoit `retry:` avant sa fermeture, pour que le navigateur se reconnecte
 *    au nouveau process plutôt qu'à celui qui s'arrête ;
 *  - sortie forcée après `STOP_GRACE_MS` : ce service n'a rien à vider à l'arrêt
 *    (ni `after()` ni écriture), une requête `/api/state` en cours dure ~200 ms.
 */
const streams = new Set<(retryMs?: number) => void>();

const STOP_GRACE_MS = 1000;
/** Délai de reconnexion annoncé au navigateur à l'arrêt : le nouveau process est prêt en ~1 s. */
const RETRY_MS = 1500;

const HOOK = Symbol.for('openclaw-monitor.sse-shutdown');
const g = globalThis as typeof globalThis & { [HOOK]?: true };
if (!g[HOOK]) {
  g[HOOK] = true;
  const shutdown = () => {
    for (const close of [...streams]) close(RETRY_MS);
    setTimeout(() => process.exit(0), STOP_GRACE_MS).unref();
  };
  // en plus du gestionnaire de Next et avant lui, pas à sa place
  process.prependOnceListener('SIGTERM', shutdown);
  process.prependOnceListener('SIGINT', shutdown);
}

export async function GET(req: Request) {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | null = null;
  let close: ((retryMs?: number) => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const push = () => {
        try {
          const snap = getSnapshot();
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(snap)}\n\n`));
        } catch (e: any) {
          controller.enqueue(encoder.encode(`event: err\ndata: ${JSON.stringify({ error: String(e?.message ?? e) })}\n\n`));
        }
      };
      close = (retryMs) => {
        if (timer) clearInterval(timer);
        timer = null;
        if (close) streams.delete(close);
        try {
          if (retryMs) controller.enqueue(encoder.encode(`retry: ${retryMs}\n\n`));
          controller.close();
        } catch {
        }
      };
      streams.add(close);
      push();
      timer = setInterval(push, TICK_MS);
      req.signal.addEventListener('abort', () => close?.());
    },
    cancel() {
      if (timer) clearInterval(timer);
      if (close) streams.delete(close);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
