/**
 * Envio de e-mail do Pulse.
 *
 * Remetente padrão: `Alloyal Pulse <noreply@alloyal.com.br>` — mesmo endereço do
 * Allvoice (`GMAIL_SENDER=noreply@alloyal.com.br`), nome próprio do produto, como
 * lá o nome é `Allvoice`. Quem recebe sabe de qual ferramenta veio sem abrir.
 */

import { ClienteGmail, contaDeServicoDoAmbiente, type ContaDeServico } from './gmail.js'

export const REMETENTE_PADRAO = 'noreply@alloyal.com.br'
export const NOME_PADRAO = 'Alloyal Pulse'

export interface Mensagem {
  readonly para: string
  readonly assunto: string
  readonly html: string
  readonly texto?: string
  readonly responderPara?: string
}

export interface ConfiguracaoDeEnvio {
  readonly conta: ContaDeServico
  readonly remetente: string
  readonly nome: string
  readonly responderPara: string | undefined
}

/**
 * Monta a configuração a partir do ambiente, ou devolve null.
 *
 * Devolver null em vez de lançar é o que permite a TRAVA ANTI-LOCKOUT do step-up:
 * sem envio configurado, a verificação por e-mail fica inerte em vez de trancar
 * todo mundo para fora. Ver `packages/auth/src/verificacao.ts`.
 */
export function configuracaoDoAmbiente(env: NodeJS.ProcessEnv): ConfiguracaoDeEnvio | null {
  const conta = contaDeServicoDoAmbiente(env)
  if (!conta) return null
  const remetente = (env['GMAIL_SENDER'] ?? REMETENTE_PADRAO).trim()
  if (!remetente) return null
  const responder = (env['MAIL_REPLY_TO'] ?? '').trim()
  return {
    conta,
    remetente,
    nome: (env['GMAIL_FROM_NAME'] ?? NOME_PADRAO).trim() || NOME_PADRAO,
    responderPara: responder || undefined,
  }
}

export const remetenteFormatado = (c: Pick<ConfiguracaoDeEnvio, 'nome' | 'remetente'>): string =>
  `${c.nome} <${c.remetente}>`

/**
 * Monta o MIME (RFC 822) e devolve em base64url, que é o formato da Gmail API.
 *
 * Função PURA e exportada: é a parte que dá para testar sem falar com o Google, e
 * é onde moram os dois detalhes que quebram em silêncio —
 *
 *   · assunto com acento precisa de RFC 2047, senão chega como `Ã§`;
 *   · corpo em base64 com linha ≤76 (RFC 2045), senão um hop no meio reflui o
 *     texto e corrompe o UTF-8.
 *
 * Os dois vêm do Allvoice, que já passou por eles.
 */
export function montarMime(m: Mensagem, cfg: ConfiguracaoDeEnvio): string {
  const responder = m.responderPara ?? cfg.responderPara
  const corpo = Buffer.from(m.html, 'utf8')
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n')

  const linhas = [
    `From: ${remetenteFormatado(cfg)}`,
    `To: ${m.para}`,
    `Subject: ${codificar2047(m.assunto)}`,
    ...(responder ? [`Reply-To: ${responder}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    corpo,
  ]
  return Buffer.from(linhas.join('\r\n'), 'utf8').toString('base64url')
}

export function codificar2047(s: string): string {
  // Só codifica se precisar: assunto ASCII fica legível no log e no cliente antigo.
  const temNaoAscii = [...s].some((c) => {
    const n = c.codePointAt(0) ?? 0
    return n < 0x20 || n > 0x7e
  })
  if (!temNaoAscii) return s
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`
}

export class Mailer {
  constructor(private readonly cfg: ConfiguracaoDeEnvio | null) {}

  static doAmbiente(env: NodeJS.ProcessEnv = process.env): Mailer {
    return new Mailer(configuracaoDoAmbiente(env))
  }

  configurado(): boolean {
    return this.cfg !== null
  }

  get de(): string | null {
    return this.cfg ? remetenteFormatado(this.cfg) : null
  }

  async enviar(m: Mensagem): Promise<{ id: string }> {
    if (!this.cfg) {
      throw new Error(
        'envio não configurado: falta GOOGLE_SA_JSON (ou GMAIL_SA_CLIENT_EMAIL + ' +
          'GMAIL_SA_PRIVATE_KEY) no ambiente',
      )
    }
    const cliente = await ClienteGmail.porContaDeServico(this.cfg.conta, this.cfg.remetente)
    return cliente.enviarBruto(montarMime(m, this.cfg))
  }

  /**
   * Envia sem propagar falha. O chamador segue o fluxo e a pessoa reenvia.
   *
   * O assunto é logado; o CORPO nunca. É por isso que o código de acesso vai só
   * no corpo — ver `verificacao.ts`. Um OTP no assunto apareceria no log, na
   * prévia da notificação e na tela de bloqueio do celular.
   */
  async enviarSilencioso(m: Mensagem, log?: (msg: string) => void): Promise<boolean> {
    try {
      const { id } = await this.enviar(m)
      log?.(`e-mail enviado para=${m.para} assunto="${m.assunto}" id=${id}`)
      return true
    } catch (err) {
      log?.(`FALHA ao enviar para=${m.para} assunto="${m.assunto}": ${(err as Error).message}`)
      return false
    }
  }
}
