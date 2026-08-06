import 'server-only'

import {
  AcessoSuspensoError,
  NaoAutenticadoError,
  SemPapelError,
  type Escopo,
  type Identidade,
  type Permissoes,
} from '@pulse/auth'
import { forbidden, redirect, unauthorized } from 'next/navigation'

import { identidade } from './identidade'
import { dispositivoVerificado, verificacaoAtiva } from './verificacao'

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
  const id = await identidadeDaSessao()

  // Segunda etapa: código enviado ao e-mail. Vem DEPOIS de resolver a identidade
  // (é preciso saber para quem mandar) e ANTES de checar a permissão — quem ainda
  // não provou ser quem diz não deve nem descobrir se teria acesso à tela.
  if (verificacaoAtiva() && !(await dispositivoVerificado(id.email))) {
    redirect('/verificar')
  }

  if (!permissao(id.permissoes)) forbidden()
  return id
}

/**
 * A identidade da sessão, sem exigir a verificação por e-mail.
 *
 * Existe para a PRÓPRIA tela de verificação poder saber para quem mandar o
 * código. Se ela usasse `exigir`, o redirecionamento para `/verificar` apontaria
 * para `/verificar` — laço fechado, e a pessoa nunca veria o campo do código.
 *
 * Não é fresta: quem chega aqui já passou pelo proxy, pelo Google e pela checagem
 * de papel. O que falta é só a segunda etapa, e esta função não dá acesso a
 * nenhum dado — só diz quem é.
 */
export async function identidadeDaSessao(): Promise<Identidade> {
  try {
    return await identidade()
  } catch (err) {
    // Falha de autenticação é ESPERADA e não é erro de servidor. Deixá-la virar
    // 500 polui o monitoramento com ruído previsível — e é exatamente assim que
    // o 500 de verdade passa despercebido no meio.
    // Autenticada sem papel é 403, NÃO 401: devolver a tela de login a quem
    // acabou de entrar com o Google é um laço — sessão válida, tela de entrar.
    // Suspenso e sem papel são 403 pelos mesmos motivos. A tela é a MESMA, e não
    // distingue os dois: `forbidden()` do Next não carrega dado do erro. Por isso
    // o texto dela cobre os três casos que chegam ali — sem papel, suspenso e sem
    // permissão para a tela. Prometer distinção que não existe seria pior.
    if (err instanceof AcessoSuspensoError) forbidden()
    if (err instanceof SemPapelError) forbidden()
    if (err instanceof NaoAutenticadoError) unauthorized()
    throw err
  }
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
    // Sem papel também não ganha a casca: a sidebar lista as telas internas, e
    // quem não tem acesso não precisa saber quais são.
    if (
      err instanceof AcessoSuspensoError ||
      err instanceof SemPapelError ||
      err instanceof NaoAutenticadoError
    )
      return false
    throw err
  }
}
