# Rotação de segredos: o que muda onde, e o que quebra

Cada segredo tem um impacto diferente, e três deles têm comportamento que **não é o
esperado**. Este arquivo existe porque "trocar a senha" parece uma operação só e são
sete, com consequências que vão de zero a irreversível.

Depois de qualquer rotação: `make secrets-check` recusa placeholder e valor curto.

---

## A regra que vale para os três de banco

**Mudar o `.env` NÃO rotaciona senha de Postgres.** A senha mora no banco, não no
arquivo. O `.env` só monta a string de conexão.

Quem edita o `.env`, reinicia o contêiner e vê tudo funcionando conclui que rotacionou.
Não rotacionou: a senha velha continua válida no banco, e a nova nem existe — o
contêiner só voltou a se conectar porque… não voltou. Ele falha na próxima conexão nova.

O `POSTGRES_PASSWORD` do compose é ainda mais traiçoeiro: o Postgres o lê **apenas na
primeira inicialização do volume**. Depois disso o valor no `.env` é decorativo.

---

## 1 · `PULSE_API_PASSWORD`, `PULSE_PORTAL_PASSWORD`, `PULSE_WORKER_PASSWORD`

**Impacto:** janela curta em que conexões NOVAS falham.

Conexões já abertas continuam funcionando — a autenticação aconteceu no `connect`. O
que quebra é o pool abrindo conexão nova entre o `ALTER ROLE` e o restart.

```bash
NOVA=$(openssl rand -base64 32 | tr -d '=+/' | cut -c1-32)

# 1. No banco (as conexões vivas não caem)
psql "$DATABASE_URL_ADMIN" -c "ALTER ROLE pulse_api PASSWORD '$NOVA'"

# 2. No SOPS
sops --set "[\"PULSE_API_PASSWORD\"] \"$NOVA\"" infra/secrets/pulse.env.sops.yaml

# 3. Regenera o .env e reinicia SÓ quem usa esse role
make secrets-decrypt
docker compose -f infra/docker-compose.yml up -d --force-recreate web-internal
```

Nesta ordem. Invertida — `.env` antes do `ALTER` — o contêiner sobe com a senha nova
contra um banco que ainda tem a velha, e não conecta de jeito nenhum.

O compose monta a URL a partir da senha, então não há segunda cópia para esquecer.

---

## 2 · `POSTGRES_PULSE_PASSWORD` (superusuário)

**Impacto:** nenhum nos serviços; o `.env` só é lido por migrations e seed.

```bash
psql "$DATABASE_URL_ADMIN" -c "ALTER ROLE postgres PASSWORD '$NOVA'"
sops --set "[\"POSTGRES_PULSE_PASSWORD\"] \"$NOVA\"" infra/secrets/pulse.env.sops.yaml
make secrets-decrypt
```

Não precisa reiniciar o Postgres. **Não recrie o contêiner esperando que ele releia o
`POSTGRES_PASSWORD`** — ele não relê, e você fica com a impressão de ter rotacionado.

---

## 3 · `REDIS_PULSE_PASSWORD`

**Impacto:** restart do Redis. A fila SOBREVIVE — `appendonly yes` e volume próprio.

```bash
sops --set "[\"REDIS_PULSE_PASSWORD\"] \"$NOVA\"" infra/secrets/pulse.env.sops.yaml
make secrets-decrypt
docker compose -f infra/docker-compose.yml up -d --force-recreate redis-pulse worker
```

O worker precisa subir junto: a senha dele vem da mesma variável. Job em execução no
instante do restart volta para a fila pelo mecanismo do BullMQ — os ciclos são
idempotentes por chave natural, então reprocessar não duplica.

---

## 4 · `PULSE_PROXY_SECRET` — dois lugares, e agora sem janela

**Impacto:** ZERO, se feito na ordem certa. Este segredo vive em **dois** lugares que
não se atualizam juntos: o `.env` da aplicação e o Advanced Config do NPM (que o NPM
guarda no banco dele, não em arquivo).

A aplicação aceita **lista separada por vírgula**, e é isso que elimina a janela:

```bash
NOVO=$(openssl rand -hex 32)
ATUAL=$(sops -d --extract '["PULSE_PROXY_SECRET"]' infra/secrets/pulse.env.sops.yaml)

# 1. Os DOIS aceitos ao mesmo tempo
sops --set "[\"PULSE_PROXY_SECRET\"] \"$ATUAL,$NOVO\"" infra/secrets/pulse.env.sops.yaml
make secrets-decrypt
docker compose -f infra/docker-compose.yml up -d --force-recreate web-internal

# 2. Só então, no NPM: trocar o valor do proxy_set_header para o NOVO

# 3. Confirmado que entra, remove o velho
sops --set "[\"PULSE_PROXY_SECRET\"] \"$NOVO\"" infra/secrets/pulse.env.sops.yaml
make secrets-decrypt
docker compose -f infra/docker-compose.yml up -d --force-recreate web-internal
```

Com um valor só — como era antes — todo mundo tomava 401 entre o passo 1 e o 2.

Não deixe a lista com dois valores para sempre: o velho continua válido, e o motivo de
rotacionar geralmente é justamente ele não ser mais confiável.

---

## 5 · `PULSE_CHAVE_MESTRA` — a única irreversível se feita errado

**Impacto se feita errado: TODOS os segredos de integração viram lixo, sem volta.**

Esta chave cifra `ops.segredo` (HubSpot, CleverTap, Omie, SMTP). Trocar a variável e
reiniciar **não migra nada** — os valores gravados continuam cifrados com a chave
velha, que a essa altura não está em lugar nenhum. Todas as integrações param, e o
recadastro manual é a única saída.

Por isso existe `PULSE_CHAVE_MESTRA_ANTERIOR`. A decifragem tenta a atual e, se falhar,
a anterior.

```bash
ANTIGA=$(sops -d --extract '["PULSE_CHAVE_MESTRA"]' infra/secrets/pulse.env.sops.yaml)
NOVA=$(openssl rand -base64 32)

# 1. Nova como principal, antiga como fallback
sops --set "[\"PULSE_CHAVE_MESTRA\"] \"$NOVA\"" infra/secrets/pulse.env.sops.yaml
sops --set "[\"PULSE_CHAVE_MESTRA_ANTERIOR\"] \"$ANTIGA\"" infra/secrets/pulse.env.sops.yaml
make secrets-decrypt
docker compose -f infra/docker-compose.yml up -d --force-recreate web-internal worker

# 2. Regravar tudo com a nova (Configurações → Segredos → Rotação, ou via API)

# 3. Conferir que NENHUM segredo ainda depende da antiga, e só então removê-la
sops unset infra/secrets/pulse.env.sops.yaml '["PULSE_CHAVE_MESTRA_ANTERIOR"]'
make secrets-decrypt
docker compose -f infra/docker-compose.yml up -d --force-recreate web-internal worker
```

`progressoDaRotacao()` responde o passo 3 sem chute: quantos já estão na chave nova,
quantos ainda dependem da velha, e **quais não abrem com nenhuma das duas** — esses
precisam ser recadastrados, e é melhor descobrir agora que numa madrugada.

Remover a anterior cedo demais é o mesmo desastre do começo, só que mais tarde.

---

## 6 · Tokens externos (HubSpot, CleverTap, Omie, SMTP)

**Impacto:** o ciclo que usa o token para de rodar até o novo entrar.

Não mexa no SOPS: **Configurações → Segredos**, cole o valor novo, e use **Testar
conexão** antes de sair da tela. A sonda diz se o fornecedor aceitou — e distingue
token recusado de fornecedor fora do ar, que pedem ações opostas.

`usado_em` mostra quando o worker usou pela última vez. "Nunca usado" num segredo
cadastrado há dias é sinal de que o ciclo não está rodando, e não de que o token é
ruim.

---

## Resumo

| Segredo | Impacto | Precisa restart | Reversível |
|---|---|---|---|
| `PULSE_API/PORTAL/WORKER_PASSWORD` | janela curta em conexão nova | sim, o serviço | sim |
| `POSTGRES_PULSE_PASSWORD` | nenhum | não | sim |
| `REDIS_PULSE_PASSWORD` | restart; fila sobrevive | sim, redis + worker | sim |
| `PULSE_PROXY_SECRET` | **zero** com a lista | sim, web-internal | sim |
| `PULSE_CHAVE_MESTRA` | **total, se pular o fallback** | sim, web + worker | **só com a chave antiga em mãos** |
| Tokens externos | ciclo para até o novo entrar | não | sim |

O único que merece medo é o quinto, e só quando feito sem `PULSE_CHAVE_MESTRA_ANTERIOR`.
