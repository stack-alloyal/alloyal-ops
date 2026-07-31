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

/**
 * Há identidade? Sem lançar, para o LAYOUT poder decidir o que envolver.
 *
 * Existe por um defeito que só a captura de tela mostrou: `unauthorized.tsx` fica
 * dentro do grupo `(interno)`, então a tela de login renderizava DENTRO da casca — e
 * um visitante não autenticado via a sidebar inteira, com os nomes de todas as telas
 * internas. No HTML do servidor o vazamento não aparecia: a `Nav` é componente de
 * cliente, sai como referência lazy e só materializa ao hidratar. Conferir o HTML da
 * resposta não bastava; foi preciso olhar o navegador.
 *
 * Devolve booleano e não a identidade porque é só isso que o layout precisa saber, e
 * um layout que carrega identidade convida a usá-la para decidir conteúdo — que é
 * trabalho da página, onde a permissão é checada com `exigir`.
 */
export async function autenticado(): Promise<boolean> {
  try {
    await identidade()
    return true
  } catch (err) {
    if (err instanceof NaoAutenticadoError) return false
    throw err
  }
}
