-- 0020 — Código de verificação por e-mail (step-up pós-SSO).
--
-- Segunda etapa depois do login do Google, no mesmo desenho do Allvoice: código
-- de 6 dígitos enviado ao próprio e-mail, e um cookie de dispositivo assinado que
-- dispensa repetir por 30 dias.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ O QUE ESTA TABELA FECHA:                                                   │
-- │                                                                            │
-- │ A autenticação interna inteira se apoia em dois cabeçalhos que o nginx      │
-- │ injeta. Quem conseguir escrever `X-Pulse-Proxy-Secret` e                    │
-- │ `X-Auth-Request-Email` É a pessoa — e o segredo do proxy vive em texto no   │
-- │ Advanced Config do NPM e no `.env` da VM.                                   │
-- │                                                                            │
-- │ O código não depende desse segredo: ele chega à CAIXA REAL do e-mail. Quem  │
-- │ forjou o cabeçalho não o recebe.                                           │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- O CÓDIGO NUNCA É GUARDADO. Guarda-se `sha256(email:codigo:segredo)`, com o
-- segredo fora do banco. Sem ele, seis dígitos são 1.000.000 de hashes que se
-- percorrem num piscar: quem lesse esta tabela saberia o código de todo mundo.

BEGIN;

CREATE TABLE IF NOT EXISTS ops.codigo_verificacao (
  email          text        PRIMARY KEY,
  hash           text        NOT NULL,
  expira_em      timestamptz NOT NULL,
  tentativas     int         NOT NULL DEFAULT 0,
  ultimo_envio   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE ops.codigo_verificacao IS
  'Código de verificação por e-mail em aberto. Uma linha por pessoa: pedir código '
  'novo SOBRESCREVE o anterior, então nunca há dois códigos válidos ao mesmo tempo.';

COMMENT ON COLUMN ops.codigo_verificacao.hash IS
  'sha256(email:codigo:PULSE_VERIFICACAO_SEGREDO). O código em claro não existe no banco.';

COMMENT ON COLUMN ops.codigo_verificacao.tentativas IS
  'Incrementado ATOMICAMENTE por UPDATE ... WHERE tentativas < 5 ANTES de comparar. '
  'A versão ingênua (ler, comparar, gravar) tem corrida: requisições simultâneas leem '
  'o mesmo contador e a trava de 5 erros deixa de valer — é bug que o Allvoice já teve.';

-- A linha morre sozinha: sem isto a tabela vira histórico de quem tentou entrar e
-- quando, que é dado de pessoa sem nenhuma razão para durar.
CREATE INDEX IF NOT EXISTS codigo_verificacao_expira_idx
  ON ops.codigo_verificacao (expira_em);

-- ── Grants ──────────────────────────────────────────────────────────────────
-- Só quem serve a tela: é ela que emite e confere. O worker não participa.
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.codigo_verificacao TO pulse_api;

-- `pulse_portal` fica de fora: o portal do cliente não tem verificação interna, e
-- a ausência de GRANT é barreira que nenhum defeito de código atravessa.

COMMIT;
