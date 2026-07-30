-- ═══════════════════════════════════════════════════════════════════════════
-- 0006 — Exceção de referência e fechamento mensal
--
-- Doc do Ops, seções 9 (captação) e 13 (governança de números).
--
-- Duas tabelas que a plataforma declara e não tinha: a fila de registros que
-- não resolveram identidade, e o congelamento da competência.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;
SET LOCAL ROLE ops_owner;

-- ─── Fila de exceção de identidade ─────────────────────────────────────────
--
-- Registro de origem que não casou com nenhuma conta pela cascata de resolução
-- (alias exato → CNPJ normalizado → par marca+filial).
--
-- Existe porque a alternativa é pior das duas maneiras: descartar transforma
-- erro de integração em número errado silencioso, e criar conta na hora produz
-- três contas para o mesmo cliente — com a adesão dividida por um denominador
-- que não existe.
--
-- É fila de TRABALHO, não log: tem dono e estado.

CREATE TABLE ops.excecao_referencia (
  id            bigserial PRIMARY KEY,
  ciclo         text NOT NULL,
  fonte         text NOT NULL,
  -- O payload bruto fica guardado: é o que permite reprocessar depois de
  -- criar o alias, sem precisar bater na origem de novo.
  payload       jsonb NOT NULL,
  motivo        text NOT NULL CHECK (motivo IN (
                  'sem_correspondencia', 'ambiguo', 'cnpj_invalido', 'conta_inativa'
                )),
  -- Preenchido quando o motivo é 'ambiguo': as contas candidatas.
  candidatos    uuid[],
  estado        text NOT NULL DEFAULT 'aberta'
                  CHECK (estado IN ('aberta', 'resolvida', 'descartada')),
  dono          text,
  resolvido_em  timestamptz,
  resolvido_por text,
  -- Para onde o registro foi, quando resolvido criando ou apontando alias.
  account_id    uuid REFERENCES core.account (id),
  nota          text,
  detectado_em  timestamptz NOT NULL DEFAULT now(),

  -- Resolver exige dizer para qual conta foi. Descartar exige dizer por quê.
  CONSTRAINT excecao_resolvida_tem_destino CHECK (
    estado <> 'resolvida'
    OR (account_id IS NOT NULL AND resolvido_por IS NOT NULL AND resolvido_em IS NOT NULL)
  ),
  CONSTRAINT excecao_descartada_tem_nota CHECK (
    estado <> 'descartada' OR (nota IS NOT NULL AND resolvido_por IS NOT NULL)
  )
);

CREATE INDEX excecao_abertas_idx ON ops.excecao_referencia (ciclo, detectado_em DESC)
  WHERE estado = 'aberta';

COMMENT ON TABLE ops.excecao_referencia IS
  'Registro que não resolveu identidade. Nunca descartado em silêncio, nunca cria conta automaticamente. O risco declarado no PRD dispara quando esta fila passa de 2% dos registros do ciclo.';

-- ─── Fechamento mensal congelado ───────────────────────────────────────────
--
-- Doc, seção 13, princípio 4. O comportamento que mais destrói confiança em BI
-- não é o erro pontual: é alguém corrigir um contrato antigo e o gráfico de
-- seis meses atrás mudar.
--
-- Por isso o congelamento é regra de banco, e não combinado de processo.

CREATE TABLE analytics.monthly_close (
  competencia        date PRIMARY KEY,

  -- A cascata da competência. Todos em centavos, inteiros.
  mrr_inicial_centavos       bigint NOT NULL,
  novo_centavos              bigint NOT NULL DEFAULT 0,
  expansao_centavos          bigint NOT NULL DEFAULT 0,
  contracao_centavos         bigint NOT NULL DEFAULT 0,
  churn_pedido_centavos      bigint NOT NULL DEFAULT 0,
  churn_inadimplencia_centavos bigint NOT NULL DEFAULT 0,
  reativacao_centavos        bigint NOT NULL DEFAULT 0,
  ajuste_centavos            bigint NOT NULL DEFAULT 0,
  -- O resíduo aparece. Nunca é empurrado para churn para o gráfico fechar:
  -- número que fecha por construção é número que ninguém confia.
  nao_atribuido_centavos     bigint NOT NULL DEFAULT 0,
  mrr_final_centavos         bigint NOT NULL,

  contas_iniciais    integer NOT NULL,
  contas_perdidas    integer NOT NULL DEFAULT 0,
  contas_novas       integer NOT NULL DEFAULT 0,

  nrr                numeric(6,4),
  grr                numeric(6,4),

  -- Congelamento
  estado             text NOT NULL DEFAULT 'aberta'
                       CHECK (estado IN ('aberta', 'congelada')),
  congelado_por      text,
  congelado_em       timestamptz,
  publicado_em       timestamptz,

  gerado_em          timestamptz NOT NULL DEFAULT now(),

  -- A identidade da cascata tem que fechar, e o resíduo é o que a fecha.
  CONSTRAINT cascata_fecha CHECK (
    mrr_final_centavos = mrr_inicial_centavos
      + novo_centavos + expansao_centavos + reativacao_centavos + ajuste_centavos
      - contracao_centavos - churn_pedido_centavos - churn_inadimplencia_centavos
      + nao_atribuido_centavos
  ),
  CONSTRAINT congelada_tem_autor CHECK (
    estado <> 'congelada' OR (congelado_por IS NOT NULL AND congelado_em IS NOT NULL)
  )
);

-- Competência congelada é imutável. Correção posterior entra como evento de
-- ajuste na competência CORRENTE, com nota — nunca reescreve o passado.
CREATE OR REPLACE FUNCTION analytics.proibe_alterar_congelada() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.estado = 'congelada' THEN
    RAISE EXCEPTION
      'Competência % está congelada e não pode ser alterada. Correção entra como evento tipo=ajuste na competência corrente.', OLD.competencia;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER monthly_close_congelada
  BEFORE UPDATE OR DELETE ON analytics.monthly_close
  FOR EACH ROW EXECUTE FUNCTION analytics.proibe_alterar_congelada();

GRANT SELECT ON ops.excecao_referencia, analytics.monthly_close TO ops_api;
GRANT INSERT, UPDATE ON ops.excecao_referencia TO ops_api;
GRANT SELECT, INSERT, UPDATE ON ops.excecao_referencia TO ops_worker;
GRANT SELECT, INSERT, UPDATE ON analytics.monthly_close TO ops_worker;
GRANT USAGE, SELECT ON SEQUENCE ops.excecao_referencia_id_seq TO ops_api, ops_worker;

COMMIT;
