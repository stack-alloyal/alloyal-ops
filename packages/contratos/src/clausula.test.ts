/**
 * O motor de cláusulas.
 *
 * Duas coisas dominam este arquivo, e são as duas que causam dano real:
 *
 *   SIGILO — desconto negociado exposto a toda a empresa vira problema na
 *   primeira renegociação em que um cliente descobre a condição de outro. As
 *   asserções são sobre o que NÃO aparece, e sobre o valor ser APAGADO do objeto
 *   e não escondido na tela.
 *
 *   VIGÊNCIA — "o que vale hoje" é consulta, não campo. O exemplo do PRD vira
 *   teste literal: contrato original diz uma coisa, aditivo diz outra, e as duas
 *   respostas continuam disponíveis.
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'

import { permissoesDe, type Identidade, type Papel } from '@pulse/auth'
import pg from 'pg'

import {
  buscarPorTipo,
  ClausulaInvalidaError,
  confirmar,
  filaDeConfirmacao,
  historicoDoTipo,
  podeConfirmar,
  progresso,
  propor,
  SemPermissaoContratos,
  substituir,
  valeHoje,
} from './clausula.js'
import { CLAUSULAS, PAPEIS_POR_FAIXA, podeLerValor, textoRestrito, tiposLegiveis } from './taxonomia.js'

const ADMIN = process.env['DATABASE_URL_ADMIN']
const HOJE = '2026-07-31'

const quem = (email: string, ...papeis: Papel[]): Identidade => ({
  email,
  papeis,
  permissoes: permissoesDe(papeis),
})

const JURIDICO = quem('ju@alloyal.com.br', 'pulse-juridico')
const MARKETING = quem('mkt@alloyal.com.br', 'pulse-marketing')
const CSM = quem('csm@alloyal.com.br', 'pulse-csm')
const COMERCIAL = quem('com@alloyal.com.br', 'pulse-comercial')
const DIRETORIA = quem('dir@alloyal.com.br', 'pulse-diretoria')

// ── A taxonomia e o sigilo, sem banco ──────────────────────────────────────

test('a taxonomia é fechada e cada tipo declara pergunta e faixa', () => {
  // A taxonomia É o produto: cada tipo existe porque alguém pergunta sobre ele.
  for (const c of CLAUSULAS) {
    assert.ok(c.pergunta.endsWith('?') || c.tipo === 'outra', `${c.tipo} sem pergunta`)
    assert.ok(c.rotulo.length >= 3, `${c.tipo} sem rótulo`)
    assert.ok(['aberta', 'reservada', 'restrita'].includes(c.faixa))
  }
})

test('Marketing lê uso de marca e NÃO lê desconto nem litígio', () => {
  // É o caso que justifica o projeto: Marketing responde sozinho se pode usar a
  // marca. E é o caso que justifica o sigilo: não pode ver o desconto.
  assert.equal(podeLerValor('uso_marca', MARKETING.papeis), true)
  assert.equal(podeLerValor('comunicacao_usuario', MARKETING.papeis), true)
  assert.equal(podeLerValor('excecao_comercial', MARKETING.papeis), false)
  assert.equal(podeLerValor('multa', MARKETING.papeis), false)
  assert.equal(podeLerValor('conflito', MARKETING.papeis), false)
})

test('CSM comum não lê a faixa reservada', () => {
  // Condição comercial de uma conta vista por quem atende outra é o caminho mais
  // curto para um cliente descobrir o desconto do vizinho.
  assert.equal(podeLerValor('escopo_produto', CSM.papeis), true)
  assert.equal(podeLerValor('excecao_comercial', CSM.papeis), false)
  assert.equal(podeLerValor('excecao_comercial', quem('l@a.br', 'pulse-cs-lead').papeis), true)
})

test('admin da plataforma não lê litígio', () => {
  // Administrar a plataforma não é o mesmo que ter alçada sobre conflito jurídico.
  assert.equal(PAPEIS_POR_FAIXA.restrita.includes('pulse-admin'), false)
  assert.equal(podeLerValor('conflito', ['pulse-admin']), false)
})

test('tipo fora da taxonomia falha FECHADO', () => {
  // Um tipo novo gravado no banco sem declarar aqui fica ilegível até ser
  // declarado. O inverso — visível para todos por omissão — é a falha que
  // ninguém percebe.
  assert.equal(podeLerValor('tipo_que_alguem_inventou', DIRETORIA.papeis), false)
})

test('"outra" só é legível por quem está na audiência escolhida', () => {
  assert.equal(podeLerValor('outra', DIRETORIA.papeis), false, 'sem audiência, ninguém lê')
  assert.equal(podeLerValor('outra', MARKETING.papeis, ['pulse-marketing']), true)
  assert.equal(podeLerValor('outra', DIRETORIA.papeis, ['pulse-marketing']), false)
})

test('o aviso de restrição diz quem lê, e não só que é restrito', () => {
  // "Acesso negado" devolve a pessoa ao ponto de partida. Dizer a quem pedir é o
  // que faz ela resolver sozinha.
  const aviso = textoRestrito('multa')
  assert.match(aviso, /juridico/)
  assert.match(aviso, /Solicite ao Jurídico/)
})

test('o aviso nomeia a faixa CORRETA, não sempre "restrita"', () => {
  // `reservada` e `restrita` são conceitos distintos aqui. Chamar as duas de
  // restrita ensinaria o vocabulário errado a quem lê a tela todo dia — e faria
  // desconto comercial parecer tão fechado quanto histórico de litígio.
  assert.match(textoRestrito('excecao_comercial'), /^reservada/)
  assert.match(textoRestrito('multa'), /^restrita/)
  // Comercial está na faixa reservada e não na restrita: a frase tem que refletir.
  assert.match(textoRestrito('excecao_comercial'), /comercial/)
  assert.equal(/comercial/.test(textoRestrito('multa')), false)
})

test('os tipos legíveis por Marketing não incluem faixa reservada', () => {
  const t = tiposLegiveis(MARKETING.papeis)
  assert.ok(t.includes('uso_marca'))
  assert.equal(t.includes('faturamento'), false)
  assert.equal(t.includes('multa'), false)
})

test('só o Jurídico confirma', () => {
  assert.equal(podeConfirmar(JURIDICO), true)
  assert.equal(podeConfirmar(quem('a@a.br', 'pulse-admin')), true, 'admin configura')
  assert.equal(podeConfirmar(COMERCIAL), false)
  assert.equal(podeConfirmar(DIRETORIA), false)
})

// ── Contra banco ────────────────────────────────────────────────────────────

describe('cláusulas', { skip: !ADMIN }, () => {
  let pool: pg.Pool
  let acme: string
  let contrato: string
  let aditivo: string

  before(async () => {
    const { migrate } = await import('@pulse/db')
    await migrate(ADMIN as string)
    pool = new pg.Pool({ connectionString: ADMIN })
  })

  after(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE contracts.clause, contracts.obligation, contracts.event,
                contracts.approval, contracts.document, core.contract,
                core.account CASCADE`,
    )
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO core.account (razao_social, porte, setor, brand_id, csm_email)
       VALUES ('Grupo Meridiano','grande','industria','b-mer','csm@alloyal.com.br')
       RETURNING id`,
    )
    acme = String(rows[0]!.id)
    await pool.query(
      `INSERT INTO core.contract
         (account_id, mrr_centavos, inicio, vigencia_fim, vidas_contratadas, status_vigencia)
       VALUES ($1, 7_000_000, '2024-03-01', '2027-12-01', 2000, 'vigente')`,
      [acme],
    )
    const docs = await pool.query<{ id: string; tipo: string }>(
      `INSERT INTO contracts.document (account_id, tipo, versao, titulo, status_assinatura, assinado_em)
       VALUES ($1,'contrato',1,'Contrato original','assinado','2024-03-03'),
              ($1,'aditivo',1,'Aditivo 1','assinado','2025-08-15')
       RETURNING id, tipo`,
      [acme],
    )
    contrato = docs.rows.find((d) => d.tipo === 'contrato')!.id
    aditivo = docs.rows.find((d) => d.tipo === 'aditivo')!.id
  })

  /** Propõe e confirma numa tacada, para os testes de leitura. */
  async function vigente(
    tipo: Parameters<typeof propor>[2]['tipo'],
    valor: Record<string, unknown>,
    validoDe = '2024-03-01',
  ): Promise<string> {
    const id = await propor(pool, JURIDICO, {
      accountId: acme,
      tipo,
      valorEstruturado: valor,
      validoDe,
    })
    await confirmar(pool, JURIDICO, id, { documentoId: contrato, trecho: 'cláusula 7.1' })
    return id
  }

  // ── O exemplo do PRD, literal ───────────────────────────────────────────

  test('aditivo fecha a cláusula antiga e abre a nova — as duas ficam', async () => {
    // CONTRATO 03/2024: uso_marca = com_aprovacao
    // ADITIVO  08/2025: uso_marca = vedado
    // O QUE VALE HOJE: vedado, com procedência no aditivo.
    const original = await vigente('uso_marca', { valor: 'com_aprovacao' })
    await substituir(pool, JURIDICO, original, {
      valorEstruturado: { valor: 'vedado' },
      validoDe: '2025-08-15',
      documentoId: aditivo,
      trecho: 'cláusula 4.2',
    })

    const hoje = await valeHoje(pool, JURIDICO, acme, { hoje: HOJE })
    const marca = hoje.filter((c) => c.tipo === 'uso_marca')
    assert.equal(marca.length, 1, 'uma resposta só para "o que vale hoje"')
    assert.equal(marca[0]?.valorEstruturado?.['valor'], 'vedado')
    assert.equal(marca[0]?.documentoTitulo, 'Aditivo 1')
    assert.equal(marca[0]?.trecho, 'cláusula 4.2')

    // E a história continua disponível: quem pergunta "por que mudou?" recebe o
    // aditivo e a data.
    const hist = await historicoDoTipo(pool, JURIDICO, acme, 'uso_marca')
    assert.equal(hist.length, 2)
    assert.equal(hist[1]?.estado, 'substituida')
    assert.equal(hist[1]?.validoAte, '2025-08-15')
    assert.equal(hist[0]?.substituiClauseId, original)
  })

  test('cláusula não substituída continua valendo do contrato original', async () => {
    // No exemplo do PRD, comunicacao_usuario nunca foi alterada: vale do original.
    await vigente('comunicacao_usuario', { valor: 'livre' })
    const original = await vigente('aviso_previo', { dias: 30 })
    await substituir(pool, JURIDICO, original, {
      valorEstruturado: { dias: 90 },
      validoDe: '2025-08-15',
      documentoId: aditivo,
      trecho: 'cláusula 9.3',
    })

    const hoje = await valeHoje(pool, JURIDICO, acme, { hoje: HOJE })
    const porTipo = new Map(hoje.map((c) => [c.tipo, c]))
    assert.equal(porTipo.get('comunicacao_usuario')?.documentoTitulo, 'Contrato original')
    assert.equal(porTipo.get('aviso_previo')?.valorEstruturado?.['dias'], 90)
    assert.equal(porTipo.get('aviso_previo')?.documentoTitulo, 'Aditivo 1')
  })

  test('a nova cláusula não pode começar antes da que ela substitui', async () => {
    const original = await vigente('uso_marca', { valor: 'livre' }, '2025-01-01')
    await assert.rejects(
      () =>
        substituir(pool, JURIDICO, original, {
          valorEstruturado: { valor: 'vedado' },
          validoDe: '2024-06-01',
          documentoId: aditivo,
          trecho: '4.2',
        }),
      ClausulaInvalidaError,
    )
  })

  test('substituir sem documento é recusado — aditivo sem PDF não substitui nada', async () => {
    const original = await vigente('uso_marca', { valor: 'livre' })
    await assert.rejects(
      () =>
        substituir(pool, JURIDICO, original, {
          valorEstruturado: { valor: 'vedado' },
          validoDe: '2025-08-15',
          documentoId: '',
          trecho: '',
        }),
      ClausulaInvalidaError,
    )
  })

  // ── Invariante 1: procedência ────────────────────────────────────────────

  test('confirmar exige documento e trecho', async () => {
    // Afirmar sem dizer onde está escrito é o que a ferramenta existe para acabar.
    const id = await propor(pool, JURIDICO, {
      accountId: acme,
      tipo: 'uso_marca',
      valorEstruturado: { valor: 'livre' },
      validoDe: '2024-03-01',
    })
    await assert.rejects(
      () => confirmar(pool, JURIDICO, id, { documentoId: contrato, trecho: '   ' }),
      ClausulaInvalidaError,
    )
  })

  test('o banco também recusa confirmada sem procedência', async () => {
    // A invariante é do banco, não só do módulo: um caminho de código novo que
    // esqueça a checagem ainda encontra a recusa.
    await assert.rejects(() =>
      pool.query(
        `INSERT INTO contracts.clause
           (account_id, tipo, valor_estruturado, valido_de, estado, confirmada_por, confirmada_em)
         VALUES ($1,'uso_marca','{}'::jsonb,'2024-03-01','confirmada','x@a.br',now())`,
        [acme],
      ),
    )
  })

  // ── Invariante 2: proposta não decide ────────────────────────────────────

  test('cláusula proposta aparece, marcada, mas não é confirmada', async () => {
    // Esconder faria a pessoa concluir que o contrato é silencioso sobre aquilo,
    // o que é pior que saber que existe uma proposta não conferida.
    await propor(pool, JURIDICO, {
      accountId: acme,
      tipo: 'uso_marca',
      valorEstruturado: { valor: 'vedado' },
      validoDe: '2024-03-01',
    })
    const [c] = await valeHoje(pool, JURIDICO, acme, { hoje: HOJE })
    assert.equal(c?.estado, 'proposta')
    assert.equal(c?.confirmadaPor, null)
  })

  test('confirmar duas vezes é recusado', async () => {
    const id = await vigente('uso_marca', { valor: 'livre' })
    await assert.rejects(
      () => confirmar(pool, JURIDICO, id, { documentoId: contrato, trecho: '7.1' }),
      ClausulaInvalidaError,
    )
  })

  test('quem não é do Jurídico não confirma', async () => {
    const id = await propor(pool, JURIDICO, {
      accountId: acme,
      tipo: 'uso_marca',
      valorEstruturado: { valor: 'livre' },
      validoDe: '2024-03-01',
    })
    await assert.rejects(
      () => confirmar(pool, COMERCIAL, id, { documentoId: contrato, trecho: '7.1' }),
      SemPermissaoContratos,
    )
  })

  // ── Sigilo aplicado na leitura ──────────────────────────────────────────

  test('o valor restrito é APAGADO do objeto, não escondido na tela', async () => {
    // Se ficasse no objeto, exportação de lista, resposta de API e relatório
    // vazariam — cada saída refazendo a regra é como uma delas erra.
    await vigente('multa', { base: '3 mensalidades', percentual: 0.3 })

    const [paraJuridico] = await valeHoje(pool, JURIDICO, acme, { hoje: HOJE })
    assert.equal(paraJuridico?.valorEstruturado?.['base'], '3 mensalidades')
    assert.equal(paraJuridico?.restrito, false)

    const [paraMarketing] = await valeHoje(pool, MARKETING, acme, { hoje: HOJE })
    assert.equal(paraMarketing?.tipo, 'multa', 'o tipo continua visível')
    assert.equal(paraMarketing?.valorEstruturado, null, 'o valor foi apagado')
    assert.equal(paraMarketing?.texto, null)
    assert.equal(paraMarketing?.trecho, null, 'o trecho do PDF também vaza o valor')
    assert.equal(paraMarketing?.restrito, true)
    assert.match(String(paraMarketing?.avisoRestricao), /Solicite ao Jurídico/)
  })

  test('a cláusula restrita NÃO desaparece da lista', async () => {
    // Esconder a existência faria a pessoa concluir que não há multa, e negociar
    // como se não houvesse.
    await vigente('uso_marca', { valor: 'livre' })
    await vigente('multa', { base: '3 mensalidades' })
    const paraMarketing = await valeHoje(pool, MARKETING, acme, { hoje: HOJE })
    assert.equal(paraMarketing.length, 2, 'as duas aparecem')
    // Por tipo, e não por posição: a consulta ordena por `tipo`, e afirmar a
    // ordem aqui amarraria o teste a um detalhe que a tela não usa.
    const porTipo = new Map(paraMarketing.map((c) => [c.tipo, c.restrito]))
    assert.equal(porTipo.get('uso_marca'), false, 'faixa aberta: legível')
    assert.equal(porTipo.get('multa'), true, 'faixa restrita: presente e oculta')
  })

  // ── A busca que decide o projeto ────────────────────────────────────────

  test('Marketing busca quais contratos vedam comunicação com usuário', async () => {
    // É a consulta que faz o projeto valer: Marketing responde sozinho.
    await vigente('comunicacao_usuario', { valor: 'vedada' })
    const r = await buscarPorTipo(pool, MARKETING, 'comunicacao_usuario', { hoje: HOJE })
    assert.equal(r.recusado, false)
    assert.equal(r.clausulas.length, 1)
    assert.equal(r.clausulas[0]?.conta, 'Grupo Meridiano')
  })

  test('busca por tipo que a pessoa não pode ler é RECUSA, não lista vazia', async () => {
    // Lista vazia se leria como "nenhum contrato tem multa", e alguém agiria com
    // base nessa conclusão errada.
    await vigente('multa', { base: '3 mensalidades' })
    const r = await buscarPorTipo(pool, MARKETING, 'multa', { hoje: HOJE })
    assert.equal(r.recusado, true)
    assert.deepEqual(r.clausulas, [])
  })

  test('a busca filtra pelo valor, não só pelo tipo', async () => {
    // "Quais reajustam por IGPM em janeiro?" precisa alcançar o conteúdo.
    await vigente('reajuste', { indice: 'IGPM', mes: 1 })
    const igpm = await buscarPorTipo(pool, CSM, 'reajuste', { hoje: HOJE, valor: 'IGPM' })
    assert.equal(igpm.clausulas.length, 1)
    const ipca = await buscarPorTipo(pool, CSM, 'reajuste', { hoje: HOJE, valor: 'IPCA' })
    assert.equal(ipca.clausulas.length, 0)
  })

  test('cláusula substituída não aparece na busca do que vale hoje', async () => {
    const original = await vigente('uso_marca', { valor: 'com_aprovacao' })
    await substituir(pool, JURIDICO, original, {
      valorEstruturado: { valor: 'vedado' },
      validoDe: '2025-08-15',
      documentoId: aditivo,
      trecho: '4.2',
    })
    const r = await buscarPorTipo(pool, MARKETING, 'uso_marca', { hoje: HOJE, valor: 'com_aprovacao' })
    assert.equal(r.clausulas.length, 0, 'o valor antigo não responde mais')
  })

  // ── Validação de valor ──────────────────────────────────────────────────

  test('tipo com enum recusa valor fora da lista', async () => {
    // Texto livre não sustenta "quais contratos vedam comunicação?".
    await assert.rejects(
      () =>
        propor(pool, JURIDICO, {
          accountId: acme,
          tipo: 'uso_marca',
          valorEstruturado: { valor: 'talvez' },
          validoDe: '2024-03-01',
        }),
      (e: Error) => {
        assert.match(e.message, /livre · com_aprovacao · vedado/)
        return true
      },
    )
  })

  test('"outra" sem audiência é recusada', async () => {
    await assert.rejects(
      () =>
        propor(pool, JURIDICO, {
          accountId: acme,
          tipo: 'outra',
          texto: 'condição peculiar',
          validoDe: '2024-03-01',
        }),
      (e: Error) => {
        assert.match(e.message, /audiência declarada/)
        return true
      },
    )
  })

  test('"outra" com audiência é legível só por ela', async () => {
    const id = await propor(pool, JURIDICO, {
      accountId: acme,
      tipo: 'outra',
      texto: 'acordo de co-marketing com a agência do cliente',
      validoDe: '2024-03-01',
      audienciaPapeis: ['pulse-marketing', 'pulse-juridico'],
    })
    await confirmar(pool, JURIDICO, id, { documentoId: contrato, trecho: 'anexo II' })

    const [paraMkt] = await valeHoje(pool, MARKETING, acme, { hoje: HOJE })
    assert.equal(paraMkt?.restrito, false)
    const [paraCsm] = await valeHoje(pool, CSM, acme, { hoje: HOJE })
    assert.equal(paraCsm?.restrito, true)
  })

  // ── Fila de confirmação e progresso ─────────────────────────────────────

  test('a fila de confirmação vem ordenada por MRR', async () => {
    // Com centenas de propostas e tempo limitado do Jurídico, conferir primeiro o
    // contrato de R$ 70 mil é o que faz o esforço valer.
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO core.account (razao_social, porte, setor, brand_id)
       VALUES ('Pequena Ltda','pequeno','servicos','b-peq') RETURNING id`,
    )
    const pequena = String(rows[0]!.id)
    await pool.query(
      `INSERT INTO core.contract (account_id, mrr_centavos, inicio, vidas_contratadas, status_vigencia)
       VALUES ($1, 200_000, '2025-01-01', 100, 'vigente')`,
      [pequena],
    )
    await propor(pool, JURIDICO, {
      accountId: pequena,
      tipo: 'uso_marca',
      valorEstruturado: { valor: 'livre' },
      validoDe: '2025-01-01',
    })
    await propor(pool, JURIDICO, {
      accountId: acme,
      tipo: 'uso_marca',
      valorEstruturado: { valor: 'vedado' },
      validoDe: '2024-03-01',
    })

    const fila = await filaDeConfirmacao(pool, JURIDICO)
    assert.equal(fila.length, 2)
    assert.equal(fila[0]?.conta, 'Grupo Meridiano', 'o de maior MRR primeiro')
  })

  test('quem não confirma não recebe a fila de confirmação', async () => {
    await propor(pool, JURIDICO, {
      accountId: acme,
      tipo: 'uso_marca',
      valorEstruturado: { valor: 'livre' },
      validoDe: '2024-03-01',
    })
    assert.deepEqual(await filaDeConfirmacao(pool, MARKETING), [])
  })

  test('o progresso conta contas sem resposta, não porcentagem', async () => {
    // "Nenhum contrato responde se podemos usar a marca" muda prioridade;
    // "43% capturado" não.
    await vigente('uso_marca', { valor: 'livre' })
    const p = await progresso(pool, ['uso_marca', 'multa'])
    const porTipo = new Map(p.map((x) => [x.tipo, x]))
    assert.equal(porTipo.get('uso_marca')?.confirmadas, 1)
    assert.equal(porTipo.get('uso_marca')?.ausentes, 0)
    assert.equal(porTipo.get('multa')?.confirmadas, 0)
    assert.equal(porTipo.get('multa')?.ausentes, 1, 'a única conta não tem multa registrada')
  })
})
