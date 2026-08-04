import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  cabecalhos,
  cnpjNormalizado,
  CoreIndisponivelError,
  credencialDoAmbiente,
  extrairLista,
  lerNegocios,
  modulosDe,
  type NegocioDoCore,
} from './core-lecupon.js'

const CRED = { base: 'https://api.teste/client/v3', token: 'tok', email: 'a@alloyal.com.br' }

// ─── Cabeçalhos ──────────────────────────────────────────────────────────────

test('a grafia dos cabeçalhos é a que a API aceita', () => {
  // `X-Client-Employee-Token`, com o hífen a mais, devolve 401 "Acesso negado" —
  // indistinguível de token errado. Custou uma rodada de diagnóstico.
  const h = cabecalhos(CRED)
  assert.equal(h['X-ClientEmployee-Token'], 'tok')
  assert.equal(h['X-ClientEmployee-Email'], 'a@alloyal.com.br')
  assert.ok(!('X-Client-Employee-Token' in h), 'grafia errada não pode existir')
})

test('sem credencial no ambiente devolve null, e não credencial pela metade', () => {
  assert.equal(credencialDoAmbiente({}), null)
  assert.equal(credencialDoAmbiente({ LECUPON_CLIENT_EMPLOYEE_TOKEN: 'x' }), null)
  assert.equal(credencialDoAmbiente({ LECUPON_CLIENT_EMPLOYEE_EMAIL: 'a@b' }), null)
})

test('o Tenant-id vai só com dígitos', () => {
  const c = credencialDoAmbiente({
    LECUPON_CLIENT_EMPLOYEE_TOKEN: 't',
    LECUPON_CLIENT_EMPLOYEE_EMAIL: 'a@b',
    LECUPON_TENANT_CNPJ: '12.345.678/0001-99',
  })
  assert.equal(cabecalhos(c!)['Tenant-id'], '12345678000199')
})

// ─── Envelope ────────────────────────────────────────────────────────────────

test('a lista vem como array ou dentro de envelope', () => {
  assert.equal(extrairLista([{ id: 1 }]).length, 1)
  assert.equal(extrairLista({ businesses: [{ id: 1 }, { id: 2 }] }).length, 2)
  assert.equal(extrairLista({ data: [{ id: 1 }] }).length, 1)
  assert.equal(extrairLista({ nada: 1 }).length, 0)
  assert.equal(extrairLista(null).length, 0)
})

// ─── Módulos ─────────────────────────────────────────────────────────────────

const negocio = (extra: Record<string, unknown> = {}): NegocioDoCore =>
  ({
    id: 1,
    name: 'Cliente',
    cnpj: '12345678000199',
    hubspot_company_id: null,
    main_business_id: null,
    active: true,
    status: 'active',
    user_count: 10,
    authorized_user_count: 20,
    contact_email: null,
    ...extra,
  }) as NegocioDoCore

test('módulo NOVO do core entra sozinho — a lista é negativa', () => {
  // É o ponto todo da escolha: com lista positiva, um módulo que o core passe a
  // reportar não apareceria, e sem erro nenhum.
  const m = modulosDe(negocio({ cashback: true, modulo_inventado_amanha: true }))
  assert.ok(m.some((x) => x.modulo === 'modulo_inventado_amanha' && x.ativo))
})

test('o que NÃO é módulo fica de fora', () => {
  const m = modulosDe(negocio({ cashback: true, biometry: true, sync_user_updates: true }))
  const nomes = m.map((x) => x.modulo)
  assert.ok(nomes.includes('cashback'))
  assert.ok(!nomes.includes('biometry'), 'biometry é configuração, não módulo')
  assert.ok(!nomes.includes('sync_user_updates'))
  assert.ok(!nomes.includes('active'), '`active` é estado do cliente, não módulo')
})

test('módulo desligado é registrado como desligado, não omitido', () => {
  // Omitir faria a tela mostrar "não informado" onde o core disse "desligado" —
  // e são coisas diferentes para quem decide configuração.
  const m = modulosDe(negocio({ cashback: false, giftcard: true }))
  assert.deepEqual(
    m.filter((x) => x.modulo === 'cashback'),
    [{ modulo: 'cashback', ativo: false }],
  )
})

test('só booleano vira módulo', () => {
  const m = modulosDe(negocio({ cashback: true, cashback_transfer_frequency: 'mensal', banner: null }))
  assert.deepEqual(m.map((x) => x.modulo), ['cashback'])
})

// ─── CNPJ ────────────────────────────────────────────────────────────────────

test('CNPJ vira dígito puro, e vazio vira null', () => {
  assert.equal(cnpjNormalizado('12.345.678/0001-99'), '12345678000199')
  assert.equal(cnpjNormalizado(''), null)
  assert.equal(cnpjNormalizado('   '), null)
  assert.equal(cnpjNormalizado(null), null)
  assert.equal(cnpjNormalizado('---'), null, 'só pontuação não é CNPJ')
})

// ─── Paginação ───────────────────────────────────────────────────────────────

const pagina = (ids: number[]) =>
  new Response(JSON.stringify(ids.map((id) => ({ ...negocio(), id }))), { status: 200 })

test('para na primeira página incompleta', async () => {
  const chamadas: string[] = []
  const buscar = (async (url: string) => {
    chamadas.push(url)
    return chamadas.length === 1
      ? pagina(Array.from({ length: 30 }, (_, i) => i + 1))
      : pagina([31, 32])
  }) as unknown as typeof fetch
  const r = await lerNegocios(CRED, { buscar, pausaMs: 0 })
  assert.equal(r.negocios.length, 32)
  assert.equal(r.paginas, 2)
  assert.equal(r.parcial, false)
  assert.equal(chamadas.length, 2, 'não pede a terceira página')
})

test('página vazia encerra sem contá-la', async () => {
  const buscar = (async (url: string) =>
    url.includes('page=1') ? pagina(Array.from({ length: 30 }, (_, i) => i + 1)) : pagina([])) as unknown as typeof fetch
  const r = await lerNegocios(CRED, { buscar, pausaMs: 0 })
  assert.equal(r.negocios.length, 30)
  assert.equal(r.paginas, 1)
  assert.equal(r.parcial, false)
})

test('id repetido entre páginas não duplica', async () => {
  // Acontece de verdade: alguém edita um cliente durante a varredura e a ordem
  // muda entre as páginas. Sem dedup, o mesmo cliente entra duas vezes.
  const buscar = (async (url: string) =>
    url.includes('page=1')
      ? pagina(Array.from({ length: 30 }, (_, i) => i + 1))
      : pagina([30, 31])) as unknown as typeof fetch
  const r = await lerNegocios(CRED, { buscar, pausaMs: 0 })
  assert.equal(r.negocios.length, 31, '30 da primeira + 1 novo')
  assert.equal(new Set(r.negocios.map((n) => n.id)).size, 31)
})

test('o teto de páginas marca a leitura como PARCIAL', async () => {
  // A distinção existe para o ciclo NÃO apagar o que não veio: leitura parcial não
  // autoriza concluir que um cliente ausente foi removido.
  const buscar = (async () => pagina(Array.from({ length: 30 }, (_, i) => i + 1))) as unknown as typeof fetch
  const r = await lerNegocios(CRED, { buscar, pausaMs: 0, maxPaginas: 3 })
  assert.equal(r.parcial, true)
  assert.equal(r.paginas, 3)
})

test('erro da API sobe como CoreIndisponivelError com o status', async () => {
  const buscar = (async () => new Response('Acesso negado', { status: 401 })) as unknown as typeof fetch
  const err = await lerNegocios(CRED, { buscar, pausaMs: 0 }).then(
    () => null,
    (e: unknown) => e,
  )
  assert.ok(err instanceof CoreIndisponivelError)
  assert.equal((err as CoreIndisponivelError).status, 401)
})

test('pede sempre per_page=30, porque a API ignora outro valor', async () => {
  // Medido: 30, 100 e 200 devolvem 30. Pedir 200 daria a impressão de menos
  // requisições do que de fato acontecem.
  let url = ''
  const buscar = (async (u: string) => {
    url = u
    return pagina([1])
  }) as unknown as typeof fetch
  await lerNegocios(CRED, { buscar, pausaMs: 0 })
  assert.match(url, /per_page=30/)
})
