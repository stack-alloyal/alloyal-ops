/**
 * Identidade vinda do oauth2-proxy.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ DECISÃO DE ARQUITETURA — ADR-016                                          │
 * │                                                                            │
 * │ A autenticação acontece no oauth2-proxy da casa (`--provider=google        │
 * │ --email-domain=alloyal.com.br`), no mesmo padrão de Hub, Radar, Enable e   │
 * │ Publi. Seguir o padrão custa menos código, centraliza a revogação de       │
 * │ sessão, e faz o Google — não a nossa aplicação — verificar o e-mail.       │
 * │                                                                            │
 * │ O CUSTO: a identidade passa a chegar por CABEÇALHO HTTP, e cabeçalho é     │
 * │ falsificável por quem consegue falar direto com a aplicação. Sem uma prova │
 * │ de que a requisição de fato passou pelo proxy, `X-Auth-Request-Email:      │
 * │ qualquer@alloyal.com.br` é uma sessão de administrador.                    │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * DUAS PROVAS POSSÍVEIS, e pelo menos uma é obrigatória:
 *
 *   segredoDoProxy    o proxy injeta um cabeçalho com um segredo compartilhado.
 *                     Funciona em qualquer contexto, inclusive onde a aplicação
 *                     não enxerga o endereço de rede de quem chamou — que é o
 *                     caso de um Server Component do Next, onde só existem
 *                     cabeçalhos. É a prova primária.
 *
 *   faixasConfiaveis  a conexão vem de uma faixa de rede confiável. Só é
 *                     verificável onde o endereço do peer está disponível de
 *                     verdade; `x-forwarded-for` NÃO serve, porque é cabeçalho —
 *                     e cabeçalho é exatamente o que o atacante controla.
 *
 * Sem nenhuma das duas configuradas, esta função RECUSA autenticar. Uma
 * configuração incompleta não pode resultar num sistema aberto.
 */

import { ehPapel, permissoesDe, type Papel, type Permissoes } from './papeis.js'

/** Cabeçalhos que o oauth2-proxy injeta com `--set-xauthrequest=true`. */
export const HEADER_EMAIL = 'x-auth-request-email'
export const HEADER_USER = 'x-auth-request-user'

/** Cabeçalho do segredo compartilhado, injetado pelo proxy reverso. */
export const HEADER_SEGREDO = 'x-pulse-proxy-secret'

export interface Identidade {
  readonly email: string
  readonly papeis: readonly Papel[]
  readonly permissoes: Permissoes
}

export class NaoAutenticadoError extends Error {
  constructor(motivo: string) {
    super(`Não autenticado: ${motivo}`)
    this.name = 'NaoAutenticadoError'
  }
}

/**
 * Autenticado no Google, sem papel no Pulse.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ CLASSE SEPARADA, E NÃO SUBCLASSE DE NaoAutenticadoError — de propósito.     │
 * │                                                                            │
 * │ Este caso já foi um `NaoAutenticadoError`, o que dava 401 e, com a tela de  │
 * │ login servida pela aplicação, mandava a pessoa DE VOLTA para a tela de      │
 * │ login logo depois de ela entrar com o Google. Sessão válida, tela de        │
 * │ entrar: parece que o login falhou, e a pessoa tenta de novo para sempre.    │
 * │                                                                            │
 * │ Se herdasse, um `catch (err instanceof NaoAutenticadoError)` escrito antes  │
 * │ desta classe existir voltaria a engoli-la em silêncio, e o laço voltaria    │
 * │ sem ninguém notar. Sendo irmã, quem não a tratar recebe erro — que é o modo │
 * │ de falha barulhento, e o certo aqui.                                       │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Quem chega aqui está autenticado: o e-mail é confiável e pode ser mostrado.
 */
export class SemPapelError extends Error {
  readonly email: string
  constructor(email: string) {
    super(`Sem papel: ${email} autenticou mas não tem acesso ao Pulse`)
    this.name = 'SemPapelError'
    this.email = email
  }
}

/** Configuração incompleta: erro de operação, não de autenticação. */
export class ConfiguracaoInsegura extends Error {
  constructor(motivo: string) {
    super(`Configuração insegura: ${motivo}`)
    this.name = 'ConfiguracaoInsegura'
  }
}

/**
 * Acesso SUSPENSO: a pessoa existe, tem papel, e alguém a desativou.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ POR QUE NÃO REAPROVEITAR `SemPapelError`:                                  │
 * │                                                                            │
 * │ Porque a mensagem decide o que a pessoa faz em seguida. "Você não tem       │
 * │ papel" manda pedir acesso; "seu acesso está suspenso" manda perguntar por   │
 * │ que — e são conversas diferentes, com pessoas diferentes.                   │
 * │                                                                            │
 * │ Classe IRMÃ e não subclasse, pela mesma razão de `SemPapelError`: um        │
 * │ `catch (err instanceof SemPapelError)` escrito antes desta classe existir   │
 * │ não deve engoli-la em silêncio.                                            │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export class AcessoSuspensoError extends Error {
  readonly email: string
  constructor(email: string) {
    super(`Acesso suspenso: ${email} tem papel, mas está desativada`)
    this.name = 'AcessoSuspensoError'
    this.email = email
  }
}

/** Como a pessoa está cadastrada. `inexistente` é diferente de `suspensa`. */
export type EstadoDaPessoa = 'ativa' | 'suspensa' | 'inexistente'

export interface OpcoesProxy {
  /** Domínio obrigatório do e-mail. Segunda barreira, além do proxy. */
  readonly dominio: string
  /** Resolve papéis a partir de `ops.user_role`. */
  readonly papeisDe: (email: string) => Promise<readonly string[]>
  /**
   * Resolve o estado em `ops.pessoa`. Opcional: sem ele, a suspensão não é
   * checada — é o que mantém os testes antigos válidos sem reescrevê-los.
   */
  readonly estadoDaPessoa?: (email: string) => Promise<EstadoDaPessoa>
  /**
   * Prova primária. Comparada em tempo constante.
   *
   * Aceita MAIS DE UM valor separado por vírgula, e é isso que torna a rotação
   * possível sem derrubar ninguém: o segredo vive em dois lugares — o `.env` da
   * aplicação e o Advanced Config do NPM — e trocá-lo é necessariamente uma mudança
   * em dois passos. Com um valor só, todo mundo toma 401 no intervalo entre os dois.
   *
   * Com dois, a sequência é: põe o novo ao lado do velho aqui → troca no NPM →
   * remove o velho daqui. Nenhum instante sem sobreposição.
   */
  readonly segredoDoProxy?: string
  /** Prova alternativa, só onde o endereço do peer é real. */
  readonly faixasConfiaveis?: readonly string[]
}

/** Verifica se um IPv4 pertence a um CIDR. Sem dependência externa de propósito. */
export function ipEmFaixa(ip: string, cidr: string): boolean {
  const [rede, bitsStr] = cidr.split('/')
  if (!rede || !bitsStr) return false
  const bits = Number(bitsStr)
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false

  const paraInt = (valor: string): number | null => {
    const partes = valor.split('.')
    if (partes.length !== 4) return null
    let n = 0
    for (const p of partes) {
      const octeto = Number(p)
      if (!Number.isInteger(octeto) || octeto < 0 || octeto > 255) return null
      n = (n << 8) | octeto
    }
    return n >>> 0
  }

  const alvo = paraInt(ip.replace(/^::ffff:/, ''))
  const base = paraInt(rede)
  if (alvo === null || base === null) return false

  const mascara = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (alvo & mascara) === (base & mascara)
}

/** Comparação em tempo constante, para o segredo não vazar por temporização. */
export function segredosIguais(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

const primeiro = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v

/**
 * Resolve a identidade da requisição.
 *
 * Lança `NaoAutenticadoError` — nunca devolve identidade parcial ou anônima em
 * silêncio. Falha fechada, igual à resolução de tenant no banco.
 */
export async function identidadeDaRequisicao(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  ipDeOrigem: string | undefined,
  opts: OpcoesProxy,
): Promise<Identidade> {
  const temSegredo = !!opts.segredoDoProxy
  const temFaixas = !!opts.faixasConfiaveis?.length
  if (!temSegredo && !temFaixas) {
    // Configuração incompleta não pode virar sistema aberto: sem prova de que a
    // requisição passou pelo proxy, o cabeçalho de identidade é só um texto que
    // qualquer um escreve.
    throw new ConfiguracaoInsegura(
      'nenhuma prova de proxy configurada — defina segredoDoProxy ou faixasConfiaveis',
    )
  }

  // Basta UMA prova. O segredo é a primária porque funciona onde não há acesso
  // ao endereço de rede de quem chamou.
  let provado = false
  if (temSegredo) {
    const enviado = primeiro(headers[HEADER_SEGREDO])
    if (enviado) {
      // Compara com TODOS os aceitos, e sem sair no primeiro acerto: `some` curto-
      // circuitaria, e o tempo de resposta passaria a revelar qual dos valores casou.
      const aceitos = (opts.segredoDoProxy as string)
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v.length > 0)
      let casou = false
      for (const aceito of aceitos) if (segredosIguais(enviado, aceito)) casou = true
      if (casou) provado = true
    }
  }
  if (!provado && temFaixas && ipDeOrigem) {
    if (opts.faixasConfiaveis!.some((faixa) => ipEmFaixa(ipDeOrigem, faixa))) provado = true
  }
  if (!provado) {
    throw new NaoAutenticadoError(
      'a requisição não comprovou ter passado pelo proxy; cabeçalho de identidade ignorado',
    )
  }

  const email = primeiro(headers[HEADER_EMAIL])?.trim().toLowerCase()
  if (!email) throw new NaoAutenticadoError('cabeçalho de identidade ausente')

  if (!email.endsWith(`@${opts.dominio}`)) {
    throw new NaoAutenticadoError(`domínio não autorizado: ${email}`)
  }

  // A suspensão vem ANTES dos papéis, e a ordem é a mensagem: quem está suspenso
  // e tem papel deve ouvir "suspenso", não "sem papel".
  //
  // `inexistente` NÃO barra aqui. Ela cai na checagem de papel logo abaixo, que
  // recusa quem não tem papel de qualquer forma — e quem tem papel sem registro
  // de pessoa (escrita parcial, inserção manual) continua entrando em vez de
  // ficar trancado para fora por um estado que ninguém pediu.
  if (opts.estadoDaPessoa) {
    if ((await opts.estadoDaPessoa(email)) === 'suspensa') throw new AcessoSuspensoError(email)
  }

  const papeis = (await opts.papeisDe(email)).filter(ehPapel)
  if (papeis.length === 0) {
    // Autenticada e sem papel não é falha de autenticação: é alguém de casa que
    // ainda não foi cadastrada. Por isso `SemPapelError` e não
    // `NaoAutenticadoError` — a diferença decide entre 403 e um laço de login.
    //
    // A mensagem NÃO manda pedir grupo no Google Workspace, como mandava antes: o
    // papel vem de `ops.user_role`, e um admin o concede em Configurações →
    // Papéis. A mensagem velha mandava a pessoa bater na porta de quem não podia
    // resolver, e o `--email-domain` do oauth2-proxy deixa QUALQUER conta
    // @alloyal.com.br chegar até aqui — é esta linha que decide quem entra.
    throw new SemPapelError(email)
  }

  return { email, papeis, permissoes: permissoesDe(papeis) }
}

/**
 * A identidade de desenvolvimento pode ser usada?
 *
 * Função pura e separada de propósito: é a decisão de segurança mais perigosa do
 * sistema, e decisão perigosa embutida no meio de um componente é decisão que
 * ninguém testa.
 *
 * Exige DUAS condições, e a de ambiente vem primeiro: uma saída de
 * desenvolvimento que funcione em produção por engano é a pior classe de falha
 * de autenticação que existe — silenciosa, total, e descoberta por terceiros.
 * Nenhuma variável de configuração pode desligar a checagem de ambiente.
 */
export function permiteIdentidadeDeDesenvolvimento(
  nodeEnv: string | undefined,
  devEmail: string | undefined,
): boolean {
  if (nodeEnv === 'production') return false
  return !!devEmail
}
