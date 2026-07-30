import 'server-only'

import { NaoAutenticadoError, type Escopo, type Identidade, type Permissoes } from '@ops/auth'
import { forbidden, unauthorized } from 'next/navigation'

import { identidade } from './identidade'

/**
 * Guarda de rota por permissão, não por papel.
 *
 * Checar papel na tela espalha a matriz de permissão pelo código: quando um
 * papel novo aparece — e apareceram três de uma vez quando a ferramenta de
 * contratos entrou — é preciso caçar todas as telas. Checar a PERMISSÃO faz o
 * papel novo herdar o acesso certo pela matriz, num lugar só.
 */
export async function exigir(
  permissao: (p: Permissoes) => boolean,
  _descricao: string,
): Promise<Identidade> {
  let id: Identidade
  try {
    id = await identidade()
  } catch (err) {
    // Falha de autenticação é ESPERADA e não é erro de servidor. Deixá-la virar
    // 500 polui o monitoramento com ruído previsível — e é exatamente assim que
    // o 500 de verdade passa despercebido no meio.
    if (err instanceof NaoAutenticadoError) unauthorized()
    throw err
  }
  if (!permissao(id.permissoes)) forbidden()
  return id
}

export const temEscopo = (e: Escopo) => e !== 'nenhum'
