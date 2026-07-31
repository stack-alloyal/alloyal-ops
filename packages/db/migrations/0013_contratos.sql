-- 0013 — Ferramenta 2: Contratos (CLM).
--
-- Não cria entidade paralela. `core.contract` continua sendo o contrato, e este
-- esquema acrescenta o que é específico do Jurídico: os documentos, as cláusulas
-- tipadas, as obrigações e a timeline.
--
-- A decisão estrutural é a VIGÊNCIA DE CLÁUSULA POR CONSULTA. A pergunta que a
-- empresa faz não é "o que o contrato dizia", é "o que vale hoje" — e com
-- aditivos as duas respostas divergem. Por isso cláusula nunca é editada: um
-- aditivo FECHA a antiga (`valido_ate`) e ABRE a nova, e quem pergunta "por que
-- mudou?" recebe o aditivo e a data. É o mesmo padrão que `core.account_alias`
-- usa para sobreviver a merge de cliente.
--
-- Duas invariantes ficam no banco, não no código:
--
--   1 · Cláusula tem PROCEDÊNCIA. Aponta o documento e o trecho de onde saiu, e
--       sem isso não pode ser confirmada. É "nenhum número sem procedência"
--       aplicado a texto contratual.
--
--   2 · Cláusula PROPOSTA não decide nada. Enquanto não confirmada, é visível e
--       marcada, mas não confirma aviso prévio, não valida cancelamento e não
--       alimenta alerta. Igual a uma métrica em verificação.

BEGIN;

CREATE SCHEMA IF NOT EXISTS contracts AUTHORIZATION ops_owner;
COMMENT ON SCHEMA contracts IS
  'Ferramenta 2 (CLM). Cláusulas, documentos, obrigações e timeline contratual. '
  'O contrato em si continua em core.contract, de que esta ferramenta é a fonte.';

-- `ops_api` lê e escreve (é a superfície interna); `ops_worker` escreve porque a
-- extração assistida e o webhook do Clicksign entram por lá. `ops_portal` NÃO
-- aparece: cláusula contratual não vai para a superfície do cliente, e a ausência
-- de grant é a garantia — não um filtro que alguém pode esquecer numa consulta.
GRANT USAGE ON SCHEMA contracts TO ops_api, ops_worker;

-- ── Documentos ──────────────────────────────────────────────────────────────
-- Append-only: versão nova é LINHA nova. O registro legal é o PDF assinado, e
-- sobrescrever a linha apagaria a prova de qual texto foi assinado.
CREATE TABLE contracts.document (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES core.account (id),
  contract_id   uuid REFERENCES core.contract (id),

  tipo          text NOT NULL CHECK (tipo IN ('minuta','contrato','aditivo','distrato')),
  versao        integer NOT NULL DEFAULT 1,
  titulo        text NOT NULL,

  -- Assinatura eletrônica. `NULL` em documento carregado do legado, que é a
  -- maioria no dia 1 — e distinguir "nunca foi ao Clicksign" de "foi e voltou
  -- recusado" é o que evita perseguir assinatura que ninguém pediu.
  clicksign_document_id text UNIQUE,
  status_assinatura text NOT NULL DEFAULT 'rascunho'
                      CHECK (status_assinatura IN
                        ('rascunho','enviado','parcial','assinado','recusado','expirado')),
  assinado_em   timestamptz,

  -- Hash do arquivo: é como se detecta que o PDF na mão de alguém não é o mesmo
  -- que está registrado aqui. Divergência entre ficha e PDF é incidente.
  hash_arquivo  text,
  url_arquivo   text,

  carregado_por text,
  criado_em     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (account_id, tipo, versao),

  CONSTRAINT assinado_tem_data CHECK (
    status_assinatura <> 'assinado' OR assinado_em IS NOT NULL
  )
);

CREATE INDEX document_por_conta ON contracts.document (account_id, tipo, versao DESC);

-- ── Cláusulas ───────────────────────────────────────────────────────────────
-- O coração da ferramenta. A taxonomia é fechada porque texto livre não sustenta
-- a pergunta "quais contratos vedam comunicação com usuário?".
CREATE TABLE contracts.clause (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES core.account (id),
  contract_id   uuid REFERENCES core.contract (id),

  tipo          text NOT NULL CHECK (tipo IN (
                  -- Faixa ABERTA: todos os papéis internos.
                  'escopo_produto','telemedicina','uso_marca','comunicacao_usuario',
                  'sla','renovacao','reajuste','aviso_previo','customizacao','obrigacoes',
                  -- Faixa RESERVADA: Comercial, CS lead, Financeiro, Jurídico, Diretoria.
                  'excecao_comercial','exclusividade','faturamento','lgpd','foro',
                  -- Faixa RESTRITA: Jurídico, Financeiro, Diretoria.
                  'multa','conflito','acordo',
                  -- Escape com audiência escolhida à mão.
                  'outra'
                )),

  -- O valor tem forma por tipo (enum, bool + escopo, regra estruturada). `jsonb`
  -- porque a forma varia; `texto` porque a cláusula literal importa para o
  -- Jurídico, e resumo estruturado nunca substitui o texto numa discussão.
  valor_estruturado jsonb NOT NULL DEFAULT '{}'::jsonb,
  texto         text,

  -- ── Vigência: é o que faz "o que vale hoje" ser consulta, não campo ──
  valido_de     date NOT NULL,
  valido_ate    date,

  -- ── Procedência (invariante 1) ──
  document_id   uuid REFERENCES contracts.document (id),
  trecho        text,

  -- Aditivo fecha a antiga e aponta para ela. Nunca sobrescreve.
  substitui_clause_id uuid REFERENCES contracts.clause (id),

  estado        text NOT NULL DEFAULT 'proposta'
                  CHECK (estado IN ('proposta','confirmada','substituida')),
  confirmada_por text,
  confirmada_em  timestamptz,

  -- Só para `tipo = 'outra'`: a audiência é escolhida, porque o tipo não existe
  -- na taxonomia e portanto não tem faixa declarada.
  audiencia_papeis text[],

  criado_em     timestamptz NOT NULL DEFAULT now(),

  -- INVARIANTE 1 — cláusula sem procedência não pode ser confirmada.
  --
  -- Proposta pode não ter documento ainda (extração de planilha, digitação
  -- inicial). Confirmar é afirmar que aquilo está escrito em algum lugar, e a
  -- afirmação sem o lugar é justamente o que a ferramenta existe para acabar.
  CONSTRAINT confirmada_tem_procedencia CHECK (
    estado <> 'confirmada'
    OR (document_id IS NOT NULL AND trecho IS NOT NULL
        AND confirmada_por IS NOT NULL AND confirmada_em IS NOT NULL)
  ),

  CONSTRAINT vigencia_coerente CHECK (valido_ate IS NULL OR valido_ate >= valido_de),

  -- `outra` exige audiência explícita: sem faixa na taxonomia e sem escolha, a
  -- cláusula ficaria visível para todos por omissão — o oposto do que se quer.
  CONSTRAINT outra_declara_audiencia CHECK (
    tipo <> 'outra' OR (audiencia_papeis IS NOT NULL AND cardinality(audiencia_papeis) > 0)
  )
);

-- A consulta que a ferramenta existe para responder: o que vale hoje, por tipo.
CREATE INDEX clause_vigente ON contracts.clause (tipo, account_id)
  WHERE valido_ate IS NULL;
CREATE INDEX clause_por_conta ON contracts.clause (account_id, tipo, valido_de DESC);
CREATE INDEX clause_propostas ON contracts.clause (account_id) WHERE estado = 'proposta';

COMMENT ON COLUMN contracts.clause.valido_ate IS
  'NULL = vigente. "O que vale hoje" é a consulta '
  '(valido_ate IS NULL OR valido_ate > current_date), nunca um campo booleano: '
  'com aditivo, o que o contrato dizia e o que vale hoje divergem, e as duas '
  'respostas precisam continuar disponíveis.';

COMMENT ON COLUMN contracts.clause.estado IS
  'proposta = extraída e não conferida; NÃO pode ser usada em decisão. '
  'confirmada = alguém afirmou, com procedência. '
  'substituida = fechada por aditivo — histórico, nunca apagada.';

-- ── Obrigações ──────────────────────────────────────────────────────────────
-- Obrigação de uma das partes, com dono interno. Alimenta a implantação e o
-- plano de sucesso: obrigação sem dono é obrigação que ninguém cumpre.
CREATE TABLE contracts.obligation (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES core.account (id),
  clause_id     uuid REFERENCES contracts.clause (id),

  parte         text NOT NULL CHECK (parte IN ('alloyal','cliente')),
  descricao     text NOT NULL,

  -- Prazo OU recorrência, nunca os dois: obrigação pontual tem data, obrigação
  -- contínua tem cadência, e confundi-las gera alerta que não faz sentido.
  prazo         date,
  recorrencia   text CHECK (recorrencia IN ('mensal','trimestral','semestral','anual')),

  dono_interno  text,
  estado        text NOT NULL DEFAULT 'ativa'
                  CHECK (estado IN ('ativa','cumprida','vencida','dispensada')),
  cumprida_em   date,
  cumprida_por  text,

  criado_em     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT prazo_ou_recorrencia CHECK (
    (prazo IS NOT NULL AND recorrencia IS NULL)
    OR (prazo IS NULL AND recorrencia IS NOT NULL)
  ),
  CONSTRAINT cumprida_tem_autor CHECK (
    estado <> 'cumprida' OR (cumprida_em IS NOT NULL AND cumprida_por IS NOT NULL)
  )
);

CREATE INDEX obligation_a_vencer ON contracts.obligation (prazo)
  WHERE estado = 'ativa' AND prazo IS NOT NULL;

-- ── Timeline ────────────────────────────────────────────────────────────────
-- Tipada, substituindo o histórico em texto livre. Texto livre não responde
-- "quantas exceções comerciais concedemos este ano".
CREATE TABLE contracts.event (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES core.account (id),
  document_id   uuid REFERENCES contracts.document (id),

  tipo          text NOT NULL CHECK (tipo IN (
                  'negociacao','excecao_concedida','conflito','notificacao',
                  'acordo','reajuste_aplicado','renovacao'
                )),
  ocorreu_em    date NOT NULL,
  descricao     text NOT NULL,
  autor         text NOT NULL,

  -- Mesma lógica de faixa das cláusulas: conflito e acordo não circulam.
  visibilidade  text NOT NULL DEFAULT 'reservada'
                  CHECK (visibilidade IN ('aberta','reservada','restrita')),

  criado_em     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX event_por_conta ON contracts.event (account_id, ocorreu_em DESC);

-- ── Aprovação ───────────────────────────────────────────────────────────────
-- O gate humano do chassi aplicado ao contrato: nenhuma minuta vai para
-- assinatura sem decisão registrada, com autor e justificativa.
CREATE TABLE contracts.approval (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   uuid NOT NULL REFERENCES contracts.document (id),

  etapa         text NOT NULL,
  papel_aprovador text NOT NULL,
  decisao       text CHECK (decisao IN ('aprovado','recusado','com_ressalva')),
  justificativa text,
  decidido_por  text,
  decidido_em   timestamptz,

  criado_em     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT decisao_tem_autor CHECK (
    decisao IS NULL OR (decidido_por IS NOT NULL AND decidido_em IS NOT NULL)
  ),
  -- Recusa e ressalva exigem motivo escrito. Aprovação silenciosa é normal;
  -- recusa sem motivo devolve o trabalho ao comercial sem dizer o que corrigir.
  CONSTRAINT recusa_tem_motivo CHECK (
    decisao NOT IN ('recusado','com_ressalva') OR justificativa IS NOT NULL
  )
);

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA contracts TO ops_api;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA contracts TO ops_worker;

COMMIT;
