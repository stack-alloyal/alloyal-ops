-- 0012 — A biblioteca: distinguir rascunho de versão aposentada.
--
-- A invariante de UMA versão ativa por chave já existe desde a 0007
-- (`playbook_uma_versao_ativa`). O que falta é menor e ainda assim importa:
-- `ativo = false` significa hoje duas coisas diferentes — rascunho que nunca foi
-- publicado, e versão que foi publicada e depois substituída.
--
-- Confundir as duas quebra o histórico de versões que o T11 pede: a lista mostra
-- oito playbooks inativos sem dizer quais valeram algum dia. E quebra a tela de
-- edição, que precisa saber se está abrindo um trabalho em curso ou revivendo
-- algo que já esteve em produção.

BEGIN;

ALTER TABLE success.playbook
  ADD COLUMN substituido_em timestamptz;

COMMENT ON COLUMN success.playbook.substituido_em IS
  'Quando esta versão deixou de ser a ativa. NULL em rascunho nunca publicado E '
  'na versão vigente — o que separa os dois é `ativo`. Rascunho e versão '
  'aposentada são coisas diferentes: uma é trabalho em curso, a outra é histórico.';

COMMENT ON COLUMN success.playbook.gatilhos IS
  'Gatilhos que usam este playbook (G-01 … G-14). Um playbook pode servir a mais '
  'de um gatilho — cobrança relacional é a mesma conversa aos 30 e aos 60 dias, '
  'com urgência diferente.';

COMMENT ON INDEX success.playbook_uma_versao_ativa IS
  'Uma versão ativa por chave. Publicar uma nova exige desativar a anterior na '
  'MESMA transação — ver `publicar()` em @ops/success/biblioteca. Sem isto, dois '
  'playbooks válidos para o mesmo gatilho fazem a pergunta "qual é o processo '
  'hoje" ter duas respostas, e ninguém percebe porque as duas parecem certas.';

-- Índice para a busca que o motor da fila faz a cada avaliação: o playbook ativo
-- de um gatilho. Sem ele é varredura completa da tabela por item gerado.
CREATE INDEX playbook_por_gatilho_ativo
  ON success.playbook USING gin (gatilhos)
  WHERE ativo;

COMMIT;
