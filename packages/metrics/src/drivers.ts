/**
 * Cálculo dos nove drivers a partir do estado capturado.
 *
 * Puro de propósito: a consolidação lê o banco e escreve o resultado, mas o
 * julgamento de "quão saudável é este número" mora aqui, onde pode ser testado
 * caso a caso sem subir nada.
 *
 * Regra que atravessa todos: **entrada ausente devolve `null`, nunca zero.**
 * Zero é uma afirmação — significa "está péssimo". Ausente significa "a fonte
 * não disse", e o driver sai da conta com o peso redistribuído. Confundir os
 * dois faz um cliente saudável despencar porque uma integração caiu.
 */

import type { DriverId, DriverValue } from './score.js'

export interface EntradaDrivers {
  /** Fração de 0 a 1. */
  readonly adesao30d: number | null
  /** Mesma métrica 30 dias antes, para a tendência. */
  readonly adesao30dAnterior: number | null
  /** Piso de adesão do segmento, fração de 0 a 1. */
  readonly pisoSegmento: number
  readonly coberturaCadastral: number | null
  readonly diasAtrasoMax: number | null
  /**
   * Posição da conta na base em intensidade de uso, de 0 a 1.
   * Calculado pela consolidação porque depende de toda a base.
   */
  readonly percentilIntensidade: number | null
  readonly diasDesdeUltimoContato: number | null
  readonly mau: number | null
  readonly dau: number | null
  /** Nulos até as fontes existirem. */
  readonly csat: number | null
  readonly nps: number | null
}

const clamp = (v: number, min = 0, max = 100) => Math.min(max, Math.max(min, v))
const arred = (v: number) => Math.round(v)

/** Interpola linearmente entre dois pontos, saturando fora do intervalo. */
function rampa(v: number, de: number, ate: number): number {
  if (ate === de) return v <= de ? 0 : 100
  return clamp(((v - de) / (ate - de)) * 100)
}

// ── S-FIN · adimplência ─────────────────────────────────────────────────────
// Maior peso da soma, porque atraso de pagamento é o sinal mais antecipado de
// saída que a empresa tem. Decai linear até zerar aos 90 dias, que é quando a
// provisão entra e o cliente deixa de ser um problema de relacionamento.
export function driverAdimplencia(diasAtraso: number | null): number | null {
  if (diasAtraso === null) return null
  if (diasAtraso <= 0) return 100
  return arred(clamp(100 - (diasAtraso / 90) * 100))
}

// ── S-ADO · adesão contra a meta do segmento ────────────────────────────────
export function driverAdesao(adesao: number | null, piso: number): number | null {
  if (adesao === null) return null
  if (piso <= 0) return 100
  return arred(clamp((adesao / piso) * 100))
}

// ── S-TEN · tendência ───────────────────────────────────────────────────────
// Normalizada entre −30% e +10%: a faixa é assimétrica de propósito, porque
// queda importa mais que alta. Um clube que cresce 30% num mês é boa notícia,
// mas não é três vezes melhor que um que cresce 10%.
export function driverTendencia(atual: number | null, anterior: number | null): number | null {
  if (atual === null || anterior === null || anterior <= 0) return null
  const variacao = (atual - anterior) / anterior
  return arred(rampa(variacao, -0.3, 0.1))
}

// ── S-USO · intensidade ─────────────────────────────────────────────────────
export function driverIntensidade(percentil: number | null): number | null {
  if (percentil === null) return null
  return arred(clamp(percentil * 100))
}

// ── S-CAD · cobertura cadastral ─────────────────────────────────────────────
// A única alavanca de adesão que depende inteiramente do cliente.
export function driverCobertura(cobertura: number | null): number | null {
  if (cobertura === null) return null
  return arred(clamp(cobertura * 100))
}

// ── S-REL · recência de relacionamento ──────────────────────────────────────
// 100 até 30 dias, decaindo a zero em 120. Considera e-mail, reunião, WhatsApp
// e ligação juntos: medir cada canal em separado produz um número que diz que o
// cliente está abandonado quando a conversa está acontecendo no WhatsApp.
export function driverRelacionamento(diasSemContato: number | null): number | null {
  if (diasSemContato === null) return null
  if (diasSemContato <= 30) return 100
  return arred(clamp(100 - rampa(diasSemContato, 30, 120)))
}

// ── S-ENG · engajamento no app ──────────────────────────────────────────────
// Aderência = DAU sobre MAU.
//
// A rampa satura em 0,20, e não em 0,40 como uma leitura ingênua sugeriria.
// Clube de benefício não é rede social: ninguém abre o app todo dia para usar
// desconto. Uma aderência de 0,15 já é um clube muito ativo, e uma rampa que só
// premia 0,40 faz a base inteira parecer moribunda — o que não informa nada,
// porque um driver em que todo mundo vai mal não ordena ninguém.
export function driverEngajamento(mau: number | null, dau: number | null): number | null {
  if (mau === null || dau === null || mau <= 0) return null
  return arred(rampa(dau / mau, 0.02, 0.2))
}

// ── S-SUP · suporte ─────────────────────────────────────────────────────────
export function driverSuporte(csat: number | null): number | null {
  if (csat === null) return null
  // CSAT de 1 a 5.
  return arred(rampa(csat, 1, 5))
}

// ── S-VOZ · voz ─────────────────────────────────────────────────────────────
export function driverVoz(nps: number | null): number | null {
  if (nps === null) return null
  // NPS de −100 a 100.
  return arred(rampa(nps, -100, 100))
}

/**
 * Calcula os nove drivers de uma conta.
 *
 * A ordem da saída é a mesma de `DRIVERS`, para que a renormalização e a
 * gravação por driver não dependam de ordenação implícita.
 */
export function calcularDrivers(e: EntradaDrivers): readonly DriverValue[] {
  const mapa: Record<DriverId, number | null> = {
    'S-FIN': driverAdimplencia(e.diasAtrasoMax),
    'S-ADO': driverAdesao(e.adesao30d, e.pisoSegmento),
    'S-TEN': driverTendencia(e.adesao30d, e.adesao30dAnterior),
    'S-USO': driverIntensidade(e.percentilIntensidade),
    'S-REL': driverRelacionamento(e.diasDesdeUltimoContato),
    'S-CAD': driverCobertura(e.coberturaCadastral),
    'S-SUP': driverSuporte(e.csat),
    'S-ENG': driverEngajamento(e.mau, e.dau),
    'S-VOZ': driverVoz(e.nps),
  }
  return (Object.keys(mapa) as DriverId[]).map((id) => ({ id, valor: mapa[id] }))
}

/**
 * Percentil de um valor dentro de uma população.
 *
 * Usado pelo driver de intensidade. Empates recebem o mesmo percentil — sem
 * isso, duas contas idênticas apareceriam em posições diferentes e o número
 * deixaria de ser explicável.
 */
export function percentil(valor: number, populacao: readonly number[]): number | null {
  if (populacao.length === 0) return null
  const abaixo = populacao.filter((v) => v < valor).length
  const iguais = populacao.filter((v) => v === valor).length
  return (abaixo + iguais / 2) / populacao.length
}
