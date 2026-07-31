/**
 * A fila de trabalho — onde os candidatos viram itens.
 *
 * Os gatilhos decidem "esta conta merece atenção". Este arquivo decide "e isso
 * deve chegar a alguém, hoje". São perguntas diferentes, e é a segunda que
 * determina se a ferramenta continua sendo usada no terceiro mês.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ AS QUATRO REGRAS                                                           │
 * │                                                                            │
 * │ teto        no máximo 12 itens abertos por pessoa. O excedente vai para o  │
 * │             backlog priorizado, não para a fila — fila que passa de uma    │
 * │             tela deixa de ser fila.                                        │
 * │                                                                            │
 * │ dedup       um item aberto por conta por família. O segundo sinal atualiza │
 * │             a evidência do item existente. Sem isso, o mesmo atraso de     │
 * │             pagamento vira três notificações para um fato — e é assim que  │
 * │             se ensina o time a silenciar a ferramenta.                     │
 * │                                                                            │
 * │ carência    item resolvido não reabre pelo mesmo motivo antes do prazo.    │
 * │             Sem ela, um cliente cronicamente abaixo do piso reaparece toda │
 * │             semana e o CSM aprende que fechar não adianta.                 │
 * │                                                                            │
 * │ modo sombra gatilho novo roda 14 dias visível só para a liderança, que     │
 * │             aprova a promoção. Nenhum gatilho vai direto à fila do time,   │
 * │             inclusive na partida.                                          │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

import { numerosConfigurados } from '@pulse/auth'
import {
  avaliarGatilhos,
  LIMIARES_PADRAO,
  type Limiares,
  umPorFamilia,
  GATILHOS,
  PESO_PRIORIDADE,
  type Candidato,
  type EstadoConta,
  type Prioridade,
} from '@pulse/metrics'
import type pg from 'pg'

/**
 * Doc 01, E3: fila que passa de uma tela deixa de ser fila.
 *
 * É o PADRÃO. O valor efetivo vem de `ops.configuracao` (`fila.teto_por_pessoa`), lido
 * em `prepararContexto` — e o padrão continua vivendo aqui, num lugar só, para o
 * sistema subir com comportamento correto num banco vazio.
 */
export const TETO_POR_PESSOA = 12

/** Prefixo da flag que promove um gatilho do modo sombra. */
export const FLAG_GATILHO = 'gatilho:'

export interface ResumoFila {
  readonly competencia: string
  readonly avaliadas: number
  readonly candidatos: number
  readonly criados: number
  readonly atualizados: number
  readonly emBacklog: number
  readonly emSombra: number
  readonly bloqueadosPorCarencia: number
}

/**
 * O contexto de uma rodada de gravação de itens.
 *
 * Existe para que `avaliarFila` (sinais da conta) e `avaliarDatasContratuais`
 * (datas do contrato) compartilhem o MESMO caminho de gravação. As quatro regras
 * — dedup por família, carência, teto por pessoa e modo sombra — escritas duas
 * vezes divergiriam, e a divergência apareceria como item contratual furando o
 * teto de alguém.
 */
export interface ContextoGravacao {
  readonly cliente: pg.PoolClient
  readonly competencia: string
  readonly agora: Date
  /** Carga por pessoa, mutada ao longo da rodada. */
  readonly carga: Map<string, number>
  readonly playbooks: Map<string, string>
  readonly promovidos: Set<string>
  /** O teto EFETIVO desta rodada: o configurado, ou o padrão. */
  readonly teto: number
  /** Os limiares EFETIVOS desta rodada. */
  readonly limiares: Limiares
}

export interface CandidatoParaGravar {
  readonly accountId: string
  readonly gatilho: string
  readonly familia: string
  readonly prioridade: Prioridade
  readonly motivo: string
  readonly evidencia: unknown
  readonly prazoDias: number
  readonly dono: string
  /** `null` = sem carência. Vem do gatilho, não é procurado aqui. */
  readonly cooldownDias: number | null
}

export type Desfecho = 'criado' | 'atualizado' | 'bloqueado' | 'sombra' | 'backlog'

/**
 * Grava um candidato aplicando as quatro regras da fila.
 *
 * Devolve o que aconteceu, para quem chamou contar. Não abre transação: quem
 * chama é dono dela, porque uma rodada tem que ser tudo ou nada — meia fila
 * gravada é pior que fila nenhuma.
 */
export async function gravarCandidato(
  ctx: ContextoGravacao,
  c: CandidatoParaGravar,
): Promise<Desfecho> {
  const { cliente } = ctx

  // ── Dedup: já existe item aberto desta família nesta conta? ──
  const existente = await cliente.query<{ id: string; gatilho: string; prioridade: string }>(
    `SELECT id, gatilho, prioridade FROM success.work_item
      WHERE account_id = $1 AND familia = $2 AND estado IN ('aberto','backlog')
      LIMIT 1`,
    [c.accountId, c.familia],
  )
  if (existente.rows.length > 0) {
    const atual = existente.rows[0]!
    // O segundo sinal atualiza a evidência: o item continua sendo o mesmo
    // trabalho, com informação mais fresca.
    //
    // MAS o texto só é sobrescrito se o novo candidato for pelo menos tão urgente
    // quanto o que está lá, ou vier do mesmo gatilho. Sem esta guarda, a família
    // `renovacao` ganhava o texto da data MENOS urgente: a janela de aviso criava
    // o item ("cliente pode denunciar em 10 dias") e o vencimento, 30 dias depois,
    // reescrevia por cima ("vigência acaba em 40 dias") — o item passava a mostrar
    // o prazo folgado e escondia o apertado.
    const maisUrgente =
      atual.gatilho === c.gatilho ||
      PESO_PRIORIDADE[c.prioridade] >= PESO_PRIORIDADE[atual.prioridade as Prioridade]

    if (maisUrgente) {
      await cliente.query(
        `UPDATE success.work_item
            SET motivo = $2, evidencia = $3, prioridade = $4, competencia = $5
          WHERE id = $1`,
        [atual.id, c.motivo, c.evidencia, c.prioridade, ctx.competencia],
      )
    } else {
      // Só a competência: o item foi reavaliado hoje, e isso é fato.
      await cliente.query(`UPDATE success.work_item SET competencia = $2 WHERE id = $1`, [
        atual.id,
        ctx.competencia,
      ])
    }
    return 'atualizado'
  }

  // ── Carência: fechei isto há pouco? ──
  if (c.cooldownDias) {
    const { rows } = await cliente.query<{ n: string }>(
      `SELECT count(*) n FROM success.work_item
        WHERE account_id = $1 AND gatilho = $2 AND estado = 'fechado'
          AND fechado_em > $3::timestamptz - make_interval(days => $4)`,
      [c.accountId, c.gatilho, ctx.agora.toISOString(), c.cooldownDias],
    )
    if (Number(rows[0]?.n) > 0) return 'bloqueado'
  }

  // ── Modo sombra e teto ──
  const sombra = !ctx.promovidos.has(c.gatilho)
  // Item em sombra não ocupa a fila de ninguém: ele existe para a liderança medir
  // o volume que ele PRODUZIRIA, e contá-lo no teto falsearia a conta.
  const estouraTeto = !sombra && (ctx.carga.get(c.dono) ?? 0) >= ctx.teto

  await cliente.query(
    `INSERT INTO success.work_item
       (account_id, gatilho, familia, prioridade, motivo, evidencia,
        dono_email, prazo, estado, modo_sombra, competencia, playbook_id)
     -- O playbook é resolvido na CRIAÇÃO e gravado por id, não consultado na
     -- leitura. Assim a auditoria de um item fechado em março mostra o processo de
     -- março: publicar a versão 3 em agosto não reescreve o que o CSM tinha em mãos.
     VALUES ($1,$2,$3,$4,$5,$6,$7,($8::date + $9::int),$10,$11,$8,$12)`,
    [
      c.accountId,
      c.gatilho,
      c.familia,
      c.prioridade,
      c.motivo,
      c.evidencia,
      c.dono,
      ctx.competencia,
      c.prazoDias,
      estouraTeto ? 'backlog' : 'aberto',
      sombra,
      ctx.playbooks.get(c.gatilho) ?? null,
    ],
  )

  if (sombra) return 'sombra'
  if (estouraTeto) return 'backlog'
  ctx.carga.set(c.dono, (ctx.carga.get(c.dono) ?? 0) + 1)
  return 'criado'
}

/** A carga por pessoa e os playbooks vigentes, para montar o contexto. */
/**
 * O teto configurado, ou o padrão.
 *
 * Consulta direta e não `@pulse/config`: o worker não deve depender do pacote que serve
 * a tela de administração, e a leitura de UMA chave não justifica a aresta. Se um dia
 * forem várias, o pacote entra — hoje seria dependência por antecipação.
 */
async function ajustesDaRodada(
  db: pg.Pool | pg.PoolClient,
): Promise<{ teto: number; limiares: Limiares }> {
  const v = await numerosConfigurados(db, {
    'fila.teto_por_pessoa': { padrao: TETO_POR_PESSOA, minimo: 3, maximo: 40, inteiro: true },
    'gatilhos.atraso_item_financeiro': {
      padrao: LIMIARES_PADRAO.atrasoItemFinanceiro,
      minimo: 5,
      maximo: 120,
      inteiro: true,
    },
  })
  return {
    teto: v['fila.teto_por_pessoa'],
    limiares: { atrasoItemFinanceiro: v['gatilhos.atraso_item_financeiro'] },
  }
}

export async function prepararContexto(
  cliente: pg.PoolClient,
  competencia: string,
  agora: Date,
  /**
   * Os ajustes já lidos por quem chama, quando houver. `avaliarFila` lê uma vez e
   * repassa; quem chama sem passar (o gerador de datas contratuais) lê aqui.
   */
  ajustes?: { teto: number; limiares: Limiares },
): Promise<ContextoGravacao> {
  const efetivos = ajustes ?? (await ajustesDaRodada(cliente))
  return {
    cliente,
    competencia,
    agora,
    carga: await cargaPorPessoa(cliente),
    playbooks: await playbooksVigentes(cliente),
    promovidos: await gatilhosPromovidos(cliente),
    // Do banco a cada rodada, nunca em cache de processo: o admin muda o teto às 10h e
    // a rodada das 11h já respeita. Cache aqui faria a tela dizer 20 e a fila continuar
    // em 12 até alguém reiniciar o worker — divergência que ninguém relaciona com a
    // configuração.
    ...efetivos,
  }
}

export interface OpcoesFila {
  readonly agora?: Date
  /**
   * Na PARTIDA, só gatilhos de estado corrente são elegíveis.
   *
   * O histórico satisfaz a condição de todos os gatilhos ao mesmo tempo: sem
   * esta trava, o dia 1 entrega centenas de itens de variação — e o time não
   * volta. Os de variação esperam a série própria acumular.
   */
  readonly apenasEstadoCorrente?: boolean
}

/** Gatilhos que olham VARIAÇÃO, e por isso precisam de série própria. */
const GATILHOS_DE_VARIACAO = new Set(['G-04', 'G-08', 'G-14'])

export async function avaliarFila(
  pool: pg.Pool,
  competencia: string,
  opts: OpcoesFila = {},
): Promise<ResumoFila> {
  const agora = opts.agora ?? new Date()

  const estados = await carregarEstados(pool, competencia)

  // UMA leitura de configuração por rodada, antes de qualquer avaliação. Ler duas
  // vezes abriria janela para metade da rodada usar um valor e a outra metade outro —
  // e o resultado seria uma fila que ninguém consegue explicar.
  const ajustes = await ajustesDaRodada(pool)

  // Todos os candidatos da competência, já com um por família por conta.
  const porConta = estados.map((e) => ({
    estado: e,
    candidatos: umPorFamilia(avaliarGatilhos(e, ajustes.limiares)),
  }))

  const total = porConta.reduce((a, c) => a + c.candidatos.length, 0)

  let criados = 0
  let atualizados = 0
  let emBacklog = 0
  let emSombra = 0
  let bloqueados = 0

  const cliente = await pool.connect()
  try {
    await cliente.query('BEGIN')

    // Carga, playbooks e flags contados UMA vez: o teto é sobre a fila que a
    // pessoa vê, e ela não muda no meio da avaliação. Com 27 itens gerados, um
    // SELECT por item seriam 27 idas ao banco por informação estática.
    const ctx = await prepararContexto(cliente, competencia, agora)

    // Prioridade primeiro: se o teto cortar, tem que cortar o menos urgente.
    const fila = porConta
      .flatMap(({ estado, candidatos }) => candidatos.map((c) => ({ estado, c })))
      .sort(
        (a, b) =>
          PESO_PRIORIDADE[b.c.prioridade] - PESO_PRIORIDADE[a.c.prioridade] ||
          a.c.prazoDias - b.c.prazoDias,
      )

    for (const { estado, c } of fila) {
      if (opts.apenasEstadoCorrente && GATILHOS_DE_VARIACAO.has(c.gatilho)) continue

      const dono = resolverDono(c, estado)
      if (!dono) continue

      const desfecho = await gravarCandidato(ctx, {
        accountId: estado.accountId,
        gatilho: c.gatilho,
        familia: c.familia,
        prioridade: c.prioridade,
        motivo: c.motivo,
        evidencia: c.evidencia,
        prazoDias: c.prazoDias,
        dono,
        cooldownDias: GATILHOS.find((x) => x.id === c.gatilho)?.cooldownDias ?? null,
      })

      if (desfecho === 'atualizado') atualizados++
      else if (desfecho === 'bloqueado') bloqueados++
      else {
        criados++
        if (desfecho === 'sombra') emSombra++
        else if (desfecho === 'backlog') emBacklog++
      }
    }

    await cliente.query('COMMIT')
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    cliente.release()
  }

  return {
    competencia,
    avaliadas: estados.length,
    candidatos: total,
    criados,
    atualizados,
    emBacklog,
    emSombra,
    bloqueadosPorCarencia: bloqueados,
  }
}

// ── Roteamento ──────────────────────────────────────────────────────────────

/**
 * Para quem vai o item.
 *
 * O papel vem do gatilho; o e-mail, da conta ou da configuração. Item sem dono
 * não é criado: item que ninguém possui é item que ninguém fecha, e ele fica na
 * fila envelhecendo até virar ruído.
 */
function resolverDono(c: Candidato, e: EstadoConta): string | null {
  if (c.donoPapel === 'csm' || c.donoPapel === null) return e.csmEmail
  const porPapel: Record<string, string | undefined> = {
    cs_lead: process.env['PULSE_EMAIL_CS_LEAD'],
    financeiro: process.env['PULSE_EMAIL_FINANCEIRO'],
    implantacao: process.env['PULSE_EMAIL_IMPLANTACAO'],
    comercial: process.env['PULSE_EMAIL_COMERCIAL'],
  }
  // Sem caixa de papel configurada, cai no CSM da conta: melhor o item chegar a
  // alguém que pode escalar do que não chegar a ninguém.
  return porPapel[c.donoPapel] ?? e.csmEmail
}

// ── Estado do banco ─────────────────────────────────────────────────────────

// Aceita pool OU cliente: dentro de uma transação a leitura tem que usar a MESMA
// conexão, senão uma flag ligada no meio da rodada seria vista pela metade dela.
async function gatilhosPromovidos(pool: pg.Pool | pg.PoolClient): Promise<Set<string>> {
  const { rows } = await pool.query<{ chave: string }>(
    `SELECT chave FROM ops.feature_flag WHERE habilitado AND chave LIKE $1`,
    [`${FLAG_GATILHO}%`],
  )
  return new Set(rows.map((r) => r.chave.slice(FLAG_GATILHO.length)))
}

/**
 * O playbook vigente de cada gatilho, num mapa.
 *
 * Gatilho sem playbook fica de fora e o item nasce sem anexo — travar a fila por
 * falta de documentação seria trocar trabalho por burocracia. Gatilho com mais de
 * um vigente usa o publicado mais recentemente; a ambiguidade aparece na tela da
 * biblioteca, que é onde quem configurou pode resolvê-la.
 */
async function playbooksVigentes(c: pg.PoolClient): Promise<Map<string, string>> {
  const { rows } = await c.query<{ gatilho: string; id: string }>(
    `SELECT DISTINCT ON (g) g AS gatilho, p.id
       FROM success.playbook p, unnest(p.gatilhos) g
      WHERE p.ativo
      ORDER BY g, p.publicado_em DESC`,
  )
  return new Map(rows.map((r) => [r.gatilho, r.id]))
}

async function cargaPorPessoa(c: pg.PoolClient): Promise<Map<string, number>> {
  const { rows } = await c.query<{ dono_email: string; n: string }>(
    `SELECT dono_email, count(*) n FROM success.work_item
      WHERE estado = 'aberto' AND NOT modo_sombra GROUP BY dono_email`,
  )
  return new Map(rows.map((r) => [r.dono_email, Number(r.n)]))
}

async function carregarEstados(pool: pg.Pool, competencia: string): Promise<EstadoConta[]> {
  const { rows } = await pool.query<Record<string, unknown>>(
    `WITH anterior AS (
       SELECT account_id, vidas_ativas_30d, vidas_elegiveis
         FROM metrics.daily_snapshot WHERE competencia = $1::date - INTERVAL '30 days'
     ),
     sob_piso AS (
       -- Competências consecutivas abaixo do piso. Uma só pode ser sazonalidade,
       -- e item disparado por sazonalidade é o primeiro que o time ignora.
       SELECT account_id, count(*)::int n FROM metrics.daily_snapshot
        WHERE competencia BETWEEN $1::date - INTERVAL '60 days' AND $1::date
          AND vidas_elegiveis > 0
        GROUP BY account_id
     ),
     contato AS (
       SELECT account_id, max(ocorreu_em) ultimo FROM fact.activity GROUP BY account_id
     )
     SELECT s.account_id, a.csm_email, a.porte,
            s.vidas_elegiveis, s.vidas_contratadas, s.vidas_ativas_30d,
            ant.vidas_ativas_30d ativas_ant, ant.vidas_elegiveis elegiveis_ant,
            s.dias_atraso_max, s.valor_aberto_centavos,
            ($1::date - c.ultimo::date) dias_sem_contato,
            (ct.vigencia_fim - $1::date) dias_para_vigencia,
            ($1::date - ct.inicio) dias_desde_inicio,
            f.severidade, f.faixa_engajamento,
            COALESCE(sp.n, 0) competencias_serie
       FROM metrics.daily_snapshot s
       JOIN core.account a ON a.id = s.account_id
       LEFT JOIN anterior ant ON ant.account_id = s.account_id
       LEFT JOIN sob_piso sp ON sp.account_id = s.account_id
       LEFT JOIN contato c ON c.account_id = s.account_id
       LEFT JOIN metrics.silent_churn_flag f
              ON f.account_id = s.account_id AND f.competencia = s.competencia
       LEFT JOIN LATERAL (
         SELECT vigencia_fim, inicio FROM core.contract
          WHERE account_id = s.account_id AND status_vigencia = 'vigente'
          ORDER BY inicio DESC LIMIT 1
       ) ct ON true
      WHERE s.competencia = $1`,
    [competencia],
  )

  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

  // O piso vem da mesma regra da consolidação: 60% da mediana do porte.
  const porPorte = new Map<string, number[]>()
  for (const r of rows) {
    const el = num(r['vidas_elegiveis'])
    const at = num(r['vidas_ativas_30d'])
    if (!el || el <= 0 || at === null) continue
    const k = String(r['porte'] ?? 'sem_porte')
    porPorte.set(k, [...(porPorte.get(k) ?? []), at / el])
  }
  const pisos = new Map<string, number>()
  for (const [k, vs] of porPorte) {
    const ord = [...vs].sort((a, b) => a - b)
    pisos.set(k, Math.max(0.15, (ord[Math.floor(ord.length / 2)] ?? 0.15) * 0.6))
  }

  return rows.map((r): EstadoConta => {
    const el = num(r['vidas_elegiveis'])
    const at = num(r['vidas_ativas_30d'])
    const elAnt = num(r['elegiveis_ant'])
    const atAnt = num(r['ativas_ant'])
    const contratadas = num(r['vidas_contratadas'])
    const piso = pisos.get(String(r['porte'] ?? 'sem_porte')) ?? 0.15
    const adesao = el && el > 0 && at !== null ? at / el : null

    return {
      accountId: String(r['account_id']),
      competencia,
      csmEmail: (r['csm_email'] as string) ?? null,
      adesao30d: adesao,
      adesao30dAnterior: elAnt && elAnt > 0 && atAnt !== null ? atAnt / elAnt : null,
      pisoSegmento: piso,
      competenciasSobPiso: adesao !== null && adesao < piso ? Number(r['competencias_serie']) : 0,
      vidasElegiveis: el,
      vidasContratadas: contratadas,
      coberturaCadastral: contratadas && contratadas > 0 && el !== null ? el / contratadas : null,
      diasDesdeGoLive: num(r['dias_desde_inicio']),
      diasAtrasoMax: num(r['dias_atraso_max']),
      valorAbertoCentavos: num(r['valor_aberto_centavos']),
      diasSemContato: num(r['dias_sem_contato']),
      diasParaVigenciaFim: num(r['dias_para_vigencia']),
      severidadeChurnSilencioso: (r['severidade'] as string) ?? null,
      faixaEngajamento: (r['faixa_engajamento'] as string) ?? null,
      // Fontes que ainda não existem. Declaradas e não avaliadas — o gatilho
      // simplesmente não dispara, em vez de inventar um valor.
      nps: null,
      horasIndisponibilidade: null,
      marcosAtrasados: null,
      segmentoMudou: null,
      produtosAusentes: null,
    }
  })
}
