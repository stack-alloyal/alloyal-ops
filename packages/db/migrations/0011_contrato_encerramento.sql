-- 0011 — Quando o contrato de fato terminou.
--
-- `vigencia_fim` é o fim CONTRATADO. Quando um cliente sai antes do prazo — e é
-- a maioria das saídas — as duas datas divergem, e cada uma responde a uma
-- pergunta diferente:
--
--   vigencia_fim   → havia prazo restante? então há multa, e é assunto do Jurídico
--   encerrado_em   → até quando esta receita entrou? é o que a cascata soma
--
-- Sobrescrever `vigencia_fim` no encerramento resolveria a cascata e apagaria a
-- primeira pergunta. São dois fatos, e ficam em duas colunas.
--
-- Por que a coluna vive em `core` e não é lida de `success.cancellation`: a
-- cascata de receita não pode depender do esquema da ferramenta de CS. Se um dia
-- houver encerramento por outro caminho — aquisição, fusão, migração de contrato
-- — ele grava aqui do mesmo jeito, e a receita continua certa.

BEGIN;

ALTER TABLE core.contract
  ADD COLUMN encerrado_em date;

COMMENT ON COLUMN core.contract.encerrado_em IS
  'Data em que o contrato DE FATO parou de produzir receita — o último dia da '
  'última competência cobrada. NULL enquanto vigente. Diferente de vigencia_fim, '
  'que é o fim contratado: a diferença entre as duas é o prazo restante, e é ela '
  'que caracteriza multa por rescisão antecipada.';

COMMENT ON COLUMN core.contract.vigencia_fim IS
  'Fim CONTRATADO da vigência. Não é alterado quando o cliente sai antes — ver '
  'encerrado_em. Consulta de receita histórica deve usar '
  'COALESCE(encerrado_em, vigencia_fim), nunca status_vigencia: status é estado '
  'CORRENTE, e filtrar por ele numa competência passada faz o número daquele mês '
  'mudar no dia em que alguém encerra o contrato.';

COMMENT ON COLUMN core.contract.status_vigencia IS
  'Estado CORRENTE do contrato, para listagens e telas. NUNCA usar em consulta '
  'com recorte de competência passada — use as datas.';

-- Coerência: encerrar exige data, e a data não pode preceder o início.
ALTER TABLE core.contract
  ADD CONSTRAINT encerrado_depois_do_inicio
  CHECK (encerrado_em IS NULL OR encerrado_em >= inicio);

-- Contratos já encerrados na base atual não têm a data — só há a massa sintética
-- e o que este repositório mesmo gravou, e ambos são reconstruíveis. Em produção
-- este backfill precisaria vir da origem, e não de um palpite: sem a data, o mês
-- em que a receita saiu seria inventado.
UPDATE core.contract
   SET encerrado_em = vigencia_fim
 WHERE status_vigencia <> 'vigente'
   AND encerrado_em IS NULL
   AND vigencia_fim IS NOT NULL;

CREATE INDEX contract_encerrado_idx ON core.contract (encerrado_em)
  WHERE encerrado_em IS NOT NULL;

COMMIT;
