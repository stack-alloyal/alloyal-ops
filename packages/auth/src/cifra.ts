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
 * Valida e devolve uma chave em base64.
 *
 * Falha fechado e com mensagem acionável: uma chave de 16 bytes seria aceita pelo
 * `createCipheriv` de algumas versões e daria cifra mais fraca em silêncio.
 */
function validar(bruta: string, nomeDaVariavel: string): Buffer {
  const chave = Buffer.from(bruta, 'base64')
  if (chave.length !== 32) {
    throw new Error(
      `${nomeDaVariavel} tem ${chave.length} bytes depois do base64; AES-256 exige 32. ` +
        'Gere com `openssl rand -base64 32`.',
    )
  }
  return chave
}

function chaveMestra(): Buffer {
  const bruta = process.env['PULSE_CHAVE_MESTRA']
  if (!bruta) throw new ChaveMestraAusenteError()
  return validar(bruta, 'PULSE_CHAVE_MESTRA')
}

/**
 * A chave ANTERIOR, usada só durante uma rotação.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ Sem isto, trocar `PULSE_CHAVE_MESTRA` tornava TODO segredo gravado         │
 * │ indecifrável — e sem volta, porque a chave velha não estava em lugar       │
 * │ nenhum. O comentário deste arquivo prometia "uma v2 futura decifra v1 com  │
 * │ a chave antiga e regrava"; a promessa não estava implementada, e uma       │
 * │ rotação de rotina teria derrubado todas as integrações de uma vez.         │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Fica em variável SEPARADA e não numa lista dentro da mesma: assim "estamos no meio
 * de uma rotação" é um estado visível, e `rotacaoPendente()` sabe responder quantos
 * segredos ainda usam a chave velha.
 */
function chaveAnterior(): Buffer | null {
  const bruta = process.env['PULSE_CHAVE_MESTRA_ANTERIOR']
  if (!bruta) return null
  return validar(bruta, 'PULSE_CHAVE_MESTRA_ANTERIOR')
}

/** Há rotação em curso? A tela usa para avisar que falta concluir. */
export function rotacaoEmCurso(): boolean {
  return !!process.env['PULSE_CHAVE_MESTRA_ANTERIOR']
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

  const corpo = Buffer.from(cifrado64, 'base64url')
  const tentar = (chave: Buffer): string | null => {
    try {
      const d = createDecipheriv(ALGORITMO, chave, iv)
      d.setAuthTag(tag)
      return Buffer.concat([d.update(corpo), d.final()]).toString('utf8')
    } catch {
      return null
    }
  }

  const comAtual = tentar(chaveMestra())
  if (comAtual !== null) return comAtual

  // Só então a anterior. A ordem importa por desempenho (o caso comum é a chave
  // atual) e por semântica: durante a rotação, um valor já regravado tem que
  // decifrar com a nova, não continuar dependendo da velha.
  const anterior = chaveAnterior()
  if (anterior) {
    const comAnterior = tentar(anterior)
    if (comAnterior !== null) return comAnterior
  }

  // A exceção do GCM não diz nada de útil, e repassá-la vazaria detalhe de
  // implementação para o log.
  throw new SegredoCorrompidoError(
    anterior
      ? 'autenticação falhou com a chave atual e com a anterior'
      : 'autenticação falhou',
  )
}

/**
 * Este texto cifrado decifra com a chave ATUAL?
 *
 * Serve à rotação para saber o que já foi regravado sem decifrar tudo de novo — e ao
 * relatório de progresso, que precisa contar sem expor valor.
 */
export function cifradoComAChaveAtual(guardado: string): boolean {
  const partes = guardado.split(':')
  if (partes.length !== 4) return false
  const [, iv64, tag64, cifrado64] = partes as [string, string, string, string]
  try {
    const d = createDecipheriv(ALGORITMO, chaveMestra(), Buffer.from(iv64, 'base64url'))
    d.setAuthTag(Buffer.from(tag64, 'base64url'))
    Buffer.concat([d.update(Buffer.from(cifrado64, 'base64url')), d.final()])
    return true
  } catch {
    return false
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
