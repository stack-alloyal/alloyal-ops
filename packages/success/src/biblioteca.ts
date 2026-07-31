import type { Identidade } from '@ops/auth'
import type pg from 'pg'

/**
 * A biblioteca de playbooks (doc 01, 4.5 · T11).
 *
 * O propósito é um só: **permitir que CS mude o processo sem depender de deploy.**
 * Um playbook que só muda com release é um playbook que fica errado por semanas,
 * e o CSM aprende a ignorá-lo e a fazer do jeito dele — que é o mesmo que não ter
 * biblioteca.
 *
 * Por isso versionamento, e não edição no lugar: o item de trabalho aponta para a
 * VERSÃO que valia quando ele foi criado. Editar em cima faria a auditoria de um
 * item fechado em março mostrar o processo de agosto, e a pergunta "o CSM seguiu
 * o processo?" perderia resposta.
 *
 * Três estados, e confundi-los é o erro que este módulo evita:
 *
 *   rascunho    ativo=false, substituido_em=NULL  → trabalho em curso
 *   vigente     ativo=true                        → o processo de hoje
 *   aposentada  ativo=false, substituido_em≠NULL  → histórico
 */

export interface Playbook {
  id: string
  chave: string
  versao: number
  titulo: string
  conteudo: string
  gatilhos: string[]
  ativo: boolean
  publicadoPor: string | null
  publicadoEm: string | null
  substituidoEm: string | null
  criadoEm: string
  /** `rascunho` · `vigente` · `aposentada` — derivado, para a tela não recalcular. */
  estado: 'rascunho' | 'vigente' | 'aposentada'
}

export class SemPermissaoBiblioteca extends Error {
  constructor() {
    super('editar a biblioteca exige permissão de configuração')
    this.name = 'SemPermissaoBiblioteca'
  }
}

export class PlaybookInvalidoError extends Error {
  constructor(mensagem: string) {
    super(mensagem)
    this.name = 'PlaybookInvalidoError'
  }
}

/** Comprimento mínimo para um playbook ser um processo e não um lembrete. */
export const MINIMO_CONTEUDO = 80

const COLUNAS = `
  id, chave, versao, titulo, conteudo, gatilhos, ativo,
  publicado_por AS "publicadoPor",
  publicado_em  AS "publicadoEm",
  substituido_em AS "substituidoEm",
  criado_em     AS "criadoEm",
  CASE WHEN ativo THEN 'vigente'
       WHEN substituido_em IS NOT NULL THEN 'aposentada'
       ELSE 'rascunho' END AS estado`

/**
 * Valida o que uma pessoa escreveu antes de deixar virar processo.
 *
 * Não é burocracia de formulário: um playbook vazio publicado é pior que playbook
 * nenhum, porque o item de trabalho passa a exibir um anexo que não ajuda, e o
 * CSM deixa de clicar no anexo — inclusive nos que ajudariam.
 */
export function validar(p: {
  chave: string
  titulo: string
  conteudo: string
  gatilhos: readonly string[]
}): string[] {
  const erros: string[] = []
  if (!/^[a-z0-9-]{3,60}$/.test(p.chave)) {
    erros.push('a chave usa minúsculas, números e hífen, com 3 a 60 caracteres')
  }
  if (p.titulo.trim().length < 8) erros.push('o título precisa dizer o que fazer, em pelo menos 8 caracteres')
  if (p.conteudo.trim().length < MINIMO_CONTEUDO) {
    erros.push(
      `o conteúdo tem ${p.conteudo.trim().length} caracteres; abaixo de ${MINIMO_CONTEUDO} é lembrete, não processo`,
    )
  }
  for (const g of p.gatilhos) {
    if (!/^G-\d{2}$/.test(g)) erros.push(`"${g}" não é um gatilho válido (G-01 … G-14)`)
  }
  return erros
}

/**
 * Salva um rascunho — versão nova, inativa.
 *
 * Sempre cria versão em vez de sobrescrever: um rascunho editado três vezes vira
 * três versões, e o histórico mostra como o processo chegou onde chegou. Espaço
 * em disco é barato; reconstruir uma decisão de memória não é.
 */
export async function salvarRascunho(
  db: pg.Pool,
  id: Identidade,
  dados: { chave: string; titulo: string; conteudo: string; gatilhos: readonly string[] },
): Promise<Playbook> {
  if (!id.permissoes.configurar) throw new SemPermissaoBiblioteca()
  const erros = validar(dados)
  if (erros.length > 0) throw new PlaybookInvalidoError(erros.join('; '))

  const { rows } = await db.query<Playbook>(
    `INSERT INTO success.playbook (chave, versao, titulo, conteudo, gatilhos, ativo)
     VALUES ($1,
             (SELECT COALESCE(max(versao), 0) + 1 FROM success.playbook WHERE chave = $1),
             $2, $3, $4, false)
     RETURNING ${COLUNAS}`,
    [dados.chave, dados.titulo.trim(), dados.conteudo.trim(), dados.gatilhos],
  )
  return normalizar(rows[0]!)
}

/**
 * Publica uma versão: ela passa a ser a vigente, e a anterior é aposentada.
 *
 * As duas coisas na MESMA transação, porque o índice parcial
 * `playbook_uma_versao_ativa` recusa duas ativas — e é essa recusa que garante
 * que a pergunta "qual é o processo hoje" tenha uma resposta só.
 */
export async function publicar(
  db: pg.Pool,
  id: Identidade,
  playbookId: string,
): Promise<Playbook> {
  if (!id.permissoes.configurar) throw new SemPermissaoBiblioteca()

  const cliente = await db.connect()
  try {
    await cliente.query('BEGIN')
    const { rows: alvo } = await cliente.query<{ chave: string; ativo: boolean }>(
      'SELECT chave, ativo FROM success.playbook WHERE id = $1 FOR UPDATE',
      [playbookId],
    )
    const p = alvo[0]
    if (!p) throw new PlaybookInvalidoError('versão não encontrada')
    if (p.ativo) throw new PlaybookInvalidoError('esta versão já é a vigente')

    // Aposenta a anterior ANTES de ativar a nova: na ordem inversa o índice
    // parcial recusaria a segunda ativa e a transação morreria.
    await cliente.query(
      `UPDATE success.playbook
          SET ativo = false, substituido_em = now()
        WHERE chave = $1 AND ativo`,
      [p.chave],
    )
    const { rows } = await cliente.query<Playbook>(
      `UPDATE success.playbook
          SET ativo = true, publicado_por = $2, publicado_em = now(),
              substituido_em = NULL
        WHERE id = $1
       RETURNING ${COLUNAS}`,
      [playbookId, id.email],
    )
    await cliente.query('COMMIT')
    return normalizar(rows[0]!)
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    cliente.release()
  }
}

/**
 * Despublica a versão vigente de uma chave.
 *
 * Existe porque um playbook errado no ar é pior que nenhum, e esperar a próxima
 * versão ficar pronta para tirar o errado do ar é a escolha errada sob pressão.
 * A versão despublicada fica como aposentada, não volta a rascunho: ela ESTEVE em
 * produção, e itens de trabalho apontam para ela.
 */
export async function despublicar(
  db: pg.Pool,
  id: Identidade,
  chave: string,
): Promise<void> {
  if (!id.permissoes.configurar) throw new SemPermissaoBiblioteca()
  const { rowCount } = await db.query(
    `UPDATE success.playbook
        SET ativo = false, substituido_em = now()
      WHERE chave = $1 AND ativo`,
    [chave],
  )
  if (rowCount === 0) throw new PlaybookInvalidoError('não há versão vigente para esta chave')
}

/** A versão vigente de cada chave, para a listagem da biblioteca. */
export async function listarVigentes(db: pg.Pool): Promise<Playbook[]> {
  const { rows } = await db.query<Playbook>(
    `SELECT ${COLUNAS} FROM success.playbook WHERE ativo ORDER BY chave`,
  )
  return rows.map(normalizar)
}

/** Toda versão de uma chave, mais recente primeiro — o histórico que o T11 pede. */
export async function historico(db: pg.Pool, chave: string): Promise<Playbook[]> {
  const { rows } = await db.query<Playbook>(
    `SELECT ${COLUNAS} FROM success.playbook WHERE chave = $1 ORDER BY versao DESC`,
    [chave],
  )
  return rows.map(normalizar)
}

/** As chaves existentes com a contagem de versões e o estado da mais recente. */
export async function indice(
  db: pg.Pool,
): Promise<Array<{ chave: string; versoes: number; titulo: string; temVigente: boolean; gatilhos: string[] }>> {
  const { rows } = await db.query<{
    chave: string
    versoes: string
    titulo: string
    tem_vigente: boolean
    gatilhos: string[]
  }>(
    `SELECT chave,
            count(*)::text AS versoes,
            -- O título da versão VIGENTE quando há uma; senão o da mais recente.
            (array_agg(titulo ORDER BY ativo DESC, versao DESC))[1] AS titulo,
            bool_or(ativo) AS tem_vigente,
            (array_agg(gatilhos ORDER BY ativo DESC, versao DESC))[1] AS gatilhos
       FROM success.playbook
      GROUP BY chave
      ORDER BY bool_or(ativo) DESC, chave`,
  )
  return rows.map((r) => ({
    chave: r.chave,
    versoes: Number(r.versoes),
    titulo: r.titulo,
    temVigente: r.tem_vigente,
    gatilhos: r.gatilhos ?? [],
  }))
}

/**
 * O playbook vigente para um gatilho, se houver.
 *
 * Usado pelo motor da fila ao criar o item. Devolve `null` sem reclamar quando
 * não há: gatilho sem playbook ainda é um gatilho útil, e travar a fila por falta
 * de documentação seria trocar trabalho por burocracia.
 */
export async function vigenteDoGatilho(
  db: pg.PoolClient | pg.Pool,
  gatilho: string,
): Promise<{ id: string; titulo: string } | null> {
  const { rows } = await db.query<{ id: string; titulo: string }>(
    `SELECT id, titulo FROM success.playbook
      WHERE ativo AND $1 = ANY(gatilhos)
      -- Mais de um vigente para o mesmo gatilho é configuração ambígua, não erro
      -- de dado: escolhe-se o mais recente e a tela mostra a ambiguidade.
      ORDER BY publicado_em DESC LIMIT 1`,
    [gatilho],
  )
  return rows[0] ?? null
}

/** Gatilhos com mais de um playbook vigente — ambiguidade para a tela mostrar. */
export async function gatilhosAmbiguos(db: pg.Pool): Promise<Array<{ gatilho: string; quantos: number }>> {
  const { rows } = await db.query<{ gatilho: string; quantos: string }>(
    `SELECT g AS gatilho, count(*)::text AS quantos
       FROM success.playbook p, unnest(p.gatilhos) g
      WHERE p.ativo
      GROUP BY g HAVING count(*) > 1
      ORDER BY g`,
  )
  return rows.map((r) => ({ gatilho: r.gatilho, quantos: Number(r.quantos) }))
}

/**
 * Gatilhos PROMOVIDOS que não têm playbook vigente.
 *
 * É a lacuna que mais custa: o gatilho já está roteando trabalho para o time, e
 * cada item nasce sem instrução — o CSM sabe que há um problema e improvisa a
 * resposta, cada um do seu jeito. Gatilho em sombra sem playbook não entra na
 * lista, porque ninguém está agindo sobre ele ainda.
 */
export async function gatilhosSemPlaybook(db: pg.Pool): Promise<string[]> {
  const { rows } = await db.query<{ gatilho: string }>(
    `SELECT replace(f.chave, 'gatilho:', '') AS gatilho
       FROM ops.feature_flag f
      WHERE f.chave LIKE 'gatilho:%' AND f.habilitado
        AND NOT EXISTS (
          SELECT 1 FROM success.playbook p
           WHERE p.ativo AND replace(f.chave, 'gatilho:', '') = ANY(p.gatilhos)
        )
      ORDER BY 1`,
  )
  return rows.map((r) => r.gatilho)
}

function normalizar(p: Playbook): Playbook {
  return { ...p, gatilhos: p.gatilhos ?? [] }
}
