-- 0031 — O logo do cliente, de "Customização do App" no core.
--
-- Guardamos a URL e não a imagem: são 3.172 clientes, e baixar ~60 MB por dia para
-- mostrar um quadrado de 28 px é custo sem retorno. O host `assets.alloyal.com.br` é da
-- própria Alloyal e entrou na CSP (`img-src`) só para isto.
--
-- `logo_origem` existe porque logo errado é a pior forma de erro visual: parece certo.
-- Com o campo de origem gravado, "por que este logo está deitado?" tem resposta —
-- caiu para `horizontal_logo_url` porque o vertical não estava preenchido.

BEGIN;

ALTER TABLE core.account
  ADD COLUMN IF NOT EXISTS logo_url    text,
  ADD COLUMN IF NOT EXISTS logo_origem text,
  ADD COLUMN IF NOT EXISTS logo_em     timestamptz;

-- Só o host da Alloyal, e só https. Uma URL que a CSP bloqueia é um logo quebrado com
-- cara de logo, e o CHECK impede que ela chegue à tela.
ALTER TABLE core.account DROP CONSTRAINT IF EXISTS account_logo_url_check;
ALTER TABLE core.account ADD CONSTRAINT account_logo_url_check CHECK (
  logo_url IS NULL OR logo_url ~ '^https://assets\.alloyal\.com\.br/'
);

COMMENT ON COLUMN core.account.logo_url IS
  'Logo de "Customização do App" no core (/businesses/:id/business_app). Vertical '
  'colorida primeiro, favicon depois — ver CAMPOS_DE_LOGO.';

CREATE INDEX IF NOT EXISTS account_sem_logo_idx
  ON core.account (brand_id) WHERE logo_url IS NULL AND ativo;

COMMIT;
