/**
 * O relatório do cliente e o benchmark anônimo.
 *
 * Este é o arquivo de maior risco do repositório, porque é o único conteúdo que SAI
 * da empresa. Duas coisas dominam:
 *
 *   K-ANONIMATO — o benchmark é o único agregado que um cliente vê contendo
 *   informação derivada de outros clientes. Com 4 empresas no recorte, quem conhece
 *   o mercado deduz quem são; com 2, a mediana É o número do concorrente.
 *
 *   CONGELAMENTO — o cliente tem uma cópia do que recebeu. Recalcular faria "vocês
 *   disseram 42%" exibir 38%, e a conversa deixaria de ser sobre o clube.
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'

import { permissoesDe, type Identidade, type Papel } from '@ops/auth'
import pg from 'pg'

import {
  calcularBenchmark,
  comparativoDaConta,
  decidirSupressao,
  MINIMO_EMPRESAS,
  MINIMO_PESSOAS,
} from './benchmark.js'
import {
  criarRascunho,
  descartar,
  enviar,
  gerarFrase,
  lerRelatorio,
  listarRelatorios,
  MAXIMO_ACOES,
  montarConteudo,
  RelatorioInvalidoError,
  revisar,
  type ConteudoRelatorio,
} from './relatorio.js'

const ADMIN = process.env['DATABASE_URL_ADMIN']
const COMP = '2026-07-01'
const ANTERIOR = '2026-06-01'

const quem = (email: string, ...papeis: Papel[]): Identidade => ({
  email,
  papeis,
  permissoes: permissoesDe(papeis),
})

const ANA = quem('ana@alloyal.com.br', 'ops-csm')
const BRUNO = quem('bruno@alloyal.com.br', 'ops-csm')
const SEM_GRUPO = quem('novo@alloyal.com.br')

// ── A supressão, pura ───────────────────────────────────────────────────────

test('as DUAS condições de k-anonimato têm que valer', () => {
  assert.equal(decidirSupressao(MINIMO_EMPRESAS, MINIMO_PESSOAS).suprimido, false)
  assert.equal(decidirSupressao(MINIMO_EMPRESAS - 1, 5000).suprimido, true, 'empresas de menos')
  assert.equal(decidirSupressao(50, MINIMO_PESSOAS - 1).suprimido, true, 'pessoas de menos')
})

test('cinco empresas minúsculas NÃO fazem um benchmark', () => {
  // Cinco empresas de 6 vidas dão um número que descreve 30 pessoas, e ninguém
  // deveria decidir com ele.
  const d = decidirSupressao(5, 30)
  assert.equal(d.suprimido, true)
  assert.match(String(d.motivo), /30 de 50 pessoas/)
})

test('o motivo diz QUAL condição falhou, com o número', () => {
  // "Recorte pequeno" sem número não permite a ninguém saber quanto falta para ele
  // deixar de ser pequeno.
  assert.match(String(decidirSupressao(3, 2000).motivo), /3 de 5 empresas/)
  assert.equal(/pessoas/.test(String(decidirSupressao(3, 2000).motivo)), false)
  const ambas = String(decidirSupressao(2, 20).motivo)
  assert.match(ambas, /2 de 5 empresas/)
  assert.match(ambas, /20 de 50 pessoas/)
})

// ── A frase, pura ───────────────────────────────────────────────────────────

const conteudoBase = (p: Partial<ConteudoRelatorio> = {}): ConteudoRelatorio => ({
  competencia: '2026-07-01',
  razaoSocial: 'Acme',
  numeros: [
    { metrica: 'adesao_30d', rotulo: 'Adesão', valor: 0.36, anterior: 0.3, unidade: 'percentual', variacao: 0.2 },
    { metrica: 'vidas_ativas_30d', rotulo: 'Usaram', valor: 288, anterior: 240, unidade: 'inteiro', variacao: 0.2 },
    { metrica: 'cobertura_cadastral', rotulo: 'Base', valor: 0.8, anterior: 0.8, unidade: 'percentual', variacao: 0 },
  ],
  evolucao: [],
  comparativo: [],
  acoes: [],
  dadoParcial: false,
  montadoEm: '2026-07-31T00:00:00.000Z',
  ...p,
})

test('a frase traz o número e a variação, sem adjetivo', () => {
  const f = gerarFrase(conteudoBase())
  assert.match(f, /288 colaboradores/)
  assert.match(f, /36%/)
  assert.match(f, /subiu 20%/)
})

test('sem mês anterior a frase NÃO diz "estável"', () => {
  // Zero afirmaria estabilidade onde não há como saber, e o cliente leria "não
  // mudou nada".
  const f = gerarFrase(
    conteudoBase({
      numeros: conteudoBase().numeros.map((n) => ({ ...n, anterior: null, variacao: null })),
    }),
  )
  assert.equal(/estável|subiu|caiu/.test(f), false)
  assert.match(f, /288 colaboradores/, 'o número do mês continua lá')
})

test('a frase declara o N do comparativo', () => {
  // Comparação sem o tamanho do grupo é comparação que o gestor não sabe defender
  // numa reunião.
  const f = gerarFrase(
    conteudoBase({
      comparativo: [
        {
          metrica: 'adesao_30d',
          valor: 0.36,
          p25: 0.2,
          p50: 0.3,
          p75: 0.45,
          nEmpresas: 12,
          suprimido: false,
          motivoSupressao: null,
          posicao: 'entre_p50_p75',
        },
      ],
    }),
  )
  assert.match(f, /12 empresas/)
  assert.match(f, /acima da mediana/)
})

test('comparativo suprimido é EXPLICADO na frase, não omitido', () => {
  // Omitir faria o cliente concluir que a Alloyal não sabe, em vez de entender que o
  // grupo é pequeno demais.
  const f = gerarFrase(
    conteudoBase({
      comparativo: [
        {
          metrica: 'adesao_30d',
          valor: 0.36,
          p25: null,
          p50: null,
          p75: null,
          nEmpresas: 3,
          suprimido: true,
          motivoSupressao: 'recorte com 3 de 5 empresas',
          posicao: null,
        },
      ],
    }),
  )
  assert.match(f, /pequeno demais/)
  // E o número de empresas NÃO vaza: dizer "3 empresas" já é informação sobre o
  // recorte que a supressão existe para proteger.
  assert.equal(/3 empresas/.test(f), false)
})

test('dado parcial é dito na frase, não só num rodapé', () => {
  // O cliente tem que saber antes de usar o número numa decisão dele.
  const f = gerarFrase(conteudoBase({ dadoParcial: true }))
  assert.match(f, /não respondeu/)
  assert.match(f, /podem ser revisados/)
})

// ── Contra banco ────────────────────────────────────────────────────────────

describe('relatório do cliente', { skip: !ADMIN }, () => {
  let pool: pg.Pool

  before(async () => {
    const { migrate } = await import('@ops/db')
    await migrate(ADMIN as string)
    pool = new pg.Pool({ connectionString: ADMIN })
  })

  after(async () => {
    // Relatório enviado resiste ao DELETE por trigger — e derrubar o teardown com a
    // própria invariante deixaria a suíte pendurada.
    await pool
      ?.query('ALTER TABLE success.client_report DISABLE TRIGGER USER')
      .catch(() => undefined)
    await pool?.query('TRUNCATE success.client_report').catch(() => undefined)
    await pool
      ?.query('ALTER TABLE success.client_report ENABLE TRIGGER USER')
      .catch(() => undefined)
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query('ALTER TABLE success.client_report DISABLE TRIGGER USER')
    await pool.query(
      `TRUNCATE success.client_report, public_v.benchmark_monthly,
                metrics.daily_snapshot, core.contract, core.account CASCADE`,
    )
    await pool.query('ALTER TABLE success.client_report ENABLE TRIGGER USER')
  })

  async function conta(
    nome: string,
    opts: {
      porte?: string
      setor?: string
      elegiveis?: number
      ativas?: number
      contratadas?: number
      completo?: boolean
      csm?: string
      comAnterior?: boolean
      ativasAnterior?: number
    } = {},
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO core.account (razao_social, porte, setor, brand_id, csm_email)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [nome, opts.porte ?? 'medio', opts.setor ?? 'industria', `b-${nome}`, opts.csm ?? ANA.email],
    )
    const id = String(rows[0]!.id)
    const inserir = async (comp: string, ativas: number) =>
      pool.query(
        `INSERT INTO metrics.daily_snapshot
           (competencia, account_id, vidas_contratadas, vidas_elegiveis, vidas_ativas_30d,
            transacoes, completo)
         VALUES ($1::date,$2,$3,$4,$5,100,$6)`,
        [comp, id, opts.contratadas ?? 1000, opts.elegiveis ?? 800, ativas, opts.completo ?? true],
      )
    if (opts.comAnterior !== false) await inserir(ANTERIOR, opts.ativasAnterior ?? 240)
    await inserir(COMP, opts.ativas ?? 288)
    return id
  }

  // ── K-anonimato contra banco ───────────────────────────────────────────────

  test('recorte com 4 empresas é GRAVADO suprimido, sem valor', async () => {
    // Não some: a ausência da linha faria a tela do cliente dizer "sem dados", e ele
    // concluiria que a Alloyal não sabe.
    for (let i = 0; i < 4; i++) await conta(`c${i}`, { elegiveis: 500 })
    const r = await calcularBenchmark(pool, COMP)

    assert.equal(r.gravados, 0)
    assert.ok(r.suprimidos >= 2, 'as duas métricas comparáveis, suprimidas')
    const { rows } = await pool.query<{ p50: string | null; suprimido: boolean }>(
      'SELECT p50, suprimido FROM public_v.benchmark_monthly',
    )
    assert.ok(rows.length >= 2, 'as linhas existem')
    assert.ok(rows.every((x) => x.suprimido && x.p50 === null), 'suprimido não carrega valor')
  })

  test('cinco empresas com pessoas suficientes produzem o benchmark', async () => {
    for (let i = 0; i < 5; i++) await conta(`c${i}`, { elegiveis: 200 })
    const r = await calcularBenchmark(pool, COMP)
    assert.ok(r.gravados >= 2)
    const { rows } = await pool.query<{ n_empresas: number; n_pessoas: number; p50: string }>(
      `SELECT n_empresas, n_pessoas, p50 FROM public_v.benchmark_monthly
        WHERE metrica = 'adesao_30d'`,
    )
    assert.equal(rows[0]?.n_empresas, 5)
    assert.equal(rows[0]?.n_pessoas, 1000)
    assert.ok(rows[0]?.p50 !== null)
  })

  test('cinco empresas MINÚSCULAS não produzem benchmark', async () => {
    // 5 × 6 vidas = 30 pessoas. Passa no k de empresas e falha no de pessoas.
    for (let i = 0; i < 5; i++) await conta(`c${i}`, { elegiveis: 6, contratadas: 10, ativas: 3 })
    const r = await calcularBenchmark(pool, COMP)
    assert.equal(r.gravados, 0)
    assert.ok(r.recortes.every((x) => x.suprimido))
    assert.match(String(r.recortes[0]?.motivoSupressao), /30 de 50 pessoas/)
  })

  test('conta com snapshot parcial fica FORA do benchmark', async () => {
    // Misturar conta completa com conta a que faltou uma fonte compara maçã com
    // meia maçã.
    for (let i = 0; i < 5; i++) await conta(`c${i}`, { elegiveis: 200 })
    await conta('parcial', { elegiveis: 200, completo: false })
    await calcularBenchmark(pool, COMP)
    const { rows } = await pool.query<{ n_empresas: number }>(
      `SELECT n_empresas FROM public_v.benchmark_monthly WHERE metrica='adesao_30d'`,
    )
    assert.equal(rows[0]?.n_empresas, 5, 'a parcial não entrou')
  })

  test('recortes de porte diferente não se misturam', async () => {
    for (let i = 0; i < 5; i++) await conta(`g${i}`, { porte: 'grande', elegiveis: 200 })
    for (let i = 0; i < 5; i++) await conta(`p${i}`, { porte: 'pequeno', elegiveis: 200 })
    await calcularBenchmark(pool, COMP)
    const { rows } = await pool.query<{ porte: string; n_empresas: number }>(
      `SELECT porte, n_empresas FROM public_v.benchmark_monthly
        WHERE metrica='adesao_30d' ORDER BY porte`,
    )
    assert.equal(rows.length, 2)
    assert.ok(rows.every((x) => x.n_empresas === 5))
  })

  test('o comparativo da conta diz a POSIÇÃO, não uma nota', async () => {
    // "Acima da mediana de empresas do seu porte" é frase que um gestor usa numa
    // reunião; "nota 7,4" é número que ele não sabe defender.
    for (let i = 0; i < 5; i++) await conta(`c${i}`, { elegiveis: 200, ativas: 40 + i * 20 })
    const alvo = await conta('alvo', { elegiveis: 200, ativas: 180 })
    await calcularBenchmark(pool, COMP)
    const comp = await comparativoDaConta(pool, alvo, COMP)
    const adesao = comp.find((c) => c.metrica === 'adesao_30d')!
    assert.equal(adesao.suprimido, false)
    assert.equal(adesao.posicao, 'acima_p75')
  })

  test('comparativo suprimido não devolve percentil algum', async () => {
    await conta('sozinha', { elegiveis: 200 })
    await calcularBenchmark(pool, COMP)
    const conta1 = await pool.query<{ id: string }>('SELECT id FROM core.account LIMIT 1')
    const comp = await comparativoDaConta(pool, conta1.rows[0]!.id, COMP)
    assert.ok(comp.length > 0, 'a linha existe')
    assert.ok(comp.every((c) => c.suprimido && c.p50 === null && c.posicao === null))
    assert.match(String(comp[0]?.motivoSupressao), /empresas/)
  })

  // ── Montagem do relatório ─────────────────────────────────────────────────

  test('o relatório tem os quatro blocos', async () => {
    const c = await conta('acme', { elegiveis: 800, ativas: 288, contratadas: 1000 })
    const conteudo = await montarConteudo(pool, c, COMP)
    assert.equal(conteudo.numeros.length, 3)
    assert.ok(conteudo.evolucao.length >= 2, 'a série mensal')
    assert.ok(Array.isArray(conteudo.comparativo))
    assert.ok(conteudo.acoes.length >= 1, 'cobertura de 80% pede ação do cliente')
  })

  test('no máximo três ações — lista de oito não é pedido', async () => {
    const c = await conta('ruim', { elegiveis: 100, ativas: 5, contratadas: 1000 })
    const conteudo = await montarConteudo(pool, c, COMP)
    assert.ok(conteudo.acoes.length <= MAXIMO_ACOES)
  })

  test('toda ação do cliente carrega o número que a sustenta', async () => {
    // Sem número é opinião, e opinião não move um gestor.
    const c = await conta('acme', { elegiveis: 400, ativas: 40, contratadas: 1000 })
    const conteudo = await montarConteudo(pool, c, COMP)
    for (const a of conteudo.acoes) assert.match(a.numero, /\d/)
  })

  test('sem snapshot da competência, não há relatório', async () => {
    const c = await conta('acme')
    await pool.query('DELETE FROM metrics.daily_snapshot WHERE competencia = $1::date', [COMP])
    await assert.rejects(() => montarConteudo(pool, c, COMP), RelatorioInvalidoError)
  })

  // ── O congelamento ────────────────────────────────────────────────────────

  test('revisar CONGELA: o número no relatório não muda quando a métrica muda', async () => {
    // É a decisão que sustenta a ferramenta. O cliente tem uma cópia.
    const c = await conta('acme', { elegiveis: 800, ativas: 288 })
    const rascunho = await criarRascunho(pool, ANA, c, COMP)
    const antes = (rascunho.conteudo as ConteudoRelatorio).numeros.find(
      (n) => n.metrica === 'vidas_ativas_30d',
    )!.valor
    assert.equal(antes, 288)

    await revisar(pool, ANA, rascunho.id, 'Frase revisada pelo CSM com contexto suficiente do mês.')

    // A métrica é recalculada por um ciclo que rodou depois.
    await pool.query(
      'UPDATE metrics.daily_snapshot SET vidas_ativas_30d = 150 WHERE competencia = $1::date',
      [COMP],
    )

    const depois = await lerRelatorio(pool, ANA, c, COMP)
    const congelado = (depois!.conteudo as ConteudoRelatorio).numeros.find(
      (n) => n.metrica === 'vidas_ativas_30d',
    )!.valor
    assert.equal(congelado, 288, 'o relatório mostra o que o cliente recebeu')
  })

  test('recriar o rascunho remonta; recriar depois de revisado NÃO', async () => {
    const c = await conta('acme', { ativas: 288 })
    await criarRascunho(pool, ANA, c, COMP)
    await pool.query(
      'UPDATE metrics.daily_snapshot SET vidas_ativas_30d = 300 WHERE competencia = $1::date',
      [COMP],
    )
    const remontado = await criarRascunho(pool, ANA, c, COMP)
    assert.equal(
      (remontado.conteudo as ConteudoRelatorio).numeros.find((n) => n.metrica === 'vidas_ativas_30d')!
        .valor,
      300,
      'rascunho ainda acompanha a métrica',
    )

    await revisar(pool, ANA, remontado.id, 'Frase revisada pelo CSM com contexto suficiente do mês.')
    await pool.query(
      'UPDATE metrics.daily_snapshot SET vidas_ativas_30d = 111 WHERE competencia = $1::date',
      [COMP],
    )
    const depois = await criarRascunho(pool, ANA, c, COMP)
    assert.equal(
      (depois.conteudo as ConteudoRelatorio).numeros.find((n) => n.metrica === 'vidas_ativas_30d')!
        .valor,
      300,
      'revisado não remonta',
    )
  })

  test('relatório ENVIADO não pode ser alterado — nem pelo banco', async () => {
    const c = await conta('acme')
    const r = await criarRascunho(pool, ANA, c, COMP)
    await revisar(pool, ANA, r.id, 'Frase revisada pelo CSM com contexto suficiente do mês.')
    await enviar(pool, ANA, r.id, 'rh@cliente.com.br')

    await assert.rejects(
      () => pool.query(`UPDATE success.client_report SET frase_final = 'outra' WHERE id = $1`, [r.id]),
      (e: Error) => {
        assert.match(e.message, /já enviado/)
        assert.match(e.message, /relatório novo/, 'o erro diz o caminho, não só que não pode')
        return true
      },
    )
  })

  test('enviado não se descarta', async () => {
    const c = await conta('acme')
    const r = await criarRascunho(pool, ANA, c, COMP)
    await revisar(pool, ANA, r.id, 'Frase revisada pelo CSM com contexto suficiente do mês.')
    await enviar(pool, ANA, r.id, 'rh@cliente.com.br')
    await assert.rejects(() => descartar(pool, ANA, r.id), Error)
  })

  // ── A revisão como porta ──────────────────────────────────────────────────

  test('rascunho NÃO pode ser enviado — a frase seria a da máquina', async () => {
    const c = await conta('acme')
    const r = await criarRascunho(pool, ANA, c, COMP)
    await assert.rejects(
      () => enviar(pool, ANA, r.id, 'rh@cliente.com.br'),
      (e: Error) => {
        assert.match(e.message, /revisado/)
        return true
      },
    )
  })

  test('frase curta é recusada — não descreve um mês', async () => {
    const c = await conta('acme')
    const r = await criarRascunho(pool, ANA, c, COMP)
    await assert.rejects(() => revisar(pool, ANA, r.id, 'ok'), RelatorioInvalidoError)
  })

  test('as duas frases ficam: a da máquina e a da pessoa', async () => {
    // Comparar as duas é o único jeito de descobrir que a geração erra sempre no
    // mesmo ponto.
    const c = await conta('acme')
    const r = await criarRascunho(pool, ANA, c, COMP)
    await revisar(
      pool,
      ANA,
      r.id,
      'A queda veio das férias coletivas de julho, e não de perda de interesse pelo clube.',
    )
    const depois = await lerRelatorio(pool, ANA, c, COMP)
    assert.ok(depois?.fraseGerada && depois.fraseGerada.length > 20)
    assert.match(String(depois?.fraseFinal), /férias coletivas/)
    assert.notEqual(depois?.fraseGerada, depois?.fraseFinal)
  })

  test('destinatário inválido é recusado antes do envio', async () => {
    const c = await conta('acme')
    const r = await criarRascunho(pool, ANA, c, COMP)
    await revisar(pool, ANA, r.id, 'Frase revisada pelo CSM com contexto suficiente do mês.')
    await assert.rejects(() => enviar(pool, ANA, r.id, 'não é e-mail'), RelatorioInvalidoError)
  })

  // ── Recorte ───────────────────────────────────────────────────────────────

  test('o CSM não lê relatório de outra carteira', async () => {
    const c = await conta('acme', { csm: ANA.email })
    await criarRascunho(pool, ANA, c, COMP)
    assert.equal(await lerRelatorio(pool, BRUNO, c, COMP), null)
    assert.deepEqual(await listarRelatorios(pool, BRUNO), [])
  })

  test('sem grupo nenhum, nada é composto', async () => {
    const c = await conta('acme')
    await assert.rejects(() => criarRascunho(pool, SEM_GRUPO, c, COMP), RelatorioInvalidoError)
  })

  test('pendentes vêm primeiro na lista', async () => {
    // Relatório não enviado é trabalho.
    const a = await conta('enviado')
    const b = await conta('pendente')
    const ra = await criarRascunho(pool, ANA, a, COMP)
    await revisar(pool, ANA, ra.id, 'Frase revisada pelo CSM com contexto suficiente do mês.')
    await enviar(pool, ANA, ra.id, 'rh@cliente.com.br')
    await criarRascunho(pool, ANA, b, COMP)

    const lista = await listarRelatorios(pool, ANA)
    assert.equal(lista[0]?.conta, 'pendente')
  })
})
