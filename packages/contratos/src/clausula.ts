import type { Identidade } from '@ops/auth'
import type pg from 'pg'

import { especificacao, podeLerValor, textoRestrito, type TipoClausula } from './taxonomia.js'

/**
 * O ciclo de vida da cláusula.
 *
 * Três operações, e nenhuma delas é "editar":
 *
 *   propor      → extração ou digitação; visível, marcada, NÃO decide nada
 *   confirmar   → alguém afirma, com procedência; passa a valer
 *   substituir  → aditivo FECHA a antiga e ABRE a nova
 *
 * Editar no lugar destruiria a resposta para "por que mudou?", que é a pergunta
 * mais frequente do Jurídico. Corrigir erro de digitação também é substituição:
 * uma correção registrada, não uma sobrescrita silenciosa.
 */

export class ClausulaInvalidaError extends Error {
  constructor(mensagem: string) {
    super(mensagem)
    this.name = 'ClausulaInvalidaError'
  }
}

export class SemPermissaoContratos extends Error {
  constructor(mensagem: string) {
    super(mensagem)
    this.name = 'SemPermissaoContratos'
  }
}

/** Só o Jurídico confirma cláusula. Confirmar é afirmar o que o contrato diz. */
const PAPEL_CONFIRMA = 'ops-juridico'

export function podeConfirmar(id: Identidade): boolean {
  return id.papeis.includes(PAPEL_CONFIRMA) || id.permissoes.configurar
}

export interface Clausula {
  id: string
  accountId: string
  conta: string
  tipo: TipoClausula
  rotulo: string
  /** `null` quando a pessoa não pode ler o valor — ver `restrito`. */
  valorEstruturado: Record<string, unknown> | null
  texto: string | null
  /** Verdadeiro quando o tipo é visível mas o valor está oculto para este papel. */
  restrito: boolean
  /** A frase que ocupa o lugar do valor quando `restrito`. */
  avisoRestricao: string | null
  validoDe: string
  validoAte: string | null
  documentoId: string | null
  documentoTitulo: string | null
  trecho: string | null
  substituiClauseId: string | null
  estado: 'proposta' | 'confirmada' | 'substituida'
  confirmadaPor: string | null
  confirmadaEm: string | null
  criadoEm: string
}

const COLUNAS = `
  c.id, c.account_id AS "accountId", a.razao_social AS conta,
  c.tipo, c.valor_estruturado, c.texto,
  to_char(c.valido_de,'YYYY-MM-DD')  AS "validoDe",
  to_char(c.valido_ate,'YYYY-MM-DD') AS "validoAte",
  c.document_id AS "documentoId", d.titulo AS "documentoTitulo", c.trecho,
  c.substitui_clause_id AS "substituiClauseId",
  c.estado, c.confirmada_por AS "confirmadaPor", c.confirmada_em AS "confirmadaEm",
  c.audiencia_papeis AS "audienciaPapeis",
  c.criado_em AS "criadoEm"`

const DE = `
  FROM contracts.clause c
  JOIN core.account a ON a.id = c.account_id
  LEFT JOIN contracts.document d ON d.id = c.document_id`

interface Bruta extends Omit<Clausula, 'rotulo' | 'restrito' | 'avisoRestricao' | 'valorEstruturado'> {
  valor_estruturado: Record<string, unknown>
  audienciaPapeis: string[] | null
}

/**
 * Aplica o sigilo à cláusula lida do banco.
 *
 * É aqui, e não na tela, porque a tela é só uma das saídas: exportação de lista,
 * resposta de API e relatório sairiam do mesmo lugar, e cada um refazendo a regra
 * é como uma delas passa a vazar. O valor oculto é apagado do OBJETO, não escondido
 * por CSS.
 */
function aplicarSigilo(b: Bruta, id: Identidade): Clausula {
  const spec = especificacao(b.tipo)
  const pode = podeLerValor(b.tipo, id.papeis, b.audienciaPapeis)
  return {
    ...b,
    rotulo: spec?.rotulo ?? b.tipo,
    valorEstruturado: pode ? b.valor_estruturado : null,
    texto: pode ? b.texto : null,
    trecho: pode ? b.trecho : null,
    restrito: !pode,
    avisoRestricao: pode ? null : textoRestrito(b.tipo),
  }
}

/**
 * O que vale HOJE para uma conta.
 *
 * A consulta é `valido_ate IS NULL OR valido_ate > hoje`, e não um campo booleano:
 * com aditivo, "o que o contrato dizia" e "o que vale hoje" divergem, e as duas
 * respostas precisam continuar disponíveis.
 *
 * Cláusula PROPOSTA aparece — marcada. Ela não decide, mas esconder faria a pessoa
 * concluir que o contrato é silencioso sobre aquilo, o que é pior que saber que
 * existe uma proposta não conferida.
 */
export async function valeHoje(
  db: pg.Pool,
  id: Identidade,
  accountId: string,
  opts: { hoje?: string } = {},
): Promise<Clausula[]> {
  if (id.permissoes.contas === 'nenhum') return []
  const hoje = opts.hoje ?? new Date().toISOString().slice(0, 10)

  const { rows } = await db.query<Bruta>(
    `SELECT ${COLUNAS} ${DE}
      WHERE c.account_id = $1
        AND c.estado <> 'substituida'
        AND (c.valido_ate IS NULL OR c.valido_ate > $2::date)
      ORDER BY c.tipo, c.valido_de DESC`,
    [accountId, hoje],
  )
  return rows.map((b) => aplicarSigilo(b, id))
}

/** Toda a história de um tipo numa conta — o que mudou, quando e por qual aditivo. */
export async function historicoDoTipo(
  db: pg.Pool,
  id: Identidade,
  accountId: string,
  tipo: TipoClausula,
): Promise<Clausula[]> {
  if (id.permissoes.contas === 'nenhum') return []
  const { rows } = await db.query<Bruta>(
    `SELECT ${COLUNAS} ${DE}
      WHERE c.account_id = $1 AND c.tipo = $2
      ORDER BY c.valido_de DESC, c.criado_em DESC`,
    [accountId, tipo],
  )
  return rows.map((b) => aplicarSigilo(b, id))
}

/**
 * A busca que decide o projeto: "quais contratos vedam comunicação com usuário?".
 *
 * É ela que faz Marketing responder sozinho, sem perguntar ao Jurídico. Quem não
 * pode ler o valor do tipo buscado recebe zero resultados com uma recusa
 * explícita — e não uma lista vazia, que se leria como "nenhum contrato veda".
 */
export async function buscarPorTipo(
  db: pg.Pool,
  id: Identidade,
  tipo: TipoClausula,
  opts: { valor?: string; hoje?: string } = {},
): Promise<{ clausulas: Clausula[]; recusado: boolean }> {
  if (id.permissoes.contas === 'nenhum') return { clausulas: [], recusado: true }
  if (!podeLerValor(tipo, id.papeis)) {
    // Recusa explícita: lista vazia aqui seria lida como "nenhum contrato tem
    // essa cláusula", e alguém agiria com base nessa conclusão errada.
    return { clausulas: [], recusado: true }
  }
  const hoje = opts.hoje ?? new Date().toISOString().slice(0, 10)

  const { rows } = await db.query<Bruta>(
    `SELECT ${COLUNAS} ${DE}
      WHERE c.tipo = $1
        AND c.estado <> 'substituida'
        AND (c.valido_ate IS NULL OR c.valido_ate > $2::date)
        -- Filtro por valor sobre o jsonb: "quais reajustam por IGPM?" precisa
        -- alcançar o conteúdo, não só o tipo.
        AND ($3::text IS NULL OR c.valor_estruturado::text ILIKE '%' || $3 || '%')
      ORDER BY a.razao_social`,
    [tipo, hoje, opts.valor ?? null],
  )
  return { clausulas: rows.map((b) => aplicarSigilo(b, id)), recusado: false }
}

/**
 * Propõe uma cláusula — extração assistida ou digitação.
 *
 * Nasce `proposta` e não decide nada. Pode não ter documento ainda: a extração da
 * planilha legada não tem PDF associado no dia 1, e exigir procedência para
 * PROPOR travaria a captação inteira. Para CONFIRMAR, o banco exige.
 */
export async function propor(
  db: pg.Pool,
  id: Identidade,
  dados: {
    accountId: string
    tipo: TipoClausula
    valorEstruturado?: Record<string, unknown>
    texto?: string
    validoDe: string
    documentoId?: string
    trecho?: string
    audienciaPapeis?: readonly string[]
  },
): Promise<string> {
  if (id.permissoes.contas === 'nenhum') {
    throw new SemPermissaoContratos('propor cláusula exige acesso a contas')
  }
  const spec = especificacao(dados.tipo)
  if (!spec) throw new ClausulaInvalidaError(`tipo "${dados.tipo}" não está na taxonomia`)
  if (spec.forma === 'enum' && spec.valores) {
    const v = dados.valorEstruturado?.['valor']
    if (typeof v !== 'string' || !spec.valores.includes(v)) {
      throw new ClausulaInvalidaError(
        `${spec.rotulo} aceita ${spec.valores.join(' · ')}, e recebeu "${String(v)}"`,
      )
    }
  }
  if (dados.tipo === 'outra' && !(dados.audienciaPapeis && dados.audienciaPapeis.length > 0)) {
    throw new ClausulaInvalidaError(
      'cláusula "outra" exige audiência declarada — sem faixa na taxonomia, ela ficaria visível para todos por omissão',
    )
  }

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO contracts.clause
       (account_id, contract_id, tipo, valor_estruturado, texto, valido_de,
        document_id, trecho, audiencia_papeis, estado)
     SELECT $1,
            (SELECT id FROM core.contract
              WHERE account_id = $1 AND status_vigencia = 'vigente'
              ORDER BY inicio DESC LIMIT 1),
            $2, $3, $4, $5::date, $6, $7, $8, 'proposta'
     RETURNING id`,
    [
      dados.accountId,
      dados.tipo,
      JSON.stringify(dados.valorEstruturado ?? {}),
      dados.texto ?? null,
      dados.validoDe,
      dados.documentoId ?? null,
      dados.trecho ?? null,
      dados.audienciaPapeis ?? null,
    ],
  )
  return String(rows[0]!.id)
}

/**
 * Confirma a cláusula: alguém do Jurídico afirma que aquilo está escrito ali.
 *
 * Exige procedência — documento e trecho. É a invariante 1, imposta pelo banco e
 * checada aqui para a recusa chegar como frase legível: afirmar sem dizer onde
 * está escrito é exatamente o que a ferramenta existe para acabar.
 */
export async function confirmar(
  db: pg.Pool,
  id: Identidade,
  clausulaId: string,
  procedencia: { documentoId: string; trecho: string },
): Promise<void> {
  if (!podeConfirmar(id)) {
    throw new SemPermissaoContratos(
      'só o Jurídico confirma cláusula — confirmar é afirmar o que o contrato diz',
    )
  }
  if (!procedencia.documentoId || !procedencia.trecho.trim()) {
    throw new ClausulaInvalidaError(
      'confirmar exige o documento e o trecho de onde a cláusula saiu',
    )
  }
  const { rowCount } = await db.query(
    `UPDATE contracts.clause
        SET estado = 'confirmada', document_id = $3, trecho = $4,
            confirmada_por = $2, confirmada_em = now()
      WHERE id = $1 AND estado = 'proposta'`,
    [clausulaId, id.email, procedencia.documentoId, procedencia.trecho.trim()],
  )
  if (rowCount === 0) {
    throw new ClausulaInvalidaError('esta cláusula não está proposta — nada a confirmar')
  }
}

/**
 * Substitui uma cláusula por outra: o aditivo fecha a antiga e abre a nova.
 *
 * As duas coisas na MESMA transação. Na ordem inversa, um erro no meio deixaria
 * duas cláusulas vigentes do mesmo tipo — e "o que vale hoje" teria duas
 * respostas, que é exatamente o problema que a ferramenta resolve.
 *
 * A antiga fica como `substituida`, nunca apagada: quem pergunta "por que mudou?"
 * recebe o aditivo e a data.
 */
export async function substituir(
  db: pg.Pool,
  id: Identidade,
  clausulaAntigaId: string,
  nova: {
    valorEstruturado?: Record<string, unknown>
    texto?: string
    validoDe: string
    documentoId: string
    trecho: string
  },
): Promise<string> {
  if (!podeConfirmar(id)) {
    throw new SemPermissaoContratos('substituir cláusula exige alçada do Jurídico')
  }
  if (!nova.documentoId || !nova.trecho.trim()) {
    throw new ClausulaInvalidaError(
      'a cláusula nova precisa do documento que a criou — aditivo sem documento não substitui nada',
    )
  }

  const cliente = await db.connect()
  try {
    await cliente.query('BEGIN')
    const { rows: antiga } = await cliente.query<{
      account_id: string
      tipo: string
      valido_de: string
      audiencia_papeis: string[] | null
    }>(
      `SELECT account_id, tipo, to_char(valido_de,'YYYY-MM-DD') valido_de, audiencia_papeis
         FROM contracts.clause WHERE id = $1 FOR UPDATE`,
      [clausulaAntigaId],
    )
    const a = antiga[0]
    if (!a) throw new ClausulaInvalidaError('cláusula a substituir não encontrada')
    if (nova.validoDe < a.valido_de) {
      throw new ClausulaInvalidaError(
        `a nova cláusula vale de ${nova.validoDe}, antes da que ela substitui (${a.valido_de})`,
      )
    }

    // Fecha a antiga NO DIA em que a nova começa: um dia de sobreposição faria
    // "o que vale hoje" devolver duas respostas naquele dia.
    await cliente.query(
      `UPDATE contracts.clause
          SET valido_ate = $2::date, estado = 'substituida'
        WHERE id = $1`,
      [clausulaAntigaId, nova.validoDe],
    )

    const { rows } = await cliente.query<{ id: string }>(
      `INSERT INTO contracts.clause
         (account_id, contract_id, tipo, valor_estruturado, texto, valido_de,
          document_id, trecho, substitui_clause_id, audiencia_papeis,
          estado, confirmada_por, confirmada_em)
       SELECT $1,
              (SELECT id FROM core.contract
                WHERE account_id = $1 AND status_vigencia = 'vigente'
                ORDER BY inicio DESC LIMIT 1),
              $2, $3, $4, $5::date, $6, $7, $8, $9, 'confirmada', $10, now()
       RETURNING id`,
      [
        a.account_id,
        a.tipo,
        JSON.stringify(nova.valorEstruturado ?? {}),
        nova.texto ?? null,
        nova.validoDe,
        nova.documentoId,
        nova.trecho.trim(),
        clausulaAntigaId,
        a.audiencia_papeis,
        id.email,
      ],
    )
    await cliente.query('COMMIT')
    return String(rows[0]!.id)
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    cliente.release()
  }
}

export interface ProgressoCaptacao {
  tipo: TipoClausula
  rotulo: string
  confirmadas: number
  propostas: number
  ausentes: number
}

/**
 * Onde a captação está, por tipo de cláusula.
 *
 * O que interessa não é o total: é quantas contas ainda não têm resposta para
 * cada pergunta. "Nenhum contrato responde se podemos usar a marca" é um número
 * que muda prioridade; "43% capturado" não é.
 */
export async function progresso(
  db: pg.Pool,
  tipos: readonly TipoClausula[],
): Promise<ProgressoCaptacao[]> {
  const { rows } = await db.query<{
    tipo: string
    confirmadas: string
    propostas: string
    contas: string
  }>(
    `WITH contas AS (SELECT count(*)::int n FROM core.account),
     t AS (SELECT unnest($1::text[]) AS tipo)
     SELECT t.tipo,
            count(DISTINCT c.account_id) FILTER (WHERE c.estado = 'confirmada')::text AS confirmadas,
            count(DISTINCT c.account_id) FILTER (WHERE c.estado = 'proposta')::text AS propostas,
            (SELECT n FROM contas)::text AS contas
       FROM t
       LEFT JOIN contracts.clause c
              ON c.tipo = t.tipo AND c.valido_ate IS NULL AND c.estado <> 'substituida'
      GROUP BY t.tipo
      ORDER BY t.tipo`,
    [tipos],
  )
  return rows.map((r) => {
    const conf = Number(r.confirmadas)
    const prop = Number(r.propostas)
    return {
      tipo: r.tipo as TipoClausula,
      rotulo: especificacao(r.tipo)?.rotulo ?? r.tipo,
      confirmadas: conf,
      propostas: prop,
      // Uma conta pode ter proposta E confirmada do mesmo tipo em vigências
      // diferentes; o piso zero evita ausente negativo nesse caso.
      ausentes: Math.max(0, Number(r.contas) - conf - prop),
    }
  })
}

/**
 * A fila de confirmação, ordenada por MRR.
 *
 * Ordem por MRR e não por data de extração: com centenas de cláusulas propostas e
 * tempo limitado do Jurídico, conferir primeiro o contrato de R$ 70 mil é o que
 * faz a confirmação valer o esforço. Vigência próxima entra como desempate —
 * cláusula que vai vencer antes de ser conferida é cláusula perdida.
 */
export async function filaDeConfirmacao(
  db: pg.Pool,
  id: Identidade,
  limite = 50,
): Promise<Array<Clausula & { mrrCentavos: string | null; diasParaVigencia: number | null }>> {
  if (!podeConfirmar(id)) return []
  const { rows } = await db.query<
    Bruta & { mrrCentavos: string | null; diasParaVigencia: number | null }
  >(
    `SELECT ${COLUNAS},
            ct.mrr_centavos::text AS "mrrCentavos",
            (ct.vigencia_fim - current_date) AS "diasParaVigencia"
       ${DE}
       LEFT JOIN core.contract ct ON ct.id = c.contract_id
      WHERE c.estado = 'proposta' AND c.valido_ate IS NULL
      ORDER BY ct.mrr_centavos DESC NULLS LAST, ct.vigencia_fim NULLS LAST
      LIMIT $1`,
    [limite],
  )
  return rows.map((b) => ({
    ...aplicarSigilo(b, id),
    mrrCentavos: b.mrrCentavos,
    diasParaVigencia: b.diasParaVigencia === null ? null : Number(b.diasParaVigencia),
  }))
}
