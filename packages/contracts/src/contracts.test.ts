import assert from 'node:assert/strict'
import { test } from 'node:test'

import { recusarTenantEmParametro, TenantEmParametroError } from './index.js'

test('requisição legítima passa', () => {
  recusarTenantEmParametro({ query: { metrica: 'adesao_30d', de: '2026-01-01', ate: '2026-07-01' } })
})

test('identificador de cliente é recusado nos quatro lugares', () => {
  const casos: { onde: string; fontes: Parameters<typeof recusarTenantEmParametro>[0] }[] = [
    { onde: 'query', fontes: { query: { account_id: 'x' } } },
    { onde: 'path', fontes: { params: { hubspot_id: 'x' } } },
    { onde: 'corpo', fontes: { body: { cliente_id: 'x' } } },
    { onde: 'cabeçalho', fontes: { headers: { 'x-ops-tenant': 'x' } } },
  ]
  for (const c of casos) {
    assert.throws(() => recusarTenantEmParametro(c.fontes), TenantEmParametroError, c.onde)
  }
})

test('camelCase e variações de caixa também são recusadas', () => {
  assert.throws(() => recusarTenantEmParametro({ query: { accountId: 'x' } }), TenantEmParametroError)
  assert.throws(() => recusarTenantEmParametro({ body: { HubspotCompanyId: 'x' } }), TenantEmParametroError)
})

test('identificador escondido em objeto aninhado é recusado', () => {
  assert.throws(
    () => recusarTenantEmParametro({ body: { filtro: { avancado: { tenant: 'x' } } } }),
    TenantEmParametroError,
  )
})
