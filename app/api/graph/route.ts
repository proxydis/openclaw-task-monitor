import { NextResponse } from 'next/server';
import { getGraph } from '@/lib/sampler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const inactive = new URL(req.url).searchParams.get('inactive') === '1';
    return NextResponse.json(getGraph(inactive), { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
