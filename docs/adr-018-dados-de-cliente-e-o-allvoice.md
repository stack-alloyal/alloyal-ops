# ADR-018 — De onde o Pulse tira o cadastro de cliente, e o papel do Allvoice

**Data:** 04/08/2026
**Estado:** proposta, à espera de decisão

## A pergunta

Já existe fluxo de organizações e dados de cliente no Allvoice (ex-Alloyal Hub).
Três caminhos foram levantados:

1. fluxo separado — o Pulse integra por conta própria;
2. o Pulse consome do Allvoice;
3. o Allvoice passa a consumir do Pulse, como fonte da verdade.

## O que foi medido antes de decidir

**O Allvoice NÃO é dono desse dado.** Ele consome
`api.lecupon.com/client/v3` — a API do core da Alloyal — em
`access-validation.service.ts`. A tabela `organizations` dele
(`organization.entity.ts`) tem cinco campos: `name`, `domain`, `document`,
`parentId` e o tenant. É CRM-leve para agrupar contatos de conversa, criado por
`create()` manual. Não é cadastro-mestre e não pretende ser.

**A API do core responde desta VM, agora, com credencial que já existe.**
Conferido em 04/08/2026 — HTTP 200 em `/businesses`. Ela devolve, por cliente:

| campo | o que resolve no Pulse |
|---|---|
| `id`, `name`, `cnpj` | identidade do cliente |
| **`hubspot_company_id`** | **o "casamento de chaves", primeiro entregável do squad** |
| `status` (`active`, `inactive`, `suspended_by_overdue`) | sinal de inadimplência já refletido no core |
| `active` | se o cliente está de fato no ar |
| `user_count`, `authorized_user_count` | base cadastrada × contratada (métrica de Operações) |
| `cashback`, `giftcard`, `marketplace`, `telemedicine`, `subscription`, `voucher_bucket`, `wallet`, … | configuração do programa — o domínio "Painel do Cliente" |
| `main_business_id` | hierarquia matriz ↔ filial |
| `contact_email` | contato do cliente |

Escopo conferido: 30 registros, **28 raízes de CNPJ distintas** — empresas não
relacionadas, e não um grupo só. `Tenant-id` vai vazio, então o retorno é o escopo
inteiro da credencial.

## Decisão proposta

**O Pulse consome a MESMA API do core que o Allvoice consome. Não consome do
Allvoice, e o Allvoice não passa a depender do Pulse para operar.**

Os dois viram consumidores do mesmo dono — que é exatamente o modelo de fonte da
verdade que o Pulse propõe. Isso não é duplicação: duplicação seria dois donos.

### Por que NÃO o Pulse consumindo do Allvoice

- Seria **consumir um consumidor**. O dado chegaria com um salto a mais e já
  filtrado pelo que o Allvoice precisou — que é agrupar contato, não medir
  contrato e receita.
- A frescura do dado do Pulse passaria a depender do uptime do Allvoice, e uma
  janela de indisponibilidade lá viraria número velho aqui, sem sinal.
- A `organizations` do Allvoice é **preenchida à mão**. Consumi-la faria o Pulse
  herdar as lacunas de quem não cadastrou.

### Por que NÃO o Allvoice consumindo do Pulse (ainda)

- A validação de acesso do Allvoice responde **em tempo real** se uma pessoa tem
  acesso. O Pulse é camada de consolidação, com ciclos. Pôr um portão de tempo
  real atrás de um consumidor em lote é rebaixar o portão.
- E o Pulse **não é dono** do cadastro. Pela própria tabela de fonte da verdade
  dele, cadastro nasce no HubSpot e a verdade operacional vive no core. O Pulse é
  dono da CONSOLIDAÇÃO, não do registro.

### Onde o Allvoice DEVE passar a consumir do Pulse

Numa coisa só, e é onde o Pulse é dono de verdade: **o de-para de chaves.**

Hoje o Allvoice guarda `hubspot_company_id` como campo customizado
(`custom-fields.service.ts`) e resolve `business` ↔ CNPJ por conta própria
(`resolveBusinessId`). Esse de-para é entregável declarado do Pulse. Quando ele
existir, o Allvoice lendo dali elimina um mapeamento mantido em dois lugares — que
é a única duplicação real entre os dois sistemas.

## O que isso desbloqueia

`C-05` estava travado em "réplica: rota + credencial". A API do core **não
substitui** a réplica, mas resolve boa parte do que dependia dela:

| precisa | vem da API do core? |
|---|---|
| cadastro de cliente, CNPJ, hierarquia | **sim** |
| de-para `hubspot_company_id` | **sim** |
| configuração do programa (módulos ativos) | **sim** |
| base cadastrada × contratada | **sim** |
| sinal de inadimplência (`suspended_by_overdue`) | **sim** — sinal, não valor |
| transação, GMV, cupom, cashback movimentado | **não** — a réplica continua necessária |
| valor faturado, aging, recebimento | **não** — é o Omie |

Ou seja: **os ciclos C1–C4 de cadastro e configuração podem começar sem a
réplica.** O que continua travado é o transacional.

## O que confirmar antes de implementar

1. **Escopo da credencial.** Os 30 registros são a base inteira da Alloyal ou o
   recorte deste `X-ClientEmployee`? Se for recorte, o Pulse precisa de credencial
   com escopo de plataforma — e essa é a pergunta a fazer a quem opera o core.
2. **Carga incremental.** Não foi achado filtro por data de atualização em
   `/businesses`. Sem ele, o ciclo é carga cheia — aceitável em 30 clientes,
   caro em milhares.
3. **Credencial própria do Pulse.** Reaproveitar a do Allvoice acopla rotação dos
   dois, e é a mesma razão que fez o Pulse ter client OAuth próprio.
4. **Limite de chamada.** O `access-validation.service.ts` do Allvoice tem
   `LECUPON_MAX_CHECKS_PER_MIN` (600) porque tratou isso como risco de DoS
   direcionado. O ciclo do Pulse precisa do mesmo respeito.
