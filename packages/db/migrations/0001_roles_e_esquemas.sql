-- ═══════════════════════════════════════════════════════════════════════════
-- 0001 — Papéis do banco e esquemas por camada
--
-- Doc 00, seções 4.3 e 5.4.
--
-- Três papéis, de propósito. A alternativa (um papel para tudo) faz o
-- isolamento de tenant depender inteiramente do código da aplicação, e o
-- objetivo do desenho é justamente que ele sobreviva a um bug de aplicação.
--
--   ops_owner   — dono do schema. Só roda migration. Não é usado em runtime.
--   ops_api     — superfície interna. Lê core/fact/metrics/analytics/ops.
--                 NÃO tem grant nenhum em public_v.
--   ops_portal  — superfície do cliente. SÓ public_v, SÓ SELECT, sob RLS.
--   ops_worker  — ingestão e consolidação. Escreve. Sob política própria.
--
-- Nenhum deles tem BYPASSRLS. Nenhum deles é superusuário.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── Papéis ────────────────────────────────────────────────────────────────
-- Senhas são atribuídas fora da migration (ver infra/secrets/README.md).
-- `NOINHERIT` em ops_portal: ele não deve herdar nada de grupo algum.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ops_owner') THEN
    CREATE ROLE ops_owner NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ops_api') THEN
    CREATE ROLE ops_api LOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ops_portal') THEN
    CREATE ROLE ops_portal LOGIN NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ops_worker') THEN
    CREATE ROLE ops_worker LOGIN NOBYPASSRLS;
  END IF;
END
$$;

-- ─── Esquemas ──────────────────────────────────────────────────────────────
-- Um esquema por camada do fluxo de dados, não por sistema de origem.
-- A fronteira entre `metrics` e o que está acima dele é a fronteira entre
-- engenharia de dados e aplicação: nenhuma tela agrega sobre `fact`.

CREATE SCHEMA IF NOT EXISTS core       AUTHORIZATION ops_owner;  -- entidades canônicas
CREATE SCHEMA IF NOT EXISTS fact       AUTHORIZATION ops_owner;  -- eventos, append-only
CREATE SCHEMA IF NOT EXISTS metrics    AUTHORIZATION ops_owner;  -- snapshot diário e sinais
CREATE SCHEMA IF NOT EXISTS analytics  AUTHORIZATION ops_owner;  -- fechamento congelado
CREATE SCHEMA IF NOT EXISTS public_v   AUTHORIZATION ops_owner;  -- agregados do cliente
CREATE SCHEMA IF NOT EXISTS ops        AUTHORIZATION ops_owner;  -- auditoria, qualidade, flags
CREATE SCHEMA IF NOT EXISTS success    AUTHORIZATION ops_owner;  -- domínio da ferramenta 1

-- ─── Uso dos esquemas ──────────────────────────────────────────────────────
-- ops_portal recebe USAGE APENAS em public_v. Ele não consegue nem enxergar
-- que os outros esquemas existem.

GRANT USAGE ON SCHEMA core, fact, metrics, analytics, ops, success TO ops_api, ops_worker;
GRANT USAGE ON SCHEMA public_v TO ops_worker;
GRANT USAGE ON SCHEMA public_v TO ops_portal;

REVOKE ALL ON SCHEMA core, fact, metrics, analytics, ops, success FROM ops_portal;
REVOKE ALL ON SCHEMA public FROM PUBLIC;

-- ─── Extensões ─────────────────────────────────────────────────────────────
-- `pgcrypto` para gen_random_uuid(). `pgvector` NÃO entra: ADR-014 — componente
-- sem caso de uso é dívida. A migration que o habilitar deve citar o caso.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── Convenção de fuso ─────────────────────────────────────────────────────
-- Armazenamento em UTC; fronteira de dia calculada em America/Sao_Paulo.
-- O identificador correto é `America/Sao_Paulo` — sem acento. `America/São_Paulo`
-- NÃO existe na base IANA e é uma fonte real de bug em pipeline diário.

DO $$
BEGIN
  PERFORM now() AT TIME ZONE 'America/Sao_Paulo';
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Fuso America/Sao_Paulo indisponível neste servidor (tzdata ausente?)';
END
$$;

COMMENT ON SCHEMA fact IS
  'Append-only. Correção não é UPDATE: é evento de correção. É o que torna o congelamento do fechamento mensal defensável (doc 00, 6.7).';

COMMENT ON SCHEMA public_v IS
  'Única camada alcançável pelo gateway externo. RLS forçado. Escrita apenas pela consolidação.';

COMMIT;
