import { NextResponse } from 'next/server';
import { getWork } from '@/lib/work';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json(await getWork(), { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    // aucun détail d'erreur : les messages d'exécution peuvent citer des chemins ou des commandes
    return NextResponse.json({ error: 'work_unavailable' }, { status: 500 });
  }
}
