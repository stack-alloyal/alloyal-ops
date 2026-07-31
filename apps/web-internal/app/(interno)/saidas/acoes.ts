'use server'

import {
  anunciar,
  confirmarAviso,
  confirmarUltimaCobranca,
  encerrar,
  reter,
  SemPermissaoError,
  TransicaoInvalidaError,
  type CanalAnuncio,
  type OrigemSaida,
} from '@pulse/success'
import { redirect } from 'next/navigation'

import { pool } from '../../../lib/db'
import { exigir, temEscopo } from '../../../lib/guarda'

/**
 * As ações do fluxo de saída.
 *
 * Cada uma reavalia a permissão: uma Server Action é endpoint público, e a tela
 * que desenhou o botão não é prova de nada. A alçada real mora em `@pulse/success`;
 * aqui só se garante que a pessoa está autenticada e tem acesso à ferramenta.
 *
 * O desfecho volta pela URL, e não por estado de cliente, para que a tela
 * funcione sem JavaScript — o time trabalha nela seis horas por dia e uma
 * confirmação de distrato não pode depender de um bundle carregar.
 *
 * Erro de transição volta como MENSAGEM. "Falta a confirmação do Financeiro" é
 * uma resposta de produto; uma pilha de exceção não é.
 */

async function tentar(fn: () => Promise<string>): Promise<never> {
  let destino: string
  try {
    destino = `/saidas?ok=${encodeURIComponent(await fn())}`
  } catch (err) {
    if (err instanceof TransicaoInvalidaError || err instanceof SemPermissaoError) {
      destino = `/saidas?erro=${encodeURIComponent(err.message)}`
    } else {
      throw err
    }
  }
  // Fora do try: `redirect` sinaliza por exceção, e capturá-la aqui
  // transformaria todo redirecionamento numa mensagem de erro.
  redirect(destino)
}

export async function registrarSaida(dados: FormData): Promise<void> {
  const id = await exigir((p) => temEscopo(p.fila), 'registro de saída')
  const canal = String(dados.get('canal') ?? '')
  const quem = String(dados.get('quemComunicou') ?? '').trim()
  const motivo = String(dados.get('motivo') ?? '').trim()
  const data = String(dados.get('dataLevantada') ?? '')
  await tentar(async () => {
    await anunciar(pool(), id, {
      accountId: String(dados.get('accountId') ?? ''),
      origem: String(dados.get('origem') ?? 'cliente') as OrigemSaida,
      ...(data ? { dataLevantada: data } : {}),
      ...(canal ? { canal: canal as CanalAnuncio } : {}),
      ...(quem ? { quemComunicou: quem } : {}),
      ...(motivo ? { motivo } : {}),
    })
    return 'saída registrada'
  })
}

export async function acaoConfirmarAviso(dados: FormData): Promise<void> {
  const id = await exigir((p) => temEscopo(p.fila), 'confirmação de aviso prévio')
  await tentar(async () => {
    await confirmarAviso(
      pool(),
      id,
      String(dados.get('id') ?? ''),
      Number(dados.get('avisoPrevioDias')),
    )
    return 'aviso prévio confirmado'
  })
}

export async function acaoConfirmarCobranca(dados: FormData): Promise<void> {
  const id = await exigir(
    (p) => temEscopo(p.fila) || p.aprovaDistrato !== 'nao',
    'confirmação de cobrança',
  )
  await tentar(async () => {
    const { competenciaEfeitoReceita } = await confirmarUltimaCobranca(
      pool(),
      id,
      String(dados.get('id') ?? ''),
      String(dados.get('competencia') ?? ''),
    )
    return `última cobrança confirmada · a receita sai em ${competenciaEfeitoReceita.slice(0, 7)}`
  })
}

export async function acaoReter(dados: FormData): Promise<void> {
  const id = await exigir((p) => temEscopo(p.fila), 'registro de retenção')
  const nota = String(dados.get('nota') ?? '').trim()
  await tentar(async () => {
    await reter(pool(), id, String(dados.get('id') ?? ''), nota || undefined)
    return 'retenção registrada — a receita nunca saiu'
  })
}

export async function acaoEncerrar(dados: FormData): Promise<void> {
  const id = await exigir((p) => p.aprovaDistrato !== 'nao' || p.configurar, 'aprovação de distrato')
  await tentar(async () => {
    const r = await encerrar(pool(), id, String(dados.get('id') ?? ''))
    return `encerrada · churn de receita em ${r.competenciaEfeitoReceita}`
  })
}
