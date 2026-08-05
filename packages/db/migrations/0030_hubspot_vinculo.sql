-- 0030 — O que "ambíguo" no HubSpot significa, caso por caso.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ MEDIDO na base real de 05/08/2026 (3.172 contas, 34 ids repetidos): olhar os │
-- │ dados desfez a premissa. "Ambíguo" não era uma coisa, eram seis — e só uma    │
-- │ pede decisão humana:                                                        │
-- │                                                                            │
-- │   1 id  ·  2 contas   `hubspot_company_id = '0'` — zero não é id            │
-- │   1 id  · 14 contas   CNPJ 26.989.697: a PRÓPRIA ALLOYAL, não cliente        │
-- │  18 ids · 38 contas   filiais do mesmo CNPJ — uma empresa, não conflito      │
-- │   7 ids · 14 contas   uma só ativa; as outras dizem "(Antigo)", "(NÃO USAR)" │
-- │   2 ids ·  4 contas   nenhuma ativa — não há receita a atribuir              │
-- │   5 ids · 16 contas   mais de uma ativa: 2 são canal de venda, 3 indecidíveis │
-- │                                                                            │
-- │ Sem esta coluna, a tela mostrava "34 ambíguos" — um número que junta erro de │
-- │ dado, estrutura societária normal e decisão de negócio pendente. Número que  │
-- │ mistura essas três coisas não orienta ação nenhuma.                          │
-- └───────────────────────────────────────────────────────────────────────────┘

BEGIN;

ALTER TABLE core.account_hubspot
  ADD COLUMN IF NOT EXISTS vinculo         text,
  ADD COLUMN IF NOT EXISTS motivo          text,
  ADD COLUMN IF NOT EXISTS classificado_em timestamptz;

-- A lista é fechada e igual à do TypeScript (`Vinculo` em hubspot-vinculo.ts). Lista
-- duplicada diverge: é a regra que já obrigou `papeis.test.ts` a existir, e aqui o
-- portão é o CHECK recusando o INSERT.
ALTER TABLE core.account_hubspot DROP CONSTRAINT IF EXISTS account_hubspot_vinculo_check;
ALTER TABLE core.account_hubspot ADD CONSTRAINT account_hubspot_vinculo_check CHECK (
  vinculo IS NULL OR vinculo IN
    ('unico', 'filial', 'interna', 'dono', 'historico', 'encerrado', 'canal', 'pendente')
);

-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ `hubspot_company_id` PRECISA ser inteiro positivo.                          │
-- │                                                                            │
-- │ Havia duas contas com `'0'`, e as duas apareciam ligadas entre si na view de │
-- │ ambíguos: MEGA PROTEGE e uma associação de socorro mútuo, que nada têm em    │
-- │ comum. Zero é o nulo do core vazando como texto. Com o CHECK, o dia em que o │
-- │ core mandar zero de novo, a carga recusa a linha em vez de inventar vínculo. │
-- └───────────────────────────────────────────────────────────────────────────┘
DELETE FROM core.account_hubspot WHERE hubspot_company_id !~ '^[1-9][0-9]*$';

ALTER TABLE core.account_hubspot DROP CONSTRAINT IF EXISTS account_hubspot_id_valido;
ALTER TABLE core.account_hubspot ADD CONSTRAINT account_hubspot_id_valido CHECK (
  hubspot_company_id ~ '^[1-9][0-9]*$'
);

COMMENT ON COLUMN core.account_hubspot.vinculo IS
  'O que o id repetido SIGNIFICA nesta conta. Calculado a cada carga do C18 por '
  'classificarVinculo() — não editado à mão, senão a próxima carga sobrescreve.';
COMMENT ON COLUMN core.account_hubspot.motivo IS
  'A frase que explica a classificação, escrita para ser lida na tela sem cruzar tabela.';

CREATE INDEX IF NOT EXISTS account_hubspot_vinculo_idx
  ON core.account_hubspot (vinculo) WHERE vinculo = 'pendente';

-- ── As duas views ───────────────────────────────────────────────────────────
--
-- `hubspot_ambiguo` continua existindo e continua crua: é o sinal de "o core repetiu
-- id", e serve para conferir a classificação contra o dado. O que muda é passar a
-- carregar o vínculo, para deixar de ser lida como lista de problemas.
-- `CREATE OR REPLACE VIEW` não muda nome nem ordem de coluna: derrubar é obrigatório.
-- Sem CASCADE de propósito — se algo passar a depender desta view, quero o erro aqui e
-- não a dependência sumindo em silêncio.
DROP VIEW IF EXISTS core.hubspot_ambiguo;
CREATE VIEW core.hubspot_ambiguo AS
  SELECT h.hubspot_company_id,
         count(*) AS contas,
         count(*) FILTER (WHERE a.ativo) AS contas_ativas,
         count(DISTINCT left(a.cnpj, 8)) AS cnpj_raizes,
         array_agg(DISTINCT h.vinculo) FILTER (WHERE h.vinculo IS NOT NULL) AS vinculos,
         array_agg(a.brand_id ORDER BY a.brand_id) AS brand_ids,
         array_agg(a.razao_social ORDER BY a.brand_id) AS nomes,
         count(*) FILTER (WHERE a.parent_account_id IS NULL) AS raizes
    FROM core.account_hubspot h
    JOIN core.account a ON a.id = h.account_id
   GROUP BY h.hubspot_company_id
  HAVING count(*) > 1;

-- E a que vale numa tela: SÓ o que precisa de gente. Era isto que faltava — "34
-- ambíguos" não dizia a ninguém o que fazer; "3 esperando decisão" diz.
DROP VIEW IF EXISTS core.hubspot_pendente;
CREATE VIEW core.hubspot_pendente AS
  SELECT h.hubspot_company_id,
         count(*) AS contas,
         count(*) FILTER (WHERE a.ativo) AS contas_ativas,
         min(h.motivo) AS motivo,
         array_agg(a.brand_id ORDER BY a.brand_id) AS brand_ids,
         array_agg(a.razao_social ORDER BY a.brand_id) AS nomes,
         array_agg(a.cnpj ORDER BY a.brand_id) AS cnpjs
    FROM core.account_hubspot h
    JOIN core.account a ON a.id = h.account_id
   WHERE h.vinculo = 'pendente'
   GROUP BY h.hubspot_company_id;

COMMENT ON VIEW core.hubspot_pendente IS
  'Ids do HubSpot que o dado NÃO resolve: mais de uma conta ativa, em CNPJs diferentes, '
  'sem assinatura de canal de venda. É a fila de decisão humana — e é curta de propósito.';

GRANT SELECT ON core.hubspot_ambiguo, core.hubspot_pendente TO pulse_api, pulse_worker;

COMMIT;
