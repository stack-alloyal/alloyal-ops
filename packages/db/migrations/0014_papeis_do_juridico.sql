-- 0014 — Os três papéis da ferramenta 2 no CHECK de `ops.user_role`.
--
-- A lista de papéis vive em DOIS lugares: `PAPEIS` em `@ops/auth/papeis.ts` e este
-- CHECK. Eu adicionei os três novos só no TypeScript, e a gravação do papel
-- explodiu na primeira tentativa — com uma mensagem sobre a constraint, que não
-- diz nada sobre a causa.
--
-- Manter os dois é deliberado: o CHECK impede papel inventado por SQL solto, e o
-- tipo impede papel inventado por código. O que faltava não era eliminar a
-- duplicação — era um teste que compara as duas listas, e ele agora existe em
-- `packages/db/src/papeis.test.ts`.
--
-- ops-juridico  → dono da ferramenta 2
-- ops-marketing → dois dos sete times que hoje perguntam ao Jurídico se podem
-- ops-produto      usar a marca do cliente e falar com os colaboradores dele

BEGIN;

ALTER TABLE ops.user_role DROP CONSTRAINT user_role_papel_check;

ALTER TABLE ops.user_role ADD CONSTRAINT user_role_papel_check CHECK (papel IN (
  'ops-csm', 'ops-cs-lead', 'ops-implantacao', 'ops-comercial',
  'ops-financeiro', 'ops-diretoria', 'ops-admin', 'ops-dados',
  'ops-juridico', 'ops-marketing', 'ops-produto'
));

COMMENT ON COLUMN ops.user_role.papel IS
  'Papel derivado de grupo do Google Workspace. A lista é espelhada em `PAPEIS` '
  'de @ops/auth, e `papeis.test.ts` recusa a divergência entre as duas.';

COMMIT;
