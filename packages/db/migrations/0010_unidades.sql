-- Unidades escritas onde o dado mora.
--
-- `peso_efetivo` guarda PONTOS PERCENTUAIS (27.78 significa 27,78%), não uma
-- fração. A ambiguidade custou um número errado numa tela — 27.78 foi
-- multiplicado por 100 e virou "2778%" — e o tipo `numeric(5,2)` aceita as duas
-- leituras sem reclamar. Comentário no banco em vez de só no código porque
-- quem escreve a próxima consulta abre o `\d+`, não o repositório.

COMMENT ON COLUMN metrics.signal_driver.peso_efetivo IS
  'Pontos percentuais (0–100), já renormalizados: driver ausente sai da conta e '
  'distribui o próprio peso entre os que ficaram. A soma por (competencia, '
  'account_id) é 100 quando há ao menos um driver com valor.';

COMMENT ON COLUMN metrics.signal_driver.valor IS
  'Escala 0–100. NULL = fonte ausente ou defasada; o driver NÃO entra como zero, '
  'porque zero penalizaria o cliente por integração que não existe.';

COMMENT ON COLUMN metrics.signal.score_composto IS
  'Escala 0–100, ou NULL quando drivers demais faltaram para o número significar '
  'algo. Ver `score_calibrado`: falso significa ordenação útil, não probabilidade.';

COMMENT ON COLUMN metrics.daily_snapshot.qualidade_por_fonte IS
  'Objeto {fonte: {atualizado_em, status}} com status em (ok|defasado|ausente). '
  'É o que alimenta o envelope de linhagem na tela — sem ele, número defasado '
  'apareceria igual a número íntegro.';
