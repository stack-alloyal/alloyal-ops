export const dynamic = 'force-dynamic'

/** Health check consumido pelo Docker e pelo painel de operação. */
export function GET() {
  return Response.json({ ok: true, superficie: 'interna', ts: new Date().toISOString() })
}
