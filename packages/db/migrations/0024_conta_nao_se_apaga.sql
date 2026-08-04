-- 0024 — Conta de cliente NÃO se apaga. Só se inativa.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ A AUSÊNCIA DE GRANT JÁ IMPEDIA, e não basta.                                │
-- │                                                                            │
-- │ Conferido antes desta migration: nem `pulse_api`, nem `pulse_worker`, nem   │
-- │ `pulse_portal` têm DELETE em `core.account`. A regra já valia — por          │
-- │ omissão.                                                                   │
-- │                                                                            │
-- │ Regra que vale por omissão é regra que a próxima migration desliga sem      │
-- │ querer: um `GRANT ALL` escrito com pressa devolve o DELETE, e ninguém nota  │
-- │ até um cliente sumir junto com o histórico dele. O gatilho abaixo diz a     │
-- │ regra em voz alta, vale até para o superusuário, e a mensagem ensina o      │
-- │ caminho certo.                                                             │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- POR QUE APAGAR CLIENTE É PIOR QUE PARECE: `fact.activity`, `fact.mrr_event`,
-- `core.contract`, `metrics.daily_snapshot` e a trilha de relatório todos apontam
-- para a conta. Apagá-la ou arrasta o histórico junto (ON DELETE CASCADE) ou quebra
-- a referência. Nos dois casos a pergunta "como estava este cliente há seis meses"
-- deixa de ter resposta — que é justamente o que o Pulse existe para responder.

BEGIN;

CREATE OR REPLACE FUNCTION core.conta_nao_se_apaga() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'core.account não aceita DELETE: cliente se INATIVA (ativo = false), nunca se apaga. '
    'Tentativa em brand_id=% / razao_social=%. '
    'O histórico em fact.activity, fact.mrr_event, core.contract e metrics.daily_snapshot '
    'aponta para esta linha — apagá-la apaga a resposta de "como estava este cliente".',
    coalesce(OLD.brand_id, '(sem brand_id)'), OLD.razao_social;
END;
$$;

DROP TRIGGER IF EXISTS conta_nao_se_apaga ON core.account;
CREATE TRIGGER conta_nao_se_apaga
  BEFORE DELETE ON core.account
  FOR EACH ROW EXECUTE FUNCTION core.conta_nao_se_apaga();

COMMENT ON COLUMN core.account.ativo IS
  'A ÚNICA forma de tirar um cliente de circulação. DELETE é recusado por gatilho '
  '(migration 0024): o histórico aponta para esta linha.';

-- ── A exceção declarada: o seed e o teste ────────────────────────────────────
--
-- `seed-db.test.ts` e `sincronizar-core.test.ts` apagam o que eles mesmos criaram.
-- Sem uma saída, os dois passariam a falhar — e a resposta preguiçosa seria remover
-- o gatilho. A saída é explícita e local: quem apaga precisa DIZER que está num
-- banco descartável, por sessão, e o gatilho confere.
CREATE OR REPLACE FUNCTION core.conta_nao_se_apaga() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('pulse.banco_descartavel', true) = 'sim' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'core.account não aceita DELETE: cliente se INATIVA (ativo = false), nunca se apaga. '
    'Tentativa em brand_id=% / razao_social=%. '
    'Em banco de TESTE, declare a intenção antes: '
    'SET LOCAL pulse.banco_descartavel = ''sim'';',
    coalesce(OLD.brand_id, '(sem brand_id)'), OLD.razao_social;
END;
$$;

COMMIT;
