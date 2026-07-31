/**
 * A decisão de alarme de um ciclo de captação, como função pura.
 *
 * Estava dentro do componente React do painel: `falhas_seguidas >= alarmeApos`, uma
 * comparação solta no meio do JSX. Regra em componente não tem teste — e esta é a
 * regra que decide se alguém é avisado de que o dado parou de entrar. O critério de
 * lançamento do PRD (§17.4) pede alarme testado com falha induzida, **por ciclo**;
 * não dava para cumprir com a regra onde ela estava.
 *
 * Aqui também mora o invariante que a comparação solta não tinha: **degradação
 * crítica não espera.** `alarme_critico` existe para perda irrecuperável — o ledger
 * de MRR do C5, cujo evento perdido não é reconstruível depois. Um `alarmeApos: 3`
 * nesse ciclo faria três ciclos de perda passarem em silêncio, e a política pareceria
 * declarada e correta. Se a perda é irrecuperável, o primeiro sinal já é o alarme.
 */

export type Degradacao =
  | 'neutro_sinalizado'
  | 'snapshot_parcial'
  | 'reprocessa'
  | 'alarme_critico'

export interface PoliticaFalha {
  readonly tentativas: number
  /** Quantos ciclos consecutivos falhando antes de alarmar. */
  readonly alarmeApos: number
  readonly degradacao: Degradacao
}

export type NivelAlarme = 'silencio' | 'aviso' | 'critico'

export interface Alarme {
  readonly nivel: NivelAlarme
  /** Sempre com número: quantas falhas, contra qual limiar. */
  readonly motivo: string
}

/**
 * `falhasSeguidas` são falhas CONSECUTIVAS contando da execução mais recente.
 *
 * Consecutivas e não totais: um ciclo que falha uma vez por semana tem um problema
 * diferente de um que falhou três vezes agora, e somar as duas coisas num contador
 * só faz o intermitente parecer parado e o parado parecer intermitente.
 */
export function decidirAlarme(falhasSeguidas: number, politica: PoliticaFalha): Alarme {
  if (falhasSeguidas <= 0) {
    return { nivel: 'silencio', motivo: 'última execução não falhou' }
  }

  if (politica.degradacao === 'alarme_critico') {
    return {
      nivel: 'critico',
      motivo: `${falhasSeguidas} falha(s) seguida(s) em ciclo de perda irrecuperável — o dado destas execuções não é reconstruível depois`,
    }
  }

  if (falhasSeguidas >= politica.alarmeApos) {
    return {
      nivel: 'aviso',
      motivo: `${falhasSeguidas} falha(s) seguida(s), limiar é ${politica.alarmeApos} · degradação: ${politica.degradacao}`,
    }
  }

  // Falhou, mas dentro do que a política tolera. Não é silêncio por descuido: é
  // silêncio declarado, e o número fica visível na tabela do painel de qualquer forma.
  return {
    nivel: 'silencio',
    motivo: `${falhasSeguidas} de ${politica.alarmeApos} falha(s) toleradas antes de alarmar`,
  }
}

/**
 * O invariante que uma política declarada não garante sozinha.
 *
 * Serve de portão: nenhum ciclo de perda irrecuperável pode declarar tolerância a
 * falha. `decidirAlarme` já ignora `alarmeApos` nesse caso, mas uma declaração que
 * diz `alarmeApos: 3` mente para quem a lê — e alguém vai ler para decidir se pode
 * dormir tranquilo.
 */
export function politicaCoerente(politica: PoliticaFalha): string | null {
  if (politica.degradacao === 'alarme_critico' && politica.alarmeApos > 1) {
    return `alarme_critico com alarmeApos ${politica.alarmeApos}: perda irrecuperável não tolera ciclo em silêncio`
  }
  if (politica.alarmeApos < 1) {
    return `alarmeApos ${politica.alarmeApos}: limiar abaixo de 1 alarmaria sem falha`
  }
  return null
}
