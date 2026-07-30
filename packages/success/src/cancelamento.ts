import type { Identidade } from '@ops/auth'
import type pg from 'pg'

/**
 * Churn real — a saída modelada como PROCESSO, com quatro datas.
 *
 * Doc 01 (v1.0), seção 10.1. Quando um cliente levanta a mão ele está perdido
 * comercialmente naquele dia, mas a receita dele continua entrando durante todo
 * o aviso prévio. São dois fatos em momentos diferentes, e tratá-los como um só
 * produz duas distorções opostas:
 *
 *   reconhecer a receita como perdida no dia do anúncio  → subestima o trimestre;
 *   contar o cliente como ativo até o último pagamento   → esconde uma perda que
 *                                                          já aconteceu e que
 *                                                          ainda dava para reverter.
 *
 * Por isso cada métrica lê a data que lhe corresponde:
 *
 *   data_levantada               → CHURN DE CONTAS
 *   data_fim_aviso               → o prazo duro da retenção
 *   competencia_ultima_cobranca  → confirmada pelo Financeiro
 *   competencia_efeito_receita   → CHURN DE RECEITA (última cobrança + 1)
 *
 * As transições daqui não repetem as invariantes: quem as impõe é o banco
 * (`efeito_receita_exige_duas_confirmacoes`, `encerrado_tem_efeito_e_aprovacao`).
 * Este módulo existe para que a transição ilegal falhe com uma frase que uma
 * pessoa entende, em vez de com uma violação de CHECK.
 */

export type EstadoSaida = 'anunciado' | 'em_aviso' | 'retido' | 'encerrado'
export type OrigemSaida = 'cliente' | 'alloyal'
export type CanalAnuncio = 'email' | 'reuniao' | 'whatsapp' | 'formulario' | 'telefone'

/**
 * A taxonomia fechada de motivos de saída.
 *
 * Texto livre não sustenta análise de padrão: com campo aberto, "preço",
 * "custo", "caro" e "orçamento" viram quatro motivos distintos, e a pergunta
 * "por que perdemos clientes" deixa de ter resposta. A lista é curta de
 * propósito — taxonomia grande é preenchida no chute.
 *
 * `outro` existe e exige detalhe: sem ele, quem não acha a categoria escolhe a
 * primeira que parece caber, e contamina a categoria certa.
 */
export const MOTIVOS_SAIDA = [
  { valor: 'custo', rotulo: 'Custo', explica: 'preço, orçamento ou corte de despesa' },
  { valor: 'baixa_adesao', rotulo: 'Baixa adesão', explica: 'o clube não pegou na base' },
  { valor: 'insatisfacao_produto', rotulo: 'Insatisfação com o produto', explica: 'falha, lacuna ou experiência' },
  { valor: 'insatisfacao_atendimento', rotulo: 'Insatisfação com o atendimento', explica: 'suporte ou relacionamento' },
  { valor: 'concorrente', rotulo: 'Foi para o concorrente', explica: 'trocou por outro fornecedor' },
  { valor: 'mudanca_interna', rotulo: 'Mudança interna do cliente', explica: 'troca de gestão, fusão, reestruturação' },
  { valor: 'encerramento_atividade', rotulo: 'Encerrou atividade', explica: 'a empresa fechou ou foi adquirida' },
  { valor: 'churn_inadimplencia', rotulo: 'Inadimplência', explica: 'encerramento pela Alloyal, decisão de crédito' },
  { valor: 'outro', rotulo: 'Outro', explica: 'exige detalhe escrito' },
] as const

export type MotivoSaida = (typeof MOTIVOS_SAIDA)[number]['valor']

/** O rótulo legível de um motivo, ou o próprio código se vier de fora da lista. */
export function rotuloDoMotivo(motivo: string | null): string | null {
  if (!motivo) return null
  return MOTIVOS_SAIDA.find((m) => m.valor === motivo)?.rotulo ?? motivo.replace(/_/g, ' ')
}

export class TransicaoInvalidaError extends Error {
  constructor(mensagem: string) {
    super(mensagem)
    this.name = 'TransicaoInvalidaError'
  }
}

export class SemPermissaoError extends Error {
  constructor(mensagem: string) {
    super(mensagem)
    this.name = 'SemPermissaoError'
  }
}

/**
 * Quais transições saem de cada estado.
 *
 * `retido` e `encerrado` são terminais de propósito. Reabrir uma saída encerrada
 * moveria receita entre competências já congeladas; se o cliente voltar, o
 * evento certo é uma reativação nova, não a edição da saída antiga.
 */
export const TRANSICOES: Readonly<Record<EstadoSaida, readonly EstadoSaida[]>> = {
  anunciado: ['em_aviso', 'retido'],
  em_aviso: ['retido', 'encerrado'],
  retido: [],
  encerrado: [],
}

export function podeIr(de: EstadoSaida, para: EstadoSaida): boolean {
  return TRANSICOES[de].includes(para)
}

/**
 * A competência em que a receita sai: último mês cobrado + 1.
 *
 * É derivada, nunca digitada. Deixar alguém digitar significa que um dia o
 * churn de receita e a última cobrança vão discordar, e a diferença aparecerá
 * como um ajuste sem explicação no fechamento.
 */
export function competenciaDeEfeito(ultimaCobranca: string): string {
  const [ano, mes] = ultimaCobranca.split('-').map(Number) as [number, number]
  const proximo = mes === 12 ? 1 : mes + 1
  const anoDoProximo = mes === 12 ? ano + 1 : ano
  return `${anoDoProximo}-${String(proximo).padStart(2, '0')}-01`
}

/** A data em que a janela de retenção fecha. */
export function fimDoAviso(dataLevantada: string, avisoPrevioDias: number): string {
  const d = new Date(`${dataLevantada}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + avisoPrevioDias)
  return d.toISOString().slice(0, 10)
}

export interface Saida {
  id: string
  accountId: string
  conta: string
  origem: OrigemSaida
  estado: EstadoSaida
  dataLevantada: string | null
  canal: CanalAnuncio | null
  quemComunicou: string | null
  mrrCentavosNaLevantada: string | null
  multaAplicavelCentavos: string | null
  debitoAbertoNaLevantadaCentavos: string | null
  avisoPrevioDias: number | null
  avisoConfirmadoPor: string | null
  avisoConfirmadoEm: string | null
  dataFimAviso: string | null
  competenciaUltimaCobranca: string | null
  cobrancaConfirmadaPor: string | null
  cobrancaConfirmadaEm: string | null
  competenciaEfeitoReceita: string | null
  motivo: string | null
  retidoEm: string | null
  retidoPor: string | null
  aprovadoPor: string | null
  /** Dias que faltam para a janela de retenção fechar; negativo se já fechou. */
  diasParaFimDoAviso: number | null
  criadoEm: string
}

/**
 * O que falta para esta saída poder ser encerrada.
 *
 * Lista, não booleano: "não pode encerrar" sem dizer o que falta é como um
 * distrato fica parado três semanas esperando alguém descobrir qual campo
 * estava em branco.
 */
export function faltaParaEncerrar(s: Saida): string[] {
  const falta: string[] = []
  if (s.avisoConfirmadoPor === null) falta.push('confirmação do aviso prévio (CS ou Jurídico)')
  if (s.competenciaUltimaCobranca === null || s.cobrancaConfirmadaPor === null) {
    falta.push('confirmação do último mês de cobrança (Financeiro)')
  }
  if (s.aprovadoPor === null) falta.push('aprovação do distrato')
  return falta
}

const COLUNAS = `
  c.id, c.account_id AS "accountId", a.razao_social AS conta,
  c.origem, c.estado,
  to_char(c.data_levantada,'YYYY-MM-DD')              AS "dataLevantada",
  c.canal, c.quem_comunicou                            AS "quemComunicou",
  c.mrr_centavos_na_levantada::text                    AS "mrrCentavosNaLevantada",
  c.multa_aplicavel_centavos::text                     AS "multaAplicavelCentavos",
  c.debito_aberto_na_levantada_centavos::text          AS "debitoAbertoNaLevantadaCentavos",
  c.aviso_previo_dias                                  AS "avisoPrevioDias",
  c.aviso_confirmado_por                               AS "avisoConfirmadoPor",
  c.aviso_confirmado_em                                AS "avisoConfirmadoEm",
  to_char(c.data_fim_aviso,'YYYY-MM-DD')               AS "dataFimAviso",
  to_char(c.competencia_ultima_cobranca,'YYYY-MM')     AS "competenciaUltimaCobranca",
  c.cobranca_confirmada_por                            AS "cobrancaConfirmadaPor",
  c.cobranca_confirmada_em                             AS "cobrancaConfirmadaEm",
  to_char(c.competencia_efeito_receita,'YYYY-MM')      AS "competenciaEfeitoReceita",
  c.motivo, to_char(c.retido_em,'YYYY-MM-DD') AS "retidoEm", c.retido_por AS "retidoPor",
  c.aprovado_por AS "aprovadoPor",
  (c.data_fim_aviso - current_date)                    AS "diasParaFimDoAviso",
  c.criado_em                                          AS "criadoEm"`

/** Registra a levantada de mão. É o instante do churn de CONTAS. */
export async function anunciar(
  db: pg.Pool,
  id: Identidade,
  dados: {
    accountId: string
    origem: OrigemSaida
    dataLevantada?: string
    canal?: CanalAnuncio
    quemComunicou?: string
    motivo?: string
    motivoDetalhe?: string
  },
): Promise<string> {
  if (id.permissoes.fila === 'nenhum' && !id.permissoes.configurar) {
    throw new SemPermissaoError('registrar saída exige acesso à fila de trabalho')
  }
  if (dados.origem === 'cliente' && !dados.dataLevantada) {
    throw new TransicaoInvalidaError(
      'levantada de mão exige a data em que o cliente comunicou — é a data do churn de contas',
    )
  }

  const cliente = await db.connect()
  try {
    await cliente.query('BEGIN')

    // Uma conta não pode ter duas saídas abertas: a segunda duplicaria o MRR na
    // conta de saída comprometida, e o número que o board olha dobraria.
    const { rows: abertas } = await cliente.query<{ id: string }>(
      `SELECT id FROM success.cancellation
        WHERE account_id = $1 AND estado IN ('anunciado','em_aviso') FOR UPDATE`,
      [dados.accountId],
    )
    if (abertas.length > 0) {
      throw new TransicaoInvalidaError(
        'já existe uma saída em andamento para esta conta — atualize aquela em vez de abrir outra',
      )
    }

    // MRR, multa e débito são CONGELADOS aqui. Durante o aviso o contrato pode
    // ser reajustado ou contraído, e a perda tem que ser medida contra o valor
    // que existia quando o cliente decidiu sair.
    const { rows } = await cliente.query<{ id: string }>(
      `INSERT INTO success.cancellation
         (account_id, contract_id, origem, estado, data_levantada, canal,
          quem_comunicou, motivo, motivo_detalhe,
          mrr_centavos_na_levantada, multa_aplicavel_centavos,
          debito_aberto_na_levantada_centavos, aviso_previo_dias)
       SELECT $1, ct.id, $2, 'anunciado', $3::date, $4, $5, $6, $7,
              ct.mrr_centavos,
              NULL,
              (SELECT valor_aberto_centavos FROM metrics.daily_snapshot
                WHERE account_id = $1 ORDER BY competencia DESC LIMIT 1),
              ct.aviso_previo_dias
         FROM core.contract ct
        WHERE ct.account_id = $1 AND ct.status_vigencia = 'vigente'
        ORDER BY ct.inicio DESC LIMIT 1
       RETURNING id`,
      [
        dados.accountId,
        dados.origem,
        dados.dataLevantada ?? null,
        dados.canal ?? null,
        dados.quemComunicou ?? null,
        dados.motivo ?? null,
        dados.motivoDetalhe ?? null,
      ],
    )
    if (rows.length === 0) {
      throw new TransicaoInvalidaError(
        'conta sem contrato vigente — não há MRR para congelar nem aviso prévio para contar',
      )
    }
    await cliente.query('COMMIT')
    return String(rows[0]!.id)
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    cliente.release()
  }
}

/**
 * CONFIRMAÇÃO 1 — o aviso prévio, por CS ou Jurídico.
 *
 * O contrato diz N dias, mas há acordo, renúncia e prorrogação: é o campo que
 * mais desloca receita entre meses, e por isso é confirmado por uma pessoa em
 * vez de copiado em silêncio.
 */
export async function confirmarAviso(
  db: pg.Pool,
  id: Identidade,
  saidaId: string,
  avisoPrevioDias: number,
): Promise<void> {
  if (id.permissoes.fila === 'nenhum' && !id.permissoes.configurar) {
    throw new SemPermissaoError('confirmar aviso prévio exige acesso à fila de trabalho')
  }
  if (!Number.isInteger(avisoPrevioDias) || avisoPrevioDias < 0) {
    throw new TransicaoInvalidaError('aviso prévio em dias tem que ser um inteiro não negativo')
  }

  const { rowCount } = await db.query(
    `UPDATE success.cancellation
        SET aviso_previo_dias = $3,
            -- Saída pedida pelo cliente conta a partir da levantada; saída da
            -- Alloyal por inadimplência não tem levantada — o equivalente é a
            -- data da provisão, que é quando o registro nasceu.
            data_fim_aviso = COALESCE(data_levantada, criado_em::date) + $3::int,
            aviso_confirmado_por = $2,
            aviso_confirmado_em = now(),
            estado = CASE WHEN estado = 'anunciado' THEN 'em_aviso' ELSE estado END
      WHERE id = $1 AND estado IN ('anunciado','em_aviso')`,
    [saidaId, id.email, avisoPrevioDias],
  )
  if (rowCount === 0) {
    throw new TransicaoInvalidaError('saída não está aberta')
  }
}

/**
 * CONFIRMAÇÃO 2 — o último mês de cobrança, pelo Financeiro.
 *
 * Só o Financeiro sabe se a última fatura saiu, foi rateada ou antecipada. É
 * aqui que `competencia_efeito_receita` nasce, derivada — e o banco recusa
 * gravá-la sem as duas confirmações.
 */
export async function confirmarUltimaCobranca(
  db: pg.Pool,
  id: Identidade,
  saidaId: string,
  competenciaUltimaCobranca: string,
): Promise<{ competenciaEfeitoReceita: string }> {
  if (id.permissoes.aprovaDistrato !== 'financeiro' && !id.permissoes.configurar) {
    throw new SemPermissaoError(
      'só o Financeiro confirma o último mês de cobrança — é quem sabe se a fatura saiu',
    )
  }
  if (!/^\d{4}-\d{2}(-\d{2})?$/.test(competenciaUltimaCobranca)) {
    throw new TransicaoInvalidaError('competência tem que estar em AAAA-MM')
  }
  const comp = competenciaUltimaCobranca.slice(0, 7) + '-01'
  const efeito = competenciaDeEfeito(comp)

  const { rowCount } = await db.query(
    `UPDATE success.cancellation
        SET competencia_ultima_cobranca = $3::date,
            cobranca_confirmada_por = $2,
            cobranca_confirmada_em = now(),
            -- Só é gravada quando a OUTRA confirmação já existe. O banco também
            -- recusa, mas recusar aqui dá uma mensagem que uma pessoa entende.
            competencia_efeito_receita =
              CASE WHEN aviso_confirmado_por IS NOT NULL THEN $4::date END
      WHERE id = $1 AND estado IN ('anunciado','em_aviso')`,
    [saidaId, id.email, comp, efeito],
  )
  if (rowCount === 0) throw new TransicaoInvalidaError('saída não está aberta')
  return { competenciaEfeitoReceita: efeito }
}

/**
 * Retenção — a saída revertida dentro da janela.
 *
 * É a métrica de vitória do time de CS que a maioria das empresas nunca
 * calcula, e por isso ela é um ESTADO e não um `delete`: apagar a saída
 * apagaria junto a prova de que houve reversão.
 */
export async function reter(
  db: pg.Pool,
  id: Identidade,
  saidaId: string,
  nota?: string,
): Promise<void> {
  if (id.permissoes.fila === 'nenhum' && !id.permissoes.configurar) {
    throw new SemPermissaoError('registrar retenção exige acesso à fila de trabalho')
  }
  const { rowCount } = await db.query(
    `UPDATE success.cancellation
        SET estado = 'retido', retido_em = current_date, retido_por = $2,
            motivo_detalhe = COALESCE($3, motivo_detalhe)
      WHERE id = $1 AND estado IN ('anunciado','em_aviso')`,
    [saidaId, id.email, nota ?? null],
  )
  if (rowCount === 0) {
    throw new TransicaoInvalidaError('só uma saída anunciada ou em aviso pode ser retida')
  }
}

/**
 * Encerramento — a receita sai da base e o evento entra no ledger.
 *
 * O gate humano é aqui, e o evento em `fact.mrr_event` é gravado na MESMA
 * transação: ledger e processo não podem discordar nem por um instante, porque
 * o fechamento mensal lê o ledger e ninguém reconcilia o que não sabe que
 * divergiu.
 */
export async function encerrar(
  db: pg.Pool,
  id: Identidade,
  saidaId: string,
): Promise<{ competenciaEfeitoReceita: string; valorCentavos: string }> {
  if (id.permissoes.aprovaDistrato === 'nao' && !id.permissoes.configurar) {
    throw new SemPermissaoError('encerrar exige alçada de aprovação de distrato')
  }

  const cliente = await db.connect()
  try {
    await cliente.query('BEGIN')
    const { rows } = await cliente.query<Saida>(
      `SELECT ${COLUNAS} FROM success.cancellation c
         JOIN core.account a ON a.id = c.account_id
        WHERE c.id = $1 FOR UPDATE OF c`,
      [saidaId],
    )
    const s = rows[0]
    if (!s) throw new TransicaoInvalidaError('saída não encontrada')
    if (s.estado === 'retido' || s.estado === 'encerrado') {
      throw new TransicaoInvalidaError(
        s.estado === 'retido'
          ? 'esta saída foi revertida; se o cliente sair de novo, o caminho é uma saída nova'
          : 'esta saída já foi encerrada',
      )
    }
    // A lista vem ANTES da checagem de estado para o caso aberto: dizer "uma
    // saída em anunciado não pode ser encerrada" é verdade e não ajuda ninguém —
    // o que a pessoa precisa saber é qual confirmação está faltando.
    const falta = faltaParaEncerrar({ ...s, aprovadoPor: 'ok' })
    if (falta.length > 0) {
      throw new TransicaoInvalidaError(`falta antes de encerrar: ${falta.join('; ')}`)
    }

    const efeito = competenciaDeEfeito(s.competenciaUltimaCobranca! + '-01')
    const valor = -Math.abs(Number(s.mrrCentavosNaLevantada ?? 0))

    await cliente.query(
      `UPDATE success.cancellation
          SET estado = 'encerrado', aprovado_por = $2, aprovado_em = now(),
              competencia_efeito_receita = $3::date
        WHERE id = $1`,
      [saidaId, id.email, efeito],
    )

    // `chave_natural` faz a gravação ser idempotente: dois cliques no botão de
    // aprovar não podem virar duas baixas de receita.
    await cliente.query(
      `INSERT INTO fact.mrr_event
         (account_id, contract_id, competencia, valor_centavos, tipo, motivo,
          origem, criado_por, chave_natural)
       SELECT c.account_id, c.contract_id, $2::date, $3, $4, c.motivo,
              'ops', $5, 'cancelamento:' || c.id
         FROM success.cancellation c WHERE c.id = $1
       ON CONFLICT (chave_natural) DO NOTHING`,
      [
        saidaId,
        efeito,
        valor,
        s.origem === 'alloyal' ? 'churn_inadimplencia' : 'churn_pedido',
        id.email,
      ],
    )

    await cliente.query('COMMIT')
    return { competenciaEfeitoReceita: efeito.slice(0, 7), valorCentavos: String(valor) }
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    cliente.release()
  }
}

export async function listarSaidas(
  db: pg.Pool,
  id: Identidade,
  opts: { estados?: readonly EstadoSaida[] } = {},
): Promise<Saida[]> {
  if (id.permissoes.contas === 'nenhum') return []
  const daBase = id.permissoes.contas === 'base'
  const estados = opts.estados ?? ['anunciado', 'em_aviso', 'retido', 'encerrado']

  const { rows } = await db.query<Saida>(
    `SELECT ${COLUNAS}
       FROM success.cancellation c
       JOIN core.account a ON a.id = c.account_id
      WHERE c.estado = ANY($1)
        AND ($2::boolean OR a.csm_email = $3)
      -- Aberto primeiro, e dentro dele o que tem menos janela de retenção: é o
      -- que ainda dá para reverter, e é a única parte desta tela que é ação.
      ORDER BY (c.estado IN ('anunciado','em_aviso')) DESC,
               c.data_fim_aviso NULLS FIRST, c.data_levantada DESC`,
    [estados, daBase, id.email],
  )
  return rows.map((r) => ({
    ...r,
    diasParaFimDoAviso: r.diasParaFimDoAviso === null ? null : Number(r.diasParaFimDoAviso),
  }))
}

export interface ResumoChurn {
  competencia: string
  /** Contas que levantaram a mão NESTA competência — churn de contas. */
  contasQueLevantaram: number
  mrrQueLevantouCentavos: string
  /**
   * Quantas daquelas levantadas foram revertidas DEPOIS.
   *
   * Vem separado em vez de subtraído do total porque `contasQueLevantaram`
   * precisa ser estável: um número de mês fechado que muda sozinho quando o
   * processo avança é a definição de relatório em que ninguém confia. Quem
   * quiser o líquido subtrai; quem quiser o bruto tem o bruto.
   */
  retidasDepois: number
  /** Contas cujo efeito na receita cai NESTA competência — churn de receita. */
  contasComEfeito: number
  mrrRealizadoCentavos: string
  /** MRR anunciado que ainda está faturando: nem ativo saudável, nem perdido. */
  mrrComprometidoCentavos: string
  contasComprometidas: number
  retidasNaCompetencia: number
  mrrRetidoCentavos: string
}

/**
 * Os dois churns, lado a lado, cada um lendo a data que lhe corresponde.
 *
 * Ver juntos é o ponto: o mês em que as contas saem quase nunca é o mês em que
 * a receita sai, e a diferença entre os dois — a SAÍDA COMPROMETIDA — é o
 * número que responde "quanto do faturamento de hoje já está perdido".
 */
export async function resumoChurn(db: pg.Pool, competencia: string): Promise<ResumoChurn> {
  const { rows } = await db.query<Record<string, string>>(
    `WITH mes AS (SELECT date_trunc('month', $1::date)::date AS ini)
     SELECT
       -- Churn de CONTAS: lê data_levantada, e conta TODAS — inclusive as que
       -- foram revertidas depois. O bruto é estável; o líquido sai da coluna
       -- ao lado.
       count(*) FILTER (
         WHERE date_trunc('month', data_levantada) = (SELECT ini FROM mes)
       )::text AS contas_levantaram,
       COALESCE(sum(mrr_centavos_na_levantada) FILTER (
         WHERE date_trunc('month', data_levantada) = (SELECT ini FROM mes)
       ), 0)::text AS mrr_levantou,
       count(*) FILTER (
         WHERE date_trunc('month', data_levantada) = (SELECT ini FROM mes)
           AND estado = 'retido'
       )::text AS retidas_depois,

       -- Churn de RECEITA: lê competencia_efeito_receita.
       count(*) FILTER (
         WHERE competencia_efeito_receita = (SELECT ini FROM mes)
       )::text AS contas_efeito,
       COALESCE(sum(mrr_centavos_na_levantada) FILTER (
         WHERE competencia_efeito_receita = (SELECT ini FROM mes)
       ), 0)::text AS mrr_realizado,

       -- COMPROMETIDO: já anunciado e ainda faturando NAQUELE mês.
       --
       -- A condição é sobre DATAS, nunca sobre o estado atual. Filtrar por
       -- estado IN ('anunciado','em_aviso') daria a resposta certa só enquanto
       -- a saída estivesse aberta: no instante em que alguém clicasse em
       -- encerrar, o comprometido de julho cairia de R$ 40 mil para zero, e um
       -- mês já fechado passaria a contar outra história.
       count(*) FILTER (
         WHERE data_levantada <= ((SELECT ini FROM mes) + INTERVAL '1 month - 1 day')
           AND (retido_em IS NULL
                OR retido_em > ((SELECT ini FROM mes) + INTERVAL '1 month - 1 day'))
           AND (competencia_efeito_receita IS NULL
                OR competencia_efeito_receita > (SELECT ini FROM mes))
       )::text AS contas_comprometidas,
       COALESCE(sum(mrr_centavos_na_levantada) FILTER (
         WHERE data_levantada <= ((SELECT ini FROM mes) + INTERVAL '1 month - 1 day')
           AND (retido_em IS NULL
                OR retido_em > ((SELECT ini FROM mes) + INTERVAL '1 month - 1 day'))
           AND (competencia_efeito_receita IS NULL
                OR competencia_efeito_receita > (SELECT ini FROM mes))
       ), 0)::text AS mrr_comprometido,

       count(*) FILTER (
         WHERE estado = 'retido' AND date_trunc('month', retido_em) = (SELECT ini FROM mes)
       )::text AS retidas,
       COALESCE(sum(mrr_centavos_na_levantada) FILTER (
         WHERE estado = 'retido' AND date_trunc('month', retido_em) = (SELECT ini FROM mes)
       ), 0)::text AS mrr_retido
     FROM success.cancellation`,
    [competencia],
  )
  const r = rows[0]!
  return {
    competencia: competencia.slice(0, 7),
    contasQueLevantaram: Number(r['contas_levantaram']),
    mrrQueLevantouCentavos: r['mrr_levantou']!,
    retidasDepois: Number(r['retidas_depois']),
    contasComEfeito: Number(r['contas_efeito']),
    mrrRealizadoCentavos: r['mrr_realizado']!,
    mrrComprometidoCentavos: r['mrr_comprometido']!,
    contasComprometidas: Number(r['contas_comprometidas']),
    retidasNaCompetencia: Number(r['retidas']),
    mrrRetidoCentavos: r['mrr_retido']!,
  }
}
