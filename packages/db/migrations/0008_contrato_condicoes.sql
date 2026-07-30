-- ═══════════════════════════════════════════════════════════════════════════
-- 0008 — Condições contratuais em core.contract
--
-- Doc do Contratos, seção 05. A ferramenta 2 passa a ser a fonte das condições
-- contratuais, e o HubSpot volta a ser fonte de pipeline.
--
-- Dois destes campos consertam dependências que a ferramenta 1 tinha e não
-- podia resolver sozinha:
--
--   aviso_previo_dias  o fluxo de saída exige CONFIRMAR o aviso prévio antes de
--                      gravar o efeito na receita, e o número só existia dentro
--                      do PDF do contrato, em prosa;
--
--   tipo_receita       taxa de setup e mensalidade estavam no mesmo campo. Sem
--                      separar, a implantação entra na cascata recorrente e o
--                      NRR fica errado de forma consistente — o pior tipo de
--                      erro, porque ninguém desconfia.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;
SET LOCAL ROLE ops_owner;

ALTER TABLE core.contract
  ADD COLUMN numero_contrato   text,
  ADD COLUMN objeto            text,

  -- Recorrente entra na cascata de MRR; pontual (setup) não entra.
  ADD COLUMN tipo_receita      text NOT NULL DEFAULT 'recorrente'
                                 CHECK (tipo_receita IN ('recorrente','pontual')),
  ADD COLUMN vencimento_pontual date,

  -- Tácita exige denúncia; expressa exige ato. Muda o sentido do aviso prévio
  -- e o cálculo do calendário de renovação.
  ADD COLUMN renovacao         text CHECK (renovacao IN ('automatica','expressa')),

  ADD COLUMN reajuste_indice   text,
  ADD COLUMN reajuste_mes      smallint CHECK (reajuste_mes BETWEEN 1 AND 12),

  -- Um estado, não quatro colunas de status como na planilha de origem.
  ADD COLUMN status_vigencia   text NOT NULL DEFAULT 'vigente'
                                 CHECK (status_vigencia IN (
                                   'em_elaboracao','vigente','em_aviso','encerrado','suspenso'
                                 ));

-- Vencimento de parcela só faz sentido em receita pontual.
ALTER TABLE core.contract
  ADD CONSTRAINT vencimento_so_em_pontual CHECK (
    vencimento_pontual IS NULL OR tipo_receita = 'pontual'
  );

CREATE UNIQUE INDEX contract_numero_idx ON core.contract (numero_contrato)
  WHERE numero_contrato IS NOT NULL;
CREATE INDEX contract_reajuste_idx ON core.contract (reajuste_mes)
  WHERE reajuste_mes IS NOT NULL AND status_vigencia = 'vigente';

COMMENT ON COLUMN core.contract.aviso_previo_dias IS
  'Copiado do contrato e confirmado por pessoa no fluxo de saída — o contrato nem sempre é a última palavra: há acordo, renúncia e prorrogação.';
COMMENT ON COLUMN core.contract.tipo_receita IS
  'Separa mensalidade de taxa de setup. Só recorrente entra na cascata de MRR.';

COMMIT;
