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

/** Configuração incompleta: erro de operação, não de autenticação. */
export class ConfiguracaoInsegura extends Error {
  constructor(motivo: string) {
    super(`Configuração insegura: ${motivo}`)
    this.name = 'ConfiguracaoInsegura'
  }
}

export interface OpcoesProxy {
  /** Domínio obrigatório do e-mail. Segunda barreira, além do proxy. */
  readonly dominio: string
  /** Resolve papéis a partir de `ops.user_role`. */
  readonly papeisDe: (email: string) => Promise<readonly string[]>
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

  const papeis = (await opts.papeisDe(email)).filter(ehPapel)
  if (papeis.length === 0) {
    // Pessoa autenticada e sem grupo não é erro de infraestrutura: é alguém que
    // ainda não foi adicionada a um grupo do Workspace. A mensagem tem que dizer
    // isso, porque a alternativa é um 403 que ninguém sabe como resolver.
    throw new NaoAutenticadoError(
      `${email} autenticado mas sem papel. Adicione a pessoa a um grupo pulse-* no Google Workspace.`,
    )
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
