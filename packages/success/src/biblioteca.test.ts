/**
 * A biblioteca de playbooks.
 *
 * O que se testa aqui é o versionamento e a invariante de UMA versão vigente. O
 * resto é forma; essas duas são o que faz a auditoria de um item fechado em março
 * mostrar o processo de março, e a pergunta "qual é o processo hoje" ter uma
 * resposta só.
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'

import { permissoesDe, type Identidade, type Papel } from '@ops/auth'
import pg from 'pg'

import {
  despublicar,
  gatilhosAmbiguos,
  gatilhosSemPlaybook,
  historico,
  indice,
  listarVigentes,
  MINIMO_CONTEUDO,
  PlaybookInvalidoError,
  publicar,
  salvarRascunho,
  SemPermissaoBiblioteca,
  validar,
  vigenteDoGatilho,
} from './biblioteca.js'

const ADMIN = process.env['DATABASE_URL_ADMIN']

const quem = (email: string, ...papeis: Papel[]): Identidade => ({
  email,
  papeis,
  permissoes: permissoesDe(papeis),
})

const LEAD = quem('lead@alloyal.com.br', 'ops-cs-lead')
const CSM = quem('csm@alloyal.com.br', 'ops-csm')

const CONTEUDO =
  'Ligar para o contato financeiro no mesmo dia. Confirmar se a nota chegou, se ' +
  'há divergência de valor e qual é a data prevista de pagamento. Registrar a ' +
  'resposta no item antes de fechar.'

// ── Validação, sem banco ────────────────────────────────────────────────────

test('a chave é um slug, e o título tem que dizer algo', () => {
  assert.deepEqual(validar({ chave: 'cobranca-30d', titulo: 'Cobrança relacional', conteudo: CONTEUDO, gatilhos: ['G-01'] }), [])
  assert.ok(validar({ chave: 'Cobrança 30d', titulo: 'Cobrança relacional', conteudo: CONTEUDO, gatilhos: [] }).length > 0)
  assert.ok(validar({ chave: 'ok-slug', titulo: 'curto', conteudo: CONTEUDO, gatilhos: [] }).length > 0)
})

test('conteúdo curto é lembrete, não processo', () => {
  // Playbook vazio publicado é pior que playbook nenhum: o item passa a exibir um
  // anexo que não ajuda, e o CSM deixa de clicar nos anexos — inclusive nos bons.
  const erros = validar({ chave: 'ok-slug', titulo: 'Título suficiente', conteudo: 'Ligar.', gatilhos: [] })
  assert.equal(erros.length, 1)
  assert.match(erros[0]!, new RegExp(String(MINIMO_CONTEUDO)))
})

test('gatilho inexistente é recusado com o código no texto', () => {
  const erros = validar({ chave: 'ok-slug', titulo: 'Título suficiente', conteudo: CONTEUDO, gatilhos: ['G-99x'] })
  assert.match(erros[0]!, /G-99x/)
})

// ── Contra banco ────────────────────────────────────────────────────────────

describe('biblioteca', { skip: !ADMIN }, () => {
  let pool: pg.Pool

  before(async () => {
    const { migrate } = await import('@ops/db')
    await migrate(ADMIN as string)
    pool = new pg.Pool({ connectionString: ADMIN })
  })

  after(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query('TRUNCATE success.playbook CASCADE')
    await pool.query(`DELETE FROM ops.feature_flag WHERE chave LIKE 'gatilho:%'`)
  })

  const rascunho = (chave = 'cobranca-30d', gatilhos: string[] = ['G-01']) =>
    salvarRascunho(pool, LEAD, {
      chave,
      titulo: 'Cobrança relacional aos 30 dias',
      conteudo: CONTEUDO,
      gatilhos,
    })

  // ── Versionamento ─────────────────────────────────────────────────────────

  test('cada salvamento cria versão nova, nunca sobrescreve', async () => {
    // O item de trabalho aponta para a versão que valia quando foi criado. Editar
    // em cima faria a auditoria de um item de março mostrar o processo de agosto.
    const v1 = await rascunho()
    const v2 = await rascunho()
    assert.equal(v1.versao, 1)
    assert.equal(v2.versao, 2)
    assert.equal((await historico(pool, 'cobranca-30d')).length, 2)
  })

  test('rascunho nasce inativo — nada vai ao ar sem alguém publicar', async () => {
    const p = await rascunho()
    assert.equal(p.ativo, false)
    assert.equal(p.estado, 'rascunho')
    assert.deepEqual(await listarVigentes(pool), [])
  })

  test('publicar registra autor e horário', async () => {
    const p = await publicar(pool, LEAD, (await rascunho()).id)
    assert.equal(p.estado, 'vigente')
    assert.equal(p.publicadoPor, LEAD.email)
    assert.ok(p.publicadoEm)
  })

  // ── Uma versão vigente ────────────────────────────────────────────────────

  test('publicar a versão 2 aposenta a versão 1, na mesma transação', async () => {
    const v1 = await publicar(pool, LEAD, (await rascunho()).id)
    const v2 = await publicar(pool, LEAD, (await rascunho()).id)

    const h = await historico(pool, 'cobranca-30d')
    assert.equal(h.length, 2)
    assert.equal(h[0]?.versao, 2)
    assert.equal(h[0]?.estado, 'vigente')
    assert.equal(h[1]?.estado, 'aposentada', 'a anterior virou histórico, não rascunho')
    assert.ok(h[1]?.substituidoEm)
    assert.equal(v1.id !== v2.id, true)
  })

  test('nunca há duas versões vigentes da mesma chave', async () => {
    // É o que faz "qual é o processo hoje" ter uma resposta só. Metade do time
    // seguindo uma versão e metade a outra é divergência que ninguém percebe,
    // porque as duas parecem certas.
    await publicar(pool, LEAD, (await rascunho()).id)
    await publicar(pool, LEAD, (await rascunho()).id)
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) n FROM success.playbook WHERE chave = 'cobranca-30d' AND ativo`,
    )
    assert.equal(rows[0]?.n, '1')
  })

  test('publicar a versão já vigente é recusado', async () => {
    const p = await publicar(pool, LEAD, (await rascunho()).id)
    await assert.rejects(() => publicar(pool, LEAD, p.id), PlaybookInvalidoError)
  })

  test('chaves diferentes têm vigentes independentes', async () => {
    await publicar(pool, LEAD, (await rascunho('cobranca-30d', ['G-01'])).id)
    await publicar(pool, LEAD, (await rascunho('cobertura-baixa', ['G-06'])).id)
    assert.equal((await listarVigentes(pool)).length, 2)
  })

  // ── Despublicar ───────────────────────────────────────────────────────────

  test('despublicar tira do ar sem esperar a próxima versão', async () => {
    // Playbook errado no ar é pior que nenhum, e esperar a substituta ficar
    // pronta é a escolha errada sob pressão.
    await publicar(pool, LEAD, (await rascunho()).id)
    await despublicar(pool, LEAD, 'cobranca-30d')
    assert.deepEqual(await listarVigentes(pool), [])
  })

  test('versão despublicada fica aposentada, não volta a rascunho', async () => {
    // Ela ESTEVE em produção, e itens de trabalho apontam para ela.
    await publicar(pool, LEAD, (await rascunho()).id)
    await despublicar(pool, LEAD, 'cobranca-30d')
    const h = await historico(pool, 'cobranca-30d')
    assert.equal(h[0]?.estado, 'aposentada')
  })

  test('despublicar o que não está no ar é recusado', async () => {
    await rascunho()
    await assert.rejects(() => despublicar(pool, LEAD, 'cobranca-30d'), PlaybookInvalidoError)
  })

  // ── Permissão ─────────────────────────────────────────────────────────────

  test('quem não configura não muda a biblioteca', async () => {
    // Mudar o processo do time é decisão de quem responde pelo processo.
    await assert.rejects(
      () =>
        salvarRascunho(pool, CSM, {
          chave: 'x-teste',
          titulo: 'Título suficiente',
          conteudo: CONTEUDO,
          gatilhos: [],
        }),
      SemPermissaoBiblioteca,
    )
    const p = await rascunho()
    await assert.rejects(() => publicar(pool, CSM, p.id), SemPermissaoBiblioteca)
    await assert.rejects(() => despublicar(pool, CSM, 'cobranca-30d'), SemPermissaoBiblioteca)
  })

  // ── Ligação com o gatilho ─────────────────────────────────────────────────

  test('o motor da fila acha o playbook vigente do gatilho', async () => {
    await publicar(pool, LEAD, (await rascunho('cobranca-30d', ['G-01', 'G-02'])).id)
    assert.equal((await vigenteDoGatilho(pool, 'G-01'))?.titulo, 'Cobrança relacional aos 30 dias')
    assert.equal((await vigenteDoGatilho(pool, 'G-02'))?.titulo, 'Cobrança relacional aos 30 dias')
    assert.equal(await vigenteDoGatilho(pool, 'G-06'), null)
  })

  test('gatilho sem playbook devolve null, sem travar a fila', async () => {
    // Travar a fila por falta de documentação seria trocar trabalho por burocracia.
    assert.equal(await vigenteDoGatilho(pool, 'G-04'), null)
  })

  test('rascunho não é achado pelo gatilho', async () => {
    await rascunho('cobranca-30d', ['G-01'])
    assert.equal(await vigenteDoGatilho(pool, 'G-01'), null)
  })

  test('dois vigentes para o mesmo gatilho aparecem como ambiguidade', async () => {
    // Não é erro de dado: são duas chaves diferentes que dizem servir ao mesmo
    // gatilho. A fila escolhe a mais recente e a tela mostra o conflito, porque
    // quem configurou é quem sabe qual das duas deveria valer.
    await publicar(pool, LEAD, (await rascunho('cobranca-a', ['G-01'])).id)
    await publicar(pool, LEAD, (await rascunho('cobranca-b', ['G-01'])).id)
    assert.deepEqual(await gatilhosAmbiguos(pool), [{ gatilho: 'G-01', quantos: 2 }])
    assert.ok(await vigenteDoGatilho(pool, 'G-01'), 'a fila continua funcionando')
  })

  // ── Índice ────────────────────────────────────────────────────────────────

  test('o índice mostra o título da versão vigente, não da mais recente', async () => {
    // Um rascunho novo com título mudado não pode alterar o que a listagem diz
    // ser o processo atual.
    await publicar(pool, LEAD, (await rascunho()).id)
    await salvarRascunho(pool, LEAD, {
      chave: 'cobranca-30d',
      titulo: 'RASCUNHO — reescrita em andamento',
      conteudo: CONTEUDO,
      gatilhos: ['G-01'],
    })
    const [i] = await indice(pool)
    assert.equal(i?.titulo, 'Cobrança relacional aos 30 dias')
    assert.equal(i?.versoes, 2)
    assert.equal(i?.temVigente, true)
  })

  test('chave só com rascunho aparece no índice sem vigente', async () => {
    await rascunho('nova-ideia')
    const [i] = await indice(pool)
    assert.equal(i?.temVigente, false)
  })

  // ── A lacuna ──────────────────────────────────────────────────────────────

  test('gatilho promovido sem playbook aparece como lacuna', async () => {
    // É a lacuna que mais custa: o gatilho já roteia trabalho, e cada item nasce
    // sem instrução.
    await pool.query(
      `INSERT INTO ops.feature_flag (chave, habilitado) VALUES ('gatilho:G-03', true)
       ON CONFLICT (chave) DO UPDATE SET habilitado = true`,
    )
    assert.deepEqual(await gatilhosSemPlaybook(pool), ['G-03'])

    await publicar(pool, LEAD, (await rascunho('pdd', ['G-03'])).id)
    assert.deepEqual(await gatilhosSemPlaybook(pool), [])
  })

  test('gatilho em sombra sem playbook não é lacuna', async () => {
    // Ninguém está agindo sobre ele ainda: cobrar documentação de um gatilho que
    // não roteia trabalho é burocracia.
    await pool.query(
      `INSERT INTO ops.feature_flag (chave, habilitado) VALUES ('gatilho:G-11', false)
       ON CONFLICT (chave) DO UPDATE SET habilitado = false`,
    )
    assert.deepEqual(await gatilhosSemPlaybook(pool), [])
  })

  test('rascunho não fecha a lacuna — só versão no ar instrui alguém', async () => {
    await pool.query(
      `INSERT INTO ops.feature_flag (chave, habilitado) VALUES ('gatilho:G-03', true)
       ON CONFLICT (chave) DO UPDATE SET habilitado = true`,
    )
    await rascunho('pdd', ['G-03'])
    assert.deepEqual(await gatilhosSemPlaybook(pool), ['G-03'])
  })
})
