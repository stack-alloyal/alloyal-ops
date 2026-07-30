-- ═══════════════════════════════════════════════════════════════════════════
-- 0005 — public_v: a única camada alcançável pelo cliente
--
-- Doc 00, seções 5.4 e 13 · Doc 01, 17.3.
--
-- ┌───────────────────────────────────────────────────────────────────────┐
-- │ Esta migration é a camada 3 do isolamento de tenant. Ela existe para   │
-- │ que o isolamento sobreviva a um bug de aplicação.                     │
-- │                                                                        │
-- │ Três armadilhas de RLS que fazem o teste passar e a produção vazar:   │
-- │                                                                        │
-- │  1. ENABLE ROW LEVEL SECURITY não vale para o DONO da tabela.          │
-- │     Sem FORCE, quem for owner lê tudo. → FORCE em todas.               │
-- │                                                                        │
-- │  2. Papel com BYPASSRLS ignora política. → nenhum papel de runtime     │
-- │     tem BYPASSRLS (migration 0001), e nenhum é superusuário.           │
-- │                                                                        │
-- │  3. `app.current_tenant` definido em nível de SESSÃO vaza entre        │
-- │     requisições quando há pool transacional. → set_config(..., true),  │
-- │     transaction-local. Ver public_v.set_tenant() abaixo.               │
-- └───────────────────────────────────────────────────────────────────────┘
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;
SET LOCAL ROLE ops_owner;

-- ─── Resolução do tenant ───────────────────────────────────────────────────
--
-- As funções vivem em `public_v`, e não em `ops`, por um motivo de superfície:
-- assim `ops_portal` precisa de USAGE em EXATAMENTE UM esquema. Se elas
-- morassem em `ops`, o papel externo precisaria de USAGE ali — e passaria a
-- enxergar a existência de `ops.audit`, `ops.user_role` e `ops.data_incident`,
-- dependendo apenas de grant por tabela para não lê-los. Um esquema alcançável
-- é uma invariante auditável; sete não são.
--
-- NULLIF trata o caso da string vazia: `''::uuid` levantaria exceção e viraria
-- erro 500 em vez de conjunto vazio. Ausente ou vazio → NULL → nenhuma linha.
-- Falha fechada, sempre.

CREATE OR REPLACE FUNCTION public_v.current_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_tenant', true), '')::uuid
$$;

COMMENT ON FUNCTION public_v.current_tenant() IS
  'Tenant da transação corrente. NULL quando não definido — e política com NULL não devolve linha. Falha fechada por construção.';

-- Único caminho suportado para definir o tenant. O terceiro argumento `true`
-- é o que torna o valor transaction-local: sem ele, o GUC persiste na conexão
-- e a próxima requisição que pegar essa conexão do pool herda o tenant anterior.
CREATE OR REPLACE FUNCTION public_v.set_tenant(p_account_id uuid) RETURNS void
LANGUAGE sql AS $$
  SELECT set_config('app.current_tenant', p_account_id::text, true)
$$;

REVOKE ALL ON FUNCTION public_v.set_tenant(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_v.current_tenant() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_v.set_tenant(uuid) TO ops_portal, ops_worker;
GRANT EXECUTE ON FUNCTION public_v.current_tenant() TO ops_portal, ops_worker;

-- ─── Métrica diária do cliente ─────────────────────────────────────────────
--
-- `competencia` está aqui porque o módulo principal do portal é EVOLUÇÃO.
-- O ERD da v1.0 modelava esta tabela sem dimensão de tempo, o que a tornava
-- incapaz de servir a própria tela que ela existia para servir.
--
-- `suprimido` + `n_base` estão aqui porque supressão precisa ser explicável.
-- Devolver vazio faz o gestor de um cliente pequeno achar que o clube não
-- funciona; devolver `suprimido` permite à tela dizer a regra e o que fazer.

CREATE TABLE public_v.metric_daily (
  account_id   uuid NOT NULL REFERENCES core.account (id),
  competencia  date NOT NULL,
  metrica      text NOT NULL,
  valor        numeric,
  n_base       integer,
  suprimido    boolean NOT NULL DEFAULT false,
  gerado_em    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, competencia, metrica),

  -- Invariante: linha suprimida não carrega valor. Impede que uma consulta
  -- distraída leia `valor` ignorando o flag.
  CONSTRAINT suprimido_nao_tem_valor CHECK (NOT suprimido OR valor IS NULL)
);

CREATE INDEX metric_daily_lookup_idx
  ON public_v.metric_daily (account_id, metrica, competencia DESC);

-- ─── Benchmark anônimo ─────────────────────────────────────────────────────
--
-- k-anonimato de EMPRESAS, não só de pessoas. Com duas empresas num corte de
-- porte × setor, uma deduz a outra — e a v1.0 só exigia N mínimo de usuários.

CREATE TABLE public_v.benchmark_monthly (
  competencia   date NOT NULL,
  porte         text NOT NULL,
  setor         text NOT NULL,
  metrica       text NOT NULL,
  p25           numeric,
  p50           numeric,
  p75           numeric,
  n_empresas    integer NOT NULL,
  n_pessoas     integer NOT NULL,
  suprimido     boolean NOT NULL DEFAULT false,
  PRIMARY KEY (competencia, porte, setor, metrica),

  CONSTRAINT benchmark_k_anonimato CHECK (
    suprimido OR (n_empresas >= 5 AND n_pessoas >= 50)
  )
);

COMMENT ON CONSTRAINT benchmark_k_anonimato ON public_v.benchmark_monthly IS
  'Doc 00, 13: benchmark exige 5 empresas E 50 pessoas no grupo. O banco recusa a linha que não atende — a regra é propriedade do dado, não filtro de consulta.';

-- ═══ RLS ═══════════════════════════════════════════════════════════════════

ALTER TABLE public_v.metric_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_v.metric_daily FORCE  ROW LEVEL SECURITY;

-- O cliente lê apenas as próprias linhas, e apenas SELECT.
CREATE POLICY tenant_read ON public_v.metric_daily
  FOR SELECT TO ops_portal
  USING (account_id = public_v.current_tenant());

-- A consolidação escreve tudo. Precisa de política própria porque FORCE vale
-- inclusive para o dono da tabela.
CREATE POLICY worker_all ON public_v.metric_daily
  FOR ALL TO ops_worker
  USING (true) WITH CHECK (true);

-- Benchmark é agregado entre clientes: não tem tenant, logo não tem RLS por
-- linha. A proteção é a restrição de k-anonimato acima, imposta pelo CHECK.
ALTER TABLE public_v.benchmark_monthly ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_v.benchmark_monthly FORCE  ROW LEVEL SECURITY;

CREATE POLICY benchmark_read ON public_v.benchmark_monthly
  FOR SELECT TO ops_portal
  USING (NOT suprimido);

CREATE POLICY benchmark_worker ON public_v.benchmark_monthly
  FOR ALL TO ops_worker
  USING (true) WITH CHECK (true);

-- ═══ Grants ════════════════════════════════════════════════════════════════

GRANT SELECT ON public_v.metric_daily, public_v.benchmark_monthly TO ops_portal;
GRANT SELECT, INSERT, UPDATE, DELETE ON public_v.metric_daily, public_v.benchmark_monthly TO ops_worker;

-- A superfície interna NÃO lê public_v. Ela lê `metrics`, que é a fonte.
-- Se o interno lesse a versão suprimida, o número mostrado ao CSM passaria a
-- depender do tamanho da base do cliente — e "paridade interno/portal" viraria
-- uma comparação de uma camada consigo mesma.
REVOKE ALL ON ALL TABLES IN SCHEMA public_v FROM ops_api;
REVOKE USAGE ON SCHEMA public_v FROM ops_api;

-- Padrão para tabelas futuras neste esquema: nada é liberado por acidente.
ALTER DEFAULT PRIVILEGES IN SCHEMA public_v REVOKE ALL ON TABLES FROM PUBLIC;

COMMIT;
