/**
 * Os catorze gatilhos da fila de trabalho.
 *
 * Puro: recebe o estado consolidado de uma conta e devolve os candidatos a item
 * de trabalho. Quem aplica teto, deduplicação, carência e modo sombra é a
 * camada de fila — aqui só se decide "esta conta merece atenção, e por quê".
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ O MOTIVO É PARTE DO GATILHO, não enfeite da tela.                         │
 * │                                                                            │
 * │ Todo candidato sai com o motivo escrito em linguagem natural e COM O       │
 * │ NÚMERO DENTRO — "adesão caiu 22% (41% → 32%)", nunca "score caiu". O CSM   │
 * │ precisa concordar com o motivo antes de agir; um item que ele não entende  │
 * │ é um item que ele fecha sem fazer nada, e aí a fila vira teatro.           │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

export type Prioridade = 'baixa' | 'media' | 'alta' | 'critica'

export type Familia =
  | 'financeiro'
  | 'adesao'
  | 'onboarding'
  | 'churn_silencioso'
  | 'relacionamento'
  | 'renovacao'
  | 'voz'
  | 'produto'
  | 'expansao'
  | 'carteira'

/** Estado consolidado de uma conta, na competência. */
export interface EstadoConta {
  readonly accountId: string
  readonly competencia: string
  readonly csmEmail: string | null

  readonly adesao30d: number | null
  readonly adesao30dAnterior: number | null
  readonly pisoSegmento: number
  readonly competenciasSobPiso: number

  readonly vidasElegiveis: number | null
  readonly vidasContratadas: number | null
  readonly coberturaCadastral: number | null
  readonly diasDesdeGoLive: number | null

  readonly diasAtrasoMax: number | null
  readonly valorAbertoCentavos: number | null

  readonly diasSemContato: number | null
  readonly diasParaVigenciaFim: number | null

  readonly severidadeChurnSilencioso: string | null
  readonly faixaEngajamento: string | null

  /** Fontes ainda inexistentes: o gatilho é declarado e não avaliado. */
  readonly nps: number | null
  readonly horasIndisponibilidade: number | null
  readonly marcosAtrasados: number | null
  readonly segmentoMudou: boolean | null
  readonly produtosAusentes: readonly string[] | null
}

export interface Candidato {
  readonly gatilho: string
  readonly familia: Familia
  readonly prioridade: Prioridade
  readonly prazoDias: number
  readonly motivo: string
  readonly evidencia: Record<string, unknown>
  /** `null` deixa a fila rotear pelo CSM da conta. */
  readonly donoPapel: 'csm' | 'cs_lead' | 'financeiro' | 'implantacao' | 'comercial' | null
}

export interface Gatilho {
  readonly id: string
  readonly familia: Familia
  readonly cooldownDias: number | null
  /** O que este gatilho existe para pegar. Aparece no painel e na biblioteca. */
  readonly proposito: string
  /** `null` quando o dado necessário ainda não existe: declarado, não avaliado. */
  readonly avaliar: (e: EstadoConta) => Candidato | null
}

// ── Formatação ──────────────────────────────────────────────────────────────

const pct = (v: number) => `${(v * 100).toFixed(0)}%`
const reais = (centavos: number) =>
  (centavos / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    maximumFractionDigits: 0,
  })

// ── Os catorze ──────────────────────────────────────────────────────────────

/**
 * A partir de quantos dias o atraso vira item próprio, da família financeira.
 *
 * Serve a dois donos: é o piso do G-01 e o teto do G-07. Fosse escrito duas
 * vezes, um dia divergiriam e a conta voltaria a receber dois itens pelo mesmo
 * atraso.
 */
export const ATRASO_ITEM_FINANCEIRO = 30

export const GATILHOS: readonly Gatilho[] = [
  {
    id: 'G-01',
    familia: 'financeiro',
    cooldownDias: 30,
    proposito: 'Cobrança relacional enquanto ainda cabe conversa, não cobrança',
    avaliar: (e) => {
      const d = e.diasAtrasoMax
      if (d === null || d < ATRASO_ITEM_FINANCEIRO || d >= 60) return null
      return {
        gatilho: 'G-01',
        familia: 'financeiro',
        prioridade: 'alta',
        prazoDias: 3,
        motivo: `atraso de ${d} dias${e.valorAbertoCentavos ? ` · ${reais(e.valorAbertoCentavos)} em aberto` : ''}`,
        evidencia: { dias_atraso: d, valor_aberto_centavos: e.valorAbertoCentavos },
        donoPapel: 'csm',
      }
    },
  },
  {
    id: 'G-02',
    familia: 'financeiro',
    cooldownDias: 30,
    proposito: 'Escalar antes da provisão, enquanto retenção ainda tem alavanca',
    avaliar: (e) => {
      const d = e.diasAtrasoMax
      if (d === null || d < 60 || d >= 90) return null
      return {
        gatilho: 'G-02',
        familia: 'financeiro',
        prioridade: 'critica',
        prazoDias: 2,
        motivo: `atraso de ${d} dias${e.valorAbertoCentavos ? ` · ${reais(e.valorAbertoCentavos)} em aberto` : ''} · a ${90 - d} dias da provisão`,
        evidencia: { dias_atraso: d, dias_para_pdd: 90 - d },
        donoPapel: 'cs_lead',
      }
    },
  },
  {
    id: 'G-03',
    familia: 'financeiro',
    cooldownDias: null,
    proposito: 'Provisão e encerramento por inadimplência — decisão de crédito',
    avaliar: (e) => {
      const d = e.diasAtrasoMax
      if (d === null || d < 90) return null
      return {
        gatilho: 'G-03',
        familia: 'financeiro',
        prioridade: 'critica',
        prazoDias: 1,
        motivo: `atraso de ${d} dias${e.valorAbertoCentavos ? ` · ${reais(e.valorAbertoCentavos)} em aberto` : ''} · entra em provisão`,
        evidencia: { dias_atraso: d, valor_aberto_centavos: e.valorAbertoCentavos },
        // O gate é do Financeiro, nunca do CS: pedir a quem tem o relacionamento
        // que aprove a rescisão é pedir que o relacionamento decida contra si.
        donoPapel: 'financeiro',
      }
    },
  },
  {
    id: 'G-04',
    familia: 'adesao',
    cooldownDias: 45,
    proposito: 'A queda que ainda dá tempo de reverter',
    avaliar: (e) => {
      if (e.adesao30d === null || e.adesao30dAnterior === null || e.adesao30dAnterior <= 0) {
        return null
      }
      const delta = (e.adesao30d - e.adesao30dAnterior) / e.adesao30dAnterior
      if (delta > -0.2) return null
      return {
        gatilho: 'G-04',
        familia: 'adesao',
        prioridade: 'alta',
        prazoDias: 5,
        motivo: `adesão 30d caiu ${Math.abs(delta * 100).toFixed(0)}% (${pct(e.adesao30dAnterior)} → ${pct(e.adesao30d)})`,
        evidencia: {
          adesao_anterior: e.adesao30dAnterior,
          adesao_atual: e.adesao30d,
          variacao: delta,
        },
        donoPapel: 'csm',
      }
    },
  },
  {
    id: 'G-05',
    familia: 'adesao',
    cooldownDias: 60,
    proposito: 'Clube que nunca decolou — diferente do que caiu',
    avaliar: (e) => {
      if (e.adesao30d === null || e.adesao30d >= e.pisoSegmento) return null
      // Duas competências: uma só pode ser sazonalidade, e item disparado por
      // sazonalidade é a primeira coisa que o time aprende a ignorar.
      if (e.competenciasSobPiso < 2) return null
      return {
        gatilho: 'G-05',
        familia: 'adesao',
        prioridade: 'media',
        prazoDias: 10,
        motivo: `adesão de ${pct(e.adesao30d)} abaixo do piso de ${pct(e.pisoSegmento)} do segmento, há ${e.competenciasSobPiso} competências`,
        evidencia: {
          adesao: e.adesao30d,
          piso: e.pisoSegmento,
          competencias: e.competenciasSobPiso,
        },
        donoPapel: 'csm',
      }
    },
  },
  {
    id: 'G-06',
    familia: 'onboarding',
    cooldownDias: 30,
    proposito: 'A alavanca que só o cliente puxa — e que move mais o TTFT',
    avaliar: (e) => {
      if (e.coberturaCadastral === null || e.coberturaCadastral >= 0.6) return null
      if (e.diasDesdeGoLive === null || e.diasDesdeGoLive < 30) return null
      const faltam =
        e.vidasContratadas !== null && e.vidasElegiveis !== null
          ? e.vidasContratadas - e.vidasElegiveis
          : null
      return {
        gatilho: 'G-06',
        familia: 'onboarding',
        prioridade: 'alta',
        prazoDias: 5,
        motivo:
          `cobertura cadastral de ${pct(e.coberturaCadastral)} · ${e.vidasElegiveis} de ${e.vidasContratadas} vidas cadastradas` +
          `${faltam ? `, faltam ${faltam}` : ''} · ${e.diasDesdeGoLive} dias de go-live`,
        evidencia: {
          cobertura: e.coberturaCadastral,
          vidas_elegiveis: e.vidasElegiveis,
          vidas_contratadas: e.vidasContratadas,
          dias_go_live: e.diasDesdeGoLive,
        },
        donoPapel: 'csm',
      }
    },
  },
  {
    id: 'G-07',
    familia: 'churn_silencioso',
    cooldownDias: 30,
    proposito: 'Cliente que já parou de ser cliente e ainda não avisou',
    avaliar: (e) => {
      const sev = e.severidadeChurnSilencioso
      if (!sev || !['risco', 'risco_alto', 'critico', 'pdd'].includes(sev)) return null
      // Quando há atraso relevante, a família financeira já é dona da conta: o
      // G-01/02/03 carrega a mesma evidência e aponta uma ação mais clara. Sem
      // este corte, um cliente com 132 dias de atraso recebe "entra em provisão"
      // e "churn silencioso · atraso de 132 dias" — dois itens para um fato, e é
      // assim que um time aprende a ignorar a fila.
      //
      // O caso que só este gatilho pega continua inteiro: paga em dia e parou de
      // usar. A combinação dos dois vetores segue registrada em
      // `metrics.silent_churn_flag` para a métrica executiva — é a FILA que
      // precisa de um dono por fato, não a medição.
      if (e.diasAtrasoMax !== null && e.diasAtrasoMax >= ATRASO_ITEM_FINANCEIRO) return null
      const porSeveridade: Record<string, { p: Prioridade; prazo: number; dono: Candidato['donoPapel'] }> = {
        risco: { p: 'alta', prazo: 5, dono: 'csm' },
        risco_alto: { p: 'alta', prazo: 3, dono: 'csm' },
        critico: { p: 'critica', prazo: 2, dono: 'cs_lead' },
        pdd: { p: 'critica', prazo: 1, dono: 'financeiro' },
      }
      const cfg = porSeveridade[sev]!
      const eng =
        e.faixaEngajamento === 'nulo'
          ? 'parou de usar'
          : e.faixaEngajamento === 'baixo'
            ? 'uso muito abaixo do segmento'
            : e.faixaEngajamento === 'em_queda'
              ? 'uso em queda'
              : 'uso saudável'
      const fin =
        e.diasAtrasoMax && e.diasAtrasoMax > 0 ? `atraso de ${e.diasAtrasoMax} dias` : 'em dia'
      return {
        gatilho: 'G-07',
        familia: 'churn_silencioso',
        prioridade: cfg.p,
        prazoDias: cfg.prazo,
        // Os dois vetores no motivo: é o que faz o CSM entender que "paga em dia"
        // não é o mesmo caso que "parou de pagar".
        motivo: `churn silencioso (${sev.replace('_', ' ')}) · ${eng} · ${fin}`,
        evidencia: {
          severidade: sev,
          faixa_engajamento: e.faixaEngajamento,
          dias_atraso: e.diasAtrasoMax,
        },
        donoPapel: cfg.dono,
      }
    },
  },
  {
    id: 'G-08',
    familia: 'relacionamento',
    cooldownDias: 45,
    proposito: 'Conta que sumiu do radar antes de sumir do contrato',
    avaliar: (e) => {
      if (e.diasSemContato === null || e.diasSemContato <= 60) return null
      return {
        gatilho: 'G-08',
        familia: 'relacionamento',
        prioridade: 'media',
        prazoDias: 10,
        motivo: `${e.diasSemContato} dias sem nenhum contato registrado`,
        evidencia: { dias_sem_contato: e.diasSemContato },
        donoPapel: 'csm',
      }
    },
  },
  {
    id: 'G-09',
    familia: 'renovacao',
    cooldownDias: null,
    proposito: 'Nunca descobrir um vencimento pelo vencimento',
    avaliar: (e) => {
      const d = e.diasParaVigenciaFim
      if (d === null || d > 90 || d < 0) return null
      return {
        gatilho: 'G-09',
        familia: 'renovacao',
        prioridade: 'alta',
        // O prazo é a própria janela: não há SLA configurável quando a data é dura.
        prazoDias: Math.max(1, d - 30),
        motivo: `vigência termina em ${d} dias`,
        evidencia: { dias_para_vigencia: d },
        donoPapel: 'csm',
      }
    },
  },
  {
    id: 'G-10',
    familia: 'voz',
    cooldownDias: 30,
    proposito: 'Detrator vira conversa, não estatística',
    avaliar: (e) => {
      // Declarado e não avaliado até existir pesquisa: sem fonte, o gatilho não
      // inventa um valor — ele simplesmente não dispara.
      if (e.nps === null || e.nps > 6) return null
      return {
        gatilho: 'G-10',
        familia: 'voz',
        prioridade: 'alta',
        prazoDias: 2,
        motivo: `NPS ${e.nps} — detrator`,
        evidencia: { nps: e.nps },
        donoPapel: 'csm',
      }
    },
  },
  {
    id: 'G-11',
    familia: 'produto',
    cooldownDias: 7,
    proposito: 'Falha nossa vira conversa nossa, antes de virar reclamação',
    avaliar: (e) => {
      if (e.horasIndisponibilidade === null || e.horasIndisponibilidade <= 4) return null
      return {
        gatilho: 'G-11',
        familia: 'produto',
        prioridade: 'alta',
        prazoDias: 1,
        motivo: `app fora do ar por ${e.horasIndisponibilidade}h — avisar antes de o cliente perguntar`,
        evidencia: { horas: e.horasIndisponibilidade },
        donoPapel: 'csm',
      }
    },
  },
  {
    id: 'G-12',
    familia: 'onboarding',
    cooldownDias: null,
    proposito: 'Implantação parada é TTFT crescendo em silêncio',
    avaliar: (e) => {
      if (!e.marcosAtrasados || e.marcosAtrasados <= 0) return null
      return {
        gatilho: 'G-12',
        familia: 'onboarding',
        prioridade: 'alta',
        prazoDias: 2,
        motivo: `${e.marcosAtrasados} marco(s) do projeto vencido(s)`,
        evidencia: { marcos_atrasados: e.marcosAtrasados },
        donoPapel: 'implantacao',
      }
    },
  },
  {
    id: 'G-13',
    familia: 'expansao',
    cooldownDias: 90,
    proposito: 'Expansão com evidência, não com palpite',
    avaliar: (e) => {
      if (!e.produtosAusentes?.length) return null
      if (e.adesao30d === null || e.adesao30d < e.pisoSegmento * 1.5) return null
      return {
        gatilho: 'G-13',
        familia: 'expansao',
        prioridade: 'baixa',
        prazoDias: 20,
        motivo: `adesão de ${pct(e.adesao30d)}, bem acima do segmento, sem ${e.produtosAusentes.join(' nem ')}`,
        evidencia: { adesao: e.adesao30d, produtos_ausentes: e.produtosAusentes },
        donoPapel: 'csm',
      }
    },
  },
  {
    id: 'G-14',
    familia: 'carteira',
    cooldownDias: null,
    proposito: 'Reclassificação nunca acontece em silêncio',
    avaliar: (e) => {
      if (!e.segmentoMudou) return null
      return {
        gatilho: 'G-14',
        familia: 'carteira',
        prioridade: 'baixa',
        prazoDias: 10,
        motivo: 'segmento mudou — o modelo de atendimento precisa acompanhar',
        evidencia: { segmento_mudou: true },
        donoPapel: 'cs_lead',
      }
    },
  },
]

/** Ordem de severidade, para o teto de carga decidir quem entra na fila. */
export const PESO_PRIORIDADE: Record<Prioridade, number> = {
  critica: 4,
  alta: 3,
  media: 2,
  baixa: 1,
}

/**
 * Avalia todos os gatilhos contra uma conta.
 *
 * Devolve TODOS os candidatos, inclusive vários da mesma família — a
 * deduplicação é da camada de fila, porque ela é a única que enxerga o que já
 * está aberto. Aqui, misturar as duas responsabilidades tornaria impossível
 * testar os gatilhos isoladamente.
 */
export function avaliarGatilhos(e: EstadoConta): readonly Candidato[] {
  return GATILHOS.map((g) => g.avaliar(e)).filter((c): c is Candidato => c !== null)
}

/**
 * Escolhe UM candidato por família.
 *
 * As faixas de atraso são mutuamente exclusivas por construção, mas nem toda
 * família tem essa garantia — e uma conta com dois candidatos de adesão viraria
 * dois itens para o mesmo fato. Vence a prioridade; empate, o prazo mais curto.
 */
export function umPorFamilia(candidatos: readonly Candidato[]): readonly Candidato[] {
  const porFamilia = new Map<Familia, Candidato>()
  for (const c of candidatos) {
    const atual = porFamilia.get(c.familia)
    if (
      !atual ||
      PESO_PRIORIDADE[c.prioridade] > PESO_PRIORIDADE[atual.prioridade] ||
      (PESO_PRIORIDADE[c.prioridade] === PESO_PRIORIDADE[atual.prioridade] &&
        c.prazoDias < atual.prazoDias)
    ) {
      porFamilia.set(c.familia, c)
    }
  }
  return [...porFamilia.values()]
}
