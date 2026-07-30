-- ═══════════════════════════════════════════════════════════════════════════
-- 0002 — Entidades canônicas
--
-- Doc 01, seção 14 · ADR-006, ADR-007.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;
SET LOCAL ROLE ops_owner;

-- ─── Contas ────────────────────────────────────────────────────────────────
--
-- A PK é interna (uuid). `hubspot_company_id` é chave EXTERNA única.
--
-- O PRD v1.0 usava `hubspot_id` como PK. Duas consequências que só aparecem
-- depois de meses de dados:
--   1. merge de company no HubSpot é rotina de RevOps e muda o id → toda FK
--      do sistema quebra e não há como remapear sem downtime;
--   2. o próprio catálogo da v1.0 admitia que o id pode não existir para
--      alguns clientes — que então não poderiam existir no sistema.
--
-- `account_alias` resolve os dois: o histórico de ids externos fica registrado
-- com validade, e a conta sobrevive à troca.

CREATE TABLE core.account (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hubspot_company_id    text UNIQUE,
  razao_social          text NOT NULL,
  cnpj                  text,
  porte                 text,
  setor                 text,
  brand_id              text,
  branch_id             text,
  parent_account_id     uuid REFERENCES core.account (id),
  csm_email             text,
  owner_comercial_email text,
  ativo                 boolean NOT NULL DEFAULT true,
  criado_em             timestamptz NOT NULL DEFAULT now(),
  atualizado_em         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN core.account.hubspot_company_id IS
  'Chave externa, NÃO primária (ADR-006). Nullable de propósito: conta pode existir antes do cadastro no HubSpot.';

CREATE INDEX account_brand_branch_idx ON core.account (brand_id, branch_id);
CREATE INDEX account_parent_idx ON core.account (parent_account_id) WHERE parent_account_id IS NOT NULL;

CREATE TABLE core.account_alias (
  account_id  uuid NOT NULL REFERENCES core.account (id) ON DELETE CASCADE,
  sistema     text NOT NULL,          -- hubspot | omie | clevertap | replica
  id_externo  text NOT NULL,
  valido_de   timestamptz NOT NULL DEFAULT now(),
  valido_ate  timestamptz,
  PRIMARY KEY (sistema, id_externo, valido_de)
);

CREATE INDEX account_alias_account_idx ON core.account_alias (account_id);

-- ─── Contratos ─────────────────────────────────────────────────────────────
-- Valor monetário sempre em centavos, inteiro (ADR-007). Nunca ponto flutuante.

CREATE TABLE core.contract (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES core.account (id),
  hubspot_deal_id    text UNIQUE,
  mrr_centavos       bigint NOT NULL CHECK (mrr_centavos >= 0),
  inicio             date NOT NULL,
  vigencia_fim       date,
  vidas_contratadas  integer CHECK (vidas_contratadas IS NULL OR vidas_contratadas > 0),
  multa_clausula     text,
  aviso_previo_dias  integer,
  criado_em          timestamptz NOT NULL DEFAULT now(),
  atualizado_em      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX contract_account_idx ON core.contract (account_id);
CREATE INDEX contract_vigencia_idx ON core.contract (vigencia_fim) WHERE vigencia_fim IS NOT NULL;

-- Multi-produto por cliente como TABELA, não string.
-- A v1.0 tinha `produtos text` no ERD e, ao mesmo tempo, o gap G16 dizendo que
-- multi-produto não estava tratado. Um cliente pode ter clube e Telemed em
-- contratos distintos, e agregar isso por string não sobrevive ao primeiro caso.
CREATE TABLE core.contract_product (
  contract_id  uuid NOT NULL REFERENCES core.contract (id) ON DELETE CASCADE,
  produto      text NOT NULL,
  mrr_centavos bigint NOT NULL DEFAULT 0 CHECK (mrr_centavos >= 0),
  PRIMARY KEY (contract_id, produto)
);

-- ─── Pessoas do cliente ────────────────────────────────────────────────────
-- Gestores e contatos: dado pessoal de profissional, base legal contratual.
-- Usuário FINAL do clube nunca entra aqui — só como pseudônimo em `fact`.

CREATE TABLE core.contact (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES core.account (id) ON DELETE CASCADE,
  nome          text NOT NULL,
  email         text NOT NULL,
  telefone      text,
  cargo         text,
  papel         text,      -- gestor | financeiro | rh | tecnico
  is_principal  boolean NOT NULL DEFAULT false,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, email)
);

COMMENT ON TABLE core.contact IS
  'Profissionais do cliente. Usuário final do clube NUNCA entra aqui: em fact ele aparece só como pseudônimo estável (doc 00, 13).';

-- ─── Leitura ───────────────────────────────────────────────────────────────

GRANT SELECT ON ALL TABLES IN SCHEMA core TO ops_api;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA core TO ops_worker;

COMMIT;
