import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import pg from 'pg'

import { sincronizarCadastro } from './sincronizar-core.js'
import type { NegocioDoCore } from './core-lecupon.js'

/**
 * A regra que este arquivo protege: `core.account.hubspot_company_id` é UNIQUE, e
 * o core reporta o MESMO hubspot_company_id em vários negócios — medido em
 * 04/08/2026: 33 IDs duplicados, um deles em 14 contas raiz.
 *
 * Se o vínculo ambíguo fosse para a coluna única, a carga quebraria (23505). Se o
 * UNIQUE fosse derrubado, toda junção a partir do HubSpot passaria a poder
 * multiplicar linha — receita contada duas vezes, sem erro nenhum.
 */
const ADMIN = process.env['DATABASE_URL_ADMIN']

const neg = (id: string, extra: Partial<NegocioDoCore> = {}): NegocioDoCore =>
  ({
    // `id` como string aqui: o ciclo faz `String(n.id)` de qualquer forma, e o
    // prefixo textual é o que impede colisão com id real do core.
    id: id as unknown as number,
    name: `Cliente ${id}`,
    cnpj: `999${id.replace(/\D/g, '')}00000`,
    hubspot_company_id: null,
    main_business_id: null,
    active: true,
    status: 'active',
    user_count: 1,
    authorized_user_count: 2,
    contact_email: null,
    cashback: true,
    ...extra,
  }) as NegocioDoCore

describe('de-para com o HubSpot', { skip: !ADMIN }, () => {
  let db: pg.Pool
  const AGORA = new Date('2026-08-04T02:00:00Z')

  before(async () => {
    const { migrate } = await import('@pulse/db')
    await migrate(ADMIN as string)
    db = new pg.Pool({ connectionString: ADMIN })
    await limpar()
  })
  after(async () => {
    await limpar()
    await db.end()
  })

  /**
   * Limpa em DUAS etapas, e o prefixo é `zzt-` de propósito.
   *
   * A primeira versão usava `LIKE '99%'` e o hook falhou com 23503: `brand_id` do
   * core é NUMÉRICO, e existem negócios reais começando em 99 — com filhas
   * apontando para eles. O prefixo agora não pode colidir com id do core.
   *
   * E a FK é AUTORREFERENTE (`account_parent_account_id_fkey`): apagar matriz antes
   * da filial viola a restrição, então o vínculo é desfeito primeiro.
   */
  const limpar = async () => {
    await db.query("UPDATE core.account SET parent_account_id = NULL WHERE brand_id LIKE 'zzt-%'")
    // O gatilho da migration 0024 recusa DELETE em core.account. A saída é
    // DECLARAR que este é banco descartável — e declarar é o ponto: o teste diz em
    // voz alta que está apagando o que ele mesmo criou.
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      await c.query("SET LOCAL pulse.banco_descartavel = 'sim'")
      await c.query("DELETE FROM core.account WHERE brand_id LIKE 'zzt-%'")
      await c.query('COMMIT')
    } finally {
      c.release()
    }
  }

  test('vínculo NÃO ambíguo vai para a coluna única', async () => {
    const r = await sincronizarCadastro(db, [neg('zzt-1', { hubspot_company_id: 'hs-solo' })], AGORA, false)
    assert.equal(r.hubspotAmbiguos, 0)
    const { rows } = await db.query(
      "SELECT hubspot_company_id FROM core.account WHERE brand_id = 'zzt-1'",
    )
    assert.equal(rows[0].hubspot_company_id, 'hs-solo')
  })

  test('vínculo AMBÍGUO não vai para a coluna única, e a carga NÃO quebra', async () => {
    // Sem o tratamento, isto é o 23505 que apareceu contra a API real.
    const r = await sincronizarCadastro(
      db,
      [neg('zzt-2', { hubspot_company_id: 'hs-dup' }), neg('zzt-3', { hubspot_company_id: 'hs-dup' })],
      AGORA,
      false,
    )
    assert.equal(r.hubspotAmbiguos, 2, 'os dois negócios contam como ambíguos')
    const { rows } = await db.query(
      "SELECT brand_id, hubspot_company_id FROM core.account WHERE brand_id IN ('zzt-2','zzt-3') ORDER BY brand_id",
    )
    assert.equal(rows.length, 2, 'os dois foram gravados')
    assert.equal(rows[0].hubspot_company_id, null, 'coluna única fica vazia')
    assert.equal(rows[1].hubspot_company_id, null)
  })

  test('mas o de-para GUARDA o vínculo ambíguo — nada se perde', async () => {
    const { rows } = await db.query(
      `SELECT count(*)::int n FROM core.account_hubspot h
         JOIN core.account a ON a.id = h.account_id
        WHERE a.brand_id IN ('zzt-2','zzt-3') AND h.hubspot_company_id = 'hs-dup'`,
    )
    assert.equal(rows[0].n, 2)
  })

  test('a view aponta o caso que precisa de decisão humana', async () => {
    const { rows } = await db.query(
      "SELECT contas, raizes FROM core.hubspot_ambiguo WHERE hubspot_company_id = 'hs-dup'",
    )
    assert.equal(rows[0].contas, '2')
    assert.equal(rows[0].raizes, '2', 'duas RAÍZES: não se explica por matriz/filial')
  })

  test('módulo que o core deixou de reportar SAI', async () => {
    await sincronizarCadastro(db, [neg('zzt-4', { cashback: true, giftcard: true })], AGORA, false)
    const antes = await db.query(
      `SELECT modulo FROM core.programa_modulo m JOIN core.account a ON a.id = m.account_id
        WHERE a.brand_id = 'zzt-4' ORDER BY modulo`,
    )
    assert.deepEqual(antes.rows.map((r) => r.modulo), ['cashback', 'giftcard'])

    const depois = new Date(AGORA.getTime() + 86_400_000)
    await sincronizarCadastro(db, [neg('zzt-4', { cashback: true })], depois, false)
    const agora = await db.query(
      `SELECT modulo FROM core.programa_modulo m JOIN core.account a ON a.id = m.account_id
        WHERE a.brand_id = 'zzt-4'`,
    )
    assert.deepEqual(agora.rows.map((r) => r.modulo), ['cashback'], 'giftcard saiu')
  })

  test('cliente ausente é INATIVADO, e nunca apagado', async () => {
    const depois = new Date(AGORA.getTime() + 172_800_000)
    const r = await sincronizarCadastro(db, [neg('zzt-1', { hubspot_company_id: 'hs-solo' })], depois, false)
    assert.ok(r.ausentes >= 1, 'os outros contam como ausentes')
    assert.ok(r.inativados >= 1, 'e foram inativados')
    const { rows } = await db.query("SELECT ativo FROM core.account WHERE brand_id = 'zzt-4'")
    assert.equal(rows.length, 1, 'CONTINUA EXISTINDO — a linha não é apagada')
    assert.equal(rows[0].ativo, false, 'e passou a inativa')
  })

  test('leitura PARCIAL não inativa ninguém', async () => {
    // O caso que mais importa: ausente numa leitura truncada provavelmente só não
    // foi lido. Inativar ali desligaria cliente que está no ar.
    const t = new Date(AGORA.getTime() + 300_000_000)
    await sincronizarCadastro(db, [neg('zzt-4')], t, false) // reativa o zzt-4
    const antes = await db.query("SELECT ativo FROM core.account WHERE brand_id = 'zzt-4'")
    assert.equal(antes.rows[0].ativo, true)

    const t2 = new Date(t.getTime() + 60_000)
    const r = await sincronizarCadastro(db, [neg('zzt-1')], t2, /* parcial */ true)
    assert.ok(r.ausentes >= 1, 'ainda conta os ausentes')
    assert.equal(r.inativados, 0, 'mas NÃO inativa nenhum')
    const depois = await db.query("SELECT ativo FROM core.account WHERE brand_id = 'zzt-4'")
    assert.equal(depois.rows[0].ativo, true, 'segue ativo')
  })

  test('o banco RECUSA apagar conta, com mensagem que ensina o caminho', async () => {
    await assert.rejects(
      db.query("DELETE FROM core.account WHERE brand_id = 'zzt-4'"),
      /não aceita DELETE.*INATIVA/s,
    )
    const { rows } = await db.query("SELECT count(*)::int n FROM core.account WHERE brand_id = 'zzt-4'")
    assert.equal(rows[0].n, 1, 'continua lá')
  })

  test('a hierarquia liga filial à matriz', async () => {
    const depois = new Date(AGORA.getTime() + 259_200_000)
    await sincronizarCadastro(
      db,
      [neg('zzt-10'), neg('zzt-11', { main_business_id: 'zzt-10' as unknown as number })],
      depois,
      false,
    )
    const { rows } = await db.query(
      `SELECT m.brand_id AS matriz FROM core.account f
         JOIN core.account m ON m.id = f.parent_account_id
        WHERE f.brand_id = 'zzt-11'`,
    )
    assert.equal(rows[0]?.matriz, 'zzt-10')
  })
})
