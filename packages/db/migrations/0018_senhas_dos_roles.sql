-- ============================================================================
-- 0018 · Senha dos roles de aplicação
--
-- POR QUE EXISTE: a 0001 cria `pulse_api`, `pulse_portal` e `pulse_worker` com
-- LOGIN e SEM SENHA. Nenhuma migration definia senha, e nenhum passo de deploy
-- aplicava. O `docker-compose` monta a URL de conexão com `PULSE_API_PASSWORD`,
-- mas o role não tinha senha nenhuma contra a qual comparar.
--
-- O DEFEITO ESCONDIA-SE ATRÁS DO pg_hba. Testar de dentro do contêiner, por
-- 127.0.0.1, PASSA: a imagem oficial do Postgres traz `host all all 127.0.0.1/32
-- trust`, que aceita sem verificar. Da REDE — que é como o app conecta — vale
-- `host all all all scram-sha-256`, e a resposta é
-- "password authentication failed for user pulse_api".
--
-- Ou seja: um teste de conexão feito do jeito mais natural (entrar no contêiner e
-- rodar psql) diz que está tudo bem. O deploy quebraria no primeiro request, com
-- uma mensagem que ninguém liga a "a migration nunca definiu a senha".
--
-- COMO A SENHA CHEGA AQUI: por `set_config`, lido de uma variável de sessão que o
-- executor de migrations preenche a partir do ambiente. Não fica no arquivo —
-- migration é versionada, e senha em arquivo versionado é o problema que o SOPS
-- existe para resolver.
--
-- IDEMPOTENTE: `ALTER ROLE ... PASSWORD` sobrescreve sem erro. Rodar de novo com a
-- mesma senha é no-op; com senha nova, é rotação — e é por isso que este arquivo
-- também É o mecanismo de rotação, em vez de haver dois caminhos que divergem.
--
-- SEM SENHA NO AMBIENTE, NÃO FAZ NADA e avisa. Falhar aqui deixaria o banco sem
-- migrar por causa de uma variável de ambiente; avisar deixa o problema visível e
-- o resto do schema em dia.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  par record;
  senha text;
  faltando text[] := '{}';
BEGIN
  FOR par IN
    SELECT * FROM (VALUES
      ('pulse_api',    'pulse.senha_api'),
      ('pulse_portal', 'pulse.senha_portal'),
      ('pulse_worker', 'pulse.senha_worker')
    ) AS t(role, ajuste)
  LOOP
    -- `true` no segundo argumento: devolve NULL em vez de erro quando a variável
    -- não foi definida. Sem isso, um ambiente sem a senha aborta a migration.
    senha := current_setting(par.ajuste, true);

    IF senha IS NULL OR length(senha) = 0 THEN
      faltando := faltando || par.role;
    ELSIF length(senha) < 16 THEN
      -- Recusa senha curta em vez de aplicá-la. Um role de aplicação alcançável
      -- pela rede com senha de 6 caracteres é pior que um role sem senha, porque
      -- parece configurado.
      RAISE EXCEPTION
        'senha de % tem % caracteres; mínimo 16. Gere com: openssl rand -base64 32',
        par.role, length(senha);
    ELSE
      EXECUTE format('ALTER ROLE %I WITH PASSWORD %L', par.role, senha);
      RAISE NOTICE 'senha aplicada em %', par.role;
    END IF;
  END LOOP;

  IF cardinality(faltando) > 0 THEN
    RAISE WARNING
      'sem senha para: %. Estes roles NÃO conseguem autenticar pela rede — defina '
      'PULSE_API_PASSWORD, PULSE_PORTAL_PASSWORD e PULSE_WORKER_PASSWORD e rode as '
      'migrations de novo. (De dentro do contêiner, por 127.0.0.1, o pg_hba usa '
      'trust e a conexão parece funcionar mesmo assim.)',
      array_to_string(faltando, ', ');
  END IF;
END $$;

COMMIT;
