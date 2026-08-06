/**
 * Executor de ciclos — semântica de falha.
 *
 * Roda contra Postgres real: o que está sendo verificado aqui é o efeito no
 * banco (watermark, cycle_run, trava), e simulação não provaria nada disso.
 *
 * Os ciclos usados são fabricados no próprio teste — não os declarados em
 * `cycles/` — para que o teste controle quando falha e quando não falha.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import pg from "pg";

import type { Ciclo } from "./cycle.js";
import { SOBREPOSICAO_MS } from "./cycle.js";
import {
  type Alarme,
  contarFalhasConsecutivas,
  executarCiclo,
  gravarWatermark,
  lerWatermark,
} from "./runner.js";

const ADMIN = process.env["DATABASE_URL_ADMIN"];
const AGORA = new Date("2026-07-30T12:00:00Z");

/** Ciclo de teste com política ajustável. */
function ciclo(
  id: string,
  executar: Ciclo["executar"],
  emFalha: Partial<Ciclo["emFalha"]> = {},
): Ciclo {
  return {
    id,
    descricao: `ciclo de teste ${id}`,
    fonte: "teste",
    metodo: "incremental_watermark",
    agenda: "*/15 * * * *",
    janela: "desde_watermark",
    chaveNatural: ["id"],
    emFalha: {
      tentativas: 1,
      backoff: "fixo",
      alarmeApos: 1,
      degradacao: "reprocessa",
      ...emFalha,
    },
    fase: "teste",
    executar,
  };
}

describe("executor de ciclos", { skip: !ADMIN }, () => {
  let pool: pg.Pool;
  const alarmes: Alarme[] = [];

  const deps = () => ({
    pool,
    agora: () => AGORA,
    alarmar: async (a: Alarme) => {
      alarmes.push(a);
    },
    // Backoff instantâneo: o teste verifica que ele foi CHAMADO, não que a
    // máquina ficou parada.
    dormir: async () => undefined,
  });

  before(async () => {
    const { migrate } = await import("@pulse/db");
    await migrate(ADMIN as string);
    pool = new pg.Pool({ connectionString: ADMIN, max: 6 });
  });

  after(async () => {
    try {
      await pool?.query("DELETE FROM ops.cycle_run WHERE ciclo LIKE 'T-%'");
      await pool?.query("DELETE FROM ops.watermark WHERE ciclo LIKE 'T-%'");
    } finally {
      await pool?.end();
    }
  });

  beforeEach(async () => {
    alarmes.length = 0;
    await pool.query("DELETE FROM ops.cycle_run WHERE ciclo LIKE 'T-%'");
    await pool.query("DELETE FROM ops.watermark WHERE ciclo LIKE 'T-%'");
  });

  // ── Caminho feliz ─────────────────────────────────────────────────────────

  test("sucesso registra a execução e avança o watermark", async () => {
    const novo = new Date("2026-07-30T11:59:00Z");
    const r = await executarCiclo(
      ciclo("T-ok", async () => ({
        linhasLidas: 120,
        linhasGravadas: 118,
        novoWatermark: novo,
      })),
      deps(),
    );

    assert.equal(r.estado, "ok");
    assert.equal(r.estado === "ok" && r.watermarkAvancou, true);

    const { rows } = await pool.query(
      `SELECT status, linhas_lidas, linhas_gravadas FROM ops.cycle_run WHERE ciclo = 'T-ok'`,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "ok");
    assert.equal(Number(rows[0].linhas_lidas), 120);
    assert.equal(Number(rows[0].linhas_gravadas), 118);

    assert.equal(
      (await lerWatermark(pool, "T-ok"))?.toISOString(),
      novo.toISOString(),
    );
  });

  test("a janela de leitura recua a sobreposição de segurança", async () => {
    const wm = new Date("2026-07-30T11:00:00Z");
    await gravarWatermark(pool, "T-janela", wm);

    let visto: Date | null = null;
    await executarCiclo(
      ciclo("T-janela", async (ctx) => {
        visto = ctx.watermark;
        return { linhasLidas: 0, linhasGravadas: 0 };
      }),
      deps(),
    );

    // Transação longa na origem que commita depois do avanço ficaria invisível
    // sem a sobreposição — e a idempotência torna a releitura inofensiva.
    assert.equal(visto!.getTime(), wm.getTime() - SOBREPOSICAO_MS);
  });

  // ── A regra central ───────────────────────────────────────────────────────

  test("falha NÃO avança o watermark: a janela fica intacta", async () => {
    const wm = new Date("2026-07-30T10:00:00Z");
    await gravarWatermark(pool, "T-falha", wm);

    const r = await executarCiclo(
      ciclo("T-falha", async () => {
        throw new Error("origem indisponível");
      }),
      deps(),
    );

    assert.equal(r.estado, "falha");
    assert.equal(r.estado === "falha" && r.erro, "origem indisponível");

    // O erro perigoso é assimétrico: watermark que avança sem carga apaga a
    // janela para sempre, e ninguém percebe.
    assert.equal(
      (await lerWatermark(pool, "T-falha"))?.toISOString(),
      wm.toISOString(),
    );

    const { rows } = await pool.query(
      `SELECT status, erro FROM ops.cycle_run WHERE ciclo = 'T-falha'`,
    );
    assert.equal(rows[0].status, "falha");
    assert.match(rows[0].erro, /origem indisponível/);
  });

  test("o watermark nunca retrocede", async () => {
    await gravarWatermark(pool, "T-retro", new Date("2026-07-30T11:00:00Z"));
    await gravarWatermark(pool, "T-retro", new Date("2026-07-30T09:00:00Z"));
    // Execução atrasada devolvendo valor antigo não desfaz o progresso.
    assert.equal(
      (await lerWatermark(pool, "T-retro"))?.toISOString(),
      new Date("2026-07-30T11:00:00Z").toISOString(),
    );
  });

  // ── Tentativas e alarme ───────────────────────────────────────────────────

  test("repete conforme a política e só então desiste", async () => {
    let chamadas = 0;
    const r = await executarCiclo(
      ciclo(
        "T-retry",
        async () => {
          chamadas++;
          throw new Error("instável");
        },
        { tentativas: 3, backoff: "exponencial" },
      ),
      deps(),
    );
    assert.equal(chamadas, 3);
    assert.equal(r.estado === "falha" && r.tentativas, 3);
    // Uma execução, três tentativas: o registro é da execução.
    const { rows } = await pool.query(
      `SELECT count(*)::int n FROM ops.cycle_run WHERE ciclo = 'T-retry'`,
    );
    assert.equal(rows[0].n, 1);
  });

  test("sucesso numa tentativa posterior não conta como falha", async () => {
    let chamadas = 0;
    const r = await executarCiclo(
      ciclo(
        "T-recupera",
        async () => {
          chamadas++;
          if (chamadas < 3) throw new Error("timeout");
          return { linhasLidas: 5, linhasGravadas: 5 };
        },
        { tentativas: 3 },
      ),
      deps(),
    );
    assert.equal(r.estado, "ok");
    assert.equal(r.estado === "ok" && r.tentativas, 3);
    assert.equal(alarmes.length, 0);
  });

  test("alarma só depois de N execuções seguidas falhando", async () => {
    const c = ciclo(
      "T-alarme",
      async () => {
        throw new Error("fonte fora");
      },
      { tentativas: 1, alarmeApos: 2 },
    );

    const r1 = await executarCiclo(c, deps());
    assert.equal(
      r1.estado === "falha" && r1.alarmado,
      false,
      "primeira falha não acorda ninguém",
    );
    assert.equal(alarmes.length, 0);

    const r2 = await executarCiclo(c, deps());
    assert.equal(r2.estado === "falha" && r2.alarmado, true);
    assert.equal(alarmes.length, 1);
    assert.equal(alarmes[0]?.falhasConsecutivas, 2);
  });

  test("sucesso zera a contagem de falhas consecutivas", async () => {
    const falho = ciclo("T-zera", async () => {
      throw new Error("x");
    });
    await executarCiclo(falho, deps());
    assert.equal(await contarFalhasConsecutivas(pool, "T-zera"), 1);

    await executarCiclo(
      ciclo("T-zera", async () => ({ linhasLidas: 1, linhasGravadas: 1 })),
      deps(),
    );
    // Um ciclo que falha uma vez por semana tem problema diferente de um que
    // falhou três vezes agora — e é o segundo que precisa acordar alguém.
    assert.equal(await contarFalhasConsecutivas(pool, "T-zera"), 0);
  });

  test("perda irrecuperável escala para crítico já na primeira falha", async () => {
    // É a política do ciclo de eventos de MRR: não existe "tentar de novo
    // amanhã" para a razão de um contrato ter mudado de valor.
    const r = await executarCiclo(
      ciclo(
        "T-critico",
        async () => {
          throw new Error("webhook recusado");
        },
        { tentativas: 1, alarmeApos: 1, degradacao: "alarme_critico" },
      ),
      deps(),
    );
    assert.equal(r.estado === "falha" && r.degradacao, "alarme_critico");
    assert.equal(alarmes[0]?.severidade, "critico");
  });

  test("degradação declarada chega ao alarme", async () => {
    await executarCiclo(
      ciclo(
        "T-degrada",
        async () => {
          throw new Error("CleverTap fora");
        },
        { degradacao: "neutro_sinalizado" },
      ),
      deps(),
    );
    // Quem consome o alarme precisa saber o que fazer com a métrica derivada.
    assert.equal(alarmes[0]?.degradacao, "neutro_sinalizado");
    assert.equal(alarmes[0]?.severidade, "alto");
  });

  // ── Concorrência ──────────────────────────────────────────────────────────

  test("o mesmo ciclo não roda concorrente consigo mesmo", async () => {
    // O ciclo de transações roda a cada 15 minutos. Uma execução que passe de
    // 15 minutos teria a seguinte em cima dela, disputando o mesmo watermark.
    let liberar: () => void = () => undefined;
    const emVoo = new Promise<void>((r) => (liberar = r));

    const lento = executarCiclo(
      ciclo("T-lock", async () => {
        await emVoo;
        return { linhasLidas: 1, linhasGravadas: 1 };
      }),
      deps(),
    );

    // Espera a primeira execução estar de fato dentro do executar().
    for (let i = 0; i < 50; i++) {
      const { rows } = await pool.query(
        `SELECT count(*)::int n FROM ops.cycle_run WHERE ciclo = 'T-lock' AND status = 'rodando'`,
      );
      if (rows[0].n === 1) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const concorrente = await executarCiclo(
      ciclo("T-lock", async () => ({ linhasLidas: 999, linhasGravadas: 999 })),
      deps(),
    );
    assert.equal(concorrente.estado, "pulado");
    assert.equal(
      concorrente.estado === "pulado" && concorrente.motivo,
      "em_execucao",
    );

    liberar();
    assert.equal((await lento).estado, "ok");

    // A execução pulada não deixa registro: ela não aconteceu.
    const { rows } = await pool.query(
      `SELECT count(*)::int n FROM ops.cycle_run WHERE ciclo = 'T-lock'`,
    );
    assert.equal(rows[0].n, 1);
  });

  test("a trava é liberada depois da falha, não fica presa", async () => {
    const c = ciclo("T-unlock", async () => {
      throw new Error("falhou");
    });
    await executarCiclo(c, deps());
    // Se a trava vazasse numa falha, o ciclo pararia de rodar para sempre e o
    // sintoma seria "o ciclo sumiu", não "o ciclo falha".
    const segunda = await executarCiclo(c, deps());
    assert.equal(segunda.estado, "falha");
  });

  test("ciclo que devolve inerte NÃO grava ok — nem falha", async () => {
    // O C18 sem credencial gravava `ok` com 0 lidas, e a tela mostrava "última execução
    // bem-sucedida: hoje" para um ciclo com a tabela de destino vazia. `falha` também
    // não serve: sem credencial ele falharia todo dia, e alarme previsível treina quem
    // está de plantão a ignorar alarme.
    const r = await executarCiclo(
      ciclo("T-INERTE", async () => ({
        linhasLidas: 0,
        linhasGravadas: 0,
        inerte: true,
        detalhe: { motivo: "sem_credencial" },
      })),
      deps(),
    );
    assert.equal(r.estado, "ok", "o executor não trata inerte como erro");

    const { rows } = await pool.query<{
      status: string;
      detalhe: Record<string, unknown>;
    }>(
      "SELECT status, detalhe FROM ops.cycle_run WHERE ciclo = 'T-INERTE' ORDER BY iniciado_em DESC LIMIT 1",
    );
    assert.equal(rows[0]?.status, "inerte");
    assert.equal(rows[0]?.detalhe?.["motivo"], "sem_credencial");

    // E o que a tela usa: `ultimoSucessoEm` olha só `status = 'ok'`, então o ciclo
    // inerte NÃO conta como sucesso — é isso que o faz aparecer como pendente.
    const { rows: suc } = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM ops.cycle_run WHERE ciclo = 'T-INERTE' AND status = 'ok'",
    );
    assert.equal(suc[0]?.n, "0");
  });
});
