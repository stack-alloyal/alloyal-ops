'use server'

import {
  darDesfecho,
  marcarCenario,
  RenovacaoInvalidaError,
  SemPermissaoRenovacao,
  type CenarioRenovacao,
} from '@pulse/success'
import { redirect } from 'next/navigation'

import { pool } from '../../../lib/db'
import { exigir, temEscopo } from '../../../lib/guarda'

/**
 * As ações da renovação.
 *
 * Permissão reavaliada em cada uma: Server Action é endpoint público, e a tela
 * que desenhou o botão não é prova de nada. O desfecho volta pela URL para a tela
 * funcionar sem JavaScript.
 */
async function tentar(fn: () => Promise<string>): Promise<never> {
  let destino: string
  try {
    destino = `/renovacoes?ok=${encodeURIComponent(await fn())}`
  } catch (err) {
    if (err instanceof RenovacaoInvalidaError || err instanceof SemPermissaoRenovacao) {
      destino = `/renovacoes?erro=${encodeURIComponent(err.message)}`
    } else {
      throw err
    }
  }
  // Fora do try: `redirect` sinaliza por exceção, e capturá-la aqui
  // transformaria todo redirecionamento numa mensagem de erro.
  redirect(destino)
}

export async function acaoCenario(dados: FormData): Promise<void> {
  const id = await exigir((p) => temEscopo(p.fila), 'renovação')
  const nota = String(dados.get('nota') ?? '').trim()
  await tentar(async () => {
    await marcarCenario(
      pool(),
      id,
      String(dados.get('id') ?? ''),
      String(dados.get('cenario') ?? 'base') as CenarioRenovacao,
      nota || undefined,
    )
    return 'leitura registrada'
  })
}

export async function acaoDesfecho(dados: FormData): Promise<void> {
  const id = await exigir((p) => temEscopo(p.fila), 'renovação')
  const desfecho = String(dados.get('desfecho') ?? '') as 'renovada' | 'perdida'
  const nota = String(dados.get('nota') ?? '').trim()
  await tentar(async () => {
    await darDesfecho(pool(), id, String(dados.get('id') ?? ''), desfecho, nota || undefined)
    return desfecho === 'renovada'
      ? 'renovação fechada — entra na acurácia da previsão'
      : 'perda registrada — entra na acurácia da previsão'
  })
}
