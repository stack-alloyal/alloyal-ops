# Decisões, verificações e dúvidas de bootstrap

| | |
|---|---|
| Documento | 02 — Pendências |
| Versão | 2.0 |
| Data | 26 de julho de 2026 |
| Irmãos | `00-PRD-Plataforma-Alloyal-Ops.md` · `01-PRD-Alloyal-Success.md` |

Este é o documento de trabalho. Tudo que impede o projeto de andar está aqui, com **dono, o que bloqueia e um default proposto**. Onde há default, o silêncio é uma resposta válida: seguimos com ele e registramos.

**Como está o bloqueio hoje:**

| | Quantidade | Bloqueia |
|---|---|---|
| Verificações que impedem a **Fase 1** | **2** (V-01, V-02) | Desenho do ciclo de ingestão |
| Decisões que impedem a **Fase 2** | **6** (DEF-01 a DEF-04, DEF-06, DEF-05) | Cálculo de métrica e gatilhos |
| Dúvidas de bootstrap na VM | ~~8 críticas~~ → **6 respondidas, 2 abertas** (C-05, C-07) | Spike de dados e login |
| Aprovações de mudança de rumo | **5** | Seção D |

A v1.0 se declarava "bloqueado por 3 verificações de dados". Na prática, o que impede **começar** são duas queries que alguém de plataforma roda em dez minutos. O resto bloqueia módulos específicos, mais adiante, e está sequenciado para isso.

---

# A. Decisões de produto e negócio

| # | Decisão | Pergunta | Dono | Default proposto | Bloqueia |
|---|---|---|---|---|---|
**DEF-01** | Métrica de adesão | Qual é o número oficial: alcance histórico ou uso corrente? | CS + Diretoria | **Nenhum dos dois isolado.** Três métricas nomeadas: `cobertura_cadastral`, `adesao_ativacao`, `adesao_30d`. A palavra "adesão" sem qualificador é proibida. O que falta decidir é o **piso de `adesao_30d` por segmento** | Todo cálculo de métrica — F1 |
**DEF-02** | Data do churn | Pedido, fim de vigência ou último pagamento? | Diretoria | **Fim de vigência** para churn contratual; **data da provisão** para PDD. Registrar as três datas sempre, para permitir recorte alternativo depois | Churn, coortes, NRR — F8 |
**DEF-03** | Churn oficial | Logo ou de receita? | Diretoria | **Churn de receita é o número oficial da empresa**; churn logo é sempre publicado ao lado. Nunca um sem o outro | Módulo executivo — F8 |
**DEF-04** | Composição do NRR | Inclui clientes novos? Qual coorte? | Diretoria | **Coorte fechada:** clientes ativos no início do período. Novos entram no mês seguinte. NRR sem clientes novos, GRR sem expansão | NRR — F8 |
**DEF-05** | Faixas de churn silencioso | Qual queda, por quantos períodos, em quantas faixas? | CS | **Quatro faixas** conforme 7.1 do doc 01, ancoradas no piso do segmento. Calibradas após 8 semanas de série, medindo o tempo entre entrada na faixa e cancelamento real | Churn silencioso — **F2** |
**DEF-06** | MRR em PDD | Em que momento sai da base ativa: 90 dias, provisão contábil ou distrato assinado? | Diretoria + Financeiro | **Na provisão contábil (90 dias)**, com evento `churn_inadimplencia`; retorno de pagamento gera `reativacao`. Alternativa (distrato assinado) infla o MRR informado por 60 a 120 dias | Revenue Flows, NRR — F8, mas o evento precisa ser capturado desde a **F0** |
**DEF-07** | SLA por gatilho | Qual prazo por tipo de item? | Head de CS | Tabela da seção 9 do doc 01 | Métrica O1 — F2 |
**DEF-08** | Taxonomia de cancelamento | Lista fechada de motivos | CS + Diretoria | A definir com CS; `churn_inadimplencia` é categoria separada e obrigatória | Cancelamento — F10 |
**DEF-09** | Eixos de segmentação | Como se calcula complexidade e profundidade de escuta hoje? | CS | Até a F16, complexidade = porte × cobertura × nº de canais; escuta = cadência contratada. PROFI substitui o primeiro eixo quando chegar | Segmentação — F4 |
**DEF-10** | Perguntas e pesos do PROFI | Conjunto atual, com peso por pergunta | CS + Implantação | Existe do lado da Alloyal; necessário para mapear pergunta → dimensão e calibrar a normalização | PROFI — F16 |

**Nomeações pendentes, ambas bloqueantes do módulo executivo:**

| Papel | Por quê | Dono da nomeação |
|---|---|---|
**Data Owner** | Dono do dicionário e do fechamento mensal. Processo humano recorrente, para sempre — não é entrega | Diretoria |
**Encarregado (DPO) do projeto** | ROPA, RIPD e fluxo de direito do titular antes da primeira carga real | Jurídico |

---

# B. Verificações técnicas

Cada uma com **como verificar**, para que a resposta não dependa de interpretação. Rodar na réplica salvo indicação.

### B.1 Bloqueantes da Fase 1

**V-01 — `updated_at` em `orders` é vivo ou decorativo?** · Dono: Plataforma · **Bloqueia o desenho do C1**

```sql
-- 1. A coluna é preenchida e coerente?
SELECT count(*)                                          AS total,
       count(*) FILTER (WHERE updated_at IS NULL)         AS nulos,
       count(*) FILTER (WHERE updated_at < created_at)    AS incoerentes,
       count(*) FILTER (WHERE updated_at = created_at)    AS nunca_tocados
FROM orders
WHERE created_at >= now() - interval '90 days';

-- 2. Existe trigger que a mantenha, ou é responsabilidade do ORM?
SELECT tgname, pg_get_triggerdef(oid)
FROM pg_trigger
WHERE tgrelid = 'orders'::regclass AND NOT tgisinternal;

-- 3. Pedido que MUDOU DE STATUS tem updated_at recente?
--    (é o caso que decide: estorno e cancelamento retroativo)
SELECT status, count(*), max(updated_at), max(created_at)
FROM orders
WHERE created_at < now() - interval '30 days'
  AND status NOT IN ('created')
GROUP BY status;
```

Leitura: se `nunca_tocados` for próximo do total, ou se não houver trigger e o status mudar sem mexer no campo, o watermark **não funciona** e o C3 (reconciliação) passa a ser o caminho principal, com janela de 180 dias na carga inicial.

**V-02 — Existe índice que sustente o C1 e os agregados?** · Dono: Plataforma · **Bloqueia desempenho**

```sql
SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'orders';

-- Plano real da consulta que o C1 vai rodar a cada 15 minutos:
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM orders WHERE updated_at > now() - interval '20 minutes';

-- Plano real da consulta de agregado por cliente:
EXPLAIN (ANALYZE, BUFFERS)
SELECT brand_id, branch_id, date_trunc('day', created_at AT TIME ZONE 'America/Sao_Paulo') d,
       count(*), sum(total_centavos)
FROM orders
WHERE created_at >= now() - interval '30 days'
GROUP BY 1,2,3;
```

Leitura: `Seq Scan` na primeira consulta inviabiliza o ciclo de 15 minutos. Índice não pode ser criado na réplica — a decisão é no primary, ou tabela materializada de agregados na origem.

### B.2 Spike de dados da Fase 0 — 2 dias, decide a arquitetura de ingestão

| # | Verificação | Comando |
|---|---|---|
**V-03** | Versão do Postgres da réplica e se é standby | `SHOW server_version;` `SELECT pg_is_in_recovery();` |
**V-04** | Chave de cliente na base Alloyal | `\d+ orders` — existe `hubspot_id`, ou só `brand_id`/`branch_id`? Quantas marcas sem mapeamento? |
**V-05** | Volumetria | `SELECT relname, n_live_tup, pg_size_pretty(pg_total_relation_size(c.oid)) FROM pg_class c JOIN pg_stat_user_tables s USING (relname) WHERE relname IN ('orders','users','eligible_base') ORDER BY n_live_tup DESC;` — e nº de clientes e de vidas |
**V-06** | Lag da réplica em pico | `SELECT now() - pg_last_xact_replay_timestamp();` amostrado de hora em hora por 24 h |

Saída do spike: tempo real de cada consulta dos ciclos, decisão entre **caminho A** (incremental viável) e **caminho B** (reconciliação como principal + agregados materializados), e dimensionamento da janela noturna. Os SLO da seção 10 do chassi são hipóteses até este spike.

### B.3 Por módulo

| # | Verificação | Dono | Bloqueia | Fase |
|---|---|---|---|---|
**V-07** | Chave de junção do Omie com a base de clientes (CNPJ? código do cliente?) | Financeiro | `S-FIN`, churn silencioso, PDD — **driver de maior peso** | F1 |
**V-08** | O perfil do CleverTap carrega `hubspot_id`? Desde quando? | Plataforma | `S-ENG`, MAU por conta | F2 |
**V-09** | Qual campo é `Identity` no CleverTap? Bate com o id de usuário da réplica? | Plataforma | Cruzar engajamento e transação | F2 |
**V-10** | Onde vivem cláusula de multa e aviso prévio? Campo, contrato em PDF, planilha? | Jurídico | Validação de cancelamento | F10 |
**V-11** | O HubSpot permite **webhook de mudança de propriedade de deal** (MRR, vigência, estágio)? Qual escopo? | RevOps | **C5 — único ciclo com perda irrecuperável** | **F0** |
**V-12** | Limite de taxa do HubSpot frente ao tamanho da base | RevOps | C4, C5 | F1 |
**V-13** | Taxonomia de motivos do Hub é lista fechada ou texto livre? | CS | Análise de motivo, `S-SUP` | quando F4 existir |
**V-14** | Serviço de lojas: chaveia por cliente? Tem histórico? Emite webhook? | Plataforma | Trava de score, correlação com queda | F2 |
**V-15** | Tier e limite de taxa do CleverTap; Partner Export está configurado? | Plataforma | C6 | F2 |
**V-16** | Stack e tokens de design do `dashboard.cliente` | Plataforma | Coerência visual do portal | F11 |
**V-17** | CAC: integrar mídia ou entrada manual por período? | Marketing | Economics | F8 |
**V-18** | Ferramenta de assinatura eletrônica | Jurídico | Distrato | F10 |
**V-19** | Existe API interna de provisionamento da implantação? | Plataforma | Handoff automatizado | F5 |

---

# C. Dúvidas para criar o projeto na VM

Onde há default, é o que eu faria. Responder **"segue os defaults"** é suficiente para eu montar o esqueleto do repo.

### C.1 Críticas — **respondidas em 26/07/2026**

Estas oito estavam travando o bootstrap. Resolvidas, e a fundação já foi construída sobre elas.

| # | Dúvida | Decisão | Onde ficou |
|---|---|---|---|
**C-01** | Onde roda? | ✅ **VM Oracle existente** (ARM64, 4 vCPU, 23 GB, 148 GB livres), projeto Compose próprio `alloyal-ops`, redes `ops-net` + `proxy-net`. **Postgres e Redis dedicados**, não os compartilhados de `/opt/stack` — ADR-018 explica por quê | `infra/docker-compose.yml` |
**C-02** | Domínios | ✅ `ops.alloyal.com.br` (interno) e `cliente.alloyal.com.br` (portal). Separados para o portal ter CSP, limite de taxa e política de cookie próprios | compose + `infra/proxy` |
**C-03** | TLS | ✅ **Nginx Proxy Manager** já no 80/443 da VM, com Let's Encrypt. Não é nginx com certbot: a configuração vive no volume do NPM e se aplica pela API dele (ver `/opt/stack/infra/proxy/PROXY-HOSTS.md`) | — |
**C-04** | Postgres | ✅ **16** em Docker, volume dedicado, `shared_buffers=2GB`, backup próprio. A versão da nossa instância não afeta CDC — quem decide isso é a réplica de origem (V-03) | `infra/docker-compose.yml` |
**C-05** | Rede até a réplica | ⚠️ **Ainda pendente.** É o único item de C.1 sem resposta, e sem ele o spike de dados não roda | `REPLICA_URL` em `.env.example` |
**C-06** | Cofre de segredos | ✅ **SOPS + age.** Cifrado versionado no repo; decifrado para `infra/.env` (600) no deploy — mesmo contrato de runtime dos outros apps da casa, com histórico e recuperação a mais | `infra/secrets/README.md` |
**C-07** | Google Workspace | ⚠️ Falta quem cria o client OAuth e os 8 grupos `ops-*`. A **arquitetura mudou**: usamos o oauth2-proxy da casa (ADR-016), não OIDC na aplicação | `infra/oauth2.env.example` |
**C-08** | Repositório e CI | ✅ GitHub Actions no `stack-alloyal/alloyal-ops`, runner hospedado para lint/tipos/build/testes; deploy por chave na VM | `.github/workflows/ci.yml` |

**Novas pendências que só apareceram ao olhar a VM:**

| # | Pendência | Severidade |
|---|---|---|
**C-25** | O backup compartilhado da casa roda `pg_dumpall` no Postgres **compartilhado** — não cobre `postgres-ops`. Já resolvido com `infra/backup/ops-backup.sh` | resolvido |
**C-26** | O backup da casa é **local** e a documentação dela diz que "não cobre perda da VM". Para a base que passa a ser a fonte de NRR e churn da empresa, falta **destino remoto** (Oracle Object Storage). É critério de lançamento, não melhoria | **Alta** |
**C-27** | Nenhum app da VM tem stack de observabilidade reutilizável identificada. Sem isso, o painel de pipeline e o canal de plantão são construídos do zero | Média |

### C.2 Importantes — travam a Fase 1

| # | Dúvida | Default proposto |
|---|---|---|
**C-09** | **Redis.** Instância nova ou reaproveitar com database separado? | Nova instância em Docker; BullMQ e cache não devem competir com outro produto |
**C-10** | **Staging.** Existe ambiente? Mesma VM? | Compose separado na mesma VM, banco distinto, subdomínio `staging-ops`. Dado sempre anonimizado |
**C-11** | **E-mail transacional.** Provedor para magic link, resumo diário e relatório. SPF/DKIM do domínio? | Amazon SES ou Resend, com subdomínio próprio de envio para não contaminar a reputação do domínio principal |
**C-12** | **Observabilidade.** Existe stack reutilizável (Grafana, Loki, Prometheus, Sentry, uptime)? | Sentry para erro (self-hosted ou SaaS) + painel de pipeline próprio, gerado da declaração de ciclos. Grafana só se já existir |
**C-13** | **Backup.** Destino, retenção, quem guarda a chave de restore? | `pg_dump` diário cifrado para Oracle Object Storage, retenção 30 dias diários + 12 mensais, restauração ensaiada por trimestre |
**C-14** | **Node e gerenciador de pacotes.** | Node 22 LTS, pnpm com workspaces, Turborepo para cache de build |
**C-15** | **Design system.** Existe biblioteca ou tokens do Hub / `dashboard.cliente` para herdar? Existe Figma? | Se existir, herdamos os tokens; se não, `packages/ui` nasce com tokens próprios derivados da marca |
**C-16** | **WhatsApp / Evolution.** Instância, credencial e número que o Ops usa | Instância existente, com número dedicado ao relacionamento de CS |
**C-17** | **Credenciais das integrações.** Quem administra HubSpot, CleverTap e Omie, e quem pode criar app/token com escopo de leitura? | Um responsável por integração, nomeado |

### C.3 De produto — travam a validação, não o código

| # | Dúvida | Default proposto |
|---|---|---|
**C-18** | **Piloto.** Quais 2 ou 3 CSMs, e quem é o Head de CS que aprova a saída do modo sombra? | 3 CSMs com carteiras de perfil diferente |
**C-19** | **Pesquisa prévia.** Quando podemos fazer as 5 entrevistas e a sessão de observação? | Semana 1 da Fase 0. É bloqueante do desenho da fila |
**C-20** | **Nome e rota.** "Alloyal Success" é o nome final da ferramenta? | `ops.alloyal.com.br/success`, com a casca do Ops por cima |
**C-21** | **Quantos clientes e quantos CSMs hoje?** | Necessário para dimensionar o orçamento de fila (seção 9 do doc 01). Também é V-05 |
**C-22** | **Base de clientes tem contratos vencidos ou em aberto no HubSpot?** Qual a qualidade do cadastro? | Auditoria de 50 registros na Fase 0 |
**C-23** | **Existe planilha em uso hoje** que precise migrar (carteira, controle de implantação, acompanhamento)? | Inventariar na Fase 0, definir corte na F4 |
**C-24** | **Fuso e locale da VM já estão em UTC?** | UTC no sistema; conversão só na apresentação |

---

# D. Aprovações necessárias

Cinco mudanças revertem decisões registradas no Anexo B da v1.0. Nenhuma pode ser tratada como detalhe de implementação.

| # | Mudança | Quem aprova | Custo de não aprovar |
|---|---|---|---|
**D-01** | Portal do cliente em domínio próprio com magic link primário; iframe no `dashboard.cliente` vira evolução | Liderança de produto + time do dashboard | A Fase 0b da v1.0 (semana 9) fica bloqueada por um épico em outro time, sem contrato, dono ou prazo |
**D-02** | "Fim do PowerPoint" entregue pelo relatório do CSM, não pelo self-service | Liderança de CS + Comercial | O5 escorrega da semana 14 para a semana 41 |
**D-03** | Detecção de churn silencioso na Fase 2, não na 4c | Head de CS | O módulo de maior valor sai na semana 30+ em vez da 13 |
**D-04** | Score composto só publicado após calibração; drivers e faixa por regra antes | Head de CS | Score não calibrado erra ordenação, o time aprende a ignorá-lo, e não se recupera |
**D-05** | Prazo real: essenciais em 9 a 10 meses, escopo completo em 13 — com marcos de valor nas semanas 7, 13 e 14 | Diretoria | O compromisso de 8 meses da v1.0 não inclui nenhum dos gates de calendário e estoura na semana em que for cobrado |

**Uma decisão adicional, de escopo:** o comercial precisa saber o que **não** vai ao cliente no lançamento — health score visível, narrativa de IA publicada e acompanhamento de item interno. Alinhar antes de vender.

---

# E. Ordem de ataque

| Quando | O quê | Quem |
|---|---|---|
**Hoje** | Rodar V-01 e V-02 na réplica; perguntar V-11 ao admin do HubSpot | Plataforma / RevOps |
**Hoje** | **C-05** — rota de rede e credencial somente-leitura da réplica | Plataforma |
**Hoje** | **C-07** — client OAuth e os 8 grupos `ops-*` no Workspace | Stack / Workspace |
~~Hoje~~ | ~~Responder C-01 a C-08~~ — respondidas em 26/07; fundação construída | ✅ |
**Semana 1** | Aprovar D-01 a D-05 | Liderança |
**Semana 1** | Marcar as 5 entrevistas com CSMs | PM |
**Semana 1** | Nomear Data Owner e Encarregado | Diretoria / Jurídico |
**Semana 1–2** | Spike de dados (V-03 a V-06) | Eng. Dados |
**Semana 1–3** | Fase 0: repo, CI, SSO, design system v0, captura de MRR, instrumentação do CleverTap | Time |
**Semana 2** | Fechar DEF-01 a DEF-04 e DEF-06 | CS + Diretoria + Financeiro |
