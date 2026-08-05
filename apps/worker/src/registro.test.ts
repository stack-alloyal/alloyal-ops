/**
 * Publicação da declaração dos ciclos.
 *
 * O painel de pipeline lê daqui. O que importa é que ele mostre o que está DE
 * FATO rodando — inclusive a diferença entre "ainda não existe" e "existe e
 * falhou", que são conversas diferentes.
 */

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import pg from "pg";

import { todosOsCiclos } from "./cycle.js";
import "./cycles/index.js";
import {
  MENSAGEM_DE_CASCA,
  ehCasca,
  registrarDeclaracoes,
} from "./registro.js";

const ADMIN = process.env["DATABASE_URL_ADMIN"];

describe("declaração dos ciclos", { skip: !ADMIN }, () => {
  let pool: pg.Pool;

  before(async () => {
    const { migrate } = await import("@pulse/db");
    await migrate(ADMIN as string);
    pool = new pg.Pool({ connectionString: ADMIN });
  });

  after(async () => {
    await pool?.end();
  });

  test("publica todos os ciclos declarados", async () => {
    const n = await registrarDeclaracoes(pool);
    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*) n FROM ops.cycle_declaration",
    );
    assert.equal(Number(rows[0]?.n), n);
    assert.equal(n, todosOsCiclos().length);
  });

  test("republicar é idempotente", async () => {
    await registrarDeclaracoes(pool);
    await registrarDeclaracoes(pool);
    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*) n FROM ops.cycle_declaration",
    );
    assert.equal(Number(rows[0]?.n), todosOsCiclos().length);
  });

  test("ciclo removido do código sai do espelho", async () => {
    // Um painel que continua exibindo um ciclo que não existe mais faz alguém
    // esperar por dado que não vem.
    await pool.query(
      `INSERT INTO ops.cycle_declaration
         (id, descricao, fonte, metodo, agenda, janela, chave_natural, em_falha, fase)
       VALUES ('C99','fantasma','x','full','0 1 * * *','estado_atual',ARRAY['id'],'{}'::jsonb,'F9')`,
    );
    await registrarDeclaracoes(pool);
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) n FROM ops.cycle_declaration WHERE id = 'C99'`,
    );
    assert.equal(Number(rows[0]?.n), 0);
  });

  test("distingue ciclo implementado de casca", async () => {
    await registrarDeclaracoes(pool);
    const { rows } = await pool.query<{ id: string; implementado: boolean }>(
      "SELECT id, implementado FROM ops.cycle_declaration ORDER BY id",
    );
    // C12 chama a consolidação de verdade; os demais aguardam o spike de dados.
    const c12 = rows.find((r) => r.id === "C12");
    assert.equal(
      c12?.implementado,
      true,
      "C12 está implementado e deveria constar como tal",
    );
    assert.ok(
      rows.some((r) => !r.implementado),
      "a fase atual ainda tem ciclos por implementar",
    );
  });

  test("a política de falha viaja junto, para o painel saber o que alarmar", async () => {
    await registrarDeclaracoes(pool);
    const { rows } = await pool.query<{ degradacao: string }>(
      `SELECT em_falha->>'degradacao' degradacao FROM ops.cycle_declaration WHERE id = 'C5'`,
    );
    // C5 é o único com perda irrecuperável: ele escala na primeira falha.
    assert.equal(rows[0]?.degradacao, "alarme_critico");
  });
});

test("nenhum ciclo é classificado por efeito colateral: a casca é DECLARADA", () => {
  // ┌───────────────────────────────────────────────────────────────────────────┐
  // │ Este teste existe por um incidente. `ehCasca` EXECUTAVA o ciclo para saber   │
  // │ se era casca, e o comentário dizia "chamar é seguro". Só era seguro porque   │
  // │ todo ciclo tocava em `ctx` na primeira linha. O C19 não toca — ele lê a base │
  // │ e chama a API do fornecedor antes — e a "verificação" rodou 900 chamadas     │
  // │ segurando aberta a transação de registro. O worker não subia, sem log.       │
  // │                                                                            │
  // │ Agora a marca é declarada, e o risco novo é o oposto: uma casca ESQUECER a   │
  // │ marca e passar por implementada. O teste lê o CÓDIGO da função — sem         │
  // │ executá-la — e recusa quem lança a mensagem de casca sem estar marcada.      │
  // └───────────────────────────────────────────────────────────────────────────┘
  for (const c of todosOsCiclos()) {
    const fonte = String(c.executar);
    const pareceCasca = fonte.includes(MENSAGEM_DE_CASCA);
    assert.equal(
      ehCasca(c),
      pareceCasca,
      `${c.id}: a marca de casca e a mensagem discordam. ` +
        "Casca se declara com `naoImplementado(id)`, nunca só lançando a mensagem.",
    );
  }
});

test("ciclo implementado NÃO é executado para ser classificado", () => {
  // A prova de que a classificação não tem efeito colateral: um ciclo cujo `executar`
  // registra a chamada continua com o contador em zero depois de classificado.
  let chamou = 0;
  const falso = {
    id: "T-EFEITO",
    executar: async () => {
      chamou++;
      return { linhasLidas: 0, linhasGravadas: 0 };
    },
  };
  assert.equal(ehCasca(falso), false);
  assert.equal(chamou, 0, "classificar não pode executar o ciclo");
});
