-- ============================================================================
-- 0016 · Configuração, segredos e trilha de mudança
--
-- POR QUE EXISTE: hoje mudar o teto da fila, o limiar de atraso ou o mínimo de
-- k-anonimato exige editar constante em TypeScript e fazer deploy. Isso tem duas
-- consequências que aparecem na operação: o número fica errado por semanas porque
-- ninguém quer pedir deploy por causa de um limiar, e quando muda, ninguém sabe
-- quando mudou nem por quê — então a comparação "antes e depois" não existe.
--
-- E papel de pessoa se atribui por INSERT manual em `ops.user_role`. Não há caminho
-- na aplicação. Quem entra na empresa espera alguém com acesso ao banco.
--
-- TRÊS TABELAS, E A SEPARAÇÃO É O PONTO:
--
--   `ops.configuracao`  valor operacional, legível por quem configura
--   `ops.segredo`       token de integração, CIFRADO, nunca devolvido à tela
--   `ops.mudanca`       quem mudou o quê, quando, de que valor para qual
--
-- Segredo em tabela separada e não numa coluna `secreto boolean` na mesma tabela:
-- com uma tabela só, todo `SELECT *` de depuração traz o token junto, e o GRANT não
-- consegue distinguir. Separadas, `ops_portal` simplesmente não tem a segunda.
-- ============================================================================

BEGIN;

-- ── Configuração operacional ────────────────────────────────────────────────
CREATE TABLE ops.configuracao (
  chave           text PRIMARY KEY,
  -- jsonb e não text: os valores são número, booleano e lista, e guardar tudo como
  -- texto obrigaria cada leitor a fazer o próprio parse — que é onde um leitor
  -- interpreta "12" e outro interpreta 12.0.
  valor           jsonb NOT NULL,
  atualizado_por  text NOT NULL,
  atualizado_em   timestamptz NOT NULL DEFAULT now(),

  -- A chave é um identificador de código, não texto livre: sem isto, um espaço no
  -- fim faz a aplicação ler o padrão e a tela mostrar o valor configurado.
  CONSTRAINT configuracao_chave_formato CHECK (chave ~ '^[a-z][a-z0-9_.]{2,60}$')
);

COMMENT ON TABLE ops.configuracao IS
  'Ajuste operacional que o admin muda sem deploy. O catálogo do que é válido vive '
  'em @ops/config — esta tabela guarda apenas o que foi mudado em relação ao padrão. '
  'Chave ausente = padrão do código, e isso é deliberado: assim o padrão continua '
  'sendo a fonte de verdade e a tabela não precisa ser semeada.';

-- ── Segredos de integração ──────────────────────────────────────────────────
CREATE TABLE ops.segredo (
  chave           text PRIMARY KEY,
  -- Formato `v1:iv:tag:cifrado`. A versão à frente permite rotação de chave sem
  -- migração de dados.
  valor_cifrado   text NOT NULL,
  -- As últimas 4 letras do valor claro, para a tela dizer QUAL token está lá sem
  -- mostrá-lo. Quatro dá para confirmar "é o que eu cadastrei" e não dá para
  -- reconstruir.
  dica            text NOT NULL,
  atualizado_por  text NOT NULL,
  atualizado_em   timestamptz NOT NULL DEFAULT now(),
  -- Quando o worker usou por último. É o que responde "esse token ainda serve para
  -- algo?" antes de alguém apagar um que parecia esquecido.
  usado_em        timestamptz,

  CONSTRAINT segredo_chave_formato CHECK (chave ~ '^[a-z][a-z0-9_.]{2,60}$'),
  -- Recusa valor que não passou pela cifra. Sem isto, um INSERT manual apressado
  -- grava texto claro e nada reclama — e o vazamento fica invisível.
  CONSTRAINT segredo_cifrado CHECK (valor_cifrado ~ '^v[0-9]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$'),
  CONSTRAINT segredo_dica_curta CHECK (length(dica) <= 12)
);

COMMENT ON TABLE ops.segredo IS
  'Token de integração, cifrado com AES-256-GCM por @ops/auth/cifra. A chave mestra '
  'vem de OPS_CHAVE_MESTRA (SOPS) e NUNCA do banco: cifra cuja chave está ao lado do '
  'texto cifrado não protege de quem tem o dump. A tela nunca decifra para exibir.';

COMMENT ON COLUMN ops.segredo.dica IS
  'Últimas 4 letras do valor claro. Existe para a tela confirmar QUAL segredo está '
  'gravado sem revelá-lo — conferir o valor inteiro é o caminho pelo qual ele acaba '
  'num print de tela.';

-- ── Trilha de mudança ───────────────────────────────────────────────────────
CREATE TABLE ops.mudanca (
  id            bigserial PRIMARY KEY,
  -- `configuracao`, `segredo` ou `papel`: as três coisas que o admin muda.
  tipo          text NOT NULL,
  chave         text NOT NULL,
  -- Para segredo, os dois são NULL: registrar o valor anterior de um token na
  -- trilha desfaria a cifra, porque a trilha não é cifrada.
  valor_antes   jsonb,
  valor_depois  jsonb,
  quem          text NOT NULL,
  quando        timestamptz NOT NULL DEFAULT now(),
  -- Motivo é OBRIGATÓRIO para papel e segredo. Mudança de acesso sem motivo escrito
  -- é a que ninguém consegue explicar numa auditoria seis meses depois.
  motivo        text,

  CONSTRAINT mudanca_tipo CHECK (tipo IN ('configuracao','segredo','papel')),
  CONSTRAINT mudanca_segredo_sem_valor CHECK (
    tipo <> 'segredo' OR (valor_antes IS NULL AND valor_depois IS NULL)
  ),
  CONSTRAINT mudanca_acesso_tem_motivo CHECK (
    tipo = 'configuracao' OR (motivo IS NOT NULL AND length(trim(motivo)) >= 10)
  )
);

CREATE INDEX mudanca_recente_idx ON ops.mudanca (quando DESC);
CREATE INDEX mudanca_por_chave_idx ON ops.mudanca (tipo, chave, quando DESC);

COMMENT ON TABLE ops.mudanca IS
  'Trilha imutável do que o admin mudou. Sem ela, "o número piorou depois que '
  'mexeram no limiar" não tem como ser verificado — e a calibração dos gatilhos '
  'perde a única referência que tem.';

-- A trilha não se corrige: um registro de auditoria editável não é auditoria.
CREATE OR REPLACE FUNCTION ops.mudanca_nao_se_altera() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'ops.mudanca é trilha de auditoria e não aceita % — registre uma mudança nova',
    TG_OP;
END;
$$;

CREATE TRIGGER mudanca_imutavel
  BEFORE UPDATE OR DELETE ON ops.mudanca
  FOR EACH ROW EXECUTE FUNCTION ops.mudanca_nao_se_altera();

-- ── Papel: motivo de quem entrou e de quem saiu ─────────────────────────────
-- `ops.user_role` já existe desde a 0002. O que falta é saber POR QUE alguém tem um
-- papel, e desde quando — a trilha cobre a mudança, estas colunas cobrem o estado.
ALTER TABLE ops.user_role
  ADD COLUMN IF NOT EXISTS concedido_por text,
  ADD COLUMN IF NOT EXISTS concedido_em  timestamptz DEFAULT now();

COMMENT ON COLUMN ops.user_role.concedido_por IS
  'Quem deu o papel. NULL nas linhas semeadas antes desta migration — e NULL aqui '
  'se lê como "não sabemos", que é a verdade, e não como "o sistema deu".';

-- ── Grants ──────────────────────────────────────────────────────────────────
-- `ops_api` lê configuração e escreve tudo (é quem serve a tela de admin).
GRANT SELECT ON ops.configuracao TO ops_api, ops_worker;
GRANT INSERT, UPDATE, DELETE ON ops.configuracao TO ops_api;

-- O SEGREDO: `ops_worker` só LÊ (para usar na integração) e `ops_api` só ESCREVE.
-- A tela não precisa ler nunca, então não recebe SELECT — assim um defeito na tela
-- não consegue devolver token nem por acidente.
GRANT SELECT, UPDATE ON ops.segredo TO ops_worker;
GRANT INSERT, UPDATE, DELETE ON ops.segredo TO ops_api;

GRANT SELECT, INSERT ON ops.mudanca TO ops_api;
GRANT USAGE, SELECT ON SEQUENCE ops.mudanca_id_seq TO ops_api;
GRANT SELECT, INSERT, DELETE ON ops.user_role TO ops_api;

-- `ops_portal` fica de fora das três, sem exceção: o portal do cliente não tem
-- nenhum motivo para alcançar configuração interna, e a ausência de GRANT é uma
-- barreira que nenhum defeito de código atravessa.

COMMIT;
