-- 0029 — Um ciclo pode ter rodado sem fazer o trabalho, e o painel precisa dizer isso.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ O DEFEITO QUE ISTO CORRIGE, medido em 05/08/2026:                          │
-- │                                                                            │
-- │ O C18 (cadastro de cliente do core) rodou às 05:00 e gravou `status = 'ok'`  │
-- │ com 0 lidas e 0 gravadas, porque a credencial não está cadastrada. Na tela   │
-- │ de Sincronização isso aparece como "última execução bem-sucedida: hoje" —    │
-- │ para um ciclo que nunca leu uma linha e uma tabela `core.account` vazia.     │
-- │                                                                            │
-- │ `falha` não serve: ciclo sem credencial falha TODO dia, e alarme previsível  │
-- │ treina quem está de plantão a ignorar alarme. `inerte` é a terceira coisa    │
-- │ que de fato aconteceu — rodou, não deu erro, não fez o trabalho.            │
-- │                                                                            │
-- │ Consequência de graça: `ultimoSucessoEm` só olha `status = 'ok'`, então um    │
-- │ ciclo inerte passa a contar como ATRASADO na tela, que é a verdade.         │
-- └───────────────────────────────────────────────────────────────────────────┘

BEGIN;

ALTER TABLE ops.cycle_run DROP CONSTRAINT IF EXISTS cycle_run_status_check;
ALTER TABLE ops.cycle_run ADD CONSTRAINT cycle_run_status_check CHECK (
  status IN ('rodando', 'ok', 'falha', 'parcial', 'inerte')
);

-- As execuções que JÁ mentiram: `ok` com zero linhas e motivo de falta de credencial
-- registrado no detalhe. Reescritas para o que foram. Só estas — `ok` com zero linhas
-- e sem motivo pode ser legítimo (nada mudou na origem).
UPDATE ops.cycle_run
   SET status = 'inerte'
 WHERE status = 'ok'
   AND coalesce(linhas_lidas, 0) = 0
   AND coalesce(linhas_gravadas, 0) = 0
   AND detalhe->>'motivo' = 'sem_credencial';

COMMIT;
