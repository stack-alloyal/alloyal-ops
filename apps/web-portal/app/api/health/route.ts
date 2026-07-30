export const dynamic = 'force-dynamic'

export function GET() {
  return Response.json({ ok: true, superficie: 'portal', ts: new Date().toISOString() })
}
