/**
 * Registro dos ciclos da Fase 0.
 *
 * Doc 01, seção 12. Cada ciclo aqui é uma casca declarada: o contrato está
 * completo e a implementação (`executar`) só será escrita depois do spike de
 * dados, porque V-01 e V-02 decidem entre dois desenhos incompatíveis:
 *
 *   caminho A — `updated_at` confiável e índice presente → C1 incremental
 *   caminho B — sem um dos dois → C3 (reconciliação) passa a ser o principal,
 *               com janela de 180 dias na carga inicial, e os agregados vêm de
 *               tabela materializada na origem
 *
 * Declarar o contrato antes de implementar é deliberado: é ele que gera o painel
 * de pipeline e as verificações de qualidade, e ele não muda entre A e B.
 *
 * Declarar cron em UTC com um comentário dizendo o horário local é a forma
 * clássica de o comentário e o valor divergirem — e o sintoma aparece meses
 * depois, como "o snapshot saiu na hora errada". As agendas abaixo estão em
 * horário de São Paulo, e o agendador aplica o fuso (ver `queue.ts`).
 */

import {
  abrirJanela,
  competenciaAnterior,
  CompetenciaCongeladaError,
  fechar,
} from "@pulse/success";

import { vencerObrigacoes } from "@pulse/contratos";

import { calcularBenchmark } from "@pulse/success";

import { avaliarDatasContratuais } from "../contratual.js";
import { consolidar } from "../consolidacao.js";
import { avaliarFila } from "../fila.js";
import {
  credencialDoCore,
  lerLogoDoApp,
  lerNegocios,
  sincronizarCadastro,
} from "@pulse/config";

import { defineCycle } from "../cycle.js";
import { poolDoWorker } from "../db.js";

/**
 * A casca de um ciclo declarado e não implementado.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ A MARCA `casca` existe porque a alternativa era EXECUTAR o ciclo para saber. │
 * │ `ehCasca` chamava `executar(undefined)` e classificava pelo erro — o que só   │
 * │ funcionava porque todo ciclo tocava em `ctx` na primeira linha e quebrava na  │
 * │ hora. O C19 não toca: ele lê a base e chama a API do fornecedor antes disso.  │
 * │                                                                            │
 * │ Resultado, medido em 05/08/2026: a "verificação" rodou o ciclo inteiro — 900  │
 * │ chamadas à API do core — segurando ABERTA a transação de registro das         │
 * │ declarações. O worker nunca terminava de subir, sem log e sem erro.           │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
const naoImplementado = (id: string) => {
  const casca = async (): Promise<never> => {
    throw new Error(
      `Ciclo ${id} declarado e não implementado. Aguarda o spike de dados (doc 02, B.2).`,
    );
  };
  (casca as { ehCascaDeclarada?: boolean }).ehCascaDeclarada = true;
  return casca;
};

/**
 * C5 — eventos de MRR.
 *
 * O ÚNICO ciclo cuja perda é irrecuperável, e por isso o primeiro a ser
 * implementado, na Fase 0. Não existe como reconstruir retroativamente a razão
 * pela qual um contrato mudou de valor.
 *
 * Entre a Fase 0 e a Fase 7 não há fluxo próprio gerando esses eventos: as
 * mudanças acontecem no HubSpot, por pessoas. Depende de V-11 (o HubSpot permite
 * webhook de mudança de propriedade de deal?). Se a resposta for não, o plano B é
 * varredura de 15 minutos sobre `hs_lastmodifieddate` mais entrada manual
 * assistida na renovação — pior, mas não irrecuperável.
 */
export const c5MrrEvents = defineCycle({
  id: "C5",
  descricao: "Eventos de MRR do HubSpot",
  fonte: "hubspot",
  metodo: "incremental_watermark",
  agenda: "*/15 * * * *",
  janela: "desde_watermark",
  chaveNatural: ["origem", "hubspot_deal_id", "competencia", "tipo"],
  emFalha: {
    tentativas: 5,
    backoff: "exponencial",
    alarmeApos: 1,
    degradacao: "alarme_critico",
  },
  fase: "F0",
  executar: naoImplementado("C5"),
});

export const c1Transacoes = defineCycle({
  id: "C1",
  descricao: "Transações da réplica",
  fonte: "replica",
  metodo: "incremental_watermark",
  agenda: "*/15 * * * *",
  janela: "desde_watermark",
  chaveNatural: ["account_id", "dia"],
  emFalha: {
    tentativas: 3,
    backoff: "exponencial",
    alarmeApos: 2,
    degradacao: "reprocessa",
  },
  fase: "F1",
  executar: naoImplementado("C1"),
});

/**
 * C18 — cadastro de cliente da API do core (Lecupon v3).
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ POR QUE UM CICLO NOVO, E NÃO O C2:                                         │
 * │                                                                            │
 * │ O C2 é `fonte: 'replica'` e continua sendo — ele trata base elegível e      │
 * │ ativada a partir do banco. Este lê do CORE por API. Fontes diferentes têm   │
 * │ disponibilidade, latência e modo de falha diferentes, e o painel de         │
 * │ pipeline mostra por fonte: juntá-los faria "a réplica está atrasada" e "a   │
 * │ API do core recusou a credencial" aparecerem como o mesmo problema.        │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ `metodo: 'full'` E NÃO `incremental_watermark` — não é escolha, é medição.  │
 * │                                                                            │
 * │ A API não tem filtro por data de atualização e a página é fixa em 30. Ler   │
 * │ só o que mudou é impossível; o que o ciclo faz é ler tudo e GRAVAR só o que │
 * │ mudou. Declarar `incremental_watermark` aqui seria mentir no contrato que   │
 * │ alimenta o painel.                                                        │
 * │                                                                            │
 * │ ~3.245 clientes ÷ 30 por página = ~108 requisições por rodada. É isso que  │
 * │ faz a agenda ser 02:00 diária: uma vez por dia, na madrugada.              │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Sem credencial configurada o ciclo NÃO falha: devolve zero e diz o motivo. Ciclo
 * que quebra por falta de configuração enche o alarme de ruído previsível — é a
 * mesma razão da trava anti-lockout do step-up de e-mail.
 */
/**
 * Teto por rodada. A base tem 3.172 clientes a ~305 ms cada: varrer tudo levaria ~16
 * minutos numa API que também sustenta o cadastro. 900 por noite cobre a base em ~4
 * dias e mantém a janela curta — e quem ainda não tem logo vem primeiro.
 */
const TETO_DE_LOGOS_POR_RODADA = 900;

export const c18CadastroDoCore = defineCycle({
  id: "C18",
  descricao: "Cadastro de cliente e configuração de programa (API do core)",
  fonte: "core",
  metodo: "full",
  agenda: "0 2 * * *",
  janela: "estado_atual",
  chaveNatural: ["brand_id"],
  emFalha: {
    tentativas: 3,
    backoff: "exponencial",
    alarmeApos: 2,
    degradacao: "snapshot_parcial",
  },
  fase: "F1",
  executar: async (ctx) => {
    // Banco primeiro (Configurações → Segredos), ambiente como reserva de
    // desenvolvimento. Antes lia SÓ do ambiente, e quem cadastrasse pela tela veria
    // "salvo" com o ciclo seguindo inerte, sem nada explicar a contradição.
    const cred = await credencialDoCore(poolDoWorker(), process.env);
    if (!cred) {
      ctx.log(
        "credencial do core não cadastrada — ciclo INERTE, nada lido. Cadastre em " +
          "Configurações → Segredos (lecupon.employee_token e lecupon.employee_email).",
      );
      // `inerte` e não `ok`: ler zero por falta de configuração NÃO é sucesso. Como
      // `ok`, a tela mostrava "última execução bem-sucedida: hoje" para um ciclo que
      // nunca leu uma linha — mesma família do health check que respondia 200 com a
      // aplicação parada.
      return {
        linhasLidas: 0,
        linhasGravadas: 0,
        inerte: true,
        detalhe: { motivo: "sem_credencial", onde: "Configurações → Segredos" },
      };
    }

    const { negocios, paginas, parcial } = await lerNegocios(cred, {
      log: ctx.log,
    });
    ctx.log(
      `${negocios.length} cliente(s) em ${paginas} página(s)${parcial ? " — PARCIAL" : ""}`,
    );

    const r = await sincronizarCadastro(
      poolDoWorker(),
      negocios,
      ctx.agora,
      parcial,
      ctx.log,
      // O CNPJ do TENANT é o CNPJ da própria Alloyal no core — é ele que separa conta
      // interna de conta de cliente. Sem `lecupon.tenant_cnpj` cadastrado, as contas
      // internas caem em `filial`: não é erro, é menos informação, e o log diz isso.
      cred.tenantCnpj ?? "",
    );
    ctx.log(
      `criados ${r.criados} · atualizados ${r.atualizados} · inalterados ${r.inalterados} · ` +
        `módulos ${r.modulosGravados} · hierarquia ${r.hierarquiaLigada} · ` +
        `com hubspot_company_id ${r.comHubspot} · sem CNPJ ${r.semCnpj}`,
    );
    ctx.log(
      `de-para do HubSpot: ${r.classificados} classificados · ${r.pendentes} esperando decisão` +
        (cred.tenantCnpj
          ? ""
          : ' · SEM lecupon.tenant_cnpj: conta interna da Alloyal não é reconhecida e cai em "filial"'),
    );

    return {
      linhasLidas: r.lidos,
      linhasGravadas: r.criados + r.atualizados,
      // Sem `novoWatermark`: não há de onde tirar um. A ausência é o registro
      // honesto de que este ciclo é carga cheia.
      detalhe: { ...r, paginas, parcial },
    };
  },
});

export const c2BaseElegivel = defineCycle({
  id: "C2",
  descricao: "Base elegível e ativada",
  fonte: "replica",
  metodo: "full",
  agenda: "0 2 * * *",
  janela: "estado_atual",
  chaveNatural: ["account_id"],
  emFalha: {
    tentativas: 2,
    backoff: "fixo",
    alarmeApos: 1,
    degradacao: "snapshot_parcial",
  },
  fase: "F1",
  executar: naoImplementado("C2"),
});

export const c3Reconciliacao = defineCycle({
  id: "C3",
  descricao: "Reconciliação de 90 dias com a origem",
  fonte: "replica",
  metodo: "reconciliacao",
  agenda: "0 4 * * *",
  janela: "90d",
  chaveNatural: ["account_id", "dia"],
  emFalha: {
    tentativas: 1,
    backoff: "fixo",
    alarmeApos: 1,
    degradacao: "reprocessa",
  },
  fase: "F1",
  executar: naoImplementado("C3"),
});

export const c8Adimplencia = defineCycle({
  id: "C8",
  descricao: "Adimplência do Omie",
  fonte: "omie",
  metodo: "full",
  agenda: "0 6 * * *",
  janela: "estado_atual",
  chaveNatural: ["account_id"],
  emFalha: {
    tentativas: 3,
    backoff: "exponencial",
    alarmeApos: 1,
    degradacao: "neutro_sinalizado",
  },
  fase: "F1",
  executar: naoImplementado("C8"),
});

/**
 * C12 — snapshot diário.
 *
 * ESPERA C2, C3, C6 e C8 até 06:50. O que não chegou entra como lacuna marcada
 * e o snapshot é publicado PARCIAL — nunca bloqueado.
 *
 * Bloquear significaria produto no ar sem número nenhum, e tornaria a meta de
 * cobertura de sinal impossível por construção: bastaria uma fonte atrasar para
 * o dia inteiro ficar sem dado.
 */
export const c12Snapshot = defineCycle({
  id: "C12",
  descricao: "Snapshot diário, sinais e avaliação de gatilhos",
  fonte: "ops",
  metodo: "consolidacao",
  agenda: "0 7 * * *",
  janela: "dia_anterior",
  chaveNatural: ["competencia", "account_id"],
  emFalha: {
    tentativas: 2,
    backoff: "fixo",
    alarmeApos: 1,
    degradacao: "snapshot_parcial",
  },
  fase: "F1",
  executar: async (ctx) => {
    // A competência é o dia anterior fechado: transação do dia corrente entra
    // no snapshot de amanhã.
    const competencia = new Date(ctx.agora.getTime() - 86_400_000)
      .toISOString()
      .slice(0, 10);
    const pool = poolDoWorker();
    const r = await consolidar(pool, competencia, { agora: ctx.agora });
    ctx.log(
      `${r.contas} contas · ${r.completos} completas · ${r.parciais} parciais · ` +
        `${r.emChurnSilencioso} em churn silencioso · ${r.suprimidos} recortes suprimidos`,
    );

    // A fila é avaliada DEPOIS da consolidação, na mesma execução: um item de
    // trabalho gerado contra sinais da competência anterior mandaria o CSM agir
    // sobre um número que já mudou.
    const f = await avaliarFila(pool, competencia, { agora: ctx.agora });
    ctx.log(
      `fila · ${f.criados} criados (${f.emSombra} em sombra, ${f.emBacklog} no backlog) · ` +
        `${f.atualizados} atualizados · ${f.bloqueadosPorCarencia} em carência`,
    );

    return {
      linhasLidas: r.contas,
      linhasGravadas: r.sinais + r.publicados + r.suprimidos + f.criados,
      detalhe: { consolidacao: r, fila: f },
    };
  },
});

/**
 * C13 — fechamento mensal.
 *
 * Roda todo dia enquanto a competência anterior estiver ABERTA, e não uma vez
 * só no dia 1: evento de MRR chega atrasado — uma aprovação de distrato no dia
 * 4 pertence ao mês 3 — e uma cascata calculada uma vez ficaria errada até
 * alguém reparar. Recalcular é barato; descobrir tarde não é.
 *
 * O congelamento NÃO é automático. Ele é a decisão de uma pessoa de que aquele
 * mês está pronto para ir ao board, e a partir dali os números não mudam mais.
 * Automatizá-lo transformaria o relógio em autoridade sobre o número.
 */
export const c13Fechamento = defineCycle({
  id: "C13",
  descricao: "Cascata de receita da competência anterior",
  fonte: "ops",
  metodo: "consolidacao",
  agenda: "30 7 * * *",
  janela: "mes_anterior",
  chaveNatural: ["competencia"],
  emFalha: {
    tentativas: 2,
    backoff: "fixo",
    alarmeApos: 1,
    degradacao: "neutro_sinalizado",
  },
  fase: "F1",
  executar: async (ctx) => {
    const anterior = competenciaAnterior(ctx.agora.toISOString().slice(0, 10));
    const pool = poolDoWorker();
    try {
      const c = await fechar(pool, anterior);
      const residuo = Number(c.naoAtribuidoCentavos);
      ctx.log(
        `${c.competencia.slice(0, 7)} · MRR final ${(Number(c.mrrFinalCentavos) / 100).toFixed(0)} · ` +
          `NRR ${c.nrr ?? "—"} · GRR ${c.grr ?? "—"} · não atribuído ${(residuo / 100).toFixed(0)}`,
      );
      return {
        linhasLidas: c.contasIniciais,
        linhasGravadas: 1,
        detalhe: { cascata: c },
      };
    } catch (err) {
      if (err instanceof CompetenciaCongeladaError) {
        // Não é falha: é o estado normal depois que alguém fechou o mês. Tratar
        // como erro encheria o painel de alarme previsível todo santo dia.
        ctx.log(`${anterior.slice(0, 7)} já congelada — nada a recalcular`);
        return { linhasLidas: 0, linhasGravadas: 0 };
      }
      throw err;
    }
  },
});

/**
 * C14 — abertura das janelas de renovação.
 *
 * Roda todo dia, não uma vez por mês: um contrato que entra na janela hoje tem
 * que aparecer hoje. O propósito do módulo inteiro é nunca descobrir um
 * vencimento pelo vencimento, e um ciclo mensal criaria até 30 dias de atraso na
 * descoberta — dentro de uma janela de 90.
 *
 * Antes do C12 de propósito: a renovação existe quando o gatilho G-09 avalia a
 * conta, e não depois dele. Na ordem inversa, o item de trabalho de renovação
 * apareceria um dia antes da renovação que ele representa.
 */
export const c14Renovacoes = defineCycle({
  id: "C14",
  descricao: "Abertura das janelas de renovação (90 dias da vigência)",
  fonte: "ops",
  metodo: "consolidacao",
  agenda: "30 6 * * *",
  janela: "estado_atual",
  chaveNatural: ["account_id", "vigencia_fim"],
  emFalha: {
    tentativas: 2,
    backoff: "fixo",
    alarmeApos: 2,
    degradacao: "reprocessa",
  },
  fase: "F1",
  executar: async (ctx) => {
    const r = await abrirJanela(poolDoWorker(), {
      hoje: ctx.agora.toISOString().slice(0, 10),
    });
    ctx.log(
      `${r.abertas} janela(s) aberta(s) · ${r.jaAbertas} já estavam na janela`,
    );
    return { linhasLidas: r.abertas + r.jaAbertas, linhasGravadas: r.abertas };
  },
});

/**
 * C15 — vencer obrigações contratuais.
 *
 * Estado gravado e não derivado da data na leitura, porque a tela precisa
 * distinguir "venceu e ninguém viu" de "venceu e alguém decidiu deixar vencer" — e
 * as duas só se separam se o estado for gravado por alguém, ou por este ciclo.
 *
 * Roda cedo, antes do snapshot: obrigação vencida é fato de ontem, e aparecer no
 * calendário de hoje já vencida é o comportamento certo.
 */
export const c15Obrigacoes = defineCycle({
  id: "C15",
  descricao: "Vencimento de obrigações contratuais",
  fonte: "ops",
  metodo: "consolidacao",
  agenda: "15 6 * * *",
  janela: "estado_atual",
  chaveNatural: ["id"],
  emFalha: {
    tentativas: 2,
    backoff: "fixo",
    alarmeApos: 2,
    degradacao: "reprocessa",
  },
  fase: "F1",
  executar: async (ctx) => {
    const n = await vencerObrigacoes(poolDoWorker(), {
      hoje: ctx.agora.toISOString().slice(0, 10),
    });
    ctx.log(`${n} obrigação(ões) marcada(s) como vencida(s)`);
    return { linhasLidas: n, linhasGravadas: n };
  },
});

/**
 * C16 — datas contratuais viram item de trabalho.
 *
 * Depois do C15 (que vence obrigações) e do C14 (que abre janelas de renovação),
 * porque as duas mudam o que este ciclo vai encontrar. Antes do C12 não seria
 * possível: o teto por pessoa é contado no momento da gravação, e as duas rodadas
 * precisam ver a mesma fila para o teto valer sobre o total.
 *
 * O calendário sozinho é uma tela que alguém precisa lembrar de abrir. Este ciclo
 * é o que faz a data crítica virar trabalho de alguém, com dono e prazo.
 */
export const c16DatasContratuais = defineCycle({
  id: "C16",
  descricao: "Datas contratuais viram item de trabalho",
  fonte: "ops",
  metodo: "consolidacao",
  agenda: "45 6 * * *",
  janela: "estado_atual",
  chaveNatural: ["account_id", "familia"],
  emFalha: {
    tentativas: 2,
    backoff: "fixo",
    alarmeApos: 1,
    degradacao: "reprocessa",
  },
  fase: "F1",
  executar: async (ctx) => {
    const competencia = ctx.agora.toISOString().slice(0, 10);
    const r = await avaliarDatasContratuais(poolDoWorker(), competencia, {
      agora: ctx.agora,
    });
    ctx.log(
      `${r.datasAvaliadas} data(s) · ${r.criados} criados (${r.emSombra} em sombra, ` +
        `${r.emBacklog} no backlog) · ${r.atualizados} atualizados · ` +
        `${r.bloqueadosPorCarencia} em carência` +
        (r.semDono > 0 ? ` · ${r.semDono} sem dono (carteira a corrigir)` : ""),
    );
    return {
      linhasLidas: r.datasAvaliadas,
      linhasGravadas: r.criados,
      detalhe: { contratual: r },
    };
  },
});

/**
 * C17 — benchmark anônimo por porte e setor.
 *
 * Depois do C12, porque lê o snapshot dele. É o único agregado do produto que sai da
 * empresa contendo informação derivada de OUTROS clientes, e por isso o k-anonimato
 * é aplicado no cálculo e imposto pelo banco: recorte pequeno é gravado suprimido e
 * sem valor, nunca omitido.
 *
 * Recalcula a competência inteira a cada rodada, apagando antes: um recorte que
 * deixa de atingir o mínimo — porque uma conta saiu — tem que voltar a ser suprimido,
 * e um UPSERT sem a limpeza deixaria o valor antigo publicado.
 */
export const c17Benchmark = defineCycle({
  id: "C17",
  descricao: "Benchmark anônimo por porte e setor (k-anonimato)",
  fonte: "ops",
  metodo: "consolidacao",
  agenda: "15 8 * * *",
  janela: "dia_anterior",
  chaveNatural: ["competencia", "porte", "setor", "metrica"],
  emFalha: {
    tentativas: 2,
    backoff: "fixo",
    alarmeApos: 1,
    degradacao: "neutro_sinalizado",
  },
  fase: "F3",
  executar: async (ctx) => {
    const competencia = new Date(ctx.agora.getTime() - 86_400_000)
      .toISOString()
      .slice(0, 10);
    const r = await calcularBenchmark(poolDoWorker(), competencia);
    ctx.log(
      `${r.gravados} recorte(s) publicado(s) · ${r.suprimidos} suprimido(s) por k-anonimato`,
    );
    return {
      linhasLidas: r.recortes.length,
      linhasGravadas: r.gravados + r.suprimidos,
    };
  },
});

export const CICLOS_ESPERADOS_PELO_SNAPSHOT = ["C2", "C3", "C6", "C8"] as const;
export const PRAZO_ESPERA_SNAPSHOT_BRT = "06:50";

/**
 * C19 — logo do cliente, de "Customização do App" no core.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ CICLO SEPARADO DO C18, mesma fonte, e é decisão de VOLUME e de falha:        │
 * │                                                                            │
 * │ o C18 lê a lista em ~109 requisições; este lê UMA POR CLIENTE — 3.172, a     │
 * │ ~305 ms cada. Juntá-los transformaria uma carga de 2 minutos numa de 20, e   │
 * │ um 429 na busca de logo derrubaria o cadastro junto. Cadastro é o que        │
 * │ sustenta a tela; logo é enfeite útil. Falhar em enfeite não pode custar o    │
 * │ cadastro.                                                                   │
 * │                                                                            │
 * │ 02:30 e não 02:00: depois do C18, para os clientes novos do dia já entrarem  │
 * │ na varredura.                                                              │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Lê PRIMEIRO quem não tem logo. Numa base em que 3.172 clientes existem e poucos
 * mudam de identidade visual, varrer sempre na mesma ordem faria o fim da lista nunca
 * chegar se o ciclo fosse interrompido.
 */
export const c19LogoDoCliente = defineCycle({
  id: "C19",
  descricao: "Logo do cliente (Customização do App, API do core)",
  fonte: "core",
  metodo: "full",
  agenda: "30 2 * * *",
  janela: "estado_atual",
  chaveNatural: ["brand_id"],
  emFalha: {
    tentativas: 2,
    backoff: "exponencial",
    alarmeApos: 3,
    degradacao: "snapshot_parcial",
  },
  fase: "F1",
  executar: async (ctx) => {
    const db = poolDoWorker();
    const cred = await credencialDoCore(db, process.env);
    if (!cred) {
      ctx.log(
        "credencial do core não cadastrada — ciclo INERTE. Configurações → Segredos.",
      );
      return {
        linhasLidas: 0,
        linhasGravadas: 0,
        inerte: true,
        detalhe: { motivo: "sem_credencial" },
      };
    }

    const { rows } = await db.query<{ id: string; brand_id: string }>(
      `SELECT id::text, brand_id
         FROM core.account
        WHERE ativo AND brand_id ~ '^[0-9]+$'
        ORDER BY (logo_url IS NOT NULL), coalesce(logo_em, '-infinity'::timestamptz)
        LIMIT $1`,
      [TETO_DE_LOGOS_POR_RODADA],
    );

    let comLogo = 0;
    let semLogo = 0;
    let falhas = 0;
    const origens: Record<string, number> = {};

    // EM SÉRIE, de propósito: é a API do core, a mesma que sustenta o cadastro. Abrir
    // dezenas de conexões para buscar enfeite é o jeito de ganhar um 429 que atrapalha o
    // que importa.
    for (const conta of rows) {
      try {
        const logo = await lerLogoDoApp(cred, conta.brand_id);
        if (logo) {
          comLogo++;
          origens[logo.origem] = (origens[logo.origem] ?? 0) + 1;
          await db.query(
            `UPDATE core.account SET logo_url = $2, logo_origem = $3, logo_em = now() WHERE id = $1`,
            [conta.id, logo.url, logo.origem],
          );
        } else {
          semLogo++;
          // `logo_em` marcado mesmo sem logo: sem isso, quem não tem logo seria
          // reconsultado toda rodada e as 3.172 nunca terminariam de ser varridas.
          await db.query(
            `UPDATE core.account SET logo_url = NULL, logo_origem = NULL, logo_em = now() WHERE id = $1`,
            [conta.id],
          );
        }
      } catch {
        // Falha de um cliente não derruba a varredura: o próximo pode estar bem, e o
        // ciclo existe para percorrer a base inteira.
        falhas++;
      }
    }

    ctx.log(
      `${rows.length} consultado(s) · ${comLogo} com logo · ${semLogo} sem · ${falhas} falha(s) · ` +
        `origem: ${
          Object.entries(origens)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ") || "—"
        }`,
    );
    return {
      linhasLidas: rows.length,
      linhasGravadas: comLogo,
      detalhe: { comLogo, semLogo, falhas, origens },
    };
  },
});
