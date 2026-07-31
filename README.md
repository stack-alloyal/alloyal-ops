# Alloyal Pulse

Plataforma interna de ferramentas de operação da Alloyal. Um login, uma casca, uma base de dados governada — e as ferramentas como módulos dentro dela.

**Ferramenta 1:** Alloyal Success (CS/CX). Outras virão.

## Documentação

| Doc | Conteúdo | Para quem |
|---|---|---|
| [`00-PRD-Plataforma-Alloyal-Pulse.md`](docs/00-PRD-Plataforma-Alloyal-Pulse.md) | O chassi: identidade e papéis, plataforma de dados, isolamento de tenant, design system, observabilidade, entrega, LGPD, ADRs | Engenharia, liderança técnica |
| [`01-PRD-Alloyal-Success.md`](docs/01-PRD-Alloyal-Success.md) | A primeira ferramenta: problema, objetivos, escopo, dicionário de métricas, sinais e score, gatilhos, design das telas, roadmap, riscos | Produto, CS, engenharia |
| [`02-Decisoes-e-Verificacoes-Abertas.md`](docs/02-Decisoes-e-Verificacoes-Abertas.md) | **Documento de trabalho.** Decisões pendentes com default, verificações com a query pronta, dúvidas de bootstrap, aprovações | Todos |

Ler nessa ordem para entender a arquitetura; começar pelo 02 para desbloquear o projeto.

## Estado

Fundação do monorepo no lugar e verificada (lint, tipos, build e 48 testes passando, incluindo o portão de isolamento de tenant contra Postgres real). Nenhum ciclo de ingestão implementado — depende do spike de dados.

Fase 0 aguardando:

- **2 verificações** na réplica (`V-01`, `V-02` no doc 02) — dez minutos de trabalho da plataforma
- **8 respostas de bootstrap** (`C-01` a `C-08`) para montar o esqueleto do repo
- **5 aprovações** de mudança de rumo em relação ao PRD v1.0 (seção D do doc 02)

## Estrutura

```
apps/       web-internal (Next.js, papel pulse_api)
            web-portal   (Next.js, papel pulse_portal)
            worker       (BullMQ, papel pulse_worker)
packages/   ui · metrics (dicionário como código) · contracts · auth · db
infra/      docker-compose · Dockerfile · secrets (SOPS) · backup
docs/       00 plataforma · 01 produto · 02 pendências
```

Não existe app de API separado: cada superfície é dona do próprio gateway e
conecta ao banco com **papel distinto**, o que faz do isolamento de tenant uma
fronteira de *deploy* em vez de fronteira de módulo (ADR-017).

## Regras que não se negociam

1. **Nenhum número é calculado duas vezes.** Toda métrica vive em `packages/metrics`, e as duas superfícies importam a mesma definição.
2. **Nenhum número aparece sem procedência.** Fonte, ciclo e carimbo de tempo viajam com o valor.
3. **O identificador do cliente vem do token, nunca de parâmetro.** RLS forçado, role da API não é owner.
4. **Série fechada não muda.** Correção entra como evento na competência corrente.
5. **Dado defasado é sinalizado, nunca exibido em silêncio.**
6. **Ação irreversível exige pessoa.** Automação prepara; gente envia.
7. **Segredo nunca entra no repo em texto claro.** Ver `.gitignore`.
