-- ============================================================================
-- 0019 · GRANT por COLUNA em ops.segredo
--
-- POR QUE EXISTE: a 0016 deu a `pulse_api` INSERT/UPDATE/DELETE em `ops.segredo` e
-- NEGOU SELECT, de propósito — a ideia era que um defeito na tela não conseguisse
-- devolver token nem por acidente.
--
-- A intenção estava certa e o GRANT era grosso demais. A tela precisa listar o que
-- está cadastrado: chave, dica (as 4 últimas letras), quem gravou, quando, e quando
-- foi usado pela última vez. Sem SELECT nenhum, `/configuracoes/segredos` respondia
-- **500 · permission denied for table segredo**.
--
-- O defeito só apareceu no CONTÊINER. Fora dele eu conectava como superusuário, e
-- superusuário ignora GRANT — a tela funcionava perfeitamente em desenvolvimento e
-- quebrava em produção, que é o pior lugar para descobrir.
--
-- A CORREÇÃO É MELHOR QUE O DESENHO ORIGINAL: `GRANT SELECT (colunas)` deixa o
-- `valor_cifrado` inalcançável pelo BANCO, e não pela minha disciplina em escrever a
-- consulta. Antes, "a tela não lê o token" dependia de ninguém nunca escrever
-- `SELECT *`. Agora o Postgres recusa.
-- ============================================================================

BEGIN;

-- Some o SELECT amplo, se algum ambiente o tiver ganhado por outro caminho.
REVOKE SELECT ON ops.segredo FROM pulse_api;

-- E entra o recorte: tudo, menos o texto cifrado.
GRANT SELECT (chave, dica, atualizado_por, atualizado_em, usado_em)
  ON ops.segredo TO pulse_api;

COMMENT ON COLUMN ops.segredo.valor_cifrado IS
  'AES-256-GCM. O role da TELA (pulse_api) não tem SELECT nesta coluna — só nas '
  'outras. Um SELECT * feito pela aplicação falha no banco, e é essa recusa que '
  'garante que o token nunca volta para a tela. `pulse_worker` tem SELECT completo '
  'porque é ele quem usa o valor na integração.';

COMMIT;
