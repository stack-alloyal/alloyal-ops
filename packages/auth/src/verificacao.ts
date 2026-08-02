/**
 * Verificação por e-mail — segunda etapa depois do SSO.
 *
 * Mesmo desenho do Allvoice (`alloyal-chat/api/src/auth/email-verify.service.ts`):
 * depois de entrar com o Google, a pessoa digita um código de 6 dígitos enviado ao
 * próprio e-mail; ao acertar ganha um cookie de dispositivo assinado e não repete
 * por 30 dias.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ POR QUE ISTO EXISTE, NO PULSE ESPECIFICAMENTE:                             │
 * │                                                                            │
 * │ Toda a autenticação da superfície interna se apoia em DOIS cabeçalhos que  │
 * │ o nginx injeta: `X-Pulse-Proxy-Secret` e `X-Auth-Request-Email`. Quem       │
 * │ conseguir escrever os dois É a pessoa, para todos os efeitos — e o segredo  │
 * │ do proxy vive em texto no Advanced Config do NPM e no `.env` da VM.         │
 * │                                                                            │
 * │ O código fecha esse vetor sem depender do segredo: ele vai para a CAIXA     │
 * │ REAL do e-mail. Quem forjou o cabeçalho não recebe, e não conclui.          │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ TRAVA ANTI-LOCKOUT — a parte mais importante deste arquivo:                │
 * │                                                                            │
 * │ O step-up só vale se houver flag LIGADA, segredo E envio configurado. Sem   │
 * │ envio não há como mandar código; exigir código nesse estado tranca TODO     │
 * │ MUNDO para fora, inclusive quem poderia consertar. Fica inerte de propósito.│
 * │                                                                            │
 * │ Copiado do Allvoice porque é a decisão que mais economiza: uma credencial   │
 * │ de e-mail que expira vira, sem esta trava, uma plataforma inacessível.      │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

import { createHash, createHmac, randomInt, timingSafeEqual } from 'node:crypto'

export const TTL_CODIGO_MS = 10 * 60_000
export const INTERVALO_REENVIO_MS = 60_000
export const MAX_TENTATIVAS = 5
export const TTL_DISPOSITIVO_MS = 30 * 24 * 60 * 60_000
export const COOKIE_DISPOSITIVO = 'pulse_ev'

/**
 * O step-up está ativo?
 *
 * Pura e separada de propósito — é a mesma razão de
 * `permiteIdentidadeDeDesenvolvimento` ser pura: decisão de segurança embutida no
 * meio de um serviço é decisão que ninguém testa.
 */
export function stepUpAtivo(
  flag: string | undefined,
  segredo: string | undefined,
  envioConfigurado: boolean,
): boolean {
  if (flag !== 'true') return false
  return Boolean(segredo?.trim()) && envioConfigurado
}

/** 6 dígitos, com zero à esquerda. `randomInt` é do CSPRNG; `Math.random` não serve. */
export function gerarCodigo(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

/**
 * O código NUNCA é guardado — guarda-se o hash, e com o segredo dentro.
 *
 * O segredo no hash é o que impede que quem leia a tabela monte a tabela dos
 * 1.000.000 de códigos possíveis e descubra o de qualquer pessoa. Sem ele, seis
 * dígitos são um espaço que um laptop percorre instantaneamente.
 */
export function hashDoCodigo(email: string, codigo: string, segredo: string): string {
  return createHash('sha256').update(`${email.trim().toLowerCase()}:${codigo}:${segredo}`).digest('hex')
}

export type RecusaDeCodigo = 'sem_codigo' | 'expirado' | 'travado' | 'invalido'

export interface RegistroDeCodigo {
  readonly hash: string
  readonly expiraEm: Date
  readonly tentativas: number
}

export type ResultadoDoCodigo =
  | { readonly ok: true }
  | { readonly ok: false; readonly motivo: RecusaDeCodigo }

/**
 * Confere o código.
 *
 * A ORDEM importa e não é arbitrária: expirado antes de travado, travado antes de
 * comparar. Comparar primeiro deixaria a contagem de tentativas ser burlada por
 * quem ignora a resposta.
 *
 * O incremento de tentativa é do CHAMADOR e tem que ser ATÔMICO e ANTES desta
 * chamada — `UPDATE ... WHERE tentativas < max` devolvendo 0 linha é o "travado".
 * O Allvoice tem comentário explicando que a versão ingênua (ler, comparar,
 * gravar) tinha corrida: requisições simultâneas liam o mesmo contador e a trava
 * de 5 erros não valia nada.
 */
export function conferirCodigo(
  registro: RegistroDeCodigo | null,
  emailApresentado: string,
  codigoApresentado: string,
  segredo: string,
  agora: Date,
): ResultadoDoCodigo {
  if (!registro) return { ok: false, motivo: 'sem_codigo' }
  if (registro.expiraEm.getTime() <= agora.getTime()) return { ok: false, motivo: 'expirado' }
  if (registro.tentativas >= MAX_TENTATIVAS) return { ok: false, motivo: 'travado' }

  const esperado = Buffer.from(registro.hash, 'utf8')
  const veio = Buffer.from(
    hashDoCodigo(emailApresentado, (codigoApresentado ?? '').trim(), segredo),
    'utf8',
  )
  const bate = esperado.length === veio.length && timingSafeEqual(esperado, veio)
  return bate ? { ok: true } : { ok: false, motivo: 'invalido' }
}

/** Pode reenviar, ou ainda está no intervalo? */
export function podeReenviar(ultimoEnvio: Date | null, agora: Date): { pode: boolean; esperarMs: number } {
  if (!ultimoEnvio) return { pode: true, esperarMs: 0 }
  const decorrido = agora.getTime() - ultimoEnvio.getTime()
  if (decorrido >= INTERVALO_REENVIO_MS) return { pode: true, esperarMs: 0 }
  return { pode: false, esperarMs: INTERVALO_REENVIO_MS - decorrido }
}

// ── Cookie de dispositivo ────────────────────────────────────────────────────
// Formato: base64url(`email|expiraMs`) + '.' + base64url(hmac). O e-mail vai
// DENTRO da carga assinada, e é conferido contra o da sessão — senão o cookie de
// uma pessoa serviria para outra.

export function assinarDispositivo(
  email: string,
  segredo: string,
  agora: Date,
): { nome: string; valor: string; maxIdadeSeg: number } {
  const expira = agora.getTime() + TTL_DISPOSITIVO_MS
  const carga = `${email.trim().toLowerCase()}|${expira}`
  const p = Buffer.from(carga, 'utf8').toString('base64url')
  const assinatura = createHmac('sha256', segredo).update(carga).digest('base64url')
  return {
    nome: COOKIE_DISPOSITIVO,
    valor: `${p}.${assinatura}`,
    maxIdadeSeg: Math.floor(TTL_DISPOSITIVO_MS / 1000),
  }
}

export function verificarDispositivo(
  email: string,
  token: string | null | undefined,
  segredo: string,
  agora: Date,
): boolean {
  if (!token || !segredo) return false
  const [p, assinatura] = token.split('.')
  if (!p || !assinatura) return false

  let carga: string
  try {
    carga = Buffer.from(p, 'base64url').toString('utf8')
  } catch {
    return false
  }

  // Confere a ASSINATURA antes de olhar o conteúdo: carga não verificada é texto
  // de terceiro, e decidir qualquer coisa por ela antes da conferência é confiar
  // no atacante.
  const esperada = createHmac('sha256', segredo).update(carga).digest('base64url')
  const a = Buffer.from(assinatura)
  const b = Buffer.from(esperada)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false

  const corte = carga.lastIndexOf('|')
  if (corte < 0) return false
  const emailDoCookie = carga.slice(0, corte)
  const expira = Number(carga.slice(corte + 1))
  if (!Number.isFinite(expira) || expira < agora.getTime()) return false
  return emailDoCookie === email.trim().toLowerCase()
}

/** Lê um cookie do cabeçalho `Cookie` sem depender de biblioteca. */
export function lerCookie(cabecalho: string | undefined | null, nome: string): string | null {
  if (!cabecalho) return null
  for (const parte of cabecalho.split(';')) {
    const i = parte.indexOf('=')
    if (i < 0) continue
    if (parte.slice(0, i).trim() === nome) return parte.slice(i + 1).trim()
  }
  return null
}

export function montarSetCookie(
  email: string,
  segredo: string,
  agora: Date,
  producao: boolean,
): string {
  const { nome, valor, maxIdadeSeg } = assinarDispositivo(email, segredo, agora)
  const atributos = [`${nome}=${valor}`, 'Path=/', `Max-Age=${maxIdadeSeg}`, 'HttpOnly', 'SameSite=Lax']
  if (producao) atributos.push('Secure')
  return atributos.join('; ')
}
