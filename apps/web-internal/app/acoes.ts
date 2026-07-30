'use server'

import { fecharItem, NaoEhSeuError, type Desfecho } from '@ops/success'
import { revalidatePath } from 'next/cache'

import { pool } from '../lib/db'
import { exigir, temEscopo } from '../lib/guarda'

/**
 * Fechar item da fila.
 *
 * A permissão é reavaliada AQUI e não confiada à tela que desenhou o botão:
 * uma Server Action é um endpoint público: qualquer pessoa autenticada pode
 * chamá-la com um id qualquer, sem passar pela página que a renderizou.
 */
export async function fechar(dados: FormData): Promise<void> {
  const id = await exigir((p) => temEscopo(p.fila), 'fila de trabalho')

  const item = String(dados.get('id') ?? '')
  const desfecho = String(dados.get('desfecho') ?? '') as Desfecho
  const nota = String(dados.get('nota') ?? '').trim()

  try {
    await fecharItem(pool(), id, item, desfecho, nota || undefined)
  } catch (err) {
    // Item de outra carteira ou já fechado. Não é erro de servidor, e virar 500
    // aqui esconderia o 500 de verdade no meio do ruído previsível.
    if (err instanceof NaoEhSeuError) return
    throw err
  }
  revalidatePath('/')
}
