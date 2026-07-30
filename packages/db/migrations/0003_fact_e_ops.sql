-- ═══════════════════════════════════════════════════════════════════════════
-- 0003 — Eventos (append-only) e infraestrutura de operação
--
-- Doc 00, seções 4.3, 6.3 e 6.4 · Doc 01, seção 5.5.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;
SET LOCAL ROLE ops_owner;

-- ═══ fact — append-only ════════════════════════════════════════════════════

-- ─── Eventos de MRR ────────────────────────────────────────────────────────
--
-- A tabela mais importante da plataforma, e a que o ciclo C5 alimenta.
-- É o único ciclo cuja perda é IRRECUPERÁVEL: não existe como reconstruir
-- retroativamente a razão pela qual um contrato mudou de valor.
--
-- `origem` e `reconstruido` existem porque o histórico de MRR no HubSpot é
-- parcial. Dado reconstruído nunca aparece na mesma série que dado capturado
-- sem distinção visual (doc 00, 6.1).

CREATE TABLE fact.mrr_event (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES core.account (id),
  contract_id    uuid REFERENCES core.contract (id),
  competencia    date NOT NULL,
  valor_centavos bigint NOT NULL,   -- sinal embutido: contração e churn são negativos
  tipo           text NOT NULL CHECK (tipo IN (
                   'novo', 'expansao', 'contracao',
                   'churn_pedido', 'churn_inadimplencia',
                   'reativacao', 'ajuste'
                 )),
  motivo         text,
  origem         text NOT NULL CHECK (origem IN ('hubspot', 'ops', 'ajuste_manual')),
  reconstruido   boolean NOT NULL DEFAULT false,
  criado_por     text,
  criado_em      timestamptz NOT NULL DEFAULT now(),
  -- Idempotência: chave natural da origem, para upsert sem duplicar (doc 00, 6.4)
  chave_natural  text UNIQUE
);

COMMENT ON COLUMN fact.mrr_event.tipo IS
  'reativacao: conta que saiu da base por PDD e voltou a pagar. ajuste: correção após congelamento, lançada na competência corrente. Nenhum dos dois existia na v1.0.';

CREATE INDEX mrr_event_account_comp_idx ON fact.mrr_event (account_id, competencia);
CREATE INDEX mrr_event_comp_tipo_idx ON fact.mrr_event (competencia, tipo);

-- Append-only imposto pelo banco, não por disciplina de código.
CREATE OR REPLACE FUNCTION fact.proibe_alteracao() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'Esquema fact é append-only. Correção entra como novo evento (tipo=ajuste) na competência corrente. Tabela: %', TG_TABLE_NAME;
END
$$;

CREATE TRIGGER mrr_event_append_only
  BEFORE UPDATE OR DELETE ON fact.mrr_event
  FOR EACH ROW EXECUTE FUNCTION fact.proibe_alteracao();

-- ─── Transações agregadas por conta e dia ──────────────────────────────────
-- Agregado, não linha-a-linha: minimização de dado pessoal (doc 00, 13) e
-- viabilidade de volume. O identificador de usuário final é pseudônimo.

CREATE TABLE fact.transaction_daily (
  account_id                 uuid NOT NULL REFERENCES core.account (id),
  dia                        date NOT NULL,   -- fronteira em America/Sao_Paulo
  transacoes                 integer NOT NULL DEFAULT 0,
  gmv_centavos               bigint NOT NULL DEFAULT 0,
  cashback_gerado_centavos   bigint NOT NULL DEFAULT 0,
  cashback_resgatado_centavos bigint NOT NULL DEFAULT 0,
  usuarios_distintos         integer NOT NULL DEFAULT 0,
  atualizado_em              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, dia)
);

-- ─── Atividade de relacionamento ───────────────────────────────────────────
-- E-mail, reunião e WhatsApp na mesma tabela: o driver de recência só faz
-- sentido se considerar os três. A v1.0 tinha o WhatsApp como "corrige o driver
-- de recência", o que já é a admissão de que separá-los produz número errado.

CREATE TABLE fact.activity (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES core.account (id),
  tipo         text NOT NULL CHECK (tipo IN ('email', 'reuniao', 'whatsapp', 'ligacao', 'item_trabalho')),
  ocorreu_em   timestamptz NOT NULL,
  ator_email   text,
  resumo       text,
  origem       text NOT NULL,
  chave_natural text UNIQUE,
  criado_em    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX activity_account_data_idx ON fact.activity (account_id, ocorreu_em DESC);

-- ═══ ops — operação da plataforma ══════════════════════════════════════════

-- ─── Watermark ─────────────────────────────────────────────────────────────
-- Avançado só depois de carga bem-sucedida, com sobreposição de segurança para
-- tolerar relógio e transação longa (doc 00, 6.4).

CREATE TABLE ops.watermark (
  ciclo           text PRIMARY KEY,
  valor           timestamptz NOT NULL,
  sobreposicao    interval NOT NULL DEFAULT interval '5 minutes',
  atualizado_em   timestamptz NOT NULL DEFAULT now()
);

-- ─── Qualidade por ciclo ───────────────────────────────────────────────────
CREATE TABLE ops.cycle_run (
  id             bigserial PRIMARY KEY,
  ciclo          text NOT NULL,
  iniciado_em    timestamptz NOT NULL DEFAULT now(),
  terminado_em   timestamptz,
  status         text NOT NULL CHECK (status IN ('rodando', 'ok', 'falha', 'parcial')),
  linhas_lidas   bigint,
  linhas_gravadas bigint,
  erro           text,
  detalhe        jsonb
);

CREATE INDEX cycle_run_ciclo_idx ON ops.cycle_run (ciclo, iniciado_em DESC);

CREATE TABLE ops.divergencia (
  id            bigserial PRIMARY KEY,
  ciclo         text NOT NULL,
  account_id    uuid REFERENCES core.account (id),
  competencia   date,
  metrica       text NOT NULL,
  valor_ops     numeric,
  valor_fonte   numeric,
  detectado_em  timestamptz NOT NULL DEFAULT now(),
  resolvido_em  timestamptz,
  nota          text
);

-- ─── Auditoria: somente inserção ───────────────────────────────────────────
CREATE TABLE ops.audit (
  id            bigserial PRIMARY KEY,
  ator          text NOT NULL,
  papel         text,
  acao          text NOT NULL,
  account_id    uuid,
  recurso       text,
  antes         jsonb,
  depois        jsonb,
  origem_ip     inet,
  user_agent    text,
  justificativa text,
  ocorreu_em    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_account_idx ON ops.audit (account_id, ocorreu_em DESC);
CREATE INDEX audit_ator_idx ON ops.audit (ator, ocorreu_em DESC);

CREATE TRIGGER audit_append_only
  BEFORE UPDATE OR DELETE ON ops.audit
  FOR EACH ROW EXECUTE FUNCTION fact.proibe_alteracao();

-- ─── Papéis de pessoa, sincronizados do Workspace ──────────────────────────
-- Doc 00, 5.1: papéis derivados de GRUPO do Workspace, não de lista paralela.
-- Desligamento revoga acesso sem ninguém precisar lembrar de limpar.

CREATE TABLE ops.user_role (
  email          text NOT NULL,
  papel          text NOT NULL CHECK (papel IN (
                   'ops-csm', 'ops-cs-lead', 'ops-implantacao', 'ops-comercial',
                   'ops-financeiro', 'ops-diretoria', 'ops-admin', 'ops-dados'
                 )),
  sincronizado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (email, papel)
);

-- ─── Feature flags ─────────────────────────────────────────────────────────
CREATE TABLE ops.feature_flag (
  chave        text PRIMARY KEY,
  habilitado   boolean NOT NULL DEFAULT false,
  -- Liberação por lote de contas: release do portal nunca vai para a base toda
  -- de uma vez (doc 00, 11).
  contas       uuid[],
  descricao    text,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

-- ─── Incidente de dado ─────────────────────────────────────────────────────
-- Doc 00, 6.8. Em algum momento a plataforma vai mostrar um número errado,
-- provavelmente para um cliente. A tabela existe para que a resposta seja um
-- processo, e não uma conversa no WhatsApp.

CREATE TABLE ops.data_incident (
  id            bigserial PRIMARY KEY,
  metrica       text NOT NULL,
  account_id    uuid REFERENCES core.account (id),
  competencia   date,
  aberto_por    text NOT NULL,
  aberto_em     timestamptz NOT NULL DEFAULT now(),
  lineage       jsonb,             -- envelope no momento da abertura
  exposto_a_cliente boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'aberto'
                  CHECK (status IN ('aberto', 'confirmado', 'improcedente', 'corrigido')),
  dono          text,
  resolvido_em  timestamptz,
  nota          text
);

GRANT SELECT ON ALL TABLES IN SCHEMA fact, ops TO ops_api;
GRANT INSERT ON ops.audit, ops.data_incident TO ops_api;
GRANT UPDATE ON ops.feature_flag, ops.data_incident TO ops_api;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA fact, ops TO ops_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ops TO ops_api, ops_worker;

COMMIT;
