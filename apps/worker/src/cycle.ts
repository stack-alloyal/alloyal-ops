/**
 * Contrato de ciclo de ingestão.
 *
 * Doc 00, seção 6.3.
 *
 * Todo ciclo declara sete campos. O painel de pipeline (doc 00, 10) é GERADO a
 * partir dessas declarações — não é uma tela mantida à mão que vai ficando
 * desatualizada conforme ciclos entram e saem.
 */

export type MetodoCiclo =
  | "incremental_watermark"
  | "full"
  | "webhook"
  | "reconciliacao"
  | "consolidacao";

export type Janela =
  | "desde_watermark"
  | "estado_atual"
  | "90d"
  | "dia_anterior"
  /** Competência inteira do mês anterior — a unidade do fechamento contábil. */
  | "mes_anterior"
  | "sem_janela";

export type Degradacao =
  /** Métrica derivada entra neutra e SINALIZADA. Nunca com o último valor. */
  | "neutro_sinalizado"
  /** Snapshot é publicado PARCIAL e marcado. Nunca bloqueado. */
  | "snapshot_parcial"
  /** Reenfileira e tenta de novo. */
  | "reprocessa"
  /** Perda irrecuperável: alarme crítico imediato. */
  | "alarme_critico";

export interface PoliticaFalha {
  readonly tentativas: number;
  readonly backoff: "exponencial" | "fixo";
  /** Quantos ciclos consecutivos falhando antes de alarmar. */
  readonly alarmeApos: number;
  readonly degradacao: Degradacao;
}

export interface Ciclo {
  readonly id: string;
  readonly descricao: string;
  readonly fonte: string;
  readonly metodo: MetodoCiclo;
  /** Cron em UTC. `null` para ciclos disparados por webhook. */
  readonly agenda: string | null;
  readonly janela: Janela;
  /** Chave natural usada no upsert. É o que garante idempotência (doc 00, 6.4). */
  readonly chaveNatural: readonly string[];
  readonly emFalha: PoliticaFalha;
  /** Fase do roadmap em que o ciclo entra (doc 01, seção 12). */
  readonly fase: string;
  readonly executar: (ctx: ContextoCiclo) => Promise<ResultadoCiclo>;
}

export interface ContextoCiclo {
  readonly cicloId: string;
  readonly watermark: Date | null;
  readonly agora: Date;
  readonly log: (msg: string) => void;
}

export interface ResultadoCiclo {
  readonly linhasLidas: number;
  readonly linhasGravadas: number;
  /** Novo watermark. Só avança quando a carga foi bem-sucedida. */
  readonly novoWatermark?: Date;
  readonly detalhe?: Record<string, unknown>;
  /**
   * O ciclo rodou e NÃO fez o trabalho — falta configuração, não houve erro.
   *
   * Existe porque o runner só sabia gravar `ok` ou `falha`, e as duas mentem aqui:
   * `falha` enche o alarme de ruído previsível (ciclo sem credencial vai falhar todo
   * dia), e `ok` faz a tela dizer "última execução bem-sucedida: hoje" para um ciclo
   * que nunca leu uma linha. Quem olha o painel precisa ver a diferença.
   */
  readonly inerte?: boolean;
}

const registro = new Map<string, Ciclo>();

export function defineCycle(c: Ciclo): Ciclo {
  if (registro.has(c.id)) throw new Error(`Ciclo duplicado: ${c.id}`);
  if (c.metodo === "webhook" && c.agenda !== null) {
    throw new Error(`Ciclo ${c.id}: webhook não tem agenda cron.`);
  }
  if (c.metodo !== "webhook" && c.agenda === null) {
    throw new Error(`Ciclo ${c.id}: ciclo agendado precisa de cron.`);
  }
  if (c.metodo === "incremental_watermark" && c.janela !== "desde_watermark") {
    throw new Error(
      `Ciclo ${c.id}: incremental por watermark exige janela desde_watermark.`,
    );
  }
  if (c.chaveNatural.length === 0) {
    throw new Error(
      `Ciclo ${c.id} sem chave natural: reexecução duplicaria dado. Idempotência é requisito, não otimização.`,
    );
  }
  registro.set(c.id, c);
  return c;
}

export function todosOsCiclos(): readonly Ciclo[] {
  return [...registro.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Sobreposição de segurança do watermark.
 *
 * Relê alguns minutos já lidos de propósito. Sem isso, transação longa na origem
 * que commita depois do watermark ter avançado fica invisível para sempre — e a
 * idempotência por chave natural torna a releitura inofensiva.
 */
export const SOBREPOSICAO_MS = 5 * 60 * 1000;

export function janelaDeLeitura(
  watermark: Date | null,
  agora: Date,
): { de: Date; ate: Date } {
  return {
    de: watermark
      ? new Date(watermark.getTime() - SOBREPOSICAO_MS)
      : new Date(0),
    ate: agora,
  };
}
