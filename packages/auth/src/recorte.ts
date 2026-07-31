import type { Identidade } from './proxy.js'

/**
 * O recorte de carteira em SQL de ESCRITA.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ Existe por uma falha real, provada contra o banco: a leitura recortava e a  │
 * │ escrita não. `listarRelatorios` filtrava por `csm_email`, mas `revisar`     │
 * │ tinha só `WHERE id = $1` — então um CSM conseguia CONGELAR o relatório de   │
 * │ um cliente de outra carteira, mesmo sem conseguir LER esse relatório.       │
 * │                                                                            │
 * │ O que torna esse tipo de falha difícil de ver: a tela nunca mostra o botão. │
 * │ Mas Server Action é endpoint POST, e quem tem sessão alcança qualquer ID.   │
 * │ A tela não é a fronteira de autorização — a consulta é.                    │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Um fragmento compartilhado e não dez cláusulas copiadas: dez cópias divergem, e a
 * que divergir vai ser a que ninguém testou. O `EXISTS` mantém uma ida só ao banco —
 * resolver a conta antes e checar depois custaria duas, e abriria janela entre a
 * checagem e a escrita.
 */

/**
 * @param colunaAccountId Coluna que aponta a conta, qualificada. Em `UPDATE`, é o
 *   nome da tabela sem alias (Postgres não aceita alias no alvo do UPDATE): por
 *   exemplo `success.client_report.account_id`.
 * @param pBase Índice do parâmetro booleano "vê a base toda".
 * @param pEmail Índice do parâmetro com o e-mail de quem chama.
 */
export function recorteDaConta(colunaAccountId: string, pBase: number, pEmail: number): string {
  return `EXISTS (
      SELECT 1 FROM core.account rec_a
       WHERE rec_a.id = ${colunaAccountId}
         AND ($${pBase}::boolean OR rec_a.csm_email = $${pEmail})
    )`
}

/**
 * Vê a base toda de CONTAS?
 *
 * `contas` e não `fila`: a pergunta que o recorte responde é "pode agir NESTA conta?",
 * e quem responde isso é a visibilidade de conta. `fila` é sobre item atribuído a
 * alguém, e item tem `dono_email` próprio — recortar conta por `fila` mistura as duas
 * coisas.
 *
 * A diferença não é teórica: `ops-financeiro` tem `contas: 'base'` e
 * `fila: 'carteira'`. Recortar a confirmação de última cobrança por `fila` impedia o
 * Financeiro de confirmar cobrança de conta de qualquer CSM — que é justamente o
 * trabalho dele. Foi assim que a suíte existente pegou a primeira versão disto.
 */
export const veBaseDeContas = (id: Identidade): boolean => id.permissoes.contas === 'base'

/** Vê a fila toda? Para item de trabalho, que tem dono próprio. */
export const veBaseDaFila = (id: Identidade): boolean => id.permissoes.fila === 'base'

/**
 * O erro de quem tentou agir fora da carteira.
 *
 * A mensagem NÃO diz se o registro existe. "Conta não é da sua carteira" confirmaria
 * a existência de um ID que a pessoa não deveria conhecer, e transformaria a recusa
 * num oráculo de enumeração.
 */
export class ForaDaCarteiraError extends Error {
  constructor(oQue: string) {
    super(`${oQue} não encontrado na sua carteira`)
    this.name = 'ForaDaCarteiraError'
  }
}

/**
 * Recorte ANTES de ler, para quem recebe `accountId` de fora.
 *
 * O `EXISTS` na cláusula de escrita resolve quando a operação é só escrita. Não
 * resolve quando há LEITURA antes: `criarRascunho` chama `montarConteudo`, que lê
 * adesão, MRR e cobertura da conta. Com o recorte só no `INSERT`, a escrita falharia
 * depois de o número do outro cliente já ter sido calculado e devolvido — vazamento
 * completo com a operação "recusada".
 *
 * Por isso esta função existe e é chamada primeiro. Uma consulta a mais é o preço de
 * não ler o que não se pode ler.
 */
export async function exigirConta(
  db: { query: (sql: string, params: unknown[]) => Promise<{ rowCount: number | null }> },
  id: Identidade,
  accountId: string,
  oQue = 'conta',
): Promise<void> {
  if (id.permissoes.contas === 'nenhum') throw new ForaDaCarteiraError(oQue)
  const { rowCount } = await db.query(
    `SELECT 1 FROM core.account
      WHERE id = $1 AND ($2::boolean OR csm_email = $3)`,
    [accountId, veBaseDeContas(id), id.email],
  )
  if (!rowCount) throw new ForaDaCarteiraError(oQue)
}
