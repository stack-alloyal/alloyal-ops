-- ═══════════════════════════════════════════════════════════════════════════
-- 0009 — Declaração dos ciclos
--
-- O painel de pipeline é gerado a partir da declaração dos ciclos. Mas quem
-- declara é o worker, e o painel roda na superfície interna: são dois
-- processos, e a declaração precisa atravessar essa fronteira.
--
-- POR QUE PELO BANCO, e não por import entre os apps:
--
--   · o painel passa a mostrar o que está DE FATO rodando, não o que estava no
--     código com que ele foi empacotado. Se o worker estiver numa versão antiga
--     ou fora do ar, é isso que se quer ver — não uma lista otimista;
--   · evita dependência entre aplicações, que é a fronteira que o chassi
--     mantém deliberadamente;
--   · o histórico de `registrado_em` responde "desde quando este ciclo mudou de
--     agenda", que é a primeira pergunta quando algo passa a rodar na hora
--     errada.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;
SET LOCAL ROLE ops_owner;

CREATE TABLE ops.cycle_declaration (
  id             text PRIMARY KEY,
  descricao      text NOT NULL,
  fonte          text NOT NULL,
  metodo         text NOT NULL,
  -- Nulo em ciclo de webhook: ele é acordado pela fonte, não por agenda.
  agenda         text,
  janela         text NOT NULL,
  chave_natural  text[] NOT NULL,
  em_falha       jsonb NOT NULL,
  fase           text NOT NULL,
  -- Implementado ou ainda casca. O painel precisa distinguir "não rodou porque
  -- falhou" de "não rodou porque ainda não existe".
  implementado   boolean NOT NULL DEFAULT false,
  registrado_em  timestamptz NOT NULL DEFAULT now(),
  atualizado_em  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chave_natural_obrigatoria CHECK (cardinality(chave_natural) > 0)
);

COMMENT ON TABLE ops.cycle_declaration IS
  'Espelho da declaração dos ciclos, escrito pelo worker ao subir. Fonte do painel de pipeline: mostra o que está rodando, não o que está no código de quem exibe.';

GRANT SELECT ON ops.cycle_declaration TO ops_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.cycle_declaration TO ops_worker;

COMMIT;
