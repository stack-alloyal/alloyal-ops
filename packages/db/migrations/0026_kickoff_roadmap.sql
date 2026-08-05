-- 0026 — O Roadmap entra no kickoff: tarefa com área, responsável, prazo e status.
--
-- O CHECK de `tipo` é lista fechada, e é assim de propósito: tipo livre deixaria um
-- erro de digitação virar categoria nova em silêncio. O custo é esta migration.

BEGIN;

ALTER TABLE ops.kickoff_registro DROP CONSTRAINT kickoff_tipo_check;
ALTER TABLE ops.kickoff_registro ADD CONSTRAINT kickoff_tipo_check CHECK (
  tipo IN ('dores', 'dados', 'planilhas', 'metricas', 'jornadas', 'automacoes', 'roadmap')
);

-- Sem coluna nova: `dados` é jsonb e o formato da tarefa é definido pelo DOCUMENTO.
-- Colunas para titulo/responsavel/inicio/fim/status seriam uma segunda definição do
-- mesmo formato, e o campo que o documento ganhasse depois se perderia até alguém
-- escrever outra migration. O mesmo raciocínio da 0025.

COMMIT;
