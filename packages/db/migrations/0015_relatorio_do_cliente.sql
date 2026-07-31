-- 0015 — O relatório do cliente, congelado no envio.
--
-- A decisão estrutural é `conteudo jsonb`: o relatório guarda os NÚMEROS que foram
-- enviados, não uma referência para recalculá-los.
--
-- Renderizar ao vivo a partir das métricas correntes parece mais simples e é a
-- escolha errada. O cliente tem uma cópia do que recebeu; se o número for
-- recalculado — porque uma fonte chegou atrasada, porque o snapshot foi refeito,
-- porque a definição da métrica mudou de versão — "vocês disseram 42%" passa a
-- exibir 38%, e a conversa deixa de ser sobre o clube e passa a ser sobre a
-- ferramenta.
--
-- É a mesma regra de `analytics.monthly_close`: o que já foi comunicado não muda.
-- Aqui ela é mais dura, porque o destinatário é externo.

BEGIN;

CREATE TABLE success.client_report (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES core.account (id),
  competencia   date NOT NULL,

  estado        text NOT NULL DEFAULT 'rascunho'
                  CHECK (estado IN ('rascunho','revisado','enviado','descartado')),

  -- Os quatro blocos, como foram montados. Escrito na REVISÃO e nunca reescrito
  -- depois: é o retrato do que o CSM leu antes de aprovar.
  conteudo      jsonb,

  -- A frase de leitura automática, e a versão que o CSM deixou. As duas ficam:
  -- comparar o que a máquina escreveu com o que a pessoa corrigiu é o único jeito
  -- de melhorar a geração — e de descobrir que ela está errando sempre no mesmo
  -- ponto.
  frase_gerada  text,
  frase_final   text,

  revisado_por  text,
  revisado_em   timestamptz,
  enviado_por   text,
  enviado_em    timestamptz,
  destinatario  text,

  criado_em     timestamptz NOT NULL DEFAULT now(),

  -- Um relatório por conta e competência. Dois relatórios do mesmo mês para o
  -- mesmo cliente é a situação em que ninguém sabe qual ele recebeu.
  UNIQUE (account_id, competencia),

  -- Revisar é congelar: sem conteúdo não há o que aprovar, e aprovar sem autor
  -- não é aprovação.
  CONSTRAINT revisado_tem_conteudo_e_autor CHECK (
    estado NOT IN ('revisado','enviado')
    OR (conteudo IS NOT NULL AND revisado_por IS NOT NULL AND revisado_em IS NOT NULL)
  ),

  -- Enviar exige destinatário e autor: o registro de que saiu, e para quem.
  CONSTRAINT enviado_tem_destinatario CHECK (
    estado <> 'enviado'
    OR (destinatario IS NOT NULL AND enviado_por IS NOT NULL AND enviado_em IS NOT NULL)
  ),

  -- A frase que vai ao cliente é a final; sem ela, o envio levaria o texto da
  -- máquina sem ninguém ter lido.
  CONSTRAINT enviado_tem_frase_revisada CHECK (
    estado <> 'enviado' OR frase_final IS NOT NULL
  )
);

CREATE INDEX client_report_por_conta ON success.client_report (account_id, competencia DESC);
CREATE INDEX client_report_pendentes ON success.client_report (competencia)
  WHERE estado IN ('rascunho','revisado');

COMMENT ON COLUMN success.client_report.conteudo IS
  'Os números COMO FORAM ENVIADOS, congelados na revisão. Nunca recalculados: o '
  'cliente tem uma cópia, e recalcular faria "vocês disseram 42%" exibir 38%.';

COMMENT ON COLUMN success.client_report.frase_gerada IS
  'A frase que a máquina escreveu. Fica ao lado da final para que a divergência '
  'entre as duas mostre onde a geração erra sempre.';

-- Relatório enviado é imutável. Trigger e não só CHECK porque o que se protege é a
-- ALTERAÇÃO de uma linha existente, não o estado de uma linha nova.
CREATE OR REPLACE FUNCTION success.relatorio_enviado_nao_muda()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.estado = 'enviado' THEN
    RAISE EXCEPTION
      'relatório de % já enviado em % — o cliente tem uma cópia. Para corrigir, '
      'gere um relatório novo e diga na frase o que mudou.',
      to_char(OLD.competencia, 'MM/YYYY'), to_char(OLD.enviado_em, 'DD/MM/YYYY');
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER client_report_imutavel
  BEFORE UPDATE OR DELETE ON success.client_report
  FOR EACH ROW EXECUTE FUNCTION success.relatorio_enviado_nao_muda();

GRANT SELECT, INSERT, UPDATE ON success.client_report TO ops_api;
GRANT SELECT, INSERT, UPDATE ON success.client_report TO ops_worker;

COMMIT;
