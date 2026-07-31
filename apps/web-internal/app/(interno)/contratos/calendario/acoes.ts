'use server'

import { cumprirObrigacao, dispensarObrigacao, ObrigacaoInvalidaError } from '@ops/contratos'
import { redirect } from 'next/navigation'

import { pool } from '../../../../lib/db'
import { exigir, temEscopo } from '../../../../lib/guarda'

/** Fecha uma obrigação — cumprida, ou dispensada com motivo. */
export async function acaoObrigacao(dados: FormData): Promise<void> {
  const id = await exigir((p) => temEscopo(p.contas), 'obrigações contratuais')
  const obrigacao = String(dados.get('id') ?? '')
  const acao = String(dados.get('acao') ?? '')
  const motivo = String(dados.get('motivo') ?? '')

  let destino: string
  try {
    if (acao === 'dispensar') {
      await dispensarObrigacao(pool(), id, obrigacao, motivo)
      destino = '/contratos/calendario?ok=' + encodeURIComponent('obrigação dispensada, com o motivo registrado')
    } else {
      await cumprirObrigacao(pool(), id, obrigacao)
      destino = '/contratos/calendario?ok=' + encodeURIComponent('obrigação registrada como cumprida')
    }
  } catch (err) {
    if (err instanceof ObrigacaoInvalidaError) {
      destino = '/contratos/calendario?erro=' + encodeURIComponent(err.message)
    } else {
      throw err
    }
  }
  // Fora do try: `redirect` sinaliza por exceção.
  redirect(destino)
}
