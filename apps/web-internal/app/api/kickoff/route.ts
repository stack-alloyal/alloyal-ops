import { AcessoSuspensoError, NaoAutenticadoError, SemPapelError } from '@pulse/auth'

import { identidade } from '../../../lib/identidade'
import { pool } from '../../../lib/db'

/**
 * O preenchimento compartilhado do documento de kickoff.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ MESMO PORTÃO DO DOCUMENTO: sessão do Google basta, papel NÃO é exigido.     │
 * │                                                                            │
 * │ O documento é aberto a todos que entram pelo SSO, e uma API mais restrita    │
 * │ que a tela que a consome daria um documento que abre e não salva — pior que  │
 * │ um documento que não abre, porque a pessoa preenche antes de descobrir.      │
 * │                                                                            │
 * │ Suspensão e falta de sessão barram, como em `/docs/[arquivo]`. A regra é     │
 * │ escrita à mão porque `identidadeDaSessao` transforma falta de papel em 403.  │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

const TIPOS = ['dores', 'dados', 'planilhas', 'metricas', 'jornadas', 'automacoes'] as const
const TIMES = ['comercial', 'financeiro', 'operacoes', 'juridico', 'todos'] as const

type Tipo = (typeof TIPOS)[number]

interface Quem {
  readonly email: string
  readonly podeApagarTudo: boolean
}

/**
 * Resolve quem está pedindo, sem exigir papel.
 *
 * Devolve `null` quando a resposta já foi decidida (401/403) — a rota então só
 * repassa. Lançar `unauthorized()` daqui não serve: em Route Handler ele não vira
 * resposta, vira erro 500.
 */
async function quemPede(): Promise<{ quem: Quem } | { resposta: Response }> {
  try {
    const id = await identidade()
    return { quem: { email: id.email, podeApagarTudo: id.permissoes.configurar } }
  } catch (err) {
    if (err instanceof SemPapelError) {
      // Autenticada pelo Google e sem papel: exatamente o público deste documento.
      return { quem: { email: err.email, podeApagarTudo: false } }
    }
    if (err instanceof AcessoSuspensoError) {
      return { resposta: Response.json({ erro: 'acesso suspenso' }, { status: 403 }) }
    }
    if (err instanceof NaoAutenticadoError) {
      return { resposta: Response.json({ erro: 'sem sessão' }, { status: 401 }) }
    }
    throw err
  }
}

interface Linha {
  id: string
  tipo: string
  time: string
  dados: Record<string, unknown>
  autor_email: string
  criado_em: Date
}

/** O formato que o documento espera: um objeto com um array por tipo. */
function agrupar(linhas: readonly Linha[]): Record<Tipo, unknown[]> {
  const saida = Object.fromEntries(TIPOS.map((t) => [t, [] as unknown[]])) as Record<
    Tipo,
    unknown[]
  >
  for (const l of linhas) {
    if (!(TIPOS as readonly string[]).includes(l.tipo)) continue
    saida[l.tipo as Tipo].push({
      // O `id` do banco substitui o gerado no navegador: é ele que a remoção usa.
      ...l.dados,
      id: l.id,
      time: l.time,
      autor: l.autor_email,
      em: l.criado_em.toISOString(),
    })
  }
  return saida
}

export async function GET(): Promise<Response> {
  const r = await quemPede()
  if ('resposta' in r) return r.resposta

  const { rows } = await pool().query<Linha>(
    `SELECT id::text, tipo, time, dados, autor_email, criado_em
       FROM ops.kickoff_registro
      ORDER BY criado_em ASC`,
  )
  // ┌───────────────────────────────────────────────────────────────────────────┐
  // │ TODO MUNDO VÊ TUDO: não há filtro por área nem por autor nesta consulta, e   │
  // │ é o ponto do documento — o kickoff é o levantamento da empresa, não o de     │
  // │ cada time em separado.                                                      │
  // │                                                                            │
  // │ `eu` e `podeApagarTudo` viajam junto para o documento poder mostrar o botão  │
  // │ de remover só onde ele vai funcionar. Sem isso a tela oferece "remover" em   │
  // │ registro de outra área e entrega 404 depois do clique — o que parece defeito │
  // │ e é a regra funcionando.                                                    │
  // └───────────────────────────────────────────────────────────────────────────┘
  return Response.json({ eu: r.quem.email, podeApagarTudo: r.quem.podeApagarTudo, ...agrupar(rows) }, {
    // A resposta depende de quem pediu (o campo `autor` decide o botão de remover),
    // e muda a cada registro. Cache compartilhado aqui serviria o preenchimento de
    // uma pessoa para outra.
    headers: { 'Cache-Control': 'private, no-store' },
  })
}

export async function POST(req: Request): Promise<Response> {
  const r = await quemPede()
  if ('resposta' in r) return r.resposta

  let corpo: unknown
  try {
    corpo = await req.json()
  } catch {
    return Response.json({ erro: 'corpo não é JSON' }, { status: 400 })
  }
  if (corpo === null || typeof corpo !== 'object') {
    return Response.json({ erro: 'corpo não é objeto' }, { status: 400 })
  }

  const { tipo, time, dados } = corpo as Record<string, unknown>
  if (typeof tipo !== 'string' || !(TIPOS as readonly string[]).includes(tipo)) {
    return Response.json({ erro: `tipo inválido: ${String(tipo)}` }, { status: 400 })
  }
  if (typeof time !== 'string' || !(TIMES as readonly string[]).includes(time)) {
    return Response.json({ erro: 'selecione a sua área antes de registrar' }, { status: 400 })
  }
  if (dados === null || typeof dados !== 'object' || Array.isArray(dados)) {
    return Response.json({ erro: 'dados não é objeto' }, { status: 400 })
  }

  // Teto antes do banco: o CHECK de 8 KB existe, mas devolver 400 com a razão é
  // melhor que devolver 500 com uma violação de restrição.
  const texto = JSON.stringify(dados)
  if (texto.length > 7000) {
    return Response.json({ erro: 'registro grande demais — resuma' }, { status: 413 })
  }

  const { rows } = await pool().query<{ id: string; criado_em: Date }>(
    `INSERT INTO ops.kickoff_registro (tipo, time, dados, autor_email)
     VALUES ($1, $2, $3::jsonb, $4)
     RETURNING id::text, criado_em`,
    [tipo, time, texto, r.quem.email],
  )
  const linha = rows[0]!
  return Response.json(
    { id: linha.id, em: linha.criado_em.toISOString(), autor: r.quem.email },
    { status: 201 },
  )
}

/**
 * Remove um registro.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ QUEM PODE APAGAR: o autor, ou quem tem permissão de configurar.             │
 * │                                                                            │
 * │ O documento é aberto a toda a empresa. Sem esta regra, qualquer pessoa       │
 * │ apagaria o levantamento de qualquer área — e como não há UPDATE nem            │
 * │ histórico aqui, o registro sumiria sem rastro no meio de uma sessão.        │
 * │                                                                            │
 * │ O autor vem da SESSÃO, nunca do corpo do pedido. Aceitá-lo do corpo faria a  │
 * │ regra ser "quem disser que é o autor".                                     │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export async function DELETE(req: Request): Promise<Response> {
  const r = await quemPede()
  if ('resposta' in r) return r.resposta

  const id = new URL(req.url).searchParams.get('id')
  if (id === null || !/^[0-9a-f-]{36}$/i.test(id)) {
    return Response.json({ erro: 'id inválido' }, { status: 400 })
  }

  const { rowCount } = await pool().query(
    `DELETE FROM ops.kickoff_registro
      WHERE id = $1::uuid AND ($2::boolean OR autor_email = $3)`,
    [id, r.quem.podeApagarTudo, r.quem.email],
  )
  if (rowCount === 0) {
    // Não distingue "não existe" de "não é seu", e é de propósito: dizer qual dos
    // dois confirmaria a existência de um registro que a pessoa não pode tocar.
    return Response.json(
      { erro: 'registro não encontrado, ou não é seu para remover' },
      { status: 404 },
    )
  }
  return Response.json({ removido: id })
}
