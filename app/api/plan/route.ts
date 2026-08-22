import { NextResponse } from 'next/server';
import { refreshPlanUsage } from '@/lib/anthropic-usage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Rafraîchissement forcé des limites de forfait (bouton ↻ de la carte). */
export async function GET() {
  const plan = await refreshPlanUsage();
  return NextResponse.json(plan, { headers: { 'Cache-Control': 'no-store' } });
}
