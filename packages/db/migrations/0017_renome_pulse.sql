-- ============================================================================
-- 0017 · Renome do produto: Alloyal Pulse → Alloyal Pulse
--
-- POR QUE UMA MIGRATION E NÃO EDITAR AS ANTERIORES: as migrations 0003 e 0014
-- criaram o CHECK com os papéis `ops-*` e JÁ RODARAM. Editá-las faria um banco novo
-- nascer com `pulse-*` e um banco migrado continuar em `ops-*` — as duas coisas
-- divergindo é exatamente o que migration existe para impedir. Aqui os dois caminhos
-- convergem no mesmo estado, e o arquivo conta que o renome aconteceu.
--
-- O QUE NÃO MUDA, de propósito:
--
--   O ESQUEMA `ops` continua `ops`. Os esquemas são nomeados por FUNÇÃO — `core`,
--   `fact`, `metrics`, `analytics`, `success`, `contracts`, `ops` — e aqui `ops`
--   significa "metadados operacionais", não o produto. Renomeá-lo faria dele o único
--   esquema batizado com nome de produto, ao lado de seis nomeados por camada.
--
--   O NOME DO BANCO (`ops`, `ops_demo`) não muda aqui porque não se renomeia o banco
--   ao qual se está conectado. É passo de operação, documentado no README.
--
-- O QUE MUDA:
--   · papéis da aplicação: `ops-csm` → `pulse-csm` (valor e CHECK)
--   · roles do Postgres: `ops_owner` → `pulse_owner`, e os outros três
--
-- ORDEM IMPORTA, e a primeira versão desta migration errou: eu reescrevia os valores
-- ANTES de derrubar o CHECK antigo — que só aceita `ops-*`. O banco vazio passou (o
-- UPDATE não tocou nada) e o banco COM gente cadastrada abortou. A ordem certa é
-- derrubar o CHECK velho, reescrever, e só então instalar o novo.
-- ============================================================================

BEGIN;

-- ── 1 · O CHECK antigo sai primeiro ─────────────────────────────────────────
-- Enquanto ele existe, gravar `pulse-csm` é violação: a lista dele só tem `ops-*`.
ALTER TABLE ops.user_role DROP CONSTRAINT IF EXISTS user_role_papel_check;

-- ── 2 · Os valores de papel nas linhas existentes ───────────────────────────
-- Sem prefixo `ops-`, nada acontece — é o caso de um banco recém-criado, onde a
-- tabela está vazia.
UPDATE ops.user_role
   SET papel = 'pulse-' || substring(papel FROM 5)
 WHERE papel LIKE 'ops-%';

-- A TRILHA `ops.mudanca` NÃO é reescrita, e isso é decisão e não esquecimento.
--
-- A primeira versão desta migration tentava reescrevê-la, e o gatilho de
-- imutabilidade da própria trilha recusou o UPDATE. O gatilho está certo: a trilha diz
-- `ops-csm` porque era esse o nome do papel quando aquela concessão aconteceu.
-- Reescrever seria falsificar o registro — e trilha que se corrige não sustenta
-- nenhuma conversa sobre o que aconteceu.
--
-- O renome entra como REGISTRO NOVO, que é exatamente o uso da trilha.
INSERT INTO ops.mudanca (tipo, chave, valor_antes, valor_depois, quem, motivo)
VALUES (
  'papel',
  'prefixo-dos-papeis',
  '"ops-*"'::jsonb,
  '"pulse-*"'::jsonb,
  'migration/0017',
  'Renome do produto Alloyal Pulse para Alloyal Pulse. Registros anteriores a esta linha '
  'usam o prefixo ops- porque era o nome vigente na época — a trilha não foi reescrita.'
);

-- ── 3 · O CHECK novo entra depois dos valores já convertidos ────────────────
ALTER TABLE ops.user_role ADD CONSTRAINT user_role_papel_check CHECK (papel IN (
  'pulse-csm', 'pulse-cs-lead', 'pulse-implantacao', 'pulse-comercial',
  'pulse-financeiro', 'pulse-diretoria', 'pulse-admin', 'pulse-dados',
  'pulse-juridico', 'pulse-marketing', 'pulse-produto'
));

COMMENT ON COLUMN ops.user_role.papel IS
  'Grupo do Google Workspace, agora com prefixo `pulse-`. A lista aqui e a de PAPEIS '
  'em @pulse/auth precisam ser idênticas — packages/db/src/papeis.test.ts recusa a '
  'divergência. Renomear aqui SEM renomear os grupos no Workspace tira o acesso de '
  'todos; os grupos ainda não existiam quando este renome foi feito, então era o '
  'momento de menor custo.';

-- ── 4 · Os roles do Postgres ────────────────────────────────────────────────
-- Role é objeto do CLUSTER, não do banco, e o executor roda esta migration uma vez
-- por banco (`pulse` e `pulse_demo`). Sem a guarda, a segunda execução falharia com
-- "role does not exist" — e o schema ficaria pela metade no segundo banco.
--
-- Os GRANTs acompanham o rename automaticamente: eles apontam para o OID do role, não
-- para o nome. Nada precisa ser reconcedido.
DO $$
DECLARE
  par record;
BEGIN
  FOR par IN
    SELECT * FROM (VALUES
      ('ops_owner',  'pulse_owner'),
      ('ops_api',    'pulse_api'),
      ('ops_portal', 'pulse_portal'),
      ('ops_worker', 'pulse_worker')
    ) AS t(antigo, novo)
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = par.antigo)
       AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = par.novo) THEN
      EXECUTE format('ALTER ROLE %I RENAME TO %I', par.antigo, par.novo);
      RAISE NOTICE 'role % renomeado para %', par.antigo, par.novo;
    END IF;
  END LOOP;
END $$;

-- ── 5 · Dono dos objetos ────────────────────────────────────────────────────
-- Nada a fazer: o dono é registrado por OID, e o rename preservou o OID. Este
-- comentário existe para a próxima pessoa não gastar meia hora procurando o
-- REASSIGN OWNED que não é necessário.

COMMIT;
