import { getSnapshot } from '@/lib/sampler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TICK_MS = 2000;

export async function GET(req: Request) {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | null = null;

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
      push();
      timer = setInterval(push, TICK_MS);
      req.signal.addEventListener('abort', () => {
        if (timer) clearInterval(timer);
        try {
          controller.close();
        } catch {
          /* déjà fermé */
        }
      });
    },
    cancel() {
      if (timer) clearInterval(timer);
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
