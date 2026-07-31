import { datasCriticas, type DataCritica, type TipoData } from '@ops/contratos'
import type { Prioridade } from '@ops/metrics'
import type pg from 'pg'

import { gravarCandidato, prepararContexto, type ContextoGravacao } from './fila.js'

/**
 * Datas contratuais viram ITEM DE TRABALHO.
 *
 * O calendário responde "o que vence"; sozinho, ele é uma tela que alguém precisa
 * lembrar de abrir. A arquitetura deste produto é a oposta — o trabalho vem até a
 * pessoa —, e um calendário que ninguém abre é exatamente a falha que a fila existe
 * para evitar.
 *
 * Passa pelo MESMO caminho de gravação da fila (`gravarCandidato`), e por isso
 * herda as quatro regras sem reescrevê-las: dedup por família, carência, teto por
 * pessoa e modo sombra. Um gerador próprio de itens teria furado o teto de alguém
 * na primeira semana.
 *
 * Os gatilhos usam prefixo `C-` para a origem ser óbvia na fila e na calibração:
 * quem olha um item sabe se ele veio de sinal de uso ou de cláusula de contrato.
 */

/**
 * De data crítica para item de trabalho.
 *
 * A FAMÍLIA é a decisão que mais importa aqui, porque é ela que faz a dedup. Janela
 * de aviso e vencimento caem na mesma família de propósito: são a mesma conversa
 * com o cliente, e dois itens fariam o CSM ligar duas vezes para dizer a mesma
 * coisa.
 */
interface Regra {
  readonly gatilho: string
  readonly familia: string
  readonly cooldownDias: number | null
  /**
   * A partir de quantos dias antes a data merece um ITEM.
   *
   * O calendário mostra os seis meses; a fila não. A primeira rodada contra a massa
   * real gerou 54 itens de reajuste para 120 contas — enchente por construção, num
   * produto cujo orçamento é 12 itens por pessoa. Reajuste a cinco meses não é
   * ação, é informação: pertence ao calendário, e o item nasce quando há o que
   * fazer.
   *
   * `null` = sempre, independente de prazo. Só o aditivo pendurado, que é problema
   * de hoje todos os dias até alguém assinar.
   */
  readonly antecedenciaDias: number | null
}

const MAPA: Readonly<Record<TipoData, Regra | null>> = {
  // A janela abrindo é a conversa mais urgente que existe aqui, e 60 dias é o
  // tempo de agendar uma reunião com quem assina.
  janela_de_aviso: { gatilho: 'C-01', familia: 'renovacao', cooldownDias: null, antecedenciaDias: 60 },
  // Mesma família da janela: uma conversa, um item.
  vencimento: { gatilho: 'C-02', familia: 'renovacao', cooldownDias: null, antecedenciaDias: 90 },
  // O reajuste se aplica na competência; 45 dias antes é folga suficiente para
  // conferir índice e comunicar o cliente.
  reajuste: { gatilho: 'C-03', familia: 'reajuste', cooldownDias: 300, antecedenciaDias: 45 },
  obrigacao: { gatilho: 'C-04', familia: 'obrigacao', cooldownDias: 30, antecedenciaDias: 30 },
  aditivo_pendente: { gatilho: 'C-05', familia: 'assinatura', cooldownDias: 15, antecedenciaDias: null },
}

/** A data está perto o bastante para virar item? */
export function mereceItem(d: DataCritica, antecedenciaDias: number | null): boolean {
  // Já passou: sempre merece. Data crítica vencida é o pior caso, e o item nasce
  // vencido para aparecer no topo da fila.
  if (d.dias < 0) return true
  if (antecedenciaDias === null) return true
  return d.dias <= antecedenciaDias
}

/**
 * A prioridade sai do que se PERDE se a data passar, não do tipo.
 *
 * Data irreversível perto é crítica; irreversível longe é alta; reversível é média.
 * Classificar por tipo faria toda obrigação parecer tão urgente quanto uma janela
 * de aviso fechando amanhã.
 */
export function prioridadeDaData(d: DataCritica): Prioridade {
  if (d.dias < 0) return d.irreversivel ? 'critica' : 'alta'
  if (d.irreversivel) return d.dias <= 15 ? 'critica' : d.dias <= 45 ? 'alta' : 'media'
  return d.dias <= 15 ? 'alta' : 'media'
}

/**
 * O prazo do item: o dia da data, com piso de um dia.
 *
 * Data que já passou vira prazo de hoje, e não prazo negativo: o item nasce
 * vencido, o que é a verdade, e o banco recusaria prazo anterior à competência de
 * qualquer forma.
 */
export function prazoDaData(d: DataCritica): number {
  return Math.max(0, d.dias)
}

export interface ResumoContratual {
  readonly competencia: string
  readonly datasAvaliadas: number
  readonly criados: number
  readonly atualizados: number
  readonly emSombra: number
  readonly emBacklog: number
  readonly bloqueadosPorCarencia: number
  readonly semDono: number
  /** Datas reais que ficaram só no calendário, por estarem longe. */
  readonly longeParaItem: number
}

/**
 * Identidade de serviço para a leitura da base inteira.
 *
 * O ciclo não age em nome de ninguém: ele lê tudo e roteia para o dono de cada
 * conta. Reaproveitar a identidade de uma pessoa aqui faria o recorte da carteira
 * dela silenciosamente limitar o que o ciclo enxerga.
 */
const SERVICO = {
  email: 'ciclo:C16',
  papeis: [] as const,
  permissoes: {
    contas: 'base',
    fila: 'base',
    receita: 'base',
    configurar: true,
    aprovaDistrato: 'nao',
    dadoIndividual: false,
  },
} as const

export async function avaliarDatasContratuais(
  pool: pg.Pool,
  competencia: string,
  opts: { agora?: Date; meses?: number } = {},
): Promise<ResumoContratual> {
  const agora = opts.agora ?? new Date()
  const hoje = agora.toISOString().slice(0, 10)

  const datas = await datasCriticas(
    pool,
    SERVICO as unknown as Parameters<typeof datasCriticas>[1],
    { hoje, ...(opts.meses === undefined ? {} : { meses: opts.meses }) },
  )

  let criados = 0
  let atualizados = 0
  let emSombra = 0
  let emBacklog = 0
  let bloqueados = 0
  let semDono = 0
  let longeDemais = 0

  const cliente = await pool.connect()
  try {
    await cliente.query('BEGIN')
    const ctx: ContextoGravacao = await prepararContexto(cliente, competencia, agora)

    // Mais urgente primeiro: se o teto cortar, tem que cortar o menos urgente.
    const ordenadas = [...datas].sort((a, b) => a.dias - b.dias)

    for (const d of ordenadas) {
      const m = MAPA[d.tipo]
      if (!m) continue
      if (!mereceItem(d, m.antecedenciaDias)) {
        longeDemais++
        continue
      }
      if (!d.donoEmail) {
        // Sem dono não há item: item de trabalho sem responsável é lista, e lista
        // não é fila. O número aparece no log para alguém corrigir a carteira.
        semDono++
        continue
      }

      const desfecho = await gravarCandidato(ctx, {
        accountId: d.accountId,
        gatilho: m.gatilho,
        familia: m.familia,
        prioridade: prioridadeDaData(d),
        motivo: d.descricao,
        evidencia: {
          tipo_data: d.tipo,
          data: d.data,
          dias: d.dias,
          irreversivel: d.irreversivel,
          mrr_centavos: d.mrrCentavos,
        },
        prazoDias: prazoDaData(d),
        dono: d.donoEmail,
        cooldownDias: m.cooldownDias,
      })

      if (desfecho === 'atualizado') atualizados++
      else if (desfecho === 'bloqueado') bloqueados++
      else {
        criados++
        if (desfecho === 'sombra') emSombra++
        else if (desfecho === 'backlog') emBacklog++
      }
    }

    await cliente.query('COMMIT')
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    cliente.release()
  }

  return {
    competencia,
    datasAvaliadas: datas.length,
    criados,
    atualizados,
    emSombra,
    emBacklog,
    bloqueadosPorCarencia: bloqueados,
    semDono,
    longeParaItem: longeDemais,
  }
}
