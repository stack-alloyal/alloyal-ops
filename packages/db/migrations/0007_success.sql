-- ═══════════════════════════════════════════════════════════════════════════
-- 0007 — Domínio da ferramenta 1 (Success)
--
-- O esquema existia desde a 0001 e estava vazio. Aqui entram as entidades da
-- fila de trabalho, da biblioteca, da implantação, da renovação e da saída.
--
-- Três invariantes desta migration são imposições de banco, não convenções:
--   1. uma conta tem no máximo UM item aberto por família de gatilho;
--   2. fechar item exige desfecho;
--   3. o efeito na receita de um cancelamento exige as DUAS confirmações.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;
SET LOCAL ROLE ops_owner;

-- ─── Biblioteca ────────────────────────────────────────────────────────────
-- Conteúdo versionado, editável pelo time de CS sem deploy.

CREATE TABLE success.playbook (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chave          text NOT NULL,
  versao         integer NOT NULL DEFAULT 1,
  titulo         text NOT NULL,
  conteudo       text NOT NULL,
  -- Gatilhos que usam este playbook (G-01 … G-14).
  gatilhos       text[] NOT NULL DEFAULT '{}',
  ativo          boolean NOT NULL DEFAULT false,
  publicado_por  text,
  publicado_em   timestamptz,
  criado_em      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chave, versao),
  CONSTRAINT playbook_ativo_foi_publicado CHECK (
    NOT ativo OR (publicado_por IS NOT NULL AND publicado_em IS NOT NULL)
  )
);

-- Só uma versão ativa por chave: a fila precisa saber qual playbook anexar.
CREATE UNIQUE INDEX playbook_uma_versao_ativa ON success.playbook (chave) WHERE ativo;

-- ─── Fila de trabalho ──────────────────────────────────────────────────────

CREATE TABLE success.work_item (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES core.account (id),

  gatilho       text NOT NULL,   -- G-01 … G-14
  familia       text NOT NULL,   -- financeiro · adesao · churn_silencioso · …
  prioridade    text NOT NULL CHECK (prioridade IN ('baixa','media','alta','critica')),

  -- O motivo é escrito em linguagem natural COM o número dentro: o CSM precisa
  -- concordar com o motivo antes de agir. "score caiu" não serve.
  motivo        text NOT NULL,
  -- A evidência que sustenta o motivo, para aparecer na própria linha da fila.
  evidencia     jsonb NOT NULL DEFAULT '{}'::jsonb,

  dono_email    text NOT NULL,
  prazo         date NOT NULL,
  playbook_id   uuid REFERENCES success.playbook (id),

  estado        text NOT NULL DEFAULT 'aberto'
                  CHECK (estado IN ('aberto','backlog','fechado')),

  -- Fechar exige desfecho. Falso positivo é o que alimenta a calibração do
  -- gatilho — sem ele a fila degrada em ruído e ninguém percebe.
  desfecho      text CHECK (desfecho IN ('resolvido','sem_acao','falso_positivo','escalado')),
  desfecho_nota text,

  -- Item em modo sombra é visível só para a liderança, que aprova a promoção
  -- do gatilho depois de 14 dias. Nenhum gatilho novo vai direto ao time.
  modo_sombra   boolean NOT NULL DEFAULT true,

  competencia   date NOT NULL,   -- o snapshot que gerou o item
  criado_em     timestamptz NOT NULL DEFAULT now(),
  fechado_em    timestamptz,
  fechado_por   text,

  CONSTRAINT fechar_exige_desfecho CHECK (
    estado <> 'fechado'
    OR (desfecho IS NOT NULL AND fechado_em IS NOT NULL AND fechado_por IS NOT NULL)
  )
);

-- ── Deduplicação por família, imposta pelo banco ──
-- Uma conta tem no máximo UM item aberto por família de gatilho. O segundo
-- sinal atualiza a evidência do item existente em vez de criar outro.
-- Sem isto, o mesmo atraso de pagamento vira três notificações para um fato —
-- que é como se ensina o time a silenciar a ferramenta.
CREATE UNIQUE INDEX work_item_uma_familia_aberta
  ON success.work_item (account_id, familia)
  WHERE estado IN ('aberto','backlog');

CREATE INDEX work_item_fila_idx ON success.work_item (dono_email, prazo)
  WHERE estado = 'aberto' AND NOT modo_sombra;
CREATE INDEX work_item_conta_idx ON success.work_item (account_id, criado_em DESC);
-- Suporte à carência: qual foi o último fechamento desta família nesta conta.
CREATE INDEX work_item_carencia_idx ON success.work_item (account_id, gatilho, fechado_em DESC)
  WHERE estado = 'fechado';

-- ─── Implantação ───────────────────────────────────────────────────────────

CREATE TABLE success.project (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES core.account (id),
  template          text,
  iniciado_em       date NOT NULL,
  go_live_previsto  date,
  go_live_real      date,
  -- TTFT: dias entre a assinatura e a PRIMEIRA TRANSAÇÃO da base. Mede se a
  -- implantação produziu valor real, não se as tarefas foram concluídas.
  primeira_transacao_em date,
  estado            text NOT NULL DEFAULT 'em_andamento'
                      CHECK (estado IN ('em_andamento','em_handoff','concluido','cancelado')),
  -- O pacote de handoff é recusado quando incompleto: validação, não convenção.
  handoff_completo  boolean NOT NULL DEFAULT false,
  handoff_em        timestamptz,
  criado_em         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT handoff_exige_completo CHECK (
    estado <> 'concluido' OR handoff_completo
  )
);

CREATE INDEX project_conta_idx ON success.project (account_id);

CREATE TABLE success.project_task (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES success.project (id) ON DELETE CASCADE,
  titulo        text NOT NULL,
  parte         text NOT NULL CHECK (parte IN ('alloyal','cliente')),
  prazo         date,
  concluida_em  date,
  -- Dependência entre tarefas: é o que produz o caminho crítico e a previsão
  -- de go-live.
  depende_de    uuid[] NOT NULL DEFAULT '{}',
  ordem         integer NOT NULL DEFAULT 0
);

CREATE INDEX project_task_projeto_idx ON success.project_task (project_id, ordem);

-- ─── Renovação ─────────────────────────────────────────────────────────────

CREATE TABLE success.renewal (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES core.account (id),
  contract_id   uuid REFERENCES core.contract (id),
  vigencia_fim  date NOT NULL,
  mrr_em_risco_centavos bigint NOT NULL,
  cenario       text CHECK (cenario IN ('base','otimista','pessimista')),
  estado        text NOT NULL DEFAULT 'aberta'
                  CHECK (estado IN ('aberta','em_negociacao','renovada','perdida')),
  desfecho_em   date,
  nota          text,
  criado_em     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX renewal_calendario_idx ON success.renewal (vigencia_fim) WHERE estado <> 'renovada';

-- ─── Saída: o churn real como processo ─────────────────────────────────────
--
-- Quando um cliente levanta a mão, ele está perdido comercialmente naquele dia.
-- Mas a receita continua entrando durante todo o aviso prévio. São dois fatos
-- em momentos diferentes, e tratá-los como um só distorce nos dois sentidos.
--
--   data_levantada              → é a data do CHURN DE CONTAS
--   competencia_efeito_receita  → é a data do CHURN DE RECEITA

CREATE TABLE success.cancellation (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES core.account (id),
  contract_id   uuid REFERENCES core.contract (id),

  origem        text NOT NULL CHECK (origem IN ('cliente','alloyal')),
  estado        text NOT NULL DEFAULT 'anunciado'
                  CHECK (estado IN ('anunciado','em_aviso','retido','encerrado')),

  -- ── 1ª data · o anúncio ──
  data_levantada     date,
  canal              text CHECK (canal IN ('email','reuniao','whatsapp','formulario','telefone')),
  quem_comunicou     text,
  -- Congelado no anúncio: o MRR pode mudar durante o aviso (reajuste, contração
  -- parcial) e a perda tem que ser medida contra o valor que existia quando o
  -- cliente decidiu sair.
  mrr_centavos_na_levantada bigint,
  multa_aplicavel_centavos  bigint,
  debito_aberto_na_levantada_centavos bigint,

  -- ── 2ª data · o fim do aviso · CONFIRMAÇÃO 1 (CS ou Jurídico) ──
  -- O contrato diz N dias, mas há acordo, renúncia e prorrogação. É o campo que
  -- mais desloca receita entre meses, então é confirmado por pessoa.
  aviso_previo_dias  integer,
  aviso_confirmado_por text,
  aviso_confirmado_em  timestamptz,
  data_fim_aviso     date,

  -- ── 3ª data · a última cobrança · CONFIRMAÇÃO 2 (Financeiro) ──
  -- Só o Financeiro sabe se a última fatura saiu, foi rateada ou antecipada.
  competencia_ultima_cobranca date,
  cobranca_confirmada_por text,
  cobranca_confirmada_em  timestamptz,

  -- ── 4ª data · o efeito na receita ──
  -- Derivada da última cobrança + 1. É a competência em que o evento entra no
  -- ledger e a receita sai da base ativa.
  competencia_efeito_receita date,

  motivo        text,
  motivo_detalhe text,

  -- Reverter dentro da janela é um RESULTADO, e precisa ser medido: é a métrica
  -- de vitória do time que a maioria das empresas nunca calcula.
  retido_em     date,
  retido_por    text,

  aprovado_por  text,
  aprovado_em   timestamptz,

  criado_em     timestamptz NOT NULL DEFAULT now(),

  -- Levantada de mão é o que caracteriza saída pedida pelo cliente.
  CONSTRAINT origem_cliente_tem_levantada CHECK (
    origem <> 'cliente'
    OR (data_levantada IS NOT NULL AND mrr_centavos_na_levantada IS NOT NULL)
  ),

  -- ── A invariante central ──
  -- O efeito na receita só pode ser gravado com as DUAS confirmações, cada uma
  -- com autor e horário. Errar o último mês move receita entre competências
  -- DEPOIS de a anterior estar congelada — e competência congelada não se
  -- corrige, só se ajusta na corrente. Confirmação esquecida hoje é ajuste
  -- inexplicável três meses depois.
  CONSTRAINT efeito_receita_exige_duas_confirmacoes CHECK (
    competencia_efeito_receita IS NULL
    OR (aviso_confirmado_por IS NOT NULL AND aviso_confirmado_em IS NOT NULL
        AND cobranca_confirmada_por IS NOT NULL AND cobranca_confirmada_em IS NOT NULL
        AND competencia_ultima_cobranca IS NOT NULL)
  ),

  -- Encerrar exige saber quando a receita sai e quem aprovou.
  CONSTRAINT encerrado_tem_efeito_e_aprovacao CHECK (
    estado <> 'encerrado'
    OR (competencia_efeito_receita IS NOT NULL AND aprovado_por IS NOT NULL)
  ),

  CONSTRAINT retido_tem_autor CHECK (
    estado <> 'retido' OR (retido_em IS NOT NULL AND retido_por IS NOT NULL)
  )
);

-- Uma saída em curso por conta: duas linhas 'em_aviso' para o mesmo cliente
-- seria receita comprometida contada em dobro.
CREATE UNIQUE INDEX cancellation_uma_em_curso
  ON success.cancellation (account_id)
  WHERE estado IN ('anunciado','em_aviso');

-- Suporte à tela de saídas em curso e à receita comprometida por mês.
CREATE INDEX cancellation_em_curso_idx ON success.cancellation (data_fim_aviso)
  WHERE estado IN ('anunciado','em_aviso');
CREATE INDEX cancellation_efeito_idx ON success.cancellation (competencia_efeito_receita)
  WHERE competencia_efeito_receita IS NOT NULL;

COMMENT ON TABLE success.cancellation IS
  'A saída é um processo, não um evento. churn de contas lê data_levantada; churn de receita lê competencia_efeito_receita. Com 90 dias de aviso, um mês pode fechar com 3% de churn de contas e 0% de churn de receita — e os dois estão certos.';

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA success TO ops_api;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA success TO ops_worker;

COMMIT;
