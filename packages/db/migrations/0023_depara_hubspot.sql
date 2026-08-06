-- 0023 — O de-para com o HubSpot é N:1, e não 1:1.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ MEDIDO NA API DO CORE EM 04/08/2026, e derruba uma premissa do modelo:      │
-- │                                                                            │
-- │   3.147 negócios lidos                                                     │
-- │   1.076 com hubspot_company_id preenchido                                  │
-- │      33 hubspot_company_id DUPLICADOS entre negócios                       │
-- │      32 desses com DUAS OU MAIS RAÍZES — não é matriz+filial               │
-- │                                                                            │
-- │ `core.account.hubspot_company_id` tem UNIQUE desde a 0002, porque o modelo  │
-- │ dizia "uma conta por empresa do HubSpot". No core isso não vale: a mesma    │
-- │ empresa do HubSpot aparece em mais de um negócio, e em 32 casos são dois    │
-- │ negócios RAIZ — dois programas sob um contrato, ou id colado errado. Os     │
-- │ dois casos são indistinguíveis daqui.                                      │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ A SAÍDA: separar o de-para da coluna, e NÃO derrubar o UNIQUE.              │
-- │                                                                            │
-- │ · `core.account_hubspot` guarda o vínculo como ele é: N contas → 1 empresa. │
-- │   Nada se perde.                                                           │
-- │ · `core.account.hubspot_company_id` continua único e passa a receber APENAS │
-- │   o vínculo NÃO AMBÍGUO — quando aquele hubspot_company_id aponta para uma  │
-- │   conta só. É a chave em que uma junção pode confiar.                      │
-- │ · A ambiguidade é CONTADA e reportada pelo ciclo, não escondida.            │
-- │                                                                            │
-- │ Derrubar o UNIQUE seria mais simples e pior: toda junção a partir do        │
-- │ HubSpot passaria a poder multiplicar linha, e receita contada duas vezes é  │
-- │ o defeito que não aparece até alguém somar à mão.                          │
-- └───────────────────────────────────────────────────────────────────────────┘

BEGIN;

CREATE TABLE IF NOT EXISTS core.account_hubspot (
  account_id         uuid        PRIMARY KEY REFERENCES core.account(id) ON DELETE CASCADE,
  hubspot_company_id text        NOT NULL,
  -- SEM unique em hubspot_company_id: a duplicidade é o fato que esta tabela existe
  -- para registrar.
  sincronizado_em    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE core.account_hubspot IS
  'De-para conta ↔ empresa do HubSpot, como o core o reporta: N contas podem apontar '
  'para a MESMA empresa. Medido em 04/08/2026: 33 hubspot_company_id duplicados, 32 '
  'deles entre contas raiz. A coluna core.account.hubspot_company_id recebe só o '
  'vínculo não ambíguo; aqui fica o vínculo inteiro.';

CREATE INDEX IF NOT EXISTS account_hubspot_company_idx
  ON core.account_hubspot (hubspot_company_id);

/**
 * Quais empresas do HubSpot têm mais de uma conta.
 *
 * Existe como view para a tela de qualidade de dado poder mostrar a lista sem
 * reescrever o agrupamento — e porque essa é a pergunta que o squad vai fazer na
 * primeira reunião sobre o casamento de chaves.
 */
CREATE OR REPLACE VIEW core.hubspot_ambiguo AS
SELECT h.hubspot_company_id,
       count(*)                             AS contas,
       array_agg(a.brand_id ORDER BY a.brand_id) AS brand_ids,
       array_agg(a.razao_social ORDER BY a.brand_id) AS nomes,
       count(*) FILTER (WHERE a.parent_account_id IS NULL) AS raizes
  FROM core.account_hubspot h
  JOIN core.account a ON a.id = h.account_id
 GROUP BY h.hubspot_company_id
HAVING count(*) > 1;

COMMENT ON VIEW core.hubspot_ambiguo IS
  'Empresas do HubSpot com mais de uma conta no core. `raizes > 1` é o caso que não '
  'se explica por matriz/filial e precisa de decisão humana.';

GRANT SELECT, INSERT, UPDATE, DELETE ON core.account_hubspot TO pulse_worker;
GRANT SELECT ON core.account_hubspot TO pulse_api;
GRANT SELECT ON core.hubspot_ambiguo TO pulse_api, pulse_worker;

COMMIT;
