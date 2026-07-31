'use server'

import { criarRascunho, descartar, enviar, RelatorioInvalidoError, revisar } from '@ops/success'
import { redirect } from 'next/navigation'

import { pool } from '../../lib/db'
import { exigir, temEscopo } from '../../lib/guarda'

/**
 * As ações do relatório.
 *
 * A permissão é reavaliada em cada uma. O desfecho volta pela URL para a tela
 * funcionar sem JavaScript — compor o relatório do mês de um cliente não pode
 * depender de um bundle carregar.
 */
async function tentar(destino: string, fn: () => Promise<string>): Promise<never> {
  let url: string
  try {
    url = `${destino}?ok=${encodeURIComponent(await fn())}`
  } catch (err) {
    if (err instanceof RelatorioInvalidoError) {
      url = `${destino}?erro=${encodeURIComponent(err.message)}`
    } else {
      throw err
    }
  }
  // Fora do try: `redirect` sinaliza por exceção.
  redirect(url)
}

export async function acaoCompor(dados: FormData): Promise<void> {
  const id = await exigir((p) => temEscopo(p.contas), 'relatório do cliente')
  const accountId = String(dados.get('accountId') ?? '')
  const competencia = String(dados.get('competencia') ?? '')
  await tentar('/relatorios', async () => {
    const r = await criarRascunho(pool(), id, accountId, `${competencia}-01`)
    return `rascunho de ${competencia} composto para ${r.conta ?? 'a conta'}`
  })
}

export async function acaoRevisar(dados: FormData): Promise<void> {
  const id = await exigir((p) => temEscopo(p.contas), 'relatório do cliente')
  const relatorioId = String(dados.get('id') ?? '')
  await tentar(`/relatorios/${relatorioId}`, async () => {
    await revisar(pool(), id, relatorioId, String(dados.get('frase') ?? ''))
    return 'relatório revisado e congelado — os números não mudam mais'
  })
}

export async function acaoEnviar(dados: FormData): Promise<void> {
  const id = await exigir((p) => temEscopo(p.contas), 'relatório do cliente')
  const relatorioId = String(dados.get('id') ?? '')
  await tentar(`/relatorios/${relatorioId}`, async () => {
    await enviar(pool(), id, relatorioId, String(dados.get('destinatario') ?? ''))
    return 'enviado — o registro fica, com os números que o cliente recebeu'
  })
}

export async function acaoDescartar(dados: FormData): Promise<void> {
  const id = await exigir((p) => temEscopo(p.contas), 'relatório do cliente')
  await tentar('/relatorios', async () => {
    await descartar(pool(), id, String(dados.get('id') ?? ''))
    return 'rascunho descartado'
  })
}
