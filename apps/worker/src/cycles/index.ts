/**
 * Registro dos ciclos da Fase 0.
 *
 * Doc 01, seção 12. Cada ciclo aqui é uma casca declarada: o contrato está
 * completo e a implementação (`executar`) só será escrita depois do spike de
 * dados, porque V-01 e V-02 decidem entre dois desenhos incompatíveis:
 *
 *   caminho A — `updated_at` confiável e índice presente → C1 incremental
 *   caminho B — sem um dos dois → C3 (reconciliação) passa a ser o principal,
 *               com janela de 180 dias na carga inicial, e os agregados vêm de
 *               tabela materializada na origem
 *
 * Declarar o contrato antes de implementar é deliberado: é ele que gera o painel
 * de pipeline e as verificações de qualidade, e ele não muda entre A e B.
 *
 * Declarar cron em UTC com um comentário dizendo o horário local é a forma
 * clássica de o comentário e o valor divergirem — e o sintoma aparece meses
 * depois, como "o snapshot saiu na hora errada". As agendas abaixo estão em
 * horário de São Paulo, e o agendador aplica o fuso (ver `queue.ts`).
 */

import {
  abrirJanela,
  competenciaAnterior,
  CompetenciaCongeladaError,
  fechar,
} from '@ops/success'

import { consolidar } from '../consolidacao.js'
import { avaliarFila } from '../fila.js'
import { defineCycle } from '../cycle.js'
import { poolDoWorker } from '../db.js'

const naoImplementado = (id: string) => async () => {
  throw new Error(
    `Ciclo ${id} declarado e não implementado. Aguarda o spike de dados (doc 02, B.2).`,
  )
}

/**
 * C5 — eventos de MRR.
 *
 * O ÚNICO ciclo cuja perda é irrecuperável, e por isso o primeiro a ser
 * implementado, na Fase 0. Não existe como reconstruir retroativamente a razão
 * pela qual um contrato mudou de valor.
 *
 * Entre a Fase 0 e a Fase 7 não há fluxo próprio gerando esses eventos: as
 * mudanças acontecem no HubSpot, por pessoas. Depende de V-11 (o HubSpot permite
 * webhook de mudança de propriedade de deal?). Se a resposta for não, o plano B é
 * varredura de 15 minutos sobre `hs_lastmodifieddate` mais entrada manual
 * assistida na renovação — pior, mas não irrecuperável.
 */
export const c5MrrEvents = defineCycle({
  id: 'C5',
  descricao: 'Eventos de MRR do HubSpot',
  fonte: 'hubspot',
  metodo: 'incremental_watermark',
  agenda: '*/15 * * * *',
  janela: 'desde_watermark',
  chaveNatural: ['origem', 'hubspot_deal_id', 'competencia', 'tipo'],
  emFalha: {
    tentativas: 5,
    backoff: 'exponencial',
    alarmeApos: 1,
    degradacao: 'alarme_critico',
  },
  fase: 'F0',
  executar: naoImplementado('C5'),
})

export const c1Transacoes = defineCycle({
  id: 'C1',
  descricao: 'Transações da réplica',
  fonte: 'replica',
  metodo: 'incremental_watermark',
  agenda: '*/15 * * * *',
  janela: 'desde_watermark',
  chaveNatural: ['account_id', 'dia'],
  emFalha: { tentativas: 3, backoff: 'exponencial', alarmeApos: 2, degradacao: 'reprocessa' },
  fase: 'F1',
  executar: naoImplementado('C1'),
})

export const c2BaseElegivel = defineCycle({
  id: 'C2',
  descricao: 'Base elegível e ativada',
  fonte: 'replica',
  metodo: 'full',
  agenda: '0 2 * * *',
  janela: 'estado_atual',
  chaveNatural: ['account_id'],
  emFalha: { tentativas: 2, backoff: 'fixo', alarmeApos: 1, degradacao: 'snapshot_parcial' },
  fase: 'F1',
  executar: naoImplementado('C2'),
})

export const c3Reconciliacao = defineCycle({
  id: 'C3',
  descricao: 'Reconciliação de 90 dias com a origem',
  fonte: 'replica',
  metodo: 'reconciliacao',
  agenda: '0 4 * * *',
  janela: '90d',
  chaveNatural: ['account_id', 'dia'],
  emFalha: { tentativas: 1, backoff: 'fixo', alarmeApos: 1, degradacao: 'reprocessa' },
  fase: 'F1',
  executar: naoImplementado('C3'),
})

export const c8Adimplencia = defineCycle({
  id: 'C8',
  descricao: 'Adimplência do Omie',
  fonte: 'omie',
  metodo: 'full',
  agenda: '0 6 * * *',
  janela: 'estado_atual',
  chaveNatural: ['account_id'],
  emFalha: { tentativas: 3, backoff: 'exponencial', alarmeApos: 1, degradacao: 'neutro_sinalizado' },
  fase: 'F1',
  executar: naoImplementado('C8'),
})

/**
 * C12 — snapshot diário.
 *
 * ESPERA C2, C3, C6 e C8 até 06:50. O que não chegou entra como lacuna marcada
 * e o snapshot é publicado PARCIAL — nunca bloqueado.
 *
 * Bloquear significaria produto no ar sem número nenhum, e tornaria a meta de
 * cobertura de sinal impossível por construção: bastaria uma fonte atrasar para
 * o dia inteiro ficar sem dado.
 */
export const c12Snapshot = defineCycle({
  id: 'C12',
  descricao: 'Snapshot diário, sinais e avaliação de gatilhos',
  fonte: 'ops',
  metodo: 'consolidacao',
  agenda: '0 7 * * *',
  janela: 'dia_anterior',
  chaveNatural: ['competencia', 'account_id'],
  emFalha: { tentativas: 2, backoff: 'fixo', alarmeApos: 1, degradacao: 'snapshot_parcial' },
  fase: 'F1',
  executar: async (ctx) => {
    // A competência é o dia anterior fechado: transação do dia corrente entra
    // no snapshot de amanhã.
    const competencia = new Date(ctx.agora.getTime() - 86_400_000).toISOString().slice(0, 10)
    const pool = poolDoWorker()
    const r = await consolidar(pool, competencia, { agora: ctx.agora })
    ctx.log(
      `${r.contas} contas · ${r.completos} completas · ${r.parciais} parciais · ` +
        `${r.emChurnSilencioso} em churn silencioso · ${r.suprimidos} recortes suprimidos`,
    )

    // A fila é avaliada DEPOIS da consolidação, na mesma execução: um item de
    // trabalho gerado contra sinais da competência anterior mandaria o CSM agir
    // sobre um número que já mudou.
    const f = await avaliarFila(pool, competencia, { agora: ctx.agora })
    ctx.log(
      `fila · ${f.criados} criados (${f.emSombra} em sombra, ${f.emBacklog} no backlog) · ` +
        `${f.atualizados} atualizados · ${f.bloqueadosPorCarencia} em carência`,
    )

    return {
      linhasLidas: r.contas,
      linhasGravadas: r.sinais + r.publicados + r.suprimidos + f.criados,
      detalhe: { consolidacao: r, fila: f },
    }
  },
})

/**
 * C13 — fechamento mensal.
 *
 * Roda todo dia enquanto a competência anterior estiver ABERTA, e não uma vez
 * só no dia 1: evento de MRR chega atrasado — uma aprovação de distrato no dia
 * 4 pertence ao mês 3 — e uma cascata calculada uma vez ficaria errada até
 * alguém reparar. Recalcular é barato; descobrir tarde não é.
 *
 * O congelamento NÃO é automático. Ele é a decisão de uma pessoa de que aquele
 * mês está pronto para ir ao board, e a partir dali os números não mudam mais.
 * Automatizá-lo transformaria o relógio em autoridade sobre o número.
 */
export const c13Fechamento = defineCycle({
  id: 'C13',
  descricao: 'Cascata de receita da competência anterior',
  fonte: 'ops',
  metodo: 'consolidacao',
  agenda: '30 7 * * *',
  janela: 'mes_anterior',
  chaveNatural: ['competencia'],
  emFalha: { tentativas: 2, backoff: 'fixo', alarmeApos: 1, degradacao: 'neutro_sinalizado' },
  fase: 'F1',
  executar: async (ctx) => {
    const anterior = competenciaAnterior(ctx.agora.toISOString().slice(0, 10))
    const pool = poolDoWorker()
    try {
      const c = await fechar(pool, anterior)
      const residuo = Number(c.naoAtribuidoCentavos)
      ctx.log(
        `${c.competencia.slice(0, 7)} · MRR final ${(Number(c.mrrFinalCentavos) / 100).toFixed(0)} · ` +
          `NRR ${c.nrr ?? '—'} · GRR ${c.grr ?? '—'} · não atribuído ${(residuo / 100).toFixed(0)}`,
      )
      return { linhasLidas: c.contasIniciais, linhasGravadas: 1, detalhe: { cascata: c } }
    } catch (err) {
      if (err instanceof CompetenciaCongeladaError) {
        // Não é falha: é o estado normal depois que alguém fechou o mês. Tratar
        // como erro encheria o painel de alarme previsível todo santo dia.
        ctx.log(`${anterior.slice(0, 7)} já congelada — nada a recalcular`)
        return { linhasLidas: 0, linhasGravadas: 0 }
      }
      throw err
    }
  },
})

/**
 * C14 — abertura das janelas de renovação.
 *
 * Roda todo dia, não uma vez por mês: um contrato que entra na janela hoje tem
 * que aparecer hoje. O propósito do módulo inteiro é nunca descobrir um
 * vencimento pelo vencimento, e um ciclo mensal criaria até 30 dias de atraso na
 * descoberta — dentro de uma janela de 90.
 *
 * Antes do C12 de propósito: a renovação existe quando o gatilho G-09 avalia a
 * conta, e não depois dele. Na ordem inversa, o item de trabalho de renovação
 * apareceria um dia antes da renovação que ele representa.
 */
export const c14Renovacoes = defineCycle({
  id: 'C14',
  descricao: 'Abertura das janelas de renovação (90 dias da vigência)',
  fonte: 'ops',
  metodo: 'consolidacao',
  agenda: '30 6 * * *',
  janela: 'estado_atual',
  chaveNatural: ['account_id', 'vigencia_fim'],
  emFalha: { tentativas: 2, backoff: 'fixo', alarmeApos: 2, degradacao: 'reprocessa' },
  fase: 'F1',
  executar: async (ctx) => {
    const r = await abrirJanela(poolDoWorker(), { hoje: ctx.agora.toISOString().slice(0, 10) })
    ctx.log(`${r.abertas} janela(s) aberta(s) · ${r.jaAbertas} já estavam na janela`)
    return { linhasLidas: r.abertas + r.jaAbertas, linhasGravadas: r.abertas }
  },
})

export const CICLOS_ESPERADOS_PELO_SNAPSHOT = ['C2', 'C3', 'C6', 'C8'] as const
export const PRAZO_ESPERA_SNAPSHOT_BRT = '06:50'
