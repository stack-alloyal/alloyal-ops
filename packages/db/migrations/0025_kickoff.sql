-- 0025 — O preenchimento do kickoff, compartilhado entre as áreas.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ O PROBLEMA QUE ISTO RESOLVE:                                                │
-- │                                                                            │
-- │ O documento nasceu como artefato do Claude, onde `window.storage` guardava   │
-- │ o preenchimento compartilhado. Servido pelo Pulse, esse objeto não existe —  │
-- │ e o substituto era `localStorage`, que é POR NAVEGADOR. Cada área via só o   │
-- │ que ela mesma digitou, num documento cujo texto promete "o que os times já   │
-- │ registraram".                                                              │
-- │                                                                            │
-- │ Consolidar por exportar/importar JSON funciona e não é o que a tela diz que  │
-- │ acontece. Aqui o dado passa a ser um só.                                    │
-- └───────────────────────────────────────────────────────────────────────────┘

BEGIN;

CREATE TABLE IF NOT EXISTS ops.kickoff_registro (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo        text        NOT NULL,
  -- A ÁREA que preencheu, escolhida na tela. Diferente do autor: uma pessoa de
  -- Operações pode registrar em nome do Financeiro numa sessão conjunta.
  time        text        NOT NULL,
  -- ┌─────────────────────────────────────────────────────────────────────────┐
  -- │ `dados` é jsonb, e é decisão: os seis tipos têm formatos diferentes, e o  │
  -- │ formato é definido pelo DOCUMENTO. Colunas aqui seriam uma segunda        │
  -- │ definição do mesmo formato — e o dia em que o documento ganhar um campo   │
  -- │ novo, esse campo se perde em silêncio até alguém escrever a migration.    │
  -- │                                                                          │
  -- │ O custo é não haver CHECK por campo. Aceito: isto é levantamento de       │
  -- │ kickoff, não dado que sustenta decisão de receita.                        │
  -- └─────────────────────────────────────────────────────────────────────────┘
  dados       jsonb       NOT NULL,
  -- QUEM registrou, pela sessão do Google. Não vem do formulário: é o que permite
  -- deixar remover só o próprio registro sem precisar de senha.
  autor_email text        NOT NULL,
  criado_em   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT kickoff_tipo_check CHECK (
    tipo IN ('dores', 'dados', 'planilhas', 'metricas', 'jornadas', 'automacoes')
  ),
  CONSTRAINT kickoff_time_check CHECK (
    time IN ('comercial', 'financeiro', 'operacoes', 'juridico', 'todos')
  ),
  -- Teto de tamanho: o formulário tem campos de texto livre, e sem limite um
  -- registro pode virar despejo de megabytes. 8 KB cabe qualquer resposta honesta.
  CONSTRAINT kickoff_dados_tamanho CHECK (pg_column_size(dados) <= 8192)
);

COMMENT ON TABLE ops.kickoff_registro IS
  'Preenchimento colaborativo do documento de kickoff do Squad Dados. Compartilhado '
  'entre as áreas: qualquer conta @alloyal.com.br com sessão vê tudo. Antes vivia em '
  'localStorage, onde cada área só via o próprio preenchimento.';

CREATE INDEX IF NOT EXISTS kickoff_tipo_idx ON ops.kickoff_registro (tipo, criado_em DESC);

-- ── Grants ──────────────────────────────────────────────────────────────────
-- `pulse_api` escreve: é a aplicação que serve o documento. DELETE é concedido, e
-- QUEM pode apagar o quê é decidido na rota — remover o próprio registro, ou
-- qualquer um se a pessoa tem permissão de configurar.
GRANT SELECT, INSERT, DELETE ON ops.kickoff_registro TO pulse_api;

-- Sem UPDATE, e é decisão: registro de levantamento se apaga e se refaz. Editar o
-- que outra área escreveu, sem rastro, é a forma mais silenciosa de a pauta mudar
-- de dono.

COMMIT;
