import { redirect } from 'next/navigation'

import { pool } from '../../../../lib/db'
import { exigir, temEscopo } from '../../../../lib/guarda'
import { uuidOu404 } from '../../../../lib/parametro'

export const dynamic = 'force-dynamic'

/**
 * O playbook de um item da fila, por id de VERSÃO.
 *
 * O link da fila aponta para a versão exata que estava anexada ao item, e não
 * para a chave: se apontasse para a chave, o CSM abriria o processo de hoje em vez
 * do que valia quando o item nasceu. Aqui só se resolve o id para a chave e se
 * redireciona ao histórico, onde a versão aparece marcada.
 *
 * O acesso é o da FILA, não o da biblioteca: o CSM precisa ler o playbook do
 * próprio item sem ter permissão de editar o processo do time.
 */
export default async function PlaybookDoItem({ params }: { params: Promise<{ id: string }> }) {
  await exigir((p) => temEscopo(p.fila) || p.configurar, 'playbook')
  const { id: idBruto } = await params
  // Formato antes da consulta: id torto virava 500, e 500 previsível esconde o real.
  const id = uuidOu404(idBruto)

  const { rows } = await pool().query<{ chave: string }>(
    'SELECT chave FROM success.playbook WHERE id = $1',
    [id],
  )
  const chave = rows[0]?.chave
  // Playbook apagado é caso real quando alguém limpa a biblioteca: mandar para a
  // lista é melhor que um 404 sem saída.
  redirect(chave ? `/biblioteca/chave/${encodeURIComponent(chave)}#v-${id}` : '/biblioteca')
}
