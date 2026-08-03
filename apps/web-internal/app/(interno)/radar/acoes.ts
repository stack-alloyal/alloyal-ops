'use server'

import {
  enviarReport,
  listarDemandas,
  listarNovidades,
  MAX_ANEXO_BYTES,
  MAX_ANEXOS,
  MAX_DESCRICAO,
  MAX_TITULO,
  type Demanda,
  type Novidade,
  type RespostaDoReport,
} from '../../../lib/radar'
import { identidadeDaSessao } from '../../../lib/guarda'

/**
 * As ações do painel do Radar.
 *
 * Uma Server Action é um ENDPOINT PÚBLICO: qualquer pessoa autenticada pode
 * chamá-la direto, sem passar pela tela que desenhou o botão. Por isso a
 * identidade é resolvida AQUI, a cada chamada — a mesma regra de `acoes.ts` da
 * fila.
 *
 * O que NÃO se exige é permissão de tela. Reportar bug e ler novidade valem
 * para qualquer pessoa que entra no Pulse: amarrar isso a um papel faria com
 * que justamente quem esbarra no defeito — o CSM sem acesso à configuração —
 * não tivesse como contar.
 *
 * O `autor` sai da sessão e nunca do formulário. Campo de autor no corpo seria
 * um jeito de qualquer pessoa da casa abrir demanda no nome de outra.
 */

export async function novidadesDoRadar(): Promise<Novidade[]> {
  await identidadeDaSessao()
  return listarNovidades()
}

export async function reportsDoRadar(): Promise<{ itens: Demanda[]; eu: string }> {
  const eu = await identidadeDaSessao()
  return { itens: await listarDemandas(), eu: eu.email }
}

export async function reportar(dados: FormData): Promise<RespostaDoReport> {
  const eu = await identidadeDaSessao()

  const texto = (campo: string) => String(dados.get(campo) ?? '').trim()
  const titulo = texto('titulo')
  const descricao = texto('descricao')

  // A mesma validação que a tela faz, refeita aqui: a tela é conveniência, esta
  // é a que vale. O Radar valida de novo do lado dele — três camadas, porque
  // cada uma responde a um caminho diferente de chegada.
  if (!titulo || !descricao) return { ok: false, erro: 'Preencha título e descrição.' }
  if (titulo.length > MAX_TITULO) return { ok: false, erro: `O título passa de ${MAX_TITULO} caracteres.` }
  if (descricao.length > MAX_DESCRICAO)
    return { ok: false, erro: `A descrição passa de ${MAX_DESCRICAO} caracteres.` }

  const anexos = dados.getAll('anexos').filter((a): a is File => a instanceof File && a.size > 0)
  if (anexos.length > MAX_ANEXOS) return { ok: false, erro: `No máximo ${MAX_ANEXOS} anexos por report.` }
  const grande = anexos.find((a) => a.size > MAX_ANEXO_BYTES)
  // Recusa ANTES de subir: deixar o Radar recusar gastaria a espera de um upload
  // de 40 MB para dizer o que já se sabia no primeiro byte.
  if (grande) return { ok: false, erro: `"${grande.name}" passa de 10 MB.` }

  return enviarReport({
    autor: eu.email,
    tipo: texto('tipo') || 'bug',
    criticidade: texto('criticidade') || 'media',
    titulo,
    descricao,
    anexos,
  })
}
