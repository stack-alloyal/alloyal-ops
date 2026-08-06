-- 0028 — A área de quem preenche o kickoff sai do navegador e entra no banco.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ NADA DO KICKOFF FICA LOCAL. Era a última coisa que ainda vivia em            │
-- │ `localStorage`: a área selecionada na barra lateral. Estava lá porque parecia │
-- │ preferência de tela, não dado — e a distinção não se sustenta.               │
-- │                                                                            │
-- │ Ela DECIDE o campo `time` de todo registro que a pessoa cria. Guardada no    │
-- │ navegador, mudar de máquina no meio da sessão faz os registros seguintes     │
-- │ saírem marcados para outra área, sem aviso. E foi exatamente "isto é só      │
-- │ preferência local" que deixou o preenchimento inteiro invisível por semanas. │
-- └───────────────────────────────────────────────────────────────────────────┘

BEGIN;

CREATE TABLE IF NOT EXISTS ops.kickoff_preferencia (
  email         text        PRIMARY KEY,
  -- A área em nome de quem a pessoa registra. Mesma lista fechada da tabela de
  -- registros: valor livre aqui viraria `time` inválido lá, e o CHECK de lá recusaria
  -- só na hora de gravar o registro — erro longe da causa.
  area          text        NOT NULL,
  atualizado_em timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT kickoff_pref_area_check CHECK (
    area IN ('comercial', 'financeiro', 'operacoes', 'juridico', 'todos')
  )
);

COMMENT ON TABLE ops.kickoff_preferencia IS
  'Área em nome de quem cada pessoa registra no kickoff. No banco e não no navegador: '
  'ela decide o campo `time` dos registros, e trocar de máquina não pode trocar a área '
  'em silêncio.';

-- UPDATE aqui é irrestrito de propósito: a linha é da própria pessoa, tem um só campo
-- útil e trocar de área é a operação normal. Nada a preservar de outra área.
GRANT SELECT, INSERT, UPDATE ON ops.kickoff_preferencia TO pulse_api;

COMMIT;
