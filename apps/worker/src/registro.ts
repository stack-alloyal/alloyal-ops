/**
 * Publica a declaração dos ciclos no banco.
 *
 * Roda quando o worker sobe. A declaração no CÓDIGO é a fonte; o banco é o
 * espelho que atravessa a fronteira de processo até o painel de pipeline.
 */

import type pg from "pg";

import { todosOsCiclos } from "./cycle.js";

/** Ciclo cuja implementação ainda é casca. */
const MARCA_NAO_IMPLEMENTADO = "declarado e não implementado";

/**
 * O ciclo é casca?
 *
 * EXPORTADA para o agendador usar a MESMA regra. Ela estava privada, e o resultado
 * apareceu na tela de Sincronização: `registrarDeclaracoes` marcava C1 e C5 como não
 * implementados, e `registrarAgendas` os agendava de qualquer forma — os dois
 * falhavam a cada 15 minutos, 96 vezes por dia cada um, e o histórico virou 90% de
 * ruído que soterrava falha de verdade.
 *
 * Duas regras para a mesma pergunta divergem. Uma só, aqui.
 */
export function ehCasca(ciclo: { executar: unknown }): boolean {
  // ┌───────────────────────────────────────────────────────────────────────────┐
  // │ LÊ A MARCA, NÃO EXECUTA. Antes esta função chamava `executar(undefined)` e   │
  // │ classificava pelo erro, com o comentário "chamar é seguro". Não era: só      │
  // │ parecia seguro porque todo ciclo tocava em `ctx` na primeira linha e quebrava │
  // │ antes de fazer qualquer coisa.                                              │
  // │                                                                            │
  // │ O C19 lê a base e chama a API do fornecedor antes de tocar em `ctx`. Em      │
  // │ 05/08/2026 a "verificação" rodou o ciclo inteiro — 900 chamadas à API — com a │
  // │ transação de `registrarDeclaracoes` ABERTA. O worker não terminava de subir, │
  // │ sem log e sem erro: o sintoma mais caro de diagnosticar que existe.          │
  // │                                                                            │
  // │ Classificar por efeito colateral é frágil por natureza. A marca é declarada  │
  // │ pela fábrica `naoImplementado`, e `registro.test.ts` recusa ciclo que lance a │
  // │ mensagem de casca sem a marca.                                              │
  // └───────────────────────────────────────────────────────────────────────────┘
  return (
    (ciclo.executar as { ehCascaDeclarada?: boolean }).ehCascaDeclarada === true
  );
}

/** Exportada para o teste que impede a divergência entre a marca e a mensagem. */
export const MENSAGEM_DE_CASCA = MARCA_NAO_IMPLEMENTADO;

export async function registrarDeclaracoes(pool: pg.Pool): Promise<number> {
  const ciclos = todosOsCiclos();
  const cliente = await pool.connect();
  try {
    await cliente.query("BEGIN");
    for (const c of ciclos) {
      await cliente.query(
        `INSERT INTO ops.cycle_declaration
           (id, descricao, fonte, metodo, agenda, janela, chave_natural, em_falha, fase, implementado)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (id) DO UPDATE SET
            descricao = EXCLUDED.descricao, fonte = EXCLUDED.fonte, metodo = EXCLUDED.metodo,
            agenda = EXCLUDED.agenda, janela = EXCLUDED.janela,
            chave_natural = EXCLUDED.chave_natural, em_falha = EXCLUDED.em_falha,
            fase = EXCLUDED.fase, implementado = EXCLUDED.implementado,
            atualizado_em = now()`,
        [
          c.id,
          c.descricao,
          c.fonte,
          c.metodo,
          c.agenda,
          c.janela,
          c.chaveNatural,
          JSON.stringify(c.emFalha),
          c.fase,
          !ehCasca(c),
        ],
      );
    }
    // Ciclo removido do código sai do espelho: um painel que continua exibindo
    // um ciclo que não existe mais faz alguém esperar por dado que não vem.
    await cliente.query(
      `DELETE FROM ops.cycle_declaration WHERE id <> ALL($1::text[])`,
      [ciclos.map((c) => c.id)],
    );
    await cliente.query("COMMIT");
    return ciclos.length;
  } catch (err) {
    await cliente.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    cliente.release();
  }
}
