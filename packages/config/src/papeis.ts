import { PAPEIS, permissoesDe, type Identidade, type Papel, type Permissoes } from '@pulse/auth'
import type pg from 'pg'

import { MotivoObrigatorioError, ValorInvalidoError } from './loja.js'

/**
 * Atribuição de papel pela tela, com trilha.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ Antes disto, papel se dava por INSERT manual em `ops.user_role`. Não havia  │
 * │ caminho na aplicação — quem entrava na empresa esperava alguém com acesso   │
 * │ ao banco, e quem saía continuava com acesso até alguém lembrar.            │
 * │                                                                            │
 * │ O segundo caso é o que importa para segurança: acesso que só sai por        │
 * │ lembrança de terceiro é acesso que não sai.                                │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * O papel aqui é a fonte para a APLICAÇÃO. Os grupos `pulse-*` do Google Workspace
 * continuam sendo quem autoriza a entrada; esta tabela decide o que a pessoa vê
 * DEPOIS de entrar. Manter as duas coisas separadas é o que permite tirar acesso a
 * uma tela sem tirar a pessoa do grupo (e vice-versa).
 */

export interface PessoaComPapeis {
  readonly email: string
  readonly papeis: readonly Papel[]
  readonly permissoes: Permissoes
  readonly concedidoPor: readonly (string | null)[]
  readonly concedidoEm: Date | null
}

export async function listarPessoas(db: pg.Pool): Promise<PessoaComPapeis[]> {
  const { rows } = await db.query<{
    email: string
    papeis: string[]
    concedido_por: (string | null)[]
    primeiro: Date | null
  }>(
    `SELECT email,
            array_agg(papel ORDER BY papel) AS papeis,
            array_agg(concedido_por ORDER BY papel) AS concedido_por,
            min(concedido_em) AS primeiro
       FROM ops.user_role
      GROUP BY email
      ORDER BY email`,
  )
  return rows.map((r) => {
    const papeis = r.papeis.filter((p): p is Papel => (PAPEIS as readonly string[]).includes(p))
    return {
      email: r.email,
      papeis,
      // As permissões EFETIVAS, com a união dos papéis já aplicada. A tela mostra o
      // resultado e não a soma que o leitor teria que fazer de cabeça — papel duplo é
      // exatamente onde alguém erra ao estimar o acesso de outra pessoa.
      permissoes: permissoesDe(papeis),
      concedidoPor: r.concedido_por,
      concedidoEm: r.primeiro,
    }
  })
}

const DOMINIO = /^[^@\s]+@alloyal\.com\.br$/i

/**
 * Dá um papel. Motivo obrigatório.
 *
 * O e-mail é normalizado para minúsculas: o domínio é case-insensitive, e gravar
 * `Ana@` ao lado de `ana@` criaria duas pessoas onde há uma — com metade dos papéis
 * cada, e um acesso que "às vezes funciona".
 */
export async function conceder(
  db: pg.Pool,
  id: Identidade,
  email: string,
  papel: string,
  motivo: string,
): Promise<void> {
  const alvo = email.trim().toLowerCase()
  if (!DOMINIO.test(alvo)) {
    throw new ValorInvalidoError(
      `"${email}" não é um e-mail @alloyal.com.br — acesso interno não vai para domínio de fora`,
    )
  }
  if (!(PAPEIS as readonly string[]).includes(papel)) {
    throw new ValorInvalidoError(`papel desconhecido: ${papel}. Os válidos são ${PAPEIS.join(', ')}`)
  }
  if (motivo.trim().length < 10) throw new MotivoObrigatorioError('papel')

  const cliente = await db.connect()
  try {
    await cliente.query('BEGIN')
    await cliente.query(
      `INSERT INTO ops.user_role (email, papel, concedido_por)
       VALUES ($1, $2, $3) ON CONFLICT (email, papel) DO NOTHING`,
      [alvo, papel, id.email],
    )
    await cliente.query(
      `INSERT INTO ops.mudanca (tipo, chave, valor_antes, valor_depois, quem, motivo)
       VALUES ('papel', $1, NULL, $2::jsonb, $3, $4)`,
      [alvo, JSON.stringify(papel), id.email, motivo.trim()],
    )
    await cliente.query('COMMIT')
  } catch (err) {
    await cliente.query('ROLLBACK')
    throw err
  } finally {
    cliente.release()
  }
}

export class UltimoAdminError extends Error {
  constructor() {
    super(
      'este é o último acesso de configuração que existe — tirá-lo deixaria a plataforma ' +
        'sem ninguém capaz de devolver acesso a ninguém, e o conserto voltaria a ser SQL manual',
    )
    this.name = 'UltimoAdminError'
  }
}

/**
 * Tira um papel. Recusa deixar a plataforma sem administrador.
 *
 * Sem esta guarda, uma pessoa consegue remover o próprio último papel de configuração
 * — sem má intenção, arrumando a lista — e a partir daí ninguém consegue devolver
 * acesso a ninguém pela tela. O conserto seria voltar ao `psql`, que é exatamente o
 * que esta tela existe para eliminar.
 */
export async function revogar(
  db: pg.Pool,
  id: Identidade,
  email: string,
  papel: string,
  motivo: string,
): Promise<void> {
  const alvo = email.trim().toLowerCase()
  if (motivo.trim().length < 10) throw new MotivoObrigatorioError('papel')

  const cliente = await db.connect()
  try {
    await cliente.query('BEGIN')

    // Quantas pessoas ainda teriam `configurar` sem esta linha? O cálculo usa a
    // matriz de permissão e não uma lista de papéis "de admin": papel novo que ganhe
    // `configurar` passa a contar aqui sozinho.
    const { rows } = await cliente.query<{ email: string; papel: string }>(
      'SELECT email, papel FROM ops.user_role FOR UPDATE',
    )
    const restantes = rows.filter((r) => !(r.email === alvo && r.papel === papel))
    const porPessoa = new Map<string, Papel[]>()
    for (const r of restantes) {
      if (!(PAPEIS as readonly string[]).includes(r.papel)) continue
      porPessoa.set(r.email, [...(porPessoa.get(r.email) ?? []), r.papel as Papel])
    }
    const admins = [...porPessoa.values()].filter((ps) => permissoesDe(ps).configurar)
    const eraAdmin = permissoesDe([papel as Papel]).configurar
    if (eraAdmin && admins.length === 0) throw new UltimoAdminError()

    await cliente.query('DELETE FROM ops.user_role WHERE email = $1 AND papel = $2', [alvo, papel])
    await cliente.query(
      `INSERT INTO ops.mudanca (tipo, chave, valor_antes, valor_depois, quem, motivo)
       VALUES ('papel', $1, $2::jsonb, NULL, $3, $4)`,
      [alvo, JSON.stringify(papel), id.email, motivo.trim()],
    )
    await cliente.query('COMMIT')
  } catch (err) {
    await cliente.query('ROLLBACK')
    throw err
  } finally {
    cliente.release()
  }
}

export interface Mudanca {
  readonly id: string
  readonly tipo: string
  readonly chave: string
  readonly antes: unknown
  readonly depois: unknown
  readonly quem: string
  readonly quando: Date
  readonly motivo: string | null
}

export async function historicoDeMudancas(db: pg.Pool, limite = 100): Promise<Mudanca[]> {
  const { rows } = await db.query<{
    id: string
    tipo: string
    chave: string
    valor_antes: unknown
    valor_depois: unknown
    quem: string
    quando: Date
    motivo: string | null
  }>(
    `SELECT id::text, tipo, chave, valor_antes, valor_depois, quem, quando, motivo
       FROM ops.mudanca ORDER BY quando DESC, id DESC LIMIT $1`,
    [limite],
  )
  return rows.map((r) => ({
    id: r.id,
    tipo: r.tipo,
    chave: r.chave,
    antes: r.valor_antes,
    depois: r.valor_depois,
    quem: r.quem,
    quando: r.quando,
    motivo: r.motivo,
  }))
}
