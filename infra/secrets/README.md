# Segredos — SOPS + age

Decisão **C-06** (doc 02). Escolhido por: zero infraestrutura nova, histórico auditável por git, funciona offline, e nada em texto claro no repositório.

## Como convive com a regra de ouro da casa

`/opt/stack/CLAUDE.md` estabelece: *"segredos NUNCA entram no Git. Só os `*.env.example` são versionados; os `.env` reais vivem na VM (perm 600)."*

O SOPS **não viola** essa regra — ele a estende. O que entra no Git é o arquivo **cifrado**, ilegível sem a chave privada. O que a aplicação consome continua sendo um `.env` em texto claro na VM, com permissão `600`, gerado no deploy. Ou seja: o contrato de runtime é idêntico ao dos outros quatro apps da casa; o que muda é que o segredo passa a ter histórico, revisão e recuperação.

O ganho concreto: hoje, se a VM for perdida, os `.env` vão com ela. Com SOPS, eles estão no repositório privado e a única coisa que precisa de custódia separada é uma chave.

```
infra/secrets/pulse.env.sops.yaml     ← cifrado, VERSIONADO
infra/.env                          ← claro, 600, NUNCA versionado, gerado no deploy
```

## Instalar (ARM64)

```bash
# age
curl -sL https://github.com/FiloSottile/age/releases/latest/download/age-v1.2.1-linux-arm64.tar.gz \
  | tar xz -C /tmp && sudo install /tmp/age/age /tmp/age/age-keygen /usr/local/bin/

# sops
curl -sLo /tmp/sops https://github.com/getsops/sops/releases/latest/download/sops-v3.9.4.linux.arm64
sudo install /tmp/sops /usr/local/bin/sops
```

## Gerar a chave, uma vez

```bash
mkdir -p ~/.config/sops/age
age-keygen -o ~/.config/sops/age/keys.txt
chmod 600 ~/.config/sops/age/keys.txt
grep 'public key' ~/.config/sops/age/keys.txt   # → age1...
```

Cole a chave **pública** em `.sops.yaml`, na raiz do repositório.

> A chave **privada** vive em dois lugares e em nenhum outro: `~/.config/sops/age/keys.txt` na VM (600) e no cofre pessoal de quem opera. Ela não entra no repositório, não vai por mensagem e não fica em backup não cifrado. Perder as duas cópias significa recriar todos os segredos das integrações.

## Uso

```bash
make secrets-edit       # abre o arquivo decifrado no editor e recifra ao salvar
make secrets-decrypt    # gera infra/.env com permissão 600
make secrets-rotate     # troca a chave e recifra (rotação semestral — doc 00, 12)
```

## Rotação

Semestral, e **imediata** após desligamento de quem tinha acesso à chave privada. Trocar a chave `age` não basta: as credenciais das integrações (HubSpot, CleverTap, Omie, SMTP) precisam ser regeradas na origem, porque quem tinha a chave já as leu.

## Se algo vazar em texto claro

1. Regenerar a credencial **na origem** — reescrever o histórico do git não desfaz leitura.
2. Registrar em `ops.audit`.
3. Rotacionar a chave `age` e recifrar.
