-- 0021 — A PESSOA, separada dos papéis dela.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ POR QUE UMA TABELA NOVA, E NÃO COLUNAS EM `ops.user_role`:                  │
-- │                                                                            │
-- │ `ops.user_role` é (email, papel) — uma linha POR PAPEL. Quem tem três       │
-- │ papéis tem três linhas. Nome e estado de acesso são da PESSOA, não do par:  │
-- │ guardá-los ali significaria repetir o nome três vezes e poder deixar duas   │
-- │ cópias divergentes. É a mesma armadilha de lista duplicada que já obrigou   │
-- │ `papeis.test.ts` e `migracoes.test.ts` a existirem neste repo.              │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ POR QUE `ativo` NÃO É "APAGAR O PAPEL":                                    │
-- │                                                                            │
-- │ Hoje a única forma de tirar acesso é revogar papel — e isso APAGA a linha.  │
-- │ Quem sai de férias, entra em licença ou é desligado por 30 dias volta e     │
-- │ alguém tem que reconstruir de memória o que a pessoa tinha.                 │
-- │                                                                            │
-- │ `ativo = false` corta o acesso na MESMA hora e preserva os papéis. É a      │
-- │ suspensão que o Publi tem, e que aqui faltava.                             │
-- │                                                                            │
-- │ E ela é uma SEGUNDA barreira, não um substituto: a pessoa suspensa é         │
-- │ recusada na resolução de identidade, antes de qualquer consulta.            │
-- └───────────────────────────────────────────────────────────────────────────┘

BEGIN;

CREATE TABLE IF NOT EXISTS ops.pessoa (
  email       text PRIMARY KEY,
  nome        text,
  ativo       boolean     NOT NULL DEFAULT true,
  criado_em   timestamptz NOT NULL DEFAULT now(),
  criado_por  text
);

COMMENT ON TABLE ops.pessoa IS
  'Quem é a pessoa. Os papéis dela ficam em ops.user_role, uma linha por papel.';

COMMENT ON COLUMN ops.pessoa.nome IS
  'Nome de exibição. NULL é honesto: significa "ninguém preencheu", e a interface '
  'cai para o e-mail em vez de inventar um nome a partir dele.';

COMMENT ON COLUMN ops.pessoa.ativo IS
  'false SUSPENDE o acesso preservando os papéis. Conferido na resolução de '
  'identidade, antes de qualquer consulta — não é filtro de tela.';

-- ── Quem já tem papel passa a existir como pessoa ────────────────────────────
-- Sem isto, todo mundo que hoje tem acesso ficaria sem registro de pessoa — e a
-- resolução de identidade, que passa a exigir `ativo`, recusaria TODOS. Migration
-- que tranca todo mundo para fora é o pior modo de falha possível.
INSERT INTO ops.pessoa (email, criado_por)
SELECT DISTINCT email, 'migration/0021'
  FROM ops.user_role
ON CONFLICT (email) DO NOTHING;

-- ── Grants ──────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE ON ops.pessoa TO pulse_api;
-- Sem DELETE, e é decisão: apagar pessoa apaga o histórico de quem fez o quê.
-- Tirar acesso é `ativo = false`.

-- `pulse_portal` fica de fora: o portal do cliente não conhece gente interna.

COMMIT;
