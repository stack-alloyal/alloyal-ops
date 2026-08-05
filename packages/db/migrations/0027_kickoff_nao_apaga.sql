-- 0027 — Registro do kickoff NÃO se apaga. Só se inativa.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ POR QUE, sem eufemismo: em 05/08/2026 eu rodei `DELETE FROM               │
-- │ ops.kickoff_registro` sem filtro contra a PRODUÇÃO, para limpar entre         │
-- │ execuções de um teste. Apagou 17 registros que o time de Operações havia      │
-- │ acabado de preencher. Não havia backup, `archive_mode` estava off e o         │
-- │ autovacuum já havia reclamado as linhas; a recuperação só foi possível lendo  │
-- │ os bytes crus do WAL, porque o segmento ainda não tinha sido reciclado.       │
-- │                                                                            │
-- │ A regra "não apaga" agora está no BANCO, e não na minha memória. É a mesma   │
-- │ decisão da 0024 para `core.account`, pelo mesmo motivo: regra que depende de │
-- │ quem escreve o comando falha no dia em que quem escreve está com pressa.     │
-- └───────────────────────────────────────────────────────────────────────────┘

BEGIN;

ALTER TABLE ops.kickoff_registro
  ADD COLUMN IF NOT EXISTS ativo         boolean     NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS inativado_em  timestamptz,
  ADD COLUMN IF NOT EXISTS inativado_por text;

COMMENT ON COLUMN ops.kickoff_registro.ativo IS
  'A ÚNICA forma de tirar um registro do kickoff de circulação. DELETE é recusado por '
  'gatilho (migration 0027).';
COMMENT ON COLUMN ops.kickoff_registro.inativado_por IS
  'Quem inativou, pela sessão. Num documento aberto a toda a empresa, "quem tirou isto '
  'da tela" é pergunta que precisa de resposta.';

-- Índice parcial: a leitura do documento só quer os ativos, e é a consulta de todo
-- carregamento e de toda recarga automática.
CREATE INDEX IF NOT EXISTS kickoff_ativo_idx
  ON ops.kickoff_registro (tipo, criado_em DESC) WHERE ativo;

-- ── O gatilho que recusa DELETE ──────────────────────────────────────────────
--
-- A saída existe e é EXPLÍCITA, igual à da 0024: quem apaga precisa declarar, por
-- sessão, que está num banco descartável. Teste que cria e limpa os próprios dados
-- continua funcionando; um DELETE distraído contra a produção, não.
CREATE OR REPLACE FUNCTION ops.kickoff_nao_se_apaga() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('pulse.banco_descartavel', true) = 'sim' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'ops.kickoff_registro não aceita DELETE: registro se INATIVA '
    '(UPDATE ... SET ativo = false), nunca se apaga. Tentativa em id=% (tipo=%, autor=%). '
    'Em banco descartável: SET LOCAL pulse.banco_descartavel = ''sim''.',
    OLD.id, OLD.tipo, OLD.autor_email;
END;
$$;

DROP TRIGGER IF EXISTS kickoff_nao_se_apaga ON ops.kickoff_registro;
CREATE TRIGGER kickoff_nao_se_apaga
  BEFORE DELETE ON ops.kickoff_registro
  FOR EACH ROW EXECUTE FUNCTION ops.kickoff_nao_se_apaga();

-- ── Grants ───────────────────────────────────────────────────────────────────
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ UPDATE APENAS NAS COLUNAS DE INATIVAÇÃO, e isto é a parte que importa.       │
-- │                                                                            │
-- │ A 0025 negou UPDATE de propósito: "editar o que outra área escreveu, sem     │
-- │ rastro, é a forma mais silenciosa de a pauta mudar de dono". Conceder UPDATE │
-- │ na tabela para permitir a inativação devolveria exatamente esse poder.       │
-- │ Grant por COLUNA mantém as duas regras de pé ao mesmo tempo.                │
-- └───────────────────────────────────────────────────────────────────────────┘
REVOKE DELETE ON ops.kickoff_registro FROM pulse_api;
GRANT UPDATE (ativo, inativado_em, inativado_por) ON ops.kickoff_registro TO pulse_api;

COMMIT;
