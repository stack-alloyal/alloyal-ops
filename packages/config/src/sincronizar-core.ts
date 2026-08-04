/**
 * Grava no Pulse o cadastro lido da API do core.
 *
 * A leitura e as regras puras vivem em `core-lecupon.ts`; aqui é só o que precisa
 * de Postgres.
 */

import type pg from 'pg'

import { cnpjNormalizado, modulosDe, type NegocioDoCore } from './core-lecupon.js'

export interface ResumoDaSincronizacao {
  readonly lidos: number
  readonly criados: number
  readonly atualizados: number
  readonly inalterados: number
  readonly semCnpj: number
  readonly comHubspot: number
  readonly modulosGravados: number
  readonly hierarquiaLigada: number
  readonly ausentes: number
  /**
   * Quantos negócios têm hubspot_company_id COMPARTILHADO com outro. Reportado, e
   * não escondido: é decisão humana se são dois programas sob um contrato ou id
   * colado errado, e daqui os dois casos são indistinguíveis.
   */
  readonly hubspotAmbiguos: number
}

/**
 * Grava a base inteira, em UMA transação.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ POR QUE TRANSAÇÃO ÚNICA, e não por cliente:                                │
 * │                                                                            │
 * │ A hierarquia matriz↔filial é resolvida no SEGUNDO passo, quando todos os    │
 * │ `brand_id` já existem. Em transações separadas, uma falha no meio deixaria  │
 * │ filiais órfãs apontando para matriz que não entrou — e o painel mostraria   │
 * │ cliente sem matriz como se fosse raiz.                                     │
 * │                                                                            │
 * │ ~3.245 clientes numa transação é grande, e é aceitável: roda uma vez por    │
 * │ dia, de madrugada, e o custo de meia-carga é maior que o de um lock longo.  │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * @param parcial quando a leitura foi truncada (teto de páginas). Ver abaixo por
 *   que isso muda o comportamento.
 */
export async function sincronizarCadastro(
  db: pg.Pool,
  negocios: readonly NegocioDoCore[],
  agora: Date,
  parcial: boolean,
  log: (msg: string) => void = () => {},
): Promise<ResumoDaSincronizacao> {
  // ── Quais hubspot_company_id são AMBÍGUOS nesta carga ────────────────────────
  // Medido em 04/08/2026: 33 IDs apontam para mais de um negócio, 32 deles entre
  // negócios RAIZ. `core.account.hubspot_company_id` é UNIQUE desde a 0002, então
  // só o vínculo de um-para-um pode ir para lá; o resto vai para
  // `core.account_hubspot`, que aceita N:1. Ver migration 0023.
  const quantosPorHubspot = new Map<string, number>()
  for (const n of negocios) {
    if (n.hubspot_company_id === null || n.hubspot_company_id === undefined) continue
    const k = String(n.hubspot_company_id)
    quantosPorHubspot.set(k, (quantosPorHubspot.get(k) ?? 0) + 1)
  }
  const ambiguo = (id: string | null): boolean => id !== null && (quantosPorHubspot.get(id) ?? 0) > 1
  let hubspotAmbiguos = 0

  const cliente = await db.connect()
  let criados = 0
  let atualizados = 0
  let inalterados = 0
  let modulosGravados = 0
  let hierarquiaLigada = 0

  try {
    await cliente.query('BEGIN')

    for (const n of negocios) {
      const brandId = String(n.id)
      const cnpj = cnpjNormalizado(n.cnpj)
      const hubspot = n.hubspot_company_id === null || n.hubspot_company_id === undefined
          ? null
          : String(n.hubspot_company_id)
      const hubspotUnico = ambiguo(hubspot) ? null : hubspot
      if (ambiguo(hubspot)) hubspotAmbiguos++

      // `xmax = 0` distingue INSERT de UPDATE no mesmo comando — é o jeito de
      // reportar criados e atualizados sem uma consulta a mais por cliente.
      //
      // `razao_social` NÃO é sobrescrito com valor vazio: o core às vezes devolve
      // nome em branco, e apagar o nome que já estava lá é perder dado por causa de
      // uma falha do lado deles.
      const { rows } = await cliente.query<{ id: string; criou: boolean; mudou: boolean }>(
        `INSERT INTO core.account
           (brand_id, razao_social, cnpj, hubspot_company_id, ativo,
            status_core, usuarios_cadastrados, usuarios_autorizados, contato_email,
            sincronizado_em, atualizado_em)
         VALUES ($1, coalesce(nullif($2, ''), 'sem nome no core'), $3, $4, $5, $6, $7, $8, $9, $10, $10)
         -- O predicado REPETIDO nao e redundancia: o indice unico de brand_id e
         -- PARCIAL (WHERE brand_id IS NOT NULL, migration 0022), porque conta
         -- semeada nao tem brand_id. Sem repetir aqui, o Postgres nao encontra o
         -- indice e devolve 42P10, "no unique constraint matching the ON CONFLICT".
         ON CONFLICT (brand_id) WHERE brand_id IS NOT NULL DO UPDATE SET
            razao_social         = coalesce(nullif($2, ''), core.account.razao_social),
            cnpj                 = coalesce($3, core.account.cnpj),
            hubspot_company_id   = coalesce($4, core.account.hubspot_company_id),
            ativo                = $5,
            status_core          = $6,
            usuarios_cadastrados = $7,
            usuarios_autorizados = $8,
            contato_email        = coalesce($9, core.account.contato_email),
            sincronizado_em      = $10,
            atualizado_em        = CASE
              WHEN core.account.ativo IS DISTINCT FROM $5
                OR core.account.status_core IS DISTINCT FROM $6
                OR core.account.usuarios_cadastrados IS DISTINCT FROM $7
                OR core.account.usuarios_autorizados IS DISTINCT FROM $8
                OR core.account.razao_social IS DISTINCT FROM coalesce(nullif($2, ''), core.account.razao_social)
              THEN $10 ELSE core.account.atualizado_em END
         RETURNING id,
                   (xmax = 0) AS criou,
                   (atualizado_em = $10) AS mudou`,
        [
          brandId,
          n.name ?? '',
          cnpj,
          hubspotUnico,
          n.active,
          n.status,
          n.user_count,
          n.authorized_user_count,
          n.contact_email,
          agora,
        ],
      )
      const linha = rows[0]!
      if (linha.criou) criados++
      else if (linha.mudou) atualizados++
      else inalterados++

      // ── O de-para COMPLETO, ambíguo ou não ─────────────────────────────────
      // Aqui nada se perde: é a tabela que existe para registrar N contas → 1
      // empresa do HubSpot.
      if (hubspot) {
        await cliente.query(
          `INSERT INTO core.account_hubspot (account_id, hubspot_company_id, sincronizado_em)
           VALUES ($1, $2, $3)
           ON CONFLICT (account_id) DO UPDATE
             SET hubspot_company_id = EXCLUDED.hubspot_company_id,
                 sincronizado_em = EXCLUDED.sincronizado_em`,
          [linha.id, hubspot, agora],
        )
      } else {
        // O core deixou de reportar o vínculo: sai, senão a tela mostra um de-para
        // que não existe mais.
        await cliente.query('DELETE FROM core.account_hubspot WHERE account_id = $1', [linha.id])
      }

      // ── Módulos: grava os que vieram e APAGA os que não vieram ──────────────
      // Módulo que o core deixou de reportar tem que sair. Deixá-lo faria a tela
      // mostrar módulo desligado como se ainda estivesse configurado.
      const modulos = modulosDe(n)
      for (const m of modulos) {
        await cliente.query(
          `INSERT INTO core.programa_modulo (account_id, modulo, ativo, sincronizado_em)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (account_id, modulo) DO UPDATE
             SET ativo = EXCLUDED.ativo, sincronizado_em = EXCLUDED.sincronizado_em`,
          [linha.id, m.modulo, m.ativo, agora],
        )
      }
      modulosGravados += modulos.length
      await cliente.query(
        `DELETE FROM core.programa_modulo
          WHERE account_id = $1 AND sincronizado_em < $2`,
        [linha.id, agora],
      )
    }

    // ── Passo 2: hierarquia, com todos os brand_id já gravados ────────────────
    const comPai = negocios.filter((n) => n.main_business_id !== null && n.main_business_id !== undefined)
    for (const n of comPai) {
      const r = await cliente.query(
        `UPDATE core.account f
            SET parent_account_id = m.id
           FROM core.account m
          WHERE f.brand_id = $1 AND m.brand_id = $2
            AND f.id <> m.id
            AND f.parent_account_id IS DISTINCT FROM m.id`,
        [String(n.id), String(n.main_business_id)],
      )
      hierarquiaLigada += r.rowCount ?? 0
    }

    await cliente.query('COMMIT')
  } catch (err) {
    await cliente.query('ROLLBACK')
    throw err
  } finally {
    cliente.release()
  }

  // ── Ausentes: contados, NUNCA apagados ─────────────────────────────────────
  //
  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ Cliente que estava no Pulse e não veio na carga NÃO é apagado, e não é   │
  // │ marcado como inativo. Três motivos, em ordem de probabilidade:           │
  // │                                                                          │
  // │  1. leitura PARCIAL — o teto de páginas cortou, e o ausente só não foi    │
  // │     lido;                                                                │
  // │  2. o escopo da credencial mudou, e o cliente saiu da visão sem sair da  │
  // │     base;                                                                │
  // │  3. o cliente foi de fato removido no core.                              │
  // │                                                                          │
  // │ Só o terceiro justifica mexer, e os três são indistinguíveis daqui. Então │
  // │ o ciclo REPORTA o número e deixa a decisão para quem sabe — que é o       │
  // │ padrão de "recorte pequeno é suprimido e EXPLICADO, nunca omitido".      │
  // └─────────────────────────────────────────────────────────────────────────┘
  const { rows: aus } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM core.account
      WHERE brand_id IS NOT NULL AND (sincronizado_em IS NULL OR sincronizado_em < $1)`,
    [agora],
  )
  const ausentes = Number(aus[0]?.n ?? 0)
  if (hubspotAmbiguos > 0) {
    log(
      `${hubspotAmbiguos} negócio(s) compartilham hubspot_company_id com outro — o vínculo ` +
        'foi gravado em core.account_hubspot e NÃO na coluna única. Ver a view ' +
        'core.hubspot_ambiguo; raizes > 1 precisa de decisão humana.',
    )
  }
  if (ausentes > 0) {
    log(
      `${ausentes} cliente(s) já gravados NÃO vieram nesta carga` +
        (parcial ? ' — mas a leitura foi PARCIAL, então provavelmente só não foram lidos' : '') +
        '. Nada foi apagado.',
    )
  }

  return {
    lidos: negocios.length,
    criados,
    atualizados,
    inalterados,
    semCnpj: negocios.filter((n) => !cnpjNormalizado(n.cnpj)).length,
    comHubspot: negocios.filter(
      (n) => n.hubspot_company_id !== null && n.hubspot_company_id !== undefined,
    ).length,
    modulosGravados,
    hierarquiaLigada,
    ausentes,
    hubspotAmbiguos,
  }
}
