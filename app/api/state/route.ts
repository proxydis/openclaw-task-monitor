import { NextResponse } from 'next/server';
import { getSnapshot } from '@/lib/sampler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json(getSnapshot(), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
