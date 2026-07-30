/**
 * Pool do worker, resolvido uma vez.
 *
 * Os ciclos precisam de banco, e receber o pool por parâmetro em cada um
 * espalharia infraestrutura pelo contrato do ciclo — que existe justamente para
 * descrever o QUE o ciclo faz, não com o que ele se conecta.
 */
import pg from 'pg'

let pool: pg.Pool | null = null

export function poolDoWorker(): pg.Pool {
  if (pool) return pool
  const url = process.env['DATABASE_URL_WORKER'] ?? process.env['DATABASE_URL_ADMIN'] ?? process.env['DATABASE_URL']
  if (!url) throw new Error('DATABASE_URL_WORKER não definida.')
  pool = new pg.Pool({ connectionString: url, max: 8, application_name: 'ops-worker' })
  return pool
}

/** Injeta um pool — usado pelos testes e pelo backfill. */
export function definirPool(p: pg.Pool): void {
  pool = p
}
