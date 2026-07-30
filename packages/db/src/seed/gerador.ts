/**
 * Gerador de massa sintética — puro e determinístico.
 *
 * Puro porque assim é testável sem banco. Determinístico porque a mesma semente
 * tem que produzir a mesma base: sem isso, um bug que aparece na massa não pode
 * ser reproduzido, e "funciona na minha máquina" volta a ser uma frase válida.
 *
 * O gerador faz o papel dos ciclos de captação (C1, C2, C6, C8) para dias
 * históricos: ele produz as colunas de ORIGEM do snapshot. Derivar, verificar
 * qualidade e calcular sinais continua sendo trabalho da consolidação — se o
 * seed calculasse isso, estaria testando a si mesmo em vez do produto.
 */

import {
  PERFIS,
  PORTE_LABEL,
  PRECO_POR_VIDA_CENTAVOS,
  SETORES,
  VIDAS_POR_PORTE,
  type Perfil,
  type PerfilId,
} from './perfis.js'

// ── Aleatório determinístico ────────────────────────────────────────────────
// mulberry32: pequeno, sem dependência, e a mesma semente dá a mesma sequência
// em qualquer máquina e qualquer versão do Node.

export function prng(semente: number): () => number {
  let a = semente >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const entre = (r: () => number, min: number, max: number) => min + r() * (max - min)
const inteiroEntre = (r: () => number, min: number, max: number) => Math.round(entre(r, min, max))
const escolher = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T

// ── Formato de saída ────────────────────────────────────────────────────────

export interface DiaSintetico {
  readonly dia: string // YYYY-MM-DD
  readonly transacoes: number
  readonly usuariosDistintos: number
  readonly gmvCentavos: number
  readonly cashbackGeradoCentavos: number
  readonly cashbackResgatadoCentavos: number
  /** Estado capturado por C2 naquele dia. */
  readonly vidasElegiveis: number
  readonly vidasAtivadasAcum: number
  readonly vidasAtivas30d: number
  /** Estado capturado por C6. `null` quando a fonte não cobre a conta. */
  readonly mau: number | null
  readonly dau: number | null
  /** Estado capturado por C8. */
  readonly diasAtrasoMax: number
  readonly valorAbertoCentavos: number
}

export interface EventoMrrSintetico {
  readonly competencia: string
  readonly valorCentavos: number
  readonly tipo: 'novo' | 'expansao' | 'contracao'
  readonly motivo: string
}

export interface AtividadeSintetica {
  readonly tipo: 'email' | 'reuniao' | 'whatsapp' | 'ligacao'
  readonly ocorreuEm: string
  readonly ator: string
  readonly resumo: string
}

export interface ContaSintetica {
  readonly perfil: PerfilId
  readonly razaoSocial: string
  readonly cnpj: string
  readonly porte: string
  readonly setor: string
  readonly brandId: string
  readonly branchId: string
  readonly csmEmail: string
  readonly contrato: {
    readonly numero: string
    readonly mrrCentavos: number
    readonly inicio: string
    readonly vigenciaFim: string
    readonly vidasContratadas: number
    readonly avisoPrevioDias: number
    readonly renovacao: 'automatica' | 'expressa'
    readonly reajusteIndice: string
    readonly reajusteMes: number
  }
  readonly contato: { readonly nome: string; readonly email: string; readonly cargo: string }
  readonly dias: readonly DiaSintetico[]
  readonly eventosMrr: readonly EventoMrrSintetico[]
  readonly atividades: readonly AtividadeSintetica[]
  readonly cancelamento?: {
    readonly dataLevantada: string
    readonly avisoPrevioDias: number
    readonly dataFimAviso: string
    readonly mrrCentavosNaLevantada: number
    readonly canal: 'email' | 'reuniao' | 'whatsapp' | 'formulario' | 'telefone'
    readonly quemComunicou: string
    readonly motivo: string
  }
}

// ── Vocabulário ─────────────────────────────────────────────────────────────

const PREFIXOS = [
  'Metalúrgica', 'Rede', 'Grupo', 'Construtora', 'Têxtil', 'Alimentos',
  'Transportes', 'Laboratório', 'Distribuidora', 'Indústria', 'Colégio', 'Agro',
] as const
const NOMES = [
  'Meridiano', 'Vega', 'Aurora', 'Bonavita', 'Praia Norte', 'Sul', 'Ipê',
  'Andorinha', 'Vale Verde', 'Horizonte', 'Serra Azul', 'Pampulha', 'Guaraci',
  'Sabiá', 'Ouro Preto', 'Canoas', 'Itamaraty', 'Boa Vista',
] as const
const PESSOAS = [
  'Ana Prado', 'Bruno Teixeira', 'Carla Menezes', 'Diego Fontes', 'Elisa Ramos',
  'Felipe Aguiar', 'Gabriela Nunes', 'Henrique Sales',
] as const
const CSMS = ['ana.prado', 'bruno.teixeira', 'carla.menezes', 'diego.fontes'] as const

const iso = (d: Date) => d.toISOString().slice(0, 10)
const somarDias = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000)
const primeiroDoMes = (d: Date) => iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)))

function cnpj(r: () => number): string {
  const n = (k: number) => String(inteiroEntre(r, 0, 10 ** k - 1)).padStart(k, '0')
  return `${n(2)}.${n(3)}.${n(3)}/0001-${n(2)}`
}

// ── Geração de uma conta ────────────────────────────────────────────────────

/**
 * Perturba o perfil para esta conta específica.
 *
 * Sem isto, todas as contas de um mesmo perfil saem com exatamente a mesma
 * adesão e a mesma cobertura — o que não se parece com nenhuma base real e,
 * pior, degenera qualquer driver calculado por percentil: se metade da base tem
 * o mesmo valor, o percentil deixa de ordenar.
 *
 * A variação preserva o CARÁTER do perfil (inadimplente continua inadimplente)
 * e move só a intensidade.
 */
function variar(p: Perfil, r: () => number): Perfil {
  const jitter = (v: number, frac: number) => v * entre(r, 1 - frac, 1 + frac)
  return {
    ...p,
    adesaoBase: Math.min(0.92, Math.max(0.01, jitter(p.adesaoBase, 0.28))),
    quebra30d: jitter(p.quebra30d, 0.3),
    cobertura: Math.min(1, Math.max(0.35, p.cobertura + entre(r, -0.07, 0.07))),
    diasAtraso: variarDentroDaFaixa(p.diasAtraso, r),
    diasSemContato: Math.max(1, Math.round(jitter(p.diasSemContato, 0.5))),
    mesesDeCasa: Math.max(1, Math.round(jitter(p.mesesDeCasa, 0.35))),
  }
}

/**
 * Varia o atraso SEM sair da faixa.
 *
 * As faixas da matriz de churn silencioso — adimplente, 1–30, 31–60, 61–90,
 * acima de 90 — são o que dá sentido ao perfil. Uma variação livre moveria uma
 * conta declarada como PDD para 73 dias, e a massa deixaria de exercitar o caso
 * que ela existe para exercitar. O número varia; a faixa não.
 */
function variarDentroDaFaixa(dias: number, r: () => number): number {
  if (dias === 0) return 0
  const faixas: readonly (readonly [number, number])[] = [
    [1, 30],
    [31, 60],
    [61, 90],
    [91, 150],
  ]
  const faixa = faixas.find(([lo, hi]) => dias >= lo && dias <= hi) ?? [91, 150]
  return inteiroEntre(r, faixa[0], faixa[1])
}

function gerarConta(
  perfilBase: Perfil,
  indice: number,
  r: () => number,
  hoje: Date,
  dias: number,
): ContaSintetica {
  const perfil = variar(perfilBase, r)
  const razaoSocial = `${escolher(r, PREFIXOS)} ${escolher(r, NOMES)}`
  const vidasContratadas = inteiroEntre(r, ...VIDAS_POR_PORTE[perfil.porte])
  const vidasElegiveis = Math.max(1, Math.round(vidasContratadas * perfil.cobertura))
  const precoPorVida = inteiroEntre(r, ...PRECO_POR_VIDA_CENTAVOS[perfil.porte])
  const mrrCentavos = vidasContratadas * precoPorVida

  const inicio = somarDias(hoje, -perfil.mesesDeCasa * 30)
  const vigenciaFim = somarDias(inicio, 365 * Math.max(1, Math.ceil(perfil.mesesDeCasa / 12) + 1))

  // Histórico limitado pelo tempo de casa: conta nova não tem 180 dias de série.
  const diasReais = Math.min(dias, perfil.mesesDeCasa * 30)

  const diasSintéticos: DiaSintetico[] = []
  let ativadasAcum = Math.round(vidasElegiveis * Math.min(0.95, perfil.adesaoBase * 1.6))

  for (let i = diasReais - 1; i >= 0; i--) {
    const data = somarDias(hoje, -i)
    const diaSemana = data.getUTCDay()

    // A quebra é um DEGRAU nos últimos 30 dias, não uma deriva suave: é assim
    // que uma queda real se parece, e é o que o gatilho precisa detectar.
    const dentroDaQuebra = i < 30
    const adesao = Math.max(
      0.005,
      perfil.adesaoBase * (1 + (dentroDaQuebra ? perfil.quebra30d : 0)) * entre(r, 0.94, 1.06),
    )

    // Fim de semana move menos: clube de benefício é usado sobretudo em dia útil.
    const sazonal = diaSemana === 0 ? 0.35 : diaSemana === 6 ? 0.55 : 1
    const ativas30d = Math.max(0, Math.round(vidasElegiveis * adesao))
    const usuariosDia = Math.max(0, Math.round((ativas30d / 30) * 3.2 * sazonal * entre(r, 0.8, 1.2)))
    const transacoes = Math.round(usuariosDia * entre(r, 1.0, 1.6))
    const ticket = inteiroEntre(r, 2_800, 11_500)
    const gmv = transacoes * ticket
    const cashbackGerado = Math.round(gmv * entre(r, 0.05, 0.085))

    if (usuariosDia > 0 && ativadasAcum < vidasElegiveis) {
      ativadasAcum = Math.min(vidasElegiveis, ativadasAcum + (r() < 0.35 ? 1 : 0))
    }

    diasSintéticos.push({
      dia: iso(data),
      transacoes,
      usuariosDistintos: usuariosDia,
      gmvCentavos: gmv,
      cashbackGeradoCentavos: cashbackGerado,
      cashbackResgatadoCentavos: Math.round(cashbackGerado * entre(r, 0.4, 0.8)),
      vidasElegiveis,
      vidasAtivadasAcum: ativadasAcum,
      vidasAtivas30d: ativas30d,
      // Fonte ausente é null, e nunca zero: zero significaria "ninguém usou",
      // que é uma afirmação — e a fonte não afirmou nada.
      mau: perfil.temEngajamento ? Math.round(ativas30d * entre(r, 0.85, 1.05)) : null,
      dau: perfil.temEngajamento ? Math.round(usuariosDia * entre(r, 0.9, 1.3)) : null,
      // O atraso cresce dia a dia até o valor do perfil: cobrança não aparece
      // pronta, ela envelhece.
      diasAtrasoMax: perfil.diasAtraso === 0 ? 0 : Math.max(0, perfil.diasAtraso - i),
      valorAbertoCentavos:
        perfil.diasAtraso === 0 ? 0 : mrrCentavos * Math.ceil(Math.max(0, perfil.diasAtraso - i) / 30),
    })
  }

  // ── Eventos de MRR ──
  const eventos: EventoMrrSintetico[] = [
    {
      competencia: primeiroDoMes(inicio),
      valorCentavos: mrrCentavos,
      tipo: 'novo',
      motivo: 'contrato inicial',
    },
  ]
  if (perfil.mesesDeCasa > 12 && r() < 0.45) {
    eventos.push({
      competencia: primeiroDoMes(somarDias(hoje, -inteiroEntre(r, 60, 300))),
      valorCentavos: Math.round(mrrCentavos * entre(r, 0.08, 0.22)),
      tipo: 'expansao',
      motivo: 'aumento de vidas',
    })
  }

  // ── Atividade de relacionamento ──
  const atividades: AtividadeSintetica[] = []
  const csm = escolher(r, CSMS)
  for (let k = 0; k < inteiroEntre(r, 3, 9); k++) {
    const quando = somarDias(hoje, -(perfil.diasSemContato + k * inteiroEntre(r, 8, 30)))
    atividades.push({
      tipo: escolher(r, ['email', 'reuniao', 'whatsapp', 'ligacao'] as const),
      ocorreuEm: quando.toISOString(),
      ator: `${csm}@alloyal.com.br`,
      resumo: escolher(r, [
        'acompanhamento mensal',
        'revisão de resultado',
        'cobrança de base elegível',
        'alinhamento de comunicação',
      ]),
    })
  }

  const conta: ContaSintetica = {
    perfil: perfilBase.id,
    razaoSocial,
    cnpj: cnpj(r),
    porte: PORTE_LABEL[perfil.porte],
    setor: escolher(r, SETORES),
    brandId: `brand-${String(indice).padStart(4, '0')}`,
    branchId: `branch-${String(indice).padStart(4, '0')}-01`,
    csmEmail: `${csm}@alloyal.com.br`,
    contrato: {
      numero: `${inicio.getUTCFullYear()}-${String(indice).padStart(4, '0')}`,
      mrrCentavos,
      inicio: iso(inicio),
      vigenciaFim: iso(vigenciaFim),
      vidasContratadas,
      avisoPrevioDias: escolher(r, [30, 60, 90]),
      renovacao: r() < 0.7 ? 'automatica' : 'expressa',
      reajusteIndice: escolher(r, ['IPCA', 'IGPM']),
      reajusteMes: inteiroEntre(r, 1, 12),
    },
    contato: {
      nome: escolher(r, PESSOAS),
      email: `rh@${razaoSocial.toLowerCase().replace(/[^a-z]/g, '')}.com.br`,
      cargo: escolher(r, ['Gerente de RH', 'Coordenadora de Benefícios', 'Diretor de Pessoas']),
    },
    dias: diasSintéticos,
    eventosMrr: eventos,
    atividades,
    ...(perfil.emAviso
      ? {
          cancelamento: {
            dataLevantada: iso(somarDias(hoje, -perfil.emAviso.diasAtras)),
            avisoPrevioDias: perfil.emAviso.avisoPrevioDias,
            dataFimAviso: iso(
              somarDias(hoje, -perfil.emAviso.diasAtras + perfil.emAviso.avisoPrevioDias),
            ),
            mrrCentavosNaLevantada: mrrCentavos,
            canal: 'reuniao' as const,
            quemComunicou: 'Diretoria de RH',
            motivo: 'custo',
          },
        }
      : {}),
  }
  return conta
}

// ── Geração da massa ────────────────────────────────────────────────────────

export interface OpcoesMassa {
  readonly semente?: number
  /** Total de contas. Cada perfil aparece pelo menos uma vez. */
  readonly contas?: number
  readonly dias?: number
  readonly hoje?: Date
}

export function gerarMassa(opts: OpcoesMassa = {}): readonly ContaSintetica[] {
  const semente = opts.semente ?? 42
  const total = Math.max(PERFIS.length, opts.contas ?? 40)
  const dias = opts.dias ?? 180
  const hoje = opts.hoje ?? new Date('2026-07-30T00:00:00Z')
  const r = prng(semente)

  const contas: ContaSintetica[] = []
  for (let i = 0; i < total; i++) {
    // Os primeiros N garantem que TODO perfil aparece; o resto é distribuído.
    // Sem essa garantia, um sorteio azarado deixaria um caso de borda de fora
    // justamente da massa que existe para exercitá-lo.
    const perfil = i < PERFIS.length ? PERFIS[i] : escolher(r, PERFIS)
    contas.push(gerarConta(perfil as Perfil, i + 1, r, hoje, dias))
  }
  return contas
}
