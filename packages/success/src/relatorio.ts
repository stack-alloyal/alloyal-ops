import {
  exigirConta,
  numeroConfigurado,
  recorteDaConta,
  veBaseDeContas,
  type Identidade,
} from '@pulse/auth'

import type pg from 'pg'

import { comparativoDaConta, type Comparativo } from './benchmark.js'

/**
 * T4 — O relatório do cliente. O fim do PowerPoint.
 *
 * Quatro blocos: o que aconteceu · evolução · comparativo anônimo · o que depende
 * de você. Mais uma frase de leitura automática, que o CSM revisa antes de enviar.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ A decisão que sustenta tudo: o relatório é CONGELADO na revisão.          │
 * │                                                                           │
 * │ Renderizar ao vivo a partir das métricas correntes é mais simples e é a    │
 * │ escolha errada. O cliente tem uma cópia do que recebeu; se o número for    │
 * │ recalculado — fonte atrasada, snapshot refeito, definição em versão nova —  │
 * │ "vocês disseram 42%" passa a exibir 38%, e a conversa deixa de ser sobre o │
 * │ clube e passa a ser sobre a ferramenta.                                   │
 * │                                                                           │
 * │ Depois de enviado, o banco recusa qualquer alteração. Para corrigir, o     │
 * │ caminho é um relatório novo que DIGA o que mudou.                         │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

export type EstadoRelatorio = 'rascunho' | 'revisado' | 'enviado' | 'descartado'

export class RelatorioInvalidoError extends Error {
  constructor(mensagem: string) {
    super(mensagem)
    this.name = 'RelatorioInvalidoError'
  }
}

export interface NumeroDoRelatorio {
  metrica: string
  rotulo: string
  valor: number | null
  /** O valor de 30 dias antes, para a variação. `null` quando não há histórico. */
  anterior: number | null
  unidade: 'percentual' | 'inteiro' | 'centavos'
  /** `null` quando não há base de comparação — e não zero. */
  variacao: number | null
}

export interface PontoDaEvolucao {
  competencia: string
  adesao30d: number | null
  coberturaCadastral: number | null
}

export interface AcaoDoCliente {
  titulo: string
  porque: string
  /** O número que sustenta o pedido. Sem ele é opinião. */
  numero: string
}

export interface ConteudoRelatorio {
  competencia: string
  razaoSocial: string
  /** Bloco 1 — três números com variação. */
  numeros: NumeroDoRelatorio[]
  /** Bloco 2 — doze meses. */
  evolucao: PontoDaEvolucao[]
  /** Bloco 3 — comparativo anônimo, com N declarado ou supressão explicada. */
  comparativo: Comparativo[]
  /** Bloco 4 — duas ou três ações que só o cliente pode fazer. */
  acoes: AcaoDoCliente[]
  /** Marca de que alguma fonte faltou na competência. */
  dadoParcial: boolean
  montadoEm: string
}

export interface Relatorio {
  id: string
  accountId: string
  conta: string
  competencia: string
  estado: EstadoRelatorio
  conteudo: ConteudoRelatorio | null
  fraseGerada: string | null
  fraseFinal: string | null
  revisadoPor: string | null
  revisadoEm: string | null
  enviadoPor: string | null
  enviadoEm: string | null
  destinatario: string | null
  criadoEm: string
}

/** Quantos meses de evolução o relatório mostra. */
export const MESES_DE_EVOLUCAO = 12

/** Faixa aceita para `relatorio.meses_de_evolucao`, espelhando o catálogo. */
const FAIXA_EVOLUCAO = { padrao: MESES_DE_EVOLUCAO, minimo: 3, maximo: 24, inteiro: true }

/** No máximo três ações: uma lista de oito não é um pedido, é um relatório de bugs. */
export const MAXIMO_ACOES = 3

const ROTULOS: Record<string, string> = {
  adesao_30d: 'Adesão nos últimos 30 dias',
  cobertura_cadastral: 'Base cadastrada',
  vidas_ativas_30d: 'Colaboradores que usaram',
}

/**
 * Monta o conteúdo a partir das métricas correntes.
 *
 * Chamado ao criar o rascunho e ao revisar. Depois da revisão, nunca mais: o que
 * está gravado é o que o CSM leu e aprovou.
 */
export async function montarConteudo(
  db: pg.Pool,
  accountId: string,
  competencia: string,
): Promise<ConteudoRelatorio> {
  const { rows: atual } = await db.query<Record<string, string | null>>(
    `SELECT a.razao_social, s.completo::text,
            s.vidas_elegiveis::text, s.vidas_ativas_30d::text, s.vidas_contratadas::text,
            ant.vidas_elegiveis::text  AS ant_elegiveis,
            ant.vidas_ativas_30d::text AS ant_ativas,
            ant.vidas_contratadas::text AS ant_contratadas
       FROM core.account a
       JOIN metrics.daily_snapshot s ON s.account_id = a.id AND s.competencia = $2::date
       LEFT JOIN metrics.daily_snapshot ant
              ON ant.account_id = a.id
             AND ant.competencia = ($2::date - INTERVAL '30 days')::date
      WHERE a.id = $1`,
    [accountId, competencia],
  )
  const r = atual[0]
  if (!r) {
    throw new RelatorioInvalidoError(
      `não há snapshot de ${competencia.slice(0, 7)} para esta conta — sem número não há relatório`,
    )
  }

  const n = (k: string) => (r[k] === null ? null : Number(r[k]))
  const razao = (a: number | null, b: number | null) => (a !== null && b !== null && b > 0 ? a / b : null)

  const adesao = razao(n('vidas_ativas_30d'), n('vidas_elegiveis'))
  const adesaoAnt = razao(n('ant_ativas'), n('ant_elegiveis'))
  const cobertura = razao(n('vidas_elegiveis'), n('vidas_contratadas'))
  const coberturaAnt = razao(n('ant_elegiveis'), n('ant_contratadas'))

  // Variação `null` e não zero quando falta base: zero afirmaria estabilidade onde
  // não há como saber, e o cliente leria "não mudou nada".
  const variacao = (hoje: number | null, antes: number | null) =>
    hoje !== null && antes !== null && antes > 0 ? Number(((hoje - antes) / antes).toFixed(4)) : null

  const numeros: NumeroDoRelatorio[] = [
    {
      metrica: 'adesao_30d',
      rotulo: ROTULOS['adesao_30d']!,
      valor: adesao,
      anterior: adesaoAnt,
      unidade: 'percentual',
      variacao: variacao(adesao, adesaoAnt),
    },
    {
      metrica: 'vidas_ativas_30d',
      rotulo: ROTULOS['vidas_ativas_30d']!,
      valor: n('vidas_ativas_30d'),
      anterior: n('ant_ativas'),
      unidade: 'inteiro',
      variacao: variacao(n('vidas_ativas_30d'), n('ant_ativas')),
    },
    {
      metrica: 'cobertura_cadastral',
      rotulo: ROTULOS['cobertura_cadastral']!,
      valor: cobertura,
      anterior: coberturaAnt,
      unidade: 'percentual',
      variacao: variacao(cobertura, coberturaAnt),
    },
  ]

  const { rows: serie } = await db.query<Record<string, string | null>>(
    `SELECT to_char(competencia,'YYYY-MM') AS mes,
            CASE WHEN vidas_elegiveis > 0
                 THEN (vidas_ativas_30d::numeric / vidas_elegiveis)::text END AS adesao,
            CASE WHEN vidas_contratadas > 0
                 THEN (vidas_elegiveis::numeric / vidas_contratadas)::text END AS cobertura
       FROM metrics.daily_snapshot
      WHERE account_id = $1
        AND competencia > ($2::date - make_interval(months => $3))
        AND competencia <= $2::date
        -- Um ponto por mês: a série do relatório é mensal, e mostrar 365 pontos
        -- diários faria o gestor procurar tendência em ruído.
        AND competencia = date_trunc('month', competencia)::date
      ORDER BY competencia`,
    [accountId, competencia, await numeroConfigurado(db, 'relatorio.meses_de_evolucao', FAIXA_EVOLUCAO)],
  )

  const comparativo = await comparativoDaConta(db, accountId, competencia)

  // ── Bloco 4: o que depende do cliente ──
  // Derivado dos números, e não dos itens de trabalho: a fila interna tem ações
  // nossas misturadas com dele, e mandar ao cliente "escalar ao Financeiro" seria
  // expor processo interno.
  const acoes: AcaoDoCliente[] = []
  if (cobertura !== null && cobertura < 0.9) {
    const faltam = (n('vidas_contratadas') ?? 0) - (n('vidas_elegiveis') ?? 0)
    acoes.push({
      titulo: 'Completar a base de colaboradores',
      porque:
        'Quem não está cadastrado não consegue usar o clube, e o benefício não aparece para essa parte do time.',
      numero: `faltam ${faltam.toLocaleString('pt-BR')} de ${(n('vidas_contratadas') ?? 0).toLocaleString('pt-BR')} vidas`,
    })
  }
  if (adesao !== null && adesao < 0.3) {
    acoes.push({
      titulo: 'Comunicar o clube internamente',
      porque:
        'A maior parte da base cadastrada ainda não usou. Uma comunicação do RH costuma dobrar a adesão no mês seguinte.',
      numero: `${Math.round(adesao * 100)}% da base usou nos últimos 30 dias`,
    })
  }
  const comp = comparativo.find((c) => c.metrica === 'adesao_30d')
  if (comp && !comp.suprimido && comp.posicao === 'abaixo_p25') {
    acoes.push({
      titulo: 'Agendar uma conversa sobre o plano de adoção',
      porque:
        'A adesão está abaixo do primeiro quartil de empresas do mesmo porte e setor — há espaço claro de melhora.',
      numero: `${Math.round((comp.valor ?? 0) * 100)}% contra mediana de ${Math.round((comp.p50 ?? 0) * 100)}%`,
    })
  }

  return {
    competencia,
    razaoSocial: String(r['razao_social']),
    numeros,
    evolucao: serie.map((s) => ({
      competencia: String(s['mes']),
      adesao30d: s['adesao'] === null ? null : Number(s['adesao']),
      coberturaCadastral: s['cobertura'] === null ? null : Number(s['cobertura']),
    })),
    comparativo,
    acoes: acoes.slice(0, MAXIMO_ACOES),
    dadoParcial: r['completo'] !== 'true',
    montadoEm: new Date().toISOString(),
  }
}

/**
 * A frase de leitura automática.
 *
 * Descreve o que os números dizem, sem adjetivo e sem promessa. É rascunho: o CSM
 * conhece o contexto que o número não tem — uma queda que veio de férias coletivas
 * não é uma queda de interesse —, e ele reescreve antes de enviar.
 *
 * Pura de propósito: é o texto que sai da empresa, e o que sai da empresa tem que
 * ser reproduzível a partir do conteúdo, sem consultar nada.
 */
export function gerarFrase(c: ConteudoRelatorio): string {
  const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`)
  const adesao = c.numeros.find((x) => x.metrica === 'adesao_30d')
  const ativas = c.numeros.find((x) => x.metrica === 'vidas_ativas_30d')
  const cobertura = c.numeros.find((x) => x.metrica === 'cobertura_cadastral')

  const partes: string[] = []

  if (ativas?.valor !== null && ativas?.valor !== undefined) {
    partes.push(
      `Em ${c.competencia.slice(0, 7)}, ${ativas.valor.toLocaleString('pt-BR')} colaboradores usaram o clube` +
        (adesao?.valor !== null && adesao?.valor !== undefined
          ? `, o que corresponde a ${pct(adesao.valor)} da base cadastrada`
          : '') +
        '.',
    )
  }

  // A variação só entra quando há base: "estável" sem mês anterior seria invenção.
  if (adesao?.variacao !== null && adesao?.variacao !== undefined) {
    const v = adesao.variacao
    const texto =
      Math.abs(v) < 0.05
        ? 'A adesão ficou praticamente estável em relação ao mês anterior.'
        : v > 0
          ? `A adesão subiu ${Math.round(v * 100)}% em relação ao mês anterior.`
          : `A adesão caiu ${Math.round(Math.abs(v) * 100)}% em relação ao mês anterior.`
    partes.push(texto)
  }

  const comp = c.comparativo.find((x) => x.metrica === 'adesao_30d')
  if (comp && !comp.suprimido && comp.p50 !== null) {
    // O N declarado vai na frase: comparação sem o tamanho do grupo é comparação
    // que o gestor não sabe defender numa reunião.
    const onde =
      comp.posicao === 'acima_p75'
        ? 'acima do terceiro quartil'
        : comp.posicao === 'entre_p50_p75'
          ? 'acima da mediana'
          : comp.posicao === 'entre_p25_p50'
            ? 'abaixo da mediana'
            : 'abaixo do primeiro quartil'
    partes.push(
      `Comparado a ${comp.nEmpresas} empresas de porte e setor semelhantes, isso está ${onde} ` +
        `(mediana de ${pct(comp.p50)}).`,
    )
  } else if (comp?.suprimido) {
    partes.push(
      'Não há comparativo neste mês: o grupo de empresas de porte e setor semelhantes é pequeno ' +
        'demais para uma comparação anônima.',
    )
  }

  if (cobertura?.valor !== null && cobertura?.valor !== undefined && cobertura.valor < 0.9) {
    partes.push(
      `${pct(cobertura.valor)} da base contratada está cadastrada — completar o cadastro é o que mais ` +
        'muda o resultado do próximo mês.',
    )
  }

  if (c.dadoParcial) {
    // Dito na frase e não só num rodapé: o cliente tem que saber antes de usar o
    // número numa decisão dele.
    partes.push(
      'Observação: uma das fontes de dados não respondeu no fechamento deste mês, e os números ' +
        'acima podem ser revisados.',
    )
  }

  return partes.join(' ')
}

const COLUNAS = `
  r.id, r.account_id AS "accountId", a.razao_social AS conta,
  to_char(r.competencia,'YYYY-MM-DD') AS competencia,
  r.estado, r.conteudo,
  r.frase_gerada AS "fraseGerada", r.frase_final AS "fraseFinal",
  r.revisado_por AS "revisadoPor", r.revisado_em AS "revisadoEm",
  r.enviado_por AS "enviadoPor", r.enviado_em AS "enviadoEm",
  r.destinatario, r.criado_em AS "criadoEm"`

/** Cria o rascunho, montando o conteúdo e a frase. Idempotente por competência. */
export async function criarRascunho(
  db: pg.Pool,
  id: Identidade,
  accountId: string,
  competencia: string,
): Promise<Relatorio> {
  // Sem grupo nenhum é problema DE ACESSO, e a mensagem tem que dizer isso: "conta
  // não encontrada na sua carteira" mandaria a pessoa procurar a conta quando o que
  // falta é ela estar num grupo `pulse-*`. As duas recusas têm soluções diferentes.
  if (id.permissoes.contas === 'nenhum') {
    throw new RelatorioInvalidoError('compor relatório exige acesso a contas')
  }
  // ANTES de montar: `montarConteudo` lê adesão, MRR e cobertura da conta. Recortar
  // só na escrita deixaria o número do outro cliente ser calculado e devolvido com a
  // operação aparentemente "recusada".
  await exigirConta(db, id, accountId, 'conta')
  const conteudo = await montarConteudo(db, accountId, competencia)
  const frase = gerarFrase(conteudo)

  const { rows } = await db.query<Relatorio>(
    `INSERT INTO success.client_report
       (account_id, competencia, estado, conteudo, frase_gerada, frase_final)
     VALUES ($1,$2::date,'rascunho',$3,$4,$4)
     ON CONFLICT (account_id, competencia) DO UPDATE
       -- Só o rascunho é remontado. Revisado ou enviado, o conteúdo está congelado,
       -- e o WHERE abaixo protege isso mesmo que alguém chame por engano.
       SET conteudo = EXCLUDED.conteudo, frase_gerada = EXCLUDED.frase_gerada
       WHERE success.client_report.estado = 'rascunho'
     -- Sem alias no INSERT..RETURNING, então as colunas vão escritas: reaproveitar
     -- a lista com prefixo de tabela daria erro de coluna inexistente.
     RETURNING id, account_id AS "accountId",
       to_char(competencia,'YYYY-MM-DD') AS competencia, estado, conteudo,
       frase_gerada AS "fraseGerada", frase_final AS "fraseFinal",
       revisado_por AS "revisadoPor", revisado_em AS "revisadoEm",
       enviado_por AS "enviadoPor", enviado_em AS "enviadoEm",
       destinatario, criado_em AS "criadoEm"`,
    [accountId, competencia, JSON.stringify(conteudo), frase],
  )
  if (rows.length === 0) {
    // O ON CONFLICT com WHERE não devolve linha quando o filtro barra: significa que
    // já existe relatório revisado ou enviado desta competência.
    const existente = await lerRelatorio(db, id, accountId, competencia)
    if (existente) return existente
    throw new RelatorioInvalidoError('não foi possível criar o rascunho')
  }
  return { ...rows[0]!, conta: conteudo.razaoSocial }
}

export async function lerRelatorio(
  db: pg.Pool,
  id: Identidade,
  accountId: string,
  competencia: string,
): Promise<Relatorio | null> {
  if (id.permissoes.contas === 'nenhum') return null
  const daBase = id.permissoes.contas === 'base'
  const { rows } = await db.query<Relatorio>(
    `SELECT ${COLUNAS}
       FROM success.client_report r
       JOIN core.account a ON a.id = r.account_id
      WHERE r.account_id = $1 AND r.competencia = $2::date
        AND ($3::boolean OR a.csm_email = $4)`,
    [accountId, competencia, daBase, id.email],
  )
  return rows[0] ?? null
}

export async function listarRelatorios(
  db: pg.Pool,
  id: Identidade,
  opts: { competencia?: string } = {},
): Promise<Relatorio[]> {
  if (id.permissoes.contas === 'nenhum') return []
  const daBase = id.permissoes.contas === 'base'
  const { rows } = await db.query<Relatorio>(
    `SELECT ${COLUNAS}
       FROM success.client_report r
       JOIN core.account a ON a.id = r.account_id
      WHERE ($1::boolean OR a.csm_email = $2)
        AND ($3::text IS NULL OR r.competencia = $3::date)
      ORDER BY r.competencia DESC,
               -- Pendentes primeiro: relatório não enviado é trabalho.
               (r.estado IN ('rascunho','revisado')) DESC, a.razao_social`,
    [daBase, id.email, opts.competencia ?? null],
  )
  return rows
}

/**
 * Revisa: congela o conteúdo e a frase que o CSM deixou.
 *
 * A partir daqui o conteúdo não é remontado. É o retrato do que a pessoa leu antes
 * de aprovar — e o que ela aprovou é o que pode ir ao cliente.
 */
export async function revisar(
  db: pg.Pool,
  id: Identidade,
  relatorioId: string,
  fraseFinal: string,
): Promise<void> {
  if (id.permissoes.contas === 'nenhum') {
    throw new RelatorioInvalidoError('revisar relatório exige acesso a contas')
  }
  if (fraseFinal.trim().length < 40) {
    // A frase é o que o cliente lê primeiro. Uma linha de dez caracteres não
    // descreve um mês, e enviar a frase da máquina sem ler é o que a revisão existe
    // para impedir.
    throw new RelatorioInvalidoError(
      'a frase precisa descrever o mês — abaixo de 40 caracteres não descreve nada',
    )
  }
  const { rowCount } = await db.query(
    `UPDATE success.client_report
        SET estado = 'revisado', frase_final = $3,
            revisado_por = $2, revisado_em = now()
      WHERE id = $1 AND estado IN ('rascunho','revisado')
        AND ${recorteDaConta('success.client_report.account_id', 4, 2)}`,
    [relatorioId, id.email, fraseFinal.trim(), veBaseDeContas(id)],
  )
  if (rowCount === 0) {
    // Mensagem única para as duas causas — já enviado, ou fora da carteira. Separar
    // as duas transformaria a recusa em confirmação de que o ID existe.
    throw new RelatorioInvalidoError(
      'este relatório já foi enviado, descartado, ou não é de uma conta da sua carteira',
    )
  }
}

/**
 * Envia: registra para quem foi, e fecha.
 *
 * O envio do e-mail em si não acontece aqui — ele depende de fonte externa. O que
 * este registro garante é que existe prova de QUE foi enviado, PARA QUEM e COM QUE
 * NÚMEROS, e é essa prova que sustenta a conversa três meses depois.
 */
export async function enviar(
  db: pg.Pool,
  id: Identidade,
  relatorioId: string,
  destinatario: string,
): Promise<void> {
  if (id.permissoes.contas === 'nenhum') {
    throw new RelatorioInvalidoError('enviar relatório exige acesso a contas')
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(destinatario.trim())) {
    throw new RelatorioInvalidoError('destinatário precisa ser um e-mail válido')
  }
  const { rowCount } = await db.query(
    `UPDATE success.client_report
        SET estado = 'enviado', destinatario = $3,
            enviado_por = $2, enviado_em = now()
      -- Só o REVISADO é enviável: rascunho enviado é a frase da máquina saindo sem
      -- ninguém ter lido.
      WHERE id = $1 AND estado = 'revisado'
        AND ${recorteDaConta('success.client_report.account_id', 4, 2)}`,
    [relatorioId, id.email, destinatario.trim(), veBaseDeContas(id)],
  )
  if (rowCount === 0) {
    // Duas causas, uma mensagem: não está revisado, ou não é de conta da sua
    // carteira. Separar as duas confirmaria a existência de um ID alheio.
    throw new RelatorioInvalidoError(
      'só um relatório revisado e de conta da sua carteira pode ser enviado — revise antes, para a frase ser sua e não da máquina',
    )
  }
}

/** Descarta o rascunho. Enviado não se descarta: o cliente tem uma cópia. */
export async function descartar(
  db: pg.Pool,
  id: Identidade,
  relatorioId: string,
): Promise<void> {
  if (id.permissoes.contas === 'nenhum') {
    throw new RelatorioInvalidoError('descartar relatório exige acesso a contas')
  }
  const { rowCount } = await db.query(
    `UPDATE success.client_report SET estado = 'descartado'
      WHERE id = $1 AND estado IN ('rascunho','revisado')
        AND ${recorteDaConta('success.client_report.account_id', 3, 2)}`,
    [relatorioId, id.email, veBaseDeContas(id)],
  )
  if (rowCount === 0) {
    // Enviado não se descarta (o cliente tem uma cópia) — e fora da carteira também
    // não. Uma mensagem só, para a recusa não virar oráculo de existência de ID.
    throw new RelatorioInvalidoError(
      'não foi possível descartar: relatório enviado tem cópia no cliente, e relatório de outra carteira não é seu para descartar',
    )
  }
}
