import 'server-only'

import {
  identidadeDaRequisicao,
  NaoAutenticadoError,
  permissoesDe,
  permiteIdentidadeDeDesenvolvimento,
  type Identidade,
  type Papel,
} from '@ops/auth'
import { headers } from 'next/headers'

import { pool } from './db'

export { NaoAutenticadoError }
export type { Identidade }

/**
 * Resolve a identidade da requisição na superfície interna.
 *
 * A prova de que a requisição passou pelo proxy é o SEGREDO COMPARTILHADO, não
 * a faixa de rede: em Server Component não existe acesso ao endereço do peer, e
 * `x-forwarded-for` é cabeçalho — usar cabeçalho para se defender de cabeçalho
 * falsificado é circular.
 */
export async function identidade(): Promise<Identidade> {
  const h = await headers()

  const dev = identidadeDeDesenvolvimento()
  if (dev) return dev

  const segredo = process.env['OPS_PROXY_SECRET']
  if (!segredo) {
    // Falha fechada: sem o segredo configurado, ninguém entra. O modo de falha
    // oposto — assumir que está tudo bem — transforma um esquecimento de deploy
    // em acesso irrestrito.
    throw new NaoAutenticadoError('OPS_PROXY_SECRET não configurado nesta instância')
  }

  const brutos: Record<string, string> = {}
  h.forEach((v, k) => (brutos[k] = v))

  return identidadeDaRequisicao(brutos, undefined, {
    dominio: process.env['AUTH_DOMINIO'] ?? 'alloyal.com.br',
    segredoDoProxy: segredo,
    papeisDe: papeisDoBanco,
  })
}

/**
 * Identidade de desenvolvimento, para rodar local sem oauth2-proxy.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ Exige DUAS condições, e as duas são verificadas aqui: não estar em         │
 * │ produção E a variável estar explicitamente definida.                       │
 * │                                                                            │
 * │ Uma saída de desenvolvimento que funcione em produção por engano é a pior  │
 * │ classe de falha de autenticação que existe: silenciosa, total, e descoberta│
 * │ por terceiros. Por isso a checagem de NODE_ENV vem primeiro e não pode ser │
 * │ desligada por configuração.                                                │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
function identidadeDeDesenvolvimento(): Identidade | null {
  const email = process.env['OPS_DEV_EMAIL']
  // A decisão mora em @ops/auth, onde é pura e testada — não aqui.
  if (!permiteIdentidadeDeDesenvolvimento(process.env['NODE_ENV'], email)) return null

  const papeis = (process.env['OPS_DEV_PAPEIS'] ?? 'ops-admin').split(',') as Papel[]
  return { email: email as string, papeis, permissoes: permissoesDe(papeis) }
}

async function papeisDoBanco(email: string): Promise<readonly string[]> {
  const { rows } = await pool().query<{ papel: string }>(
    'SELECT papel FROM ops.user_role WHERE email = $1',
    [email],
  )
  return rows.map((r) => r.papel)
}
