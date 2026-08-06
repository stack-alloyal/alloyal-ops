/**
 * Executor de ciclos.
 *
 * O contrato do ciclo (`cycle.ts`) declara o que ele é. Este arquivo é o que o
 * executa — e a maior parte do código aqui existe para o caso de FALHA, não
 * para o caso de sucesso.
 *
 * Doc do Pulse, seções 09 e 10.
 */

import type pg from "pg";

import type {
  Ciclo,
  ContextoCiclo,
  Degradacao,
  ResultadoCiclo,
} from "./cycle.js";
import { janelaDeLeitura } from "./cycle.js";

export interface Alarme {
  readonly ciclo: string;
  readonly severidade: "critico" | "alto";
  readonly mensagem: string;
  readonly falhasConsecutivas: number;
  readonly degradacao: Degradacao;
}

export interface DepsRunner {
  readonly pool: pg.Pool;
  /** Injetável para que o teste não dependa do relógio da máquina. */
  readonly agora: () => Date;
  readonly alarmar: (a: Alarme) => Promise<void>;
  readonly log?: (msg: string) => void;
  /** Injetável para o teste não esperar o backoff de verdade. */
  readonly dormir?: (ms: number) => Promise<void>;
}

export type ResultadoExecucao =
  | {
      readonly estado: "ok";
      readonly runId: string;
      readonly linhasLidas: number;
      readonly linhasGravadas: number;
      readonly watermarkAvancou: boolean;
      readonly tentativas: number;
    }
  /** Outra instância já está rodando este ciclo. Não é erro. */
  | { readonly estado: "pulado"; readonly motivo: "em_execucao" }
  | {
      readonly estado: "falha";
      readonly runId: string;
      readonly erro: string;
      readonly tentativas: number;
      readonly falhasConsecutivas: number;
      readonly alarmado: boolean;
      readonly degradacao: Degradacao;
    };

const BACKOFF_BASE_MS = 2_000;

function esperaDaTentativa(n: number, tipo: "exponencial" | "fixo"): number {
  return tipo === "fixo" ? BACKOFF_BASE_MS : BACKOFF_BASE_MS * 2 ** (n - 1);
}

/**
 * Executa um ciclo com a semântica completa de falha.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ A regra que governa tudo aqui: o WATERMARK SÓ AVANÇA DEPOIS DO SUCESSO.   │
 * │                                                                            │
 * │ O erro perigoso é assimétrico. Se o watermark avança e a carga falha, a    │
 * │ janela some para sempre e ninguém percebe — o ciclo seguinte começa depois │
 * │ dos registros que nunca foram gravados. O contrário é inofensivo: se a     │
 * │ carga grava e o watermark não avança, a próxima execução relê a mesma      │
 * │ janela, e o upsert por chave natural não duplica nada.                     │
 * │                                                                            │
 * │ É por isso que a idempotência é requisito e não otimização — ela é o que   │
 * │ torna seguro separar a carga do avanço do marcador.                        │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export async function executarCiclo(
  ciclo: Ciclo,
  deps: DepsRunner,
): Promise<ResultadoExecucao> {
  const log = deps.log ?? (() => undefined);
  const dormir =
    deps.dormir ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const agora = deps.agora();

  // ── Trava: um ciclo não roda concorrente consigo mesmo ────────────────────
  // O C1 roda a cada 15 minutos. Se uma execução passar de 15 minutos, a
  // seguinte entraria em cima dela — lendo a mesma janela e disputando o mesmo
  // watermark. A trava é de sessão, então precisa de um cliente dedicado
  // mantido aberto durante toda a execução.
  const travaClient = await deps.pool.connect();
  let travou = false;
  try {
    const { rows } = await travaClient.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS ok",
      [ciclo.id],
    );
    travou = rows[0]?.ok === true;
    if (!travou) {
      log(`${ciclo.id}: já em execução, pulando`);
      return { estado: "pulado", motivo: "em_execucao" };
    }

    // ── Abre o registro da execução ─────────────────────────────────────────
    const { rows: runRows } = await deps.pool.query<{ id: string }>(
      `INSERT INTO ops.cycle_run (ciclo, iniciado_em, status) VALUES ($1, $2, 'rodando') RETURNING id`,
      [ciclo.id, agora],
    );
    const runId = String(runRows[0]?.id);

    // ── Watermark, com a sobreposição de segurança ──────────────────────────
    const watermark = await lerWatermark(deps.pool, ciclo.id);
    const janela = janelaDeLeitura(watermark, agora);

    const ctx: ContextoCiclo = {
      cicloId: ciclo.id,
      watermark: janela.de.getTime() === 0 ? null : janela.de,
      agora,
      log: (m) => log(`${ciclo.id}: ${m}`),
    };

    // ── Tentativas ──────────────────────────────────────────────────────────
    let ultimoErro: unknown;
    for (
      let tentativa = 1;
      tentativa <= ciclo.emFalha.tentativas;
      tentativa++
    ) {
      try {
        const r: ResultadoCiclo = await ciclo.executar(ctx);

        // Sucesso: fecha o registro e só então mexe no watermark.
        // `inerte`: rodou sem erro E sem fazer o trabalho, por falta de configuração.
        // Nem `ok` — que no painel vira "última execução bem-sucedida: hoje" para um
        // ciclo que não leu uma linha — nem `falha`, que viraria alarme diário
        // previsível enquanto a credencial não for cadastrada.
        const statusFinal = r.inerte === true ? "inerte" : "ok";
        await deps.pool.query(
          `UPDATE ops.cycle_run
              SET status = $6, terminado_em = $2, linhas_lidas = $3,
                  linhas_gravadas = $4, detalhe = $5
            WHERE id = $1`,
          [
            runId,
            deps.agora(),
            r.linhasLidas,
            r.linhasGravadas,
            r.detalhe ?? null,
            statusFinal,
          ],
        );

        let watermarkAvancou = false;
        if (r.novoWatermark) {
          await gravarWatermark(deps.pool, ciclo.id, r.novoWatermark);
          watermarkAvancou = true;
        }

        log(
          `${ciclo.id}: ${statusFinal} · ${r.linhasLidas} lidas · ${r.linhasGravadas} gravadas`,
        );
        return {
          estado: "ok",
          runId,
          linhasLidas: r.linhasLidas,
          linhasGravadas: r.linhasGravadas,
          watermarkAvancou,
          tentativas: tentativa,
        };
      } catch (err) {
        ultimoErro = err;
        const ultima = tentativa === ciclo.emFalha.tentativas;
        log(
          `${ciclo.id}: tentativa ${tentativa}/${ciclo.emFalha.tentativas} falhou${ultima ? "" : ", repetindo"}`,
        );
        if (!ultima)
          await dormir(esperaDaTentativa(tentativa, ciclo.emFalha.backoff));
      }
    }

    // ── Falha definitiva ────────────────────────────────────────────────────
    const erro =
      ultimoErro instanceof Error ? ultimoErro.message : String(ultimoErro);
    await deps.pool.query(
      `UPDATE ops.cycle_run SET status = 'falha', terminado_em = $2, erro = $3 WHERE id = $1`,
      [runId, deps.agora(), erro],
    );

    // O watermark NÃO avança. A janela fica intacta para a próxima execução.

    const falhasConsecutivas = await contarFalhasConsecutivas(
      deps.pool,
      ciclo.id,
    );
    const alarmado = falhasConsecutivas >= ciclo.emFalha.alarmeApos;
    if (alarmado) {
      await deps.alarmar({
        ciclo: ciclo.id,
        // Perda irrecuperável escala sozinha: não existe "tentar de novo amanhã"
        // para um evento de contrato que ninguém registrou.
        severidade:
          ciclo.emFalha.degradacao === "alarme_critico" ? "critico" : "alto",
        mensagem: `${ciclo.id} falhou ${falhasConsecutivas}× seguidas: ${erro}`,
        falhasConsecutivas,
        degradacao: ciclo.emFalha.degradacao,
      });
    }

    return {
      estado: "falha",
      runId,
      erro,
      tentativas: ciclo.emFalha.tentativas,
      falhasConsecutivas,
      alarmado,
      degradacao: ciclo.emFalha.degradacao,
    };
  } finally {
    if (travou) {
      await travaClient
        .query("SELECT pg_advisory_unlock(hashtext($1))", [ciclo.id])
        .catch(() => undefined);
    }
    travaClient.release();
  }
}

// ── Watermark ───────────────────────────────────────────────────────────────

export async function lerWatermark(
  pool: pg.Pool,
  ciclo: string,
): Promise<Date | null> {
  const { rows } = await pool.query<{ valor: Date }>(
    "SELECT valor FROM ops.watermark WHERE ciclo = $1",
    [ciclo],
  );
  return rows[0]?.valor ?? null;
}

/**
 * O watermark nunca retrocede.
 *
 * Uma execução atrasada que devolvesse um valor mais antigo faria o ciclo
 * seguinte reler uma janela maior — inofensivo — mas também mascararia um bug
 * de ordenação na origem, que é o tipo de coisa que se quer ver.
 */
export async function gravarWatermark(
  pool: pg.Pool,
  ciclo: string,
  valor: Date,
): Promise<void> {
  await pool.query(
    `INSERT INTO ops.watermark (ciclo, valor, atualizado_em) VALUES ($1, $2, now())
     ON CONFLICT (ciclo) DO UPDATE
        SET valor = GREATEST(ops.watermark.valor, EXCLUDED.valor), atualizado_em = now()`,
    [ciclo, valor],
  );
}

// ── Falhas consecutivas ─────────────────────────────────────────────────────

/**
 * Conta falhas seguidas a partir da execução mais recente.
 *
 * Consecutivas, e não totais: um ciclo que falha uma vez por semana há um ano
 * tem um problema diferente de um que falhou três vezes seguidas agora — e é o
 * segundo que precisa acordar alguém.
 */
export async function contarFalhasConsecutivas(
  pool: pg.Pool,
  ciclo: string,
): Promise<number> {
  const { rows } = await pool.query<{ status: string }>(
    `SELECT status FROM ops.cycle_run
      WHERE ciclo = $1 AND status <> 'rodando'
      ORDER BY iniciado_em DESC, id DESC
      LIMIT 20`,
    [ciclo],
  );
  let n = 0;
  for (const r of rows) {
    if (r.status !== "falha") break;
    n++;
  }
  return n;
}
