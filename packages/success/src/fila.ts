import type { Identidade } from '@ops/auth'
import type pg from 'pg'

/**
 * A consulta da fila e o fechamento de item.
 *
 * Está aqui, e não dentro do componente, porque duas regras deste arquivo são
 * as que causam dano quando erram: o RECORTE (quem vê qual item) e o MODO
 * SOMBRA (item que o time não deveria estar vendo ainda). Ambas são testadas
 * contra Postgres real em `fila.test.ts` — a asserção é sobre o que NÃO
 * aparece, que é o tipo de erro que passa despercebido numa revisão de tela.
 *
 * Sem `server-only`, ao contrário das outras telas, para que o teste consiga
 * importar o módulo. A marca não faz falta aqui: toda função recebe o `pg.Pool`
 * por parâmetro, e o pool só nasce em `lib/db.ts`, que é `server-only`. Um
 * componente de cliente não tem como obter um — a cadeia está barrada na raiz.
 */

export interface ItemDaFila {
  id: string
  accountId: string
  conta: string
  gatilho: string
  familia: string
  prioridade: 'baixa' | 'media' | 'alta' | 'critica'
  motivo: string
  evidencia: Record<string, unknown>
  donoEmail: string
  prazo: string
  estado: 'aberto' | 'backlog'
  modoSombra: boolean
  diasParaPrazo: number
  diasAberto: number
  mrrCentavos: string | null
  /** O playbook que valia quando o item foi criado. `null` se o gatilho não tem. */
  playbookId: string | null
  playbookTitulo: string | null
}

export interface Fila {
  abertos: ItemDaFila[]
  backlog: ItemDaFila[]
  sombra: ItemDaFila[]
  /** Verdadeiro quando a pessoa enxerga a fila da base inteira, não só a sua. */
  visaoDaBase: boolean
}

/**
 * Quem enxerga item em modo sombra.
 *
 * O propósito do modo sombra é medir a precisão de um gatilho ANTES de gastar a
 * atenção do time com ele. Se o CSM vir esses itens, o experimento acabou: ou
 * ele age (e o gatilho nunca é medido em repouso), ou ele aprende que parte da
 * fila é para ignorar. Só quem aprova a promoção enxerga.
 */
export const vePelaSombra = (id: Identidade): boolean =>
  id.permissoes.configurar || id.permissoes.fila === 'base'

/** Ordem de prioridade em SQL — a mesma que o motor usa para cortar no teto. */
const ORDEM_PRIORIDADE = `CASE w.prioridade
    WHEN 'critica' THEN 1 WHEN 'alta' THEN 2 WHEN 'media' THEN 3 ELSE 4 END`

interface Linha extends Omit<ItemDaFila, 'diasParaPrazo' | 'diasAberto'> {
  dias_para_prazo: number
  dias_aberto: number
}

export async function carregarFila(
  db: pg.Pool,
  id: Identidade,
  opts: { hoje?: Date } = {},
): Promise<Fila> {
  if (id.permissoes.fila === 'nenhum') {
    return { abertos: [], backlog: [], sombra: [], visaoDaBase: false }
  }
  const hoje = opts.hoje ?? new Date()
  const daBase = id.permissoes.fila === 'base'
  const sombra = vePelaSombra(id)

  const { rows } = await db.query<Linha>(
    `SELECT w.id,
            w.account_id                          AS "accountId",
            a.razao_social                        AS conta,
            w.gatilho, w.familia, w.prioridade, w.motivo, w.evidencia,
            w.dono_email                          AS "donoEmail",
            to_char(w.prazo, 'YYYY-MM-DD')        AS prazo,
            w.estado,
            w.modo_sombra                         AS "modoSombra",
            (w.prazo - $2::date)                  AS dias_para_prazo,
            ($2::date - w.criado_em::date)        AS dias_aberto,
            ct.mrr_centavos::text                 AS "mrrCentavos",
            w.playbook_id                         AS "playbookId",
            pb.titulo                             AS "playbookTitulo"
       FROM success.work_item w
       JOIN core.account a ON a.id = w.account_id
       -- Por id gravado no item, não por gatilho: o CSM tem que ver o processo
       -- que valia quando o item nasceu, e não o que foi publicado depois.
       LEFT JOIN success.playbook pb ON pb.id = w.playbook_id
       LEFT JOIN LATERAL (
         SELECT mrr_centavos FROM core.contract
          WHERE account_id = w.account_id AND status_vigencia = 'vigente'
          ORDER BY inicio DESC LIMIT 1
       ) ct ON true
      WHERE w.estado IN ('aberto','backlog')
        -- O recorte: 'carteira' vê só o que é seu. Sem isso, um CSM abre a fila
        -- e encontra a carteira do colega — e a tela deixa de ser dele.
        AND ($3::boolean OR w.dono_email = $1)
        AND (NOT w.modo_sombra OR $4::boolean)
      -- Vencido primeiro, depois prioridade, depois prazo: a primeira linha tem
      -- que ser a primeira ação sem que ninguém precise comparar duas.
      --
      -- O desempate é o MRR, não o nome da conta. Com a fila cheia é comum
      -- quatro itens empatarem em prioridade e prazo — quatro contas entrando em
      -- provisão no mesmo dia. Aí o que separa é quanto está em jogo, e ordenar
      -- por ordem alfabética faz a de R$ 1.673 aparecer antes da de R$ 17.531.
      ORDER BY (w.prazo < $2::date) DESC, ${ORDEM_PRIORIDADE}, w.prazo,
               ct.mrr_centavos DESC NULLS LAST, a.razao_social`,
    [id.email, hoje.toISOString().slice(0, 10), daBase, sombra],
  )

  const item = (l: Linha): ItemDaFila => ({
    ...l,
    diasParaPrazo: Number(l.dias_para_prazo),
    diasAberto: Number(l.dias_aberto),
  })

  return {
    abertos: rows.filter((l) => l.estado === 'aberto' && !l.modoSombra).map(item),
    backlog: rows.filter((l) => l.estado === 'backlog' && !l.modoSombra).map(item),
    sombra: rows.filter((l) => l.modoSombra).map(item),
    visaoDaBase: daBase,
  }
}

export type Desfecho = 'resolvido' | 'sem_acao' | 'falso_positivo' | 'escalado'

export const DESFECHOS: ReadonlyArray<{ valor: Desfecho; rotulo: string; explica: string }> = [
  { valor: 'resolvido', rotulo: 'Resolvido', explica: 'a ação foi feita e o problema saiu' },
  { valor: 'sem_acao', rotulo: 'Sem ação necessária', explica: 'era real, mas não pedia ação' },
  {
    valor: 'falso_positivo',
    rotulo: 'Falso positivo',
    explica: 'o gatilho errou — é este desfecho que calibra o motor',
  },
  { valor: 'escalado', rotulo: 'Escalado', explica: 'passou para liderança ou outra área' },
]

export class NaoEhSeuError extends Error {
  constructor() {
    super('item de outra carteira')
    this.name = 'NaoEhSeuError'
  }
}

/**
 * Fecha um item, exigindo desfecho.
 *
 * O desfecho não é burocracia: `falso_positivo` é o único sinal que calibra o
 * gatilho. Sem ele a fila degrada em ruído e ninguém consegue provar que
 * degradou — o banco também recusa fechar sem desfecho (`fechar_exige_desfecho`).
 *
 * A checagem de dono acontece no UPDATE, não antes dele: entre um SELECT de
 * verificação e o UPDATE cabe uma troca de dono, e o item seria fechado por
 * quem já não é responsável.
 */
export async function fecharItem(
  db: pg.Pool,
  id: Identidade,
  itemId: string,
  desfecho: Desfecho,
  nota?: string,
): Promise<void> {
  const { rowCount } = await db.query(
    `UPDATE success.work_item
        SET estado='fechado', desfecho=$3, desfecho_nota=$4,
            fechado_em=now(), fechado_por=$2
      WHERE id=$1 AND estado IN ('aberto','backlog')
        AND ($5::boolean OR dono_email = $2)`,
    [itemId, id.email, desfecho, nota ?? null, id.permissoes.fila === 'base'],
  )
  if (rowCount === 0) throw new NaoEhSeuError()
}
