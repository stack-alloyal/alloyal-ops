import 'server-only'

import pg from 'pg'

/**
 * Pool da superfície interna.
 *
 * Conecta como `ops_api`, que NÃO tem acesso a `public_v` — a camada do
 * cliente. Se o interno lesse a versão suprimida, o número mostrado ao CSM
 * passaria a depender do tamanho da base do cliente.
 */
let p: pg.Pool | null = null

export function pool(): pg.Pool {
  if (p) return p
  const url = process.env['DATABASE_URL']
  if (!url) throw new Error('DATABASE_URL não definida.')
  p = new pg.Pool({ connectionString: url, max: 10, application_name: 'ops-web-internal' })
  return p
}
