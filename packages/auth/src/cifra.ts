import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Cifra dos segredos que o admin cadastra pela tela.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ O SOPS+age já cifra `infra/secrets` — o que está no REPOSITÓRIO está        │
 * │ protegido. Isto resolve outra coisa: token que o admin digita numa tela vai │
 * │ para o BANCO, e banco tem backup, réplica, dump de suporte e `SELECT *` de  │
 * │ quem estiver depurando. Um token do HubSpot em texto claro numa coluna vaza │
 * │ por qualquer um desses caminhos sem ninguém invadir nada.                  │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * AES-256-GCM, e não AES-CBC: GCM é autenticado, então adulterar o texto cifrado
 * quebra a decifragem em vez de produzir um valor diferente e plausível. Quem tem
 * acesso de escrita ao banco mas não à chave não consegue TROCAR um token por outro —
 * o que num token de API significaria redirecionar a integração para um servidor dele.
 *
 * A chave NUNCA está no repositório: vem de `PULSE_CHAVE_MESTRA`, que vive no SOPS. É
 * cifra em duas camadas de propósito — a do repo protege o arquivo, esta protege a
 * linha do banco, e o comprometimento de uma não entrega a outra.
 */

/** Rótulo da versão da chave, gravado junto. Sem isso, rotação exige adivinhar. */
const VERSAO = 'v1'
const ALGORITMO = 'aes-256-gcm'
const TAMANHO_IV = 12 // 96 bits, o recomendado para GCM
const TAMANHO_TAG = 16

export class ChaveMestraAusenteError extends Error {
  constructor() {
    super(
      'PULSE_CHAVE_MESTRA não configurada. Gere com `openssl rand -base64 32` e guarde ' +
        'no SOPS — sem ela nenhum segredo pode ser gravado nem lido.',
    )
    this.name = 'ChaveMestraAusenteError'
  }
}

export class SegredoCorrompidoError extends Error {
  constructor(motivo: string) {
    // A mensagem não repete o valor: ela é escrita em log, e log com texto cifrado
    // dentro é material para ataque offline.
    super(`segredo não pôde ser decifrado (${motivo}) — chave trocada ou valor adulterado`)
    this.name = 'SegredoCorrompidoError'
  }
}

/**
 * A chave, validada.
 *
 * Falha fechado e com mensagem acionável: uma chave de 16 bytes seria aceita pelo
 * `createCipheriv` de algumas versões e daria cifra mais fraca em silêncio.
 */
function chaveMestra(): Buffer {
  const bruta = process.env['PULSE_CHAVE_MESTRA']
  if (!bruta) throw new ChaveMestraAusenteError()
  const chave = Buffer.from(bruta, 'base64')
  if (chave.length !== 32) {
    throw new Error(
      `PULSE_CHAVE_MESTRA tem ${chave.length} bytes depois do base64; AES-256 exige 32. ` +
        'Gere com `openssl rand -base64 32`.',
    )
  }
  return chave
}

/** Há chave configurada? Para a tela dizer o que falta sem derrubar a página. */
export function chaveMestraConfigurada(): boolean {
  try {
    chaveMestra()
    return true
  } catch {
    return false
  }
}

/**
 * Cifra um segredo. O formato é `v1:iv:tag:cifrado`, tudo em base64url.
 *
 * A versão vem primeiro para a rotação ser possível sem migração de dados: uma `v2`
 * futura decifra `v1` com a chave antiga e regrava.
 */
export function cifrar(claro: string): string {
  if (claro.length === 0) throw new Error('segredo vazio não se cifra — apague o registro')
  const iv = randomBytes(TAMANHO_IV)
  const c = createCipheriv(ALGORITMO, chaveMestra(), iv)
  const cifrado = Buffer.concat([c.update(claro, 'utf8'), c.final()])
  const tag = c.getAuthTag()
  return [
    VERSAO,
    iv.toString('base64url'),
    tag.toString('base64url'),
    cifrado.toString('base64url'),
  ].join(':')
}

/**
 * Decifra. Só o worker chama — a tela nunca decifra para exibir.
 *
 * Exibir um segredo "para conferir" é o caminho pelo qual ele acaba num print de
 * tela, num compartilhamento de janela ou num cache de navegador. Quem precisa
 * conferir troca o valor; quem precisa usar é o processo, não a pessoa.
 */
export function decifrar(guardado: string): string {
  const partes = guardado.split(':')
  if (partes.length !== 4) throw new SegredoCorrompidoError('formato inesperado')
  const [versao, iv64, tag64, cifrado64] = partes as [string, string, string, string]
  if (versao !== VERSAO) throw new SegredoCorrompidoError(`versão ${versao} desconhecida`)

  const iv = Buffer.from(iv64, 'base64url')
  const tag = Buffer.from(tag64, 'base64url')
  if (iv.length !== TAMANHO_IV || tag.length !== TAMANHO_TAG) {
    throw new SegredoCorrompidoError('iv ou tag com tamanho errado')
  }

  try {
    const d = createDecipheriv(ALGORITMO, chaveMestra(), iv)
    d.setAuthTag(tag)
    return Buffer.concat([d.update(Buffer.from(cifrado64, 'base64url')), d.final()]).toString('utf8')
  } catch {
    // A exceção do GCM não diz nada de útil, e repassá-la vazaria detalhe de
    // implementação para o log.
    throw new SegredoCorrompidoError('autenticação falhou')
  }
}

/**
 * As últimas quatro letras, para a tela dizer QUAL valor está lá sem mostrá-lo.
 *
 * Quatro e não oito: com oito de um token de 40, quem já viu o token reconhece; com
 * quatro, dá para confirmar "é o que eu cadastrei" e não dá para reconstruir. Abaixo
 * de 12 caracteres não mostra nada — num segredo curto, quatro é fração demais.
 */
export function dica(claro: string): string {
  if (claro.length < 12) return '····'
  return `····${claro.slice(-4)}`
}

/**
 * Comparação em tempo constante, para segredo que a aplicação verifica em vez de usar.
 *
 * `===` em string vaza o tamanho do prefixo igual pelo tempo de resposta. Com muitas
 * tentativas isso reconstrói o valor byte a byte.
 */
export function iguais(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}
