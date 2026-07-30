/**
 * Magic link — porta primária do portal do cliente (ADR-011).
 *
 * Doc 00, 5.3.
 *
 * Regras que os critérios de lançamento (doc 01, 17.3) exigem provar:
 *   • TTL curto;
 *   • uso único;
 *   • vinculado ao e-mail no primeiro uso;
 *   • aberto por e-mail diferente → recusado E registrado.
 *
 * O token nunca é armazenado: guarda-se o hash. Vazamento da tabela de tokens
 * não dá acesso a ninguém.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const TTL_PADRAO_MS = 20 * 60 * 1000
export const DURACAO_SESSAO_MS = 8 * 60 * 60 * 1000

export interface TokenEmitido {
  /** Vai no link, por e-mail. Não é persistido em lugar nenhum. */
  readonly token: string
  /** Persistido. */
  readonly hash: string
  readonly expiraEm: Date
}

export interface RegistroToken {
  readonly hash: string
  readonly accountId: string
  readonly email: string
  readonly expiraEm: Date
  readonly usadoEm: Date | null
}

export function emitirToken(agora: Date, ttlMs: number = TTL_PADRAO_MS): TokenEmitido {
  const token = randomBytes(32).toString('base64url')
  return {
    token,
    hash: hashToken(token),
    expiraEm: new Date(agora.getTime() + ttlMs),
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export type ResultadoValidacao =
  | { readonly ok: true; readonly accountId: string; readonly email: string }
  | { readonly ok: false; readonly motivo: MotivoRecusa }

export type MotivoRecusa =
  | 'token_desconhecido'
  | 'token_expirado'
  | 'token_ja_usado'
  | 'email_divergente'

/**
 * Valida o token.
 *
 * Toda recusa devolve motivo específico para o LOG de auditoria — e uma mensagem
 * genérica para o usuário. A distinção importa: "e-mail divergente" é sinal de
 * link encaminhado ou vazado e precisa aparecer no log; dizer isso na tela
 * confirmaria ao atacante que o token existe.
 */
export function validarToken(
  registro: RegistroToken | null,
  emailApresentado: string,
  agora: Date,
): ResultadoValidacao {
  if (!registro) return { ok: false, motivo: 'token_desconhecido' }
  if (registro.usadoEm !== null) return { ok: false, motivo: 'token_ja_usado' }
  if (registro.expiraEm.getTime() <= agora.getTime()) {
    return { ok: false, motivo: 'token_expirado' }
  }
  if (!emailsIguais(registro.email, emailApresentado)) {
    return { ok: false, motivo: 'email_divergente' }
  }
  return { ok: true, accountId: registro.accountId, email: registro.email }
}

export const MENSAGEM_GENERICA =
  'Este link não é mais válido. Peça um novo acesso na página inicial.'

function emailsIguais(a: string, b: string): boolean {
  const na = Buffer.from(a.trim().toLowerCase())
  const nb = Buffer.from(b.trim().toLowerCase())
  if (na.length !== nb.length) return false
  return timingSafeEqual(na, nb)
}
