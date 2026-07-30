-- ═══════════════════════════════════════════════════════════════════════════
-- 0004 — Snapshot diário, sinais e flags
--
-- Doc 00, 6.2 · Doc 01, seções 5, 6 e 14.
--
-- O snapshot é a fronteira entre dado e produto: acima dele é engenharia de
-- dados, abaixo é aplicação. Nenhuma tela agrega sobre `fact` em tempo real.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;
SET LOCAL ROLE ops_owner;

-- ─── Snapshot diário ───────────────────────────────────────────────────────
--
-- Chave composta (competencia, account_id): é o que garante série histórica
-- imutável. O gráfico de março não muda em julho.
--
-- `completo` e `qualidade_por_fonte` existem porque a alternativa — bloquear o
-- snapshot quando uma fonte falha — significa produto no ar sem número nenhum,
-- e tornava a meta O2 (100% de contas com sinal atualizado) impossível por
-- construção. Snapshot parcial é publicado, marcado, e a interface diz o que
-- falta (doc 00, 6.4).

CREATE TABLE metrics.daily_snapshot (
  competencia                 date NOT NULL,
  account_id                  uuid NOT NULL REFERENCES core.account (id),

  -- base
  vidas_contratadas           integer,
  vidas_elegiveis             integer,
  vidas_ativadas_acum         integer,
  vidas_ativas_30d            integer,

  -- engajamento (CleverTap — pode ser NULL até V-08/V-09)
  mau                         integer,
  dau                         integer,

  -- resultado
  transacoes                  integer NOT NULL DEFAULT 0,
  gmv_centavos                bigint  NOT NULL DEFAULT 0,
  cashback_gerado_centavos    bigint  NOT NULL DEFAULT 0,
  cashback_resgatado_centavos bigint  NOT NULL DEFAULT 0,

  -- financeiro
  dias_atraso_max             integer,
  valor_aberto_centavos       bigint,

  -- relacionamento
  dias_desde_ultimo_contato   integer,

  -- contrato
  mrr_centavos                bigint,

  -- qualidade
  completo                    boolean NOT NULL DEFAULT false,
  qualidade_por_fonte         jsonb   NOT NULL DEFAULT '{}'::jsonb,
  gerado_em                   timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (competencia, account_id)
);

COMMENT ON COLUMN metrics.daily_snapshot.vidas_contratadas IS
  'Presente no snapshot de propósito: sem ela nenhuma das três métricas de adesão fecha. Faltava no ERD da v1.0.';

COMMENT ON COLUMN metrics.daily_snapshot.qualidade_por_fonte IS
  'Por fonte: {"omie": {"atualizado_em": "...", "status": "ok|defasado|ausente"}}. Fonte defasada entra NEUTRA e sinalizada — nunca mantendo o último valor.';

CREATE INDEX daily_snapshot_account_idx ON metrics.daily_snapshot (account_id, competencia DESC);
CREATE INDEX daily_snapshot_incompleto_idx ON metrics.daily_snapshot (competencia) WHERE NOT completo;

-- ─── Sinais e drivers ──────────────────────────────────────────────────────
--
-- `score_composto` é NULLABLE de propósito: da F1 até a F6 ele não é publicado.
-- Só a `faixa_por_regra` é mostrada ao time. Score não calibrado ensina o CSM a
-- desconfiar do número, e desconfiança não se desfaz (doc 01, 6.1).

CREATE TABLE metrics.signal (
  competencia        date NOT NULL,
  account_id         uuid NOT NULL REFERENCES core.account (id),
  score_composto     smallint CHECK (score_composto BETWEEN 0 AND 100),
  score_calibrado    boolean NOT NULL DEFAULT false,
  drivers_usados     smallint NOT NULL DEFAULT 0,
  parcial            boolean NOT NULL DEFAULT true,
  faixa_por_regra    text NOT NULL CHECK (faixa_por_regra IN ('saudavel','atencao','risco','critico')),
  faixa_final        text NOT NULL CHECK (faixa_final IN ('saudavel','atencao','risco','critico')),

  -- Override: só para VERMELHO, fora da soma, com justificativa e VALIDADE.
  -- A v1.0 não tinha validade — override esquecido é vermelho permanente, que
  -- o time aprende a ignorar.
  override_ativo     boolean NOT NULL DEFAULT false,
  override_por       text,
  override_motivo    text,
  override_expira_em date,

  -- Trava por indisponibilidade de app: congela adesão e tendência para não
  -- punir o cliente por falha da Alloyal. Diferente de fonte parada, que entra
  -- neutra e sinalizada.
  travado            boolean NOT NULL DEFAULT false,
  travado_motivo     text,

  gerado_em          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (competencia, account_id),

  CONSTRAINT override_exige_justificativa_e_validade CHECK (
    NOT override_ativo
    OR (override_por IS NOT NULL AND override_motivo IS NOT NULL AND override_expira_em IS NOT NULL)
  )
);

CREATE TABLE metrics.signal_driver (
  competencia   date NOT NULL,
  account_id    uuid NOT NULL,
  driver        text NOT NULL CHECK (driver IN (
                  'S-FIN','S-ADO','S-TEN','S-USO','S-CAD','S-REL','S-SUP','S-ENG','S-VOZ'
                )),
  -- NULL = fonte ausente ou defasada. O peso é renormalizado, o driver NÃO
  -- entra como zero. Zero penalizaria o cliente por integração inexistente.
  valor         smallint CHECK (valor IS NULL OR valor BETWEEN 0 AND 100),
  peso_efetivo  numeric(5,2) NOT NULL,
  fonte_status  text NOT NULL CHECK (fonte_status IN ('ok','defasado','ausente')),
  PRIMARY KEY (competencia, account_id, driver),
  FOREIGN KEY (competencia, account_id) REFERENCES metrics.signal (competencia, account_id) ON DELETE CASCADE
);

-- ─── Churn silencioso ──────────────────────────────────────────────────────

CREATE TABLE metrics.silent_churn_flag (
  competencia        date NOT NULL,
  account_id         uuid NOT NULL REFERENCES core.account (id),
  faixa_engajamento  text NOT NULL CHECK (faixa_engajamento IN ('saudavel','em_queda','baixo','nulo')),
  faixa_atraso       text NOT NULL CHECK (faixa_atraso IN ('adimplente','1_30','31_60','61_90','acima_90')),
  severidade         text NOT NULL CHECK (severidade IN ('saudavel','atencao','risco','risco_alto','critico','pdd')),
  dono               text NOT NULL,
  entrou_em          date NOT NULL,
  -- Calibração: tempo entre entrada na faixa e cancelamento real, por vetor.
  -- É o que valida se o sinal antecipa o suficiente para caber ação.
  dias_na_faixa      integer NOT NULL DEFAULT 0,
  PRIMARY KEY (competencia, account_id)
);

CREATE INDEX silent_churn_severidade_idx ON metrics.silent_churn_flag (competencia, severidade);

-- ─── RFM ───────────────────────────────────────────────────────────────────
-- Atividade da base, deliberadamente sem misturar MRR de contrato.

CREATE TABLE metrics.rfm_score (
  competencia  date NOT NULL,
  account_id   uuid NOT NULL REFERENCES core.account (id),
  r_quintil    smallint NOT NULL CHECK (r_quintil BETWEEN 1 AND 5),
  f_quintil    smallint NOT NULL CHECK (f_quintil BETWEEN 1 AND 5),
  m_quintil    smallint NOT NULL CHECK (m_quintil BETWEEN 1 AND 5),
  celula       text NOT NULL,   -- campeoes | leais | em_risco | hibernando | novos
  PRIMARY KEY (competencia, account_id)
);

GRANT SELECT ON ALL TABLES IN SCHEMA metrics TO ops_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA metrics TO ops_worker;

COMMIT;
