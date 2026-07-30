# Alloyal Ops — atalhos de operação.
# Alvos com efeito em produção estão marcados. Nada aqui faz deploy sem ser pedido.

SHELL := /bin/bash
COMPOSE := docker compose -f infra/docker-compose.yml

.PHONY: help
help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'

# ─── Desenvolvimento ────────────────────────────────────────────────────────
.PHONY: install
install: ## Instala dependências
	pnpm install

.PHONY: check
check: ## Roda os portões locais: lint, tipos, testes, build
	pnpm lint && pnpm typecheck && pnpm test && pnpm build

.PHONY: db-up
db-up: ## Sobe apenas Postgres e Redis
	$(COMPOSE) up -d postgres-ops redis-ops

.PHONY: db-migrate
db-migrate: ## Aplica migrations (usa DATABASE_URL_ADMIN)
	pnpm --filter @ops/db build && pnpm --filter @ops/db migrate

.PHONY: seed
seed: ## Popula um banco descartável com massa sintética (recusa base com dado real)
	pnpm --filter @ops/db build && pnpm --filter @ops/db seed

.PHONY: db-test
db-test: ## Sobe Postgres descartável e roda o portão de isolamento de tenant
	@docker rm -f ops-pg-test >/dev/null 2>&1 || true
	@docker run -d --name ops-pg-test -e POSTGRES_PASSWORD=teste -e POSTGRES_DB=ops \
		-p 127.0.0.1:5434:5432 postgres:16 >/dev/null
	@echo "aguardando o banco..."
	@for i in $$(seq 1 45); do docker exec ops-pg-test pg_isready -U postgres -d ops >/dev/null 2>&1 && sleep 2 && break || sleep 1; done
	@pnpm --filter @ops/db build
	@DATABASE_URL_ADMIN=postgres://postgres:teste@127.0.0.1:5434/ops \
		node --test packages/db/dist/rls.test.js
	@docker rm -f ops-pg-test >/dev/null

# ─── Segredos ───────────────────────────────────────────────────────────────
.PHONY: secrets-edit
secrets-edit: ## Edita os segredos cifrados
	sops infra/secrets/ops.env.sops.yaml

.PHONY: secrets-decrypt
secrets-decrypt: ## Gera infra/.env (600) a partir do arquivo cifrado
	@sops -d --output-type dotenv infra/secrets/ops.env.sops.yaml > infra/.env
	@chmod 600 infra/.env
	@echo "infra/.env gerado (600). NÃO versionar."

# ─── Produção (VM) ──────────────────────────────────────────────────────────
.PHONY: up
up: ## [PRODUÇÃO] Sobe a stack
	$(COMPOSE) up -d --build

.PHONY: logs
logs: ## Segue os logs
	$(COMPOSE) logs -f --tail=100

.PHONY: ps
ps: ## Estado dos contêineres
	$(COMPOSE) ps

.PHONY: backup
backup: ## [PRODUÇÃO] Dump do banco do Ops
	bash infra/backup/ops-backup.sh
