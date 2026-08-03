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
  /** NULL quando ninguém preencheu. A tela cai para o e-mail, sem inventar. */
  readonly nome: string | null
  /** `false` SUSPENDE, preservando os papéis. Ver migration 0021. */
  readonly ativo: boolean
  readonly papeis: readonly Papel[]
  readonly permissoes: Permissoes
  readonly concedidoPor: readonly (string | null)[]
  readonly concedidoEm: Date | null
}

export async function listarPessoas(db: pg.Pool): Promise<PessoaComPapeis[]> {
  const { rows } = await db.query<{
    email: string
    nome: string | null
    ativo: boolean
    // `array_remove(..., NULL)` na consulta garante que nenhum elemento é null —
    // o FULL JOIN produz NULL para pessoa sem papel, e o array_remove o descarta.
    papeis: string[]
    concedido_por: (string | null)[]
    primeiro: Date | null
  }>(
    // FULL JOIN, e cada lado existe por um motivo:
    //   · pessoa sem papel precisa aparecer, senão quem acabou de ser cadastrado
    //     fica invisível justamente para quem deveria dar o papel;
    //   · papel sem pessoa também, porque é ANOMALIA — inserção manual ou escrita
    //     parcial — e esconder anomalia de acesso é o pior lugar para esconder.
    `SELECT coalesce(p.email, r.email)                    AS email,
            p.nome,
            coalesce(p.ativo, true)                       AS ativo,
            array_remove(array_agg(r.papel ORDER BY r.papel), NULL)          AS papeis,
            array_remove(array_agg(r.concedido_por ORDER BY r.papel), NULL)  AS concedido_por,
            min(r.concedido_em)                           AS primeiro
       FROM ops.pessoa p
       FULL JOIN ops.user_role r ON r.email = p.email
      GROUP BY coalesce(p.email, r.email), p.nome, p.ativo
      ORDER BY 1`,
  )
  return rows.map((r) => {
    const papeis = r.papeis.filter((p): p is Papel => (PAPEIS as readonly string[]).includes(p))
    return {
      email: r.email,
      nome: r.nome,
      ativo: r.ativo,
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
    // A pessoa nasce junto com o papel, e na MESMA transação. Em duas transações,
    // uma falha no meio deixaria papel sem pessoa — e a resolução de identidade
    // passaria a ver `inexistente` para quem tem acesso.
    await cliente.query(
      `INSERT INTO ops.pessoa (email, criado_por) VALUES ($1, $2)
       ON CONFLICT (email) DO NOTHING`,
      [alvo, id.email],
    )
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

// ─── Pessoa: nome e suspensão ────────────────────────────────────────────────

/**
 * Cria ou atualiza o registro de pessoa.
 *
 * Idempotente de propósito: `conceder` chama isto antes de dar o papel, e chamar
 * duas vezes não pode desfazer nome já preenchido. Por isso o `coalesce` — passar
 * nome vazio NÃO apaga o que estava lá.
 */
export async function registrarPessoa(
  db: pg.Pool,
  quem: string,
  email: string,
  nome?: string,
): Promise<void> {
  const alvo = email.trim().toLowerCase()
  if (!DOMINIO.test(alvo)) {
    throw new ValorInvalidoError(
      `"${email}" não é um e-mail @alloyal.com.br — acesso interno não vai para domínio de fora`,
    )
  }
  await db.query(
    `INSERT INTO ops.pessoa (email, nome, criado_por)
     VALUES ($1, nullif($2, ''), $3)
     ON CONFLICT (email) DO UPDATE
       SET nome = coalesce(nullif($2, ''), ops.pessoa.nome)`,
    [alvo, (nome ?? '').trim(), quem],
  )
}

export class UltimoAcessoAtivoError extends Error {
  constructor() {
    super(
      'esta é a última pessoa ATIVA com acesso de configuração — suspendê-la deixaria ' +
        'a plataforma sem ninguém capaz de reativar ninguém, e o conserto voltaria a ser SQL manual',
    )
    this.name = 'UltimoAcessoAtivoError'
  }
}

/**
 * Suspende ou reativa. Motivo obrigatório, como em toda mudança de acesso.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ A TRAVA DO ÚLTIMO ADMIN ATIVO:                                            │
 * │                                                                            │
 * │ `revogar` já recusa tirar o último papel de configuração. Suspender é outro │
 * │ caminho para o MESMO estado terminal — a pessoa continua com o papel, mas   │
 * │ não entra, e ninguém mais pode reativá-la. Sem esta trava, a suspensão      │
 * │ seria a porta de trás para trancar a plataforma inteira.                   │
 * │                                                                            │
 * │ Conta pessoa ATIVA com `configurar`, e é `FOR UPDATE`: sem o lock, duas     │
 * │ suspensões simultâneas leem "ainda tem dois" e gravam as duas.             │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export async function definirAtivo(
  db: pg.Pool,
  id: Identidade,
  email: string,
  ativo: boolean,
  motivo: string,
): Promise<void> {
  const alvo = email.trim().toLowerCase()
  if (motivo.trim().length < 10) throw new MotivoObrigatorioError('acesso')

  const cliente = await db.connect()
  try {
    await cliente.query('BEGIN')

    const { rows: antes } = await cliente.query<{ ativo: boolean }>(
      'SELECT ativo FROM ops.pessoa WHERE email = $1 FOR UPDATE',
      [alvo],
    )
    if (antes.length === 0) throw new ValorInvalidoError(`${email} não está cadastrada`)
    if (antes[0]!.ativo === ativo) {
      await cliente.query('ROLLBACK')
      return
    }

    if (!ativo) {
      const { rows } = await cliente.query<{ email: string; papel: string }>(
        `SELECT p.email, r.papel
           FROM ops.pessoa p
           JOIN ops.user_role r ON r.email = p.email
          WHERE p.ativo
          FOR UPDATE OF p`,
      )
      const porPessoa = new Map<string, Papel[]>()
      for (const l of rows) {
        if (!(PAPEIS as readonly string[]).includes(l.papel)) continue
        const lista = porPessoa.get(l.email) ?? []
        lista.push(l.papel as Papel)
        porPessoa.set(l.email, lista)
      }
      const admins = [...porPessoa.entries()].filter(([, ps]) => permissoesDe(ps).configurar)
      if (admins.length === 1 && admins[0]![0] === alvo) throw new UltimoAcessoAtivoError()
    }

    await cliente.query('UPDATE ops.pessoa SET ativo = $2 WHERE email = $1', [alvo, ativo])
    await cliente.query(
      `INSERT INTO ops.mudanca (tipo, chave, valor_antes, valor_depois, quem, motivo)
       VALUES ('acesso', $1, $2::jsonb, $3::jsonb, $4, $5)`,
      [alvo, JSON.stringify(antes[0]!.ativo), JSON.stringify(ativo), id.email, motivo.trim()],
    )
    await cliente.query('COMMIT')
  } catch (err) {
    await cliente.query('ROLLBACK')
    throw err
  } finally {
    cliente.release()
  }
}

/** O estado, para a resolução de identidade. `inexistente` não é `suspensa`. */
export async function estadoDaPessoa(
  db: pg.Pool,
  email: string,
): Promise<'ativa' | 'suspensa' | 'inexistente'> {
  const { rows } = await db.query<{ ativo: boolean }>(
    'SELECT ativo FROM ops.pessoa WHERE email = $1',
    [email.trim().toLowerCase()],
  )
  if (rows.length === 0) return 'inexistente'
  return rows[0]!.ativo ? 'ativa' : 'suspensa'
}

/** O nome de exibição, para o header. NULL quando ninguém preencheu. */
export async function nomeDaPessoa(db: pg.Pool, email: string): Promise<string | null> {
  const { rows } = await db.query<{ nome: string | null }>(
    'SELECT nome FROM ops.pessoa WHERE email = $1',
    [email.trim().toLowerCase()],
  )
  return rows[0]?.nome ?? null
}
