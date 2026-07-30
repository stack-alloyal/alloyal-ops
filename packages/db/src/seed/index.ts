/**
 * Escrita da massa sintética no banco.
 *
 * O gerador é puro; este arquivo é o que toca o Postgres. A separação existe
 * para que a forma dos dados seja testável sem banco, e para que a escrita seja
 * trivialmente reexecutável.
 */

import type pg from 'pg'

import { gerarMassa, type ContaSintetica, type OpcoesMassa } from './gerador.js'

export * from './gerador.js'
export * from './perfis.js'

export interface ResumoSeed {
  readonly contas: number
  readonly contratos: number
  readonly diasDeHistorico: number
  readonly linhasTransacao: number
  readonly linhasSnapshot: number
  readonly eventosMrr: number
  readonly atividades: number
  readonly cancelamentos: number
}

/**
 * Semeia o banco.
 *
 * Idempotente pela mesma razão que os ciclos são: reexecutar é a operação mais
 * comum durante desenvolvimento, e uma massa que duplica a cada `make seed`
 * gera números que ninguém consegue explicar.
 */
export async function semear(
  pool: pg.Pool,
  opts: OpcoesMassa & { readonly limpar?: boolean } = {},
): Promise<ResumoSeed> {
  const massa = gerarMassa(opts)
  const cliente = await pool.connect()

  try {
    await cliente.query('BEGIN')

    if (opts.limpar !== false) {
      // TRUNCATE, e não DELETE, por um motivo que não é desempenho: `fact` é
      // append-only por trigger, e DELETE linha a linha é justamente o que o
      // trigger existe para recusar. TRUNCATE é outra operação — reset da
      // tabela inteira — e é exatamente o que semear faz.
      //
      // O guard-rail contra rodar isto na base errada não é o trigger: é
      // `semearComGuarda`, que recusa banco com conta que o seed não criou.
      //
      // Uma lista só, para o Postgres resolver a ordem das chaves estrangeiras.
      await cliente.query(`TRUNCATE
        success.cancellation, success.work_item, success.project_task, success.project,
        success.renewal, success.playbook,
        metrics.signal_driver, metrics.signal, metrics.silent_churn_flag,
        metrics.rfm_score, metrics.daily_snapshot,
        public_v.metric_daily,
        ops.excecao_referencia,
        fact.transaction_daily, fact.activity, fact.mrr_event,
        core.contract_product, core.contract, core.contact, core.account_alias, core.account
        RESTART IDENTITY CASCADE`)
    }

    let linhasTransacao = 0
    let linhasSnapshot = 0
    let eventosMrr = 0
    let atividades = 0
    let cancelamentos = 0

    for (const c of massa) {
      const accountId = await inserirConta(cliente, c)
      await inserirContrato(cliente, accountId, c)
      eventosMrr += await inserirEventosMrr(cliente, accountId, c)
      linhasTransacao += await inserirTransacoes(cliente, accountId, c)
      linhasSnapshot += await inserirSnapshotDeOrigem(cliente, accountId, c)
      atividades += await inserirAtividades(cliente, accountId, c)
      cancelamentos += await inserirCancelamento(cliente, accountId, c)
    }

    await cliente.query('COMMIT')

    return {
      contas: massa.length,
      contratos: massa.length,
      diasDeHistorico: Math.max(...massa.map((c) => c.dias.length)),
      linhasTransacao,
      linhasSnapshot,
      eventosMrr,
      atividades,
      cancelamentos,
    }
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    cliente.release()
  }
}

/**
 * Recusa semear um banco que tenha dado que o seed não criou.
 *
 * O seed apaga tudo antes de escrever. Rodar por engano contra um banco com
 * dado real é o tipo de erro que não tem desfazer — e a diferença entre local e
 * produção é uma variável de ambiente.
 */
export async function semearComGuarda(
  pool: pg.Pool,
  opts: OpcoesMassa & { readonly forcar?: boolean } = {},
): Promise<ResumoSeed> {
  if (!opts.forcar) {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM core.account WHERE brand_id IS NULL OR brand_id NOT LIKE 'brand-%'`,
    )
    if (Number(rows[0]?.n ?? 0) > 0) {
      throw new Error(
        'O banco tem contas que não vieram do seed. Semear apagaria dado real. ' +
          'Use forcar: true se tem certeza de que este banco é descartável.',
      )
    }
  }
  return semear(pool, opts)
}

// ── Inserções ───────────────────────────────────────────────────────────────

async function inserirConta(c: pg.PoolClient, s: ContaSintetica): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO core.account
       (razao_social, cnpj, porte, setor, brand_id, branch_id, csm_email, hubspot_company_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (hubspot_company_id) DO UPDATE SET razao_social = EXCLUDED.razao_social
     RETURNING id`,
    [
      s.razaoSocial,
      s.cnpj,
      s.porte,
      s.setor,
      s.brandId,
      s.branchId,
      s.csmEmail,
      `hs-${s.brandId}`,
    ],
  )
  const id = String(rows[0]?.id)

  await c.query(
    `INSERT INTO core.account_alias (account_id, sistema, id_externo)
     VALUES ($1,'replica',$2) ON CONFLICT DO NOTHING`,
    [id, `${s.brandId}:${s.branchId}`],
  )
  await c.query(
    `INSERT INTO core.contact (account_id, nome, email, cargo, papel, is_principal)
     VALUES ($1,$2,$3,$4,'gestor',true) ON CONFLICT (account_id, email) DO NOTHING`,
    [id, s.contato.nome, s.contato.email, s.contato.cargo],
  )
  return id
}

async function inserirContrato(c: pg.PoolClient, id: string, s: ContaSintetica): Promise<void> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO core.contract
       (account_id, mrr_centavos, inicio, vigencia_fim, vidas_contratadas, aviso_previo_dias,
        numero_contrato, tipo_receita, renovacao, reajuste_indice, reajuste_mes, status_vigencia)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'recorrente',$8,$9,$10,'vigente')
     RETURNING id`,
    [
      id,
      s.contrato.mrrCentavos,
      s.contrato.inicio,
      s.contrato.vigenciaFim,
      s.contrato.vidasContratadas,
      s.contrato.avisoPrevioDias,
      s.contrato.numero,
      s.contrato.renovacao,
      s.contrato.reajusteIndice,
      s.contrato.reajusteMes,
    ],
  )
  await c.query(
    `INSERT INTO core.contract_product (contract_id, produto, mrr_centavos)
     VALUES ($1,'clube',$2) ON CONFLICT DO NOTHING`,
    [rows[0]?.id, s.contrato.mrrCentavos],
  )
}

async function inserirEventosMrr(
  c: pg.PoolClient,
  id: string,
  s: ContaSintetica,
): Promise<number> {
  for (const e of s.eventosMrr) {
    await c.query(
      `INSERT INTO fact.mrr_event
         (account_id, competencia, valor_centavos, tipo, motivo, origem, chave_natural)
       VALUES ($1,$2,$3,$4,$5,'ops',$6)
       ON CONFLICT (chave_natural) DO NOTHING`,
      [id, e.competencia, e.valorCentavos, e.tipo, e.motivo, `seed:${id}:${e.competencia}:${e.tipo}`],
    )
  }
  return s.eventosMrr.length
}

async function inserirTransacoes(c: pg.PoolClient, id: string, s: ContaSintetica): Promise<number> {
  for (const d of s.dias) {
    await c.query(
      `INSERT INTO fact.transaction_daily
         (account_id, dia, transacoes, gmv_centavos, cashback_gerado_centavos,
          cashback_resgatado_centavos, usuarios_distintos)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (account_id, dia) DO UPDATE
          SET transacoes = EXCLUDED.transacoes, gmv_centavos = EXCLUDED.gmv_centavos,
              cashback_gerado_centavos = EXCLUDED.cashback_gerado_centavos,
              cashback_resgatado_centavos = EXCLUDED.cashback_resgatado_centavos,
              usuarios_distintos = EXCLUDED.usuarios_distintos`,
      [
        id,
        d.dia,
        d.transacoes,
        d.gmvCentavos,
        d.cashbackGeradoCentavos,
        d.cashbackResgatadoCentavos,
        d.usuariosDistintos,
      ],
    )
  }
  return s.dias.length
}

/**
 * Escreve as colunas de ORIGEM do snapshot — o papel de C1, C2, C6 e C8.
 *
 * Deliberadamente NÃO escreve `completo` nem `qualidade_por_fonte`: essas são
 * conclusões da consolidação. Se o seed as preenchesse, a consolidação passaria
 * a ser testada contra o que o seed decidiu, e não contra os fatos.
 */
async function inserirSnapshotDeOrigem(
  c: pg.PoolClient,
  id: string,
  s: ContaSintetica,
): Promise<number> {
  for (const d of s.dias) {
    await c.query(
      `INSERT INTO metrics.daily_snapshot
         (competencia, account_id, vidas_contratadas, vidas_elegiveis, vidas_ativadas_acum,
          vidas_ativas_30d, mau, dau, transacoes, gmv_centavos, cashback_gerado_centavos,
          cashback_resgatado_centavos, dias_atraso_max, valor_aberto_centavos, mrr_centavos)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (competencia, account_id) DO UPDATE SET
          vidas_contratadas = EXCLUDED.vidas_contratadas,
          vidas_elegiveis = EXCLUDED.vidas_elegiveis,
          vidas_ativadas_acum = EXCLUDED.vidas_ativadas_acum,
          vidas_ativas_30d = EXCLUDED.vidas_ativas_30d,
          mau = EXCLUDED.mau, dau = EXCLUDED.dau,
          transacoes = EXCLUDED.transacoes, gmv_centavos = EXCLUDED.gmv_centavos,
          cashback_gerado_centavos = EXCLUDED.cashback_gerado_centavos,
          cashback_resgatado_centavos = EXCLUDED.cashback_resgatado_centavos,
          dias_atraso_max = EXCLUDED.dias_atraso_max,
          valor_aberto_centavos = EXCLUDED.valor_aberto_centavos,
          mrr_centavos = EXCLUDED.mrr_centavos`,
      [
        d.dia,
        id,
        s.contrato.vidasContratadas,
        d.vidasElegiveis,
        d.vidasAtivadasAcum,
        d.vidasAtivas30d,
        d.mau,
        d.dau,
        d.transacoes,
        d.gmvCentavos,
        d.cashbackGeradoCentavos,
        d.cashbackResgatadoCentavos,
        d.diasAtrasoMax,
        d.valorAbertoCentavos,
        s.contrato.mrrCentavos,
      ],
    )
  }
  return s.dias.length
}

async function inserirAtividades(c: pg.PoolClient, id: string, s: ContaSintetica): Promise<number> {
  for (const [i, a] of s.atividades.entries()) {
    await c.query(
      `INSERT INTO fact.activity (account_id, tipo, ocorreu_em, ator_email, resumo, origem, chave_natural)
       VALUES ($1,$2,$3,$4,$5,'seed',$6) ON CONFLICT (chave_natural) DO NOTHING`,
      [id, a.tipo, a.ocorreuEm, a.ator, a.resumo, `seed:${id}:atv:${i}`],
    )
  }
  return s.atividades.length
}

async function inserirCancelamento(
  c: pg.PoolClient,
  id: string,
  s: ContaSintetica,
): Promise<number> {
  if (!s.cancelamento) return 0
  const x = s.cancelamento
  // Em aviso, e de propósito SEM as duas confirmações: é o estado em que a tela
  // de saídas em curso mostra "efeito na receita indefinido" e cobra a
  // confirmação do Financeiro.
  await c.query(
    `INSERT INTO success.cancellation
       (account_id, origem, estado, data_levantada, canal, quem_comunicou,
        mrr_centavos_na_levantada, aviso_previo_dias, aviso_confirmado_por,
        aviso_confirmado_em, data_fim_aviso, motivo)
     VALUES ($1,'cliente','em_aviso',$2,$3,$4,$5,$6,'juridico@alloyal.com.br',now(),$7,$8)`,
    [
      id,
      x.dataLevantada,
      x.canal,
      x.quemComunicou,
      x.mrrCentavosNaLevantada,
      x.avisoPrevioDias,
      x.dataFimAviso,
      x.motivo,
    ],
  )
  return 1
}
