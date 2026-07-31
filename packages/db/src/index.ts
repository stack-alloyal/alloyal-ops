/**
 * @pulse/db — acesso ao banco e imposição de tenant.
 *
 * Doc 00, seção 5.4.
 */

import pg from 'pg'

export { migrate } from './migrate.js'
export * from './seed/index.js'

/**
 * Pool do gateway EXTERNO (portal do cliente).
 *
 * Conecta como `pulse_portal`, que só tem USAGE em `public_v` e só SELECT.
 * Qualquer tentativa de alcançar `core`, `fact`, `metrics` ou `analytics`
 * falha com permission denied no próprio banco — não depende de o código estar
 * correto.
 */
export function poolPortal(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10, application_name: 'ops-portal' })
}

/** Pool do gateway interno. Conecta como `pulse_api`, sem acesso a `public_v`. */
export function poolApi(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 20, application_name: 'ops-api' })
}

export class TenantAusenteError extends Error {
  constructor() {
    super(
      'Consulta externa sem tenant resolvido. O identificador do cliente vem do token, nunca de parâmetro (doc 00, 5.4, camada 1).',
    )
    this.name = 'TenantAusenteError'
  }
}

/**
 * Executa uma consulta do portal dentro de uma transação com o tenant definido.
 *
 * ┌───────────────────────────────────────────────────────────────────────┐
 * │ Este é o ÚNICO caminho suportado para o portal ler dado.              │
 * │                                                                       │
 * │ `public_v.set_tenant()` usa set_config(..., true) — transaction-local.│
 * │ Em nível de sessão, o GUC persistiria na conexão e a próxima           │
 * │ requisição que tirasse essa conexão do pool herdaria o tenant          │
 * │ anterior. Com pool de 10 conexões e requisições concorrentes, isso é   │
 * │ vazamento entre clientes — e passa em teste unitário sem sintoma.     │
 * └───────────────────────────────────────────────────────────────────────┘
 */
export async function comTenant<T>(
  pool: pg.Pool,
  accountId: string | null | undefined,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  if (!accountId) throw new TenantAusenteError()

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT public_v.set_tenant($1)', [accountId])
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
}
