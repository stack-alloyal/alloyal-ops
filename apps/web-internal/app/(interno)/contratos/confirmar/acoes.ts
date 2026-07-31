'use server'

import { ClausulaInvalidaError, confirmar, SemPermissaoContratos } from '@pulse/contratos'
import { redirect } from 'next/navigation'

import { pool } from '../../../../lib/db'
import { exigir, temEscopo } from '../../../../lib/guarda'

/**
 * Confirmar cláusula.
 *
 * A alçada real está em `@pulse/contratos` (só o Jurídico confirma). Aqui só se
 * garante autenticação e acesso à ferramenta — Server Action é endpoint público, e
 * a tela que desenhou o botão não é prova de nada.
 */
export async function acaoConfirmar(dados: FormData): Promise<void> {
  const id = await exigir((p) => temEscopo(p.contas), 'confirmação de cláusula')
  const clausula = String(dados.get('id') ?? '')
  const documentoId = String(dados.get('documentoId') ?? '')
  const trecho = String(dados.get('trecho') ?? '')

  let destino: string
  try {
    await confirmar(pool(), id, clausula, { documentoId, trecho })
    destino = '/contratos/confirmar?ok=' + encodeURIComponent('cláusula confirmada — agora vale para decisão')
  } catch (err) {
    if (err instanceof ClausulaInvalidaError || err instanceof SemPermissaoContratos) {
      destino = '/contratos/confirmar?erro=' + encodeURIComponent(err.message)
    } else {
      throw err
    }
  }
  // Fora do try: `redirect` sinaliza por exceção, e capturá-la aqui
  // transformaria todo redirecionamento numa mensagem de erro.
  redirect(destino)
}
