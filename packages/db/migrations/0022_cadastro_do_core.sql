-- 0022 — O cadastro de cliente vindo da API do core (Lecupon v3).
--
-- Ver `docs/adr-018-dados-de-cliente-e-o-allvoice.md`. O Pulse consome a MESMA API
-- que o Allvoice consome; nenhum dos dois é dono, os dois são leitores.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ `core.account` JÁ TINHA A FORMA CERTA e não precisou de tabela nova para a  │
-- │ identidade: `hubspot_company_id`, `cnpj`, `brand_id`, `parent_account_id` e │
-- │ `ativo` mapeiam 1:1 no que a API devolve. O que entra aqui é o que faltava. │
-- └───────────────────────────────────────────────────────────────────────────┘

BEGIN;

-- ── Estado operacional, que muda ao longo do tempo ───────────────────────────
ALTER TABLE core.account
  ADD COLUMN IF NOT EXISTS status_core             text,
  ADD COLUMN IF NOT EXISTS usuarios_cadastrados    int,
  ADD COLUMN IF NOT EXISTS usuarios_autorizados    int,
  ADD COLUMN IF NOT EXISTS contato_email           text,
  ADD COLUMN IF NOT EXISTS sincronizado_em         timestamptz;

COMMENT ON COLUMN core.account.status_core IS
  'O `status` como o core o diz: active, inactive, suspended_by_overdue. Texto livre '
  'de propósito — é valor de terceiro, e um CHECK aqui quebraria a carga no dia em '
  'que o core inventar um estado novo. Quem traduz para linguagem de negócio é a tela.';

COMMENT ON COLUMN core.account.usuarios_cadastrados IS
  'user_count do core. Ao lado de usuarios_autorizados dá adoção da base — a métrica '
  'de Operações que hoje ninguém consegue responder sem abrir três telas.';

COMMENT ON COLUMN core.account.sincronizado_em IS
  'Quando este registro foi lido do core. É a PROCEDÊNCIA exigida pelo doc de '
  'governança: todo número exibido diz de onde veio e quando. NULL = nunca veio do '
  'core (semeado, ou criado por outro caminho).';

-- `brand_id` passa a ser o identificador do core, e precisa ser único: é por ele que
-- o upsert do ciclo encontra a linha. Sem a restrição, uma segunda carga duplicaria
-- toda a base em vez de atualizá-la.
CREATE UNIQUE INDEX IF NOT EXISTS account_brand_id_uk
  ON core.account (brand_id) WHERE brand_id IS NOT NULL;

-- ── Configuração do programa, em formato LONGO ───────────────────────────────
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ POR QUE UMA LINHA POR MÓDULO, E NÃO 30 COLUNAS BOOLEANAS:                  │
-- │                                                                            │
-- │ A API devolve hoje ~30 flags de módulo (cashback, giftcard, marketplace,    │
-- │ telemedicine, subscription, wallet, voucher_bucket, pharmacy…). Em coluna,  │
-- │ cada módulo novo do core seria uma MIGRATION — e o dia em que ninguém       │
-- │ escrever essa migration é o dia em que o módulo simplesmente não aparece,   │
-- │ sem erro nenhum.                                                           │
-- │                                                                            │
-- │ Em formato longo, módulo novo é DADO: entra na próxima carga sozinho.       │
-- └───────────────────────────────────────────────────────────────────────────┘
CREATE TABLE IF NOT EXISTS core.programa_modulo (
  account_id      uuid        NOT NULL REFERENCES core.account(id) ON DELETE CASCADE,
  modulo          text        NOT NULL,
  ativo           boolean     NOT NULL,
  sincronizado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, modulo)
);

COMMENT ON TABLE core.programa_modulo IS
  'Módulos do programa por cliente, como o core os reporta. Formato longo: módulo '
  'novo entra como dado, não como migration. Domínio "Painel do Cliente" da tabela '
  'de fonte da verdade.';

CREATE INDEX IF NOT EXISTS programa_modulo_ativo_idx
  ON core.programa_modulo (modulo) WHERE ativo;

-- ── Grants ──────────────────────────────────────────────────────────────────
-- O WORKER escreve (é ele que roda o ciclo); a API só lê.
GRANT SELECT, INSERT, UPDATE ON core.programa_modulo TO pulse_worker;
GRANT SELECT ON core.programa_modulo TO pulse_api;
-- DELETE só para o worker: módulo que o core deixou de reportar precisa sair, e
-- deixá-lo para trás faria a tela mostrar módulo desligado como se estivesse ativo.
GRANT DELETE ON core.programa_modulo TO pulse_worker;

-- `core.account` já tem grant; as colunas novas o herdam. Conferir depois:
--   SELECT has_column_privilege('pulse_worker','core.account','status_core','UPDATE');

COMMIT;
