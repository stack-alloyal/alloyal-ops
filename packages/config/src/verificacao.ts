/**
 * Verificação por e-mail — o lado que fala com o banco e com o envio.
 *
 * A lógica pura mora em `@pulse/auth/verificacao` (código, hash, cookie, trava
 * anti-lockout) e é testada sem banco nenhum. Aqui fica só o que precisa de
 * Postgres e de rede.
 */

import {
  conferirCodigo,
  gerarCodigo,
  hashDoCodigo,
  MAX_TENTATIVAS,
  podeReenviar,
  TTL_CODIGO_MS,
  type RecusaDeCodigo,
} from '@pulse/auth'
import { montarEmail, type Mailer } from '@pulse/mail'
import type pg from 'pg'

export interface PedidoDeCodigo {
  readonly enviado: boolean
  /** Quanto falta para poder reenviar, quando `enviado` é falso. */
  readonly esperarMs?: number
}

/**
 * Emite e envia um código, respeitando o intervalo de reenvio.
 *
 * O intervalo NÃO gera código novo quando barra — se gerasse, quem clicasse
 * "reenviar" duas vezes invalidaria o código que já está a caminho, e a pessoa
 * digitaria o do primeiro e-mail para sempre.
 */
export async function pedirCodigo(
  db: pg.Pool,
  mailer: Mailer,
  email: string,
  segredo: string,
  agora: Date = new Date(),
): Promise<PedidoDeCodigo> {
  const alvo = email.trim().toLowerCase()

  const { rows } = await db.query<{ ultimo_envio: Date }>(
    'SELECT ultimo_envio FROM ops.codigo_verificacao WHERE email = $1',
    [alvo],
  )
  const espera = podeReenviar(rows[0]?.ultimo_envio ?? null, agora)
  if (!espera.pode) return { enviado: false, esperarMs: espera.esperarMs }

  const codigo = gerarCodigo()
  await db.query(
    `INSERT INTO ops.codigo_verificacao (email, hash, expira_em, tentativas, ultimo_envio)
     VALUES ($1, $2, $3, 0, $4)
     ON CONFLICT (email) DO UPDATE
       SET hash = EXCLUDED.hash,
           expira_em = EXCLUDED.expira_em,
           tentativas = 0,
           ultimo_envio = EXCLUDED.ultimo_envio`,
    [alvo, hashDoCodigo(alvo, codigo, segredo), new Date(agora.getTime() + TTL_CODIGO_MS), agora],
  )

  await enviarCodigo(mailer, alvo, codigo)
  return { enviado: true }
}

async function enviarCodigo(mailer: Mailer, email: string, codigo: string): Promise<void> {
  const html = montarEmail({
    saudacao: 'Confirmação de acesso',
    corpoHtml:
      '<p style="margin:0 0 12px">Use o código abaixo para concluir a entrada no <strong>Alloyal Pulse</strong>:</p>' +
      `<p style="margin:0 0 12px;font-size:30px;font-weight:800;letter-spacing:8px">${codigo}</p>` +
      '<p style="margin:0 0 8px;font-size:13px">O código vale por 10 minutos. Se não foi você que tentou entrar, ignore este e-mail e avise a TI — alguém tem a sua sessão.</p>',
    rodape: 'Verificação de acesso do Alloyal Pulse. Nunca compartilhe este código.',
  })

  // O CÓDIGO NÃO VAI NO ASSUNTO. O assunto é logado no envio; o corpo não. Um OTP
  // no assunto apareceria no log, na prévia da notificação e na tela de bloqueio
  // do celular — três lugares onde ele é visível sem desbloquear nada.
  await mailer.enviarSilencioso(
    {
      para: email,
      assunto: 'Seu código de acesso ao Alloyal Pulse',
      html,
      texto: `Seu código de acesso ao Alloyal Pulse é ${codigo} (vale por 10 minutos). Não compartilhe.`,
    },
    (m) => console.warn(`[verificacao] ${m}`),
  )
}

export type ResultadoDaConferencia =
  | { readonly ok: true }
  | { readonly ok: false; readonly motivo: RecusaDeCodigo }

/**
 * Confere o código digitado. Consome a linha no acerto.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ O INCREMENTO VEM ANTES DA COMPARAÇÃO, E É ATÔMICO.                         │
 * │                                                                            │
 * │ `UPDATE ... WHERE tentativas < 5` devolvendo 0 linha É o "travado" — o      │
 * │ próprio banco decide, numa operação só. A versão ingênua (ler, comparar,    │
 * │ gravar) tem corrida: dez requisições simultâneas leem `tentativas = 0`,     │
 * │ todas gravam 1, e a trava de 5 erros vira trava de 5 RODADAS de tentativas  │
 * │ paralelas — que é o mesmo que não ter trava contra quem automatiza.        │
 * │                                                                            │
 * │ É bug que o Allvoice já teve e corrigiu; entra aqui já corrigido.          │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export async function conferir(
  db: pg.Pool,
  email: string,
  codigo: string,
  segredo: string,
  agora: Date = new Date(),
): Promise<ResultadoDaConferencia> {
  const alvo = email.trim().toLowerCase()

  const { rows } = await db.query<{ hash: string; expira_em: Date; tentativas: number }>(
    'SELECT hash, expira_em, tentativas FROM ops.codigo_verificacao WHERE email = $1',
    [alvo],
  )
  const linha = rows[0]
  if (!linha) return { ok: false, motivo: 'sem_codigo' }
  if (linha.expira_em.getTime() <= agora.getTime()) return { ok: false, motivo: 'expirado' }

  const upd = await db.query(
    'UPDATE ops.codigo_verificacao SET tentativas = tentativas + 1 WHERE email = $1 AND tentativas < $2',
    [alvo, MAX_TENTATIVAS],
  )
  if (upd.rowCount === 0) return { ok: false, motivo: 'travado' }

  const r = conferirCodigo(
    { hash: linha.hash, expiraEm: linha.expira_em, tentativas: linha.tentativas },
    alvo,
    codigo,
    segredo,
    agora,
  )
  if (r.ok) await db.query('DELETE FROM ops.codigo_verificacao WHERE email = $1', [alvo])
  return r
}

/**
 * Apaga códigos vencidos.
 *
 * Sem isto a tabela vira histórico de quem tentou entrar e quando — dado de
 * pessoa, guardado sem nenhuma razão para durar.
 */
export async function limparVencidos(db: pg.Pool, agora: Date = new Date()): Promise<number> {
  const r = await db.query('DELETE FROM ops.codigo_verificacao WHERE expira_em < $1', [agora])
  return r.rowCount ?? 0
}
