'use server'

import {
  despublicar,
  publicar,
  salvarRascunho,
  PlaybookInvalidoError,
  SemPermissaoBiblioteca,
} from '@ops/success'
import { redirect } from 'next/navigation'

import { pool } from '../../../lib/db'
import { exigir } from '../../../lib/guarda'

/**
 * As ações da biblioteca.
 *
 * A permissão é reavaliada em cada uma: Server Action é endpoint público, e a
 * tela que desenhou o botão não é prova de nada. Mudar o processo do time é
 * decisão de quem responde pelo processo.
 *
 * O desfecho volta pela URL para a tela funcionar sem JavaScript. Erro de
 * validação volta como MENSAGEM: "o conteúdo tem 12 caracteres" é resposta de
 * produto, pilha de exceção não é.
 */

async function tentar(destinoOk: string, fn: () => Promise<string>): Promise<never> {
  let destino: string
  try {
    destino = `${destinoOk}?ok=${encodeURIComponent(await fn())}`
  } catch (err) {
    if (err instanceof PlaybookInvalidoError || err instanceof SemPermissaoBiblioteca) {
      destino = `/biblioteca?erro=${encodeURIComponent(err.message)}`
    } else {
      throw err
    }
  }
  // Fora do try: `redirect` sinaliza por exceção, e capturá-la aqui
  // transformaria todo redirecionamento numa mensagem de erro.
  redirect(destino)
}

export async function salvar(dados: FormData): Promise<void> {
  const id = await exigir((p) => p.configurar, 'biblioteca')
  const chave = String(dados.get('chave') ?? '').trim()
  const gatilhos = String(dados.get('gatilhos') ?? '')
    .split(/[\s,]+/)
    .map((g) => g.trim().toUpperCase())
    .filter(Boolean)

  await tentar(`/biblioteca/chave/${encodeURIComponent(chave)}`, async () => {
    const p = await salvarRascunho(pool(), id, {
      chave,
      titulo: String(dados.get('titulo') ?? ''),
      conteudo: String(dados.get('conteudo') ?? ''),
      gatilhos,
    })
    return `rascunho salvo como versão ${p.versao}`
  })
}

export async function acaoPublicar(dados: FormData): Promise<void> {
  const id = await exigir((p) => p.configurar, 'biblioteca')
  const playbookId = String(dados.get('id') ?? '')
  await tentar('/biblioteca', async () => {
    const p = await publicar(pool(), id, playbookId)
    return `versão ${p.versao} de "${p.chave}" publicada — é o processo a partir de agora`
  })
}

export async function acaoDespublicar(dados: FormData): Promise<void> {
  const id = await exigir((p) => p.configurar, 'biblioteca')
  const chave = String(dados.get('chave') ?? '')
  await tentar('/biblioteca', async () => {
    await despublicar(pool(), id, chave)
    return `"${chave}" saiu do ar — itens novos deste gatilho nascerão sem anexo`
  })
}
