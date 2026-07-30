/**
 * Sinais, drivers e score de saúde.
 *
 * Doc 01, seção 6.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ O score composto NÃO é publicado ao time antes de calibrado (F6).       │
 * │ Até lá, o CSM vê os drivers e a faixa de risco por regra explícita.     │
 * │                                                                          │
 * │ Motivo: um score é uma soma ponderada, e pesos adivinhados erram a       │
 * │ ordenação de clientes. O CSM percebe em duas semanas, e desconfiança de  │
 * │ número não se desfaz. Já "atraso de 63 dias" é verificável na hora.      │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

export type DriverId =
  | 'S-FIN'
  | 'S-ADO'
  | 'S-TEN'
  | 'S-USO'
  | 'S-CAD'
  | 'S-REL'
  | 'S-SUP'
  | 'S-ENG'
  | 'S-VOZ'

export interface DriverSpec {
  readonly id: DriverId
  readonly nome: string
  /** Peso inicial. A soma dos nove é 100. Recalibrado na F6 contra desfecho real. */
  readonly peso: number
  readonly explicacao: string
}

/**
 * Os nove drivers.
 *
 * Cada um é contínuo de 0 a 100, nunca binário (decisão registrada no Anexo B
 * da v1.0 e mantida): faixa binária transforma variação gradual em degrau, e
 * degrau em score é o que gera alerta que aparece e desaparece sem nada ter
 * mudado de verdade.
 */
export const DRIVERS: readonly DriverSpec[] = [
  {
    id: 'S-FIN',
    nome: 'Adimplência',
    peso: 25,
    explicacao:
      '100 se adimplente; decai linearmente até 0 em 90 dias de atraso. Maior peso porque atraso de pagamento é o sinal mais antecipado de saída que a Alloyal tem.',
  },
  {
    id: 'S-ADO',
    nome: 'Adesão vs. meta do segmento',
    peso: 20,
    explicacao: 'Adesão de 30 dias sobre o piso definido para o segmento do cliente.',
  },
  {
    id: 'S-TEN',
    nome: 'Tendência de adesão',
    peso: 15,
    explicacao:
      'Variação da adesão de 30 dias contra os 30 dias anteriores, normalizada entre −30% e +10%.',
  },
  {
    id: 'S-USO',
    nome: 'Intensidade',
    peso: 10,
    explicacao: 'Percentil do cliente na base em transações por vida ativa.',
  },
  {
    id: 'S-CAD',
    nome: 'Cobertura cadastral',
    peso: 5,
    explicacao: 'Vidas cadastradas sobre contratadas. É a alavanca que depende do cliente.',
  },
  {
    id: 'S-REL',
    nome: 'Recência de relacionamento',
    peso: 10,
    explicacao:
      '100 até 30 dias do último contato; decai a 0 em 120 dias. Considera e-mail, reunião e WhatsApp.',
  },
  {
    id: 'S-SUP',
    nome: 'Suporte',
    peso: 5,
    explicacao: 'Volume anômalo de tickets, SLA estourado e CSAT.',
  },
  {
    id: 'S-ENG',
    nome: 'Engajamento',
    peso: 5,
    explicacao: 'Aderência (DAU sobre MAU) e tendência de MAU.',
  },
  {
    id: 'S-VOZ',
    nome: 'Voz',
    peso: 5,
    explicacao: 'NPS do gestor e do usuário final, medidos separadamente.',
  },
]

export interface DriverValue {
  readonly id: DriverId
  /** 0 a 100. `null` quando a fonte está ausente ou defasada. */
  readonly valor: number | null
}

export type FaixaSaude = 'saudavel' | 'atencao' | 'risco' | 'critico'

export interface ScoreResult {
  /** `null` quando nenhum driver está disponível. */
  readonly valor: number | null
  readonly faixa: FaixaSaude | null
  /** Quantos dos nove drivers entraram na conta. */
  readonly driversUsados: number
  /** `true` quando algum driver ficou de fora — a interface precisa dizer isso. */
  readonly parcial: boolean
  readonly ausentes: readonly DriverId[]
}

/**
 * Calcula o score composto renormalizando os pesos dos drivers disponíveis.
 *
 * Driver indisponível NÃO recebe o último valor conhecido e NÃO entra como zero.
 * Ele sai da conta e o peso é redistribuído proporcionalmente. É o que permite o
 * score existir antes de todas as integrações sem mentir sobre a própria
 * completude — e é o oposto de manter o último valor, que faz um cliente parecer
 * saudável porque a fonte parou de responder (doc 00, 6.1, princípio 3).
 */
export function calcularScore(valores: readonly DriverValue[]): ScoreResult {
  const porId = new Map(valores.map((v) => [v.id, v.valor]))
  const disponiveis = DRIVERS.filter((d) => {
    const v = porId.get(d.id)
    return v !== null && v !== undefined
  })
  const ausentes = DRIVERS.filter((d) => !disponiveis.includes(d)).map((d) => d.id)

  if (disponiveis.length === 0) {
    return { valor: null, faixa: null, driversUsados: 0, parcial: true, ausentes }
  }

  const pesoTotal = disponiveis.reduce((acc, d) => acc + d.peso, 0)
  const soma = disponiveis.reduce((acc, d) => acc + d.peso * (porId.get(d.id) as number), 0)
  const valor = Math.round(soma / pesoTotal)

  return {
    valor,
    faixa: faixaSaude(valor),
    driversUsados: disponiveis.length,
    parcial: ausentes.length > 0,
    ausentes,
  }
}

export function faixaSaude(score: number): FaixaSaude {
  if (score >= 80) return 'saudavel'
  if (score >= 60) return 'atencao'
  if (score >= 40) return 'risco'
  return 'critico'
}

/**
 * Faixa de risco por regra explícita — o que o CSM vê da F1 até a F6.
 *
 * Não é um score: é uma regra que cabe numa frase. Qualquer driver em nível
 * crítico coloca a conta em risco, independentemente da média. É deliberadamente
 * conservador: a média esconde exatamente o caso que interessa, do mesmo modo
 * que a regra do elo mais fraco no PROFI (doc 01, anexo B).
 */
export function faixaPorRegra(valores: readonly DriverValue[]): FaixaSaude {
  const presentes = valores.filter((v) => v.valor !== null) as readonly {
    id: DriverId
    valor: number
  }[]
  if (presentes.length === 0) return 'atencao'
  const pior = Math.min(...presentes.map((v) => v.valor))
  if (pior < 25) return 'critico'
  if (pior < 50) return 'risco'
  if (pior < 70) return 'atencao'
  return 'saudavel'
}

/** Validação estrutural: os pesos precisam somar 100. Verificada em teste. */
export const PESO_TOTAL_ESPERADO = 100
