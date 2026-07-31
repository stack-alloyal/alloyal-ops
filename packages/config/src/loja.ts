import { cifrar, dica, type Identidade } from '@pulse/auth'
import type pg from 'pg'

import { AJUSTE_POR_CHAVE, CATALOGO, SEGREDOS, type Ajuste } from './catalogo.js'

/**
 * Leitura e escrita da configuração, com validação num lugar só.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ A validação é aqui e não na tela. Server Action é endpoint POST: validar no │
 * │ formulário deixa o campo `min`/`max` do HTML como única barreira, e quem     │
 * │ manda POST direto passa por cima. `teto_fila = 0` chegando ao banco esvazia  │
 * │ a fila do time inteiro, e ninguém vai suspeitar da configuração.            │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Nada aqui decide permissão: quem chama já passou por `exigir(p => p.configurar)`.
 * O que esta camada garante é que o VALOR é possível.
 */

export class ValorInvalidoError extends Error {
  constructor(mensagem: string) {
    super(mensagem)
    this.name = 'ValorInvalidoError'
  }
}

export class MotivoObrigatorioError extends Error {
  constructor(oQue: string) {
    super(
      `mudar ${oQue} exige motivo escrito com pelo menos 10 caracteres — ` +
        'mudança de acesso sem motivo é a que ninguém consegue explicar numa auditoria',
    )
    this.name = 'MotivoObrigatorioError'
  }
}

/** O valor efetivo de cada ajuste: o gravado, ou o padrão do código. */
export type Configuracao = Readonly<Record<string, number | boolean>>

/**
 * Lê tudo, com o padrão preenchendo o que não foi mudado.
 *
 * Uma consulta e não uma por chave: esta função é chamada no início de cada ciclo do
 * worker e em toda renderização da tela de configuração.
 */
export async function lerConfiguracao(db: pg.Pool): Promise<Configuracao> {
  const efetiva: Record<string, number | boolean> = {}
  for (const a of CATALOGO) efetiva[a.chave] = a.padrao

  const { rows } = await db.query<{ chave: string; valor: number | boolean }>(
    'SELECT chave, valor FROM ops.configuracao',
  )
  for (const r of rows) {
    // Chave que não está mais no catálogo é ignorada, não é erro: acontece quando um
    // ajuste é removido do código e a linha fica. Ignorar em silêncio seria ruim —
    // `chavesOrfas` existe para a tela mostrar.
    if (AJUSTE_POR_CHAVE.has(r.chave)) efetiva[r.chave] = r.valor
  }
  return efetiva
}

/** Chaves gravadas que não existem mais no catálogo. A tela oferece limpar. */
export async function chavesOrfas(db: pg.Pool): Promise<string[]> {
  const { rows } = await db.query<{ chave: string }>('SELECT chave FROM ops.configuracao')
  return rows.map((r) => r.chave).filter((c) => !AJUSTE_POR_CHAVE.has(c))
}

/** O valor gravado (ou `null` se é o padrão), para a tela distinguir os dois. */
export async function gravados(db: pg.Pool): Promise<
  Map<string, { valor: number | boolean; por: string; em: Date }>
> {
  const { rows } = await db.query<{
    chave: string
    valor: number | boolean
    atualizado_por: string
    atualizado_em: Date
  }>('SELECT chave, valor, atualizado_por, atualizado_em FROM ops.configuracao')
  return new Map(rows.map((r) => [r.chave, { valor: r.valor, por: r.atualizado_por, em: r.atualizado_em }]))
}

/**
 * Valida contra o catálogo. Devolve o valor convertido, ou lança dizendo o limite.
 *
 * A mensagem carrega o número do limite E o motivo dele. "Valor inválido" faz a
 * pessoa tentar de novo às cegas; "acima de 40 a fila deixa de ser fila" faz ela
 * entender que o limite não é capricho.
 */
export function validar(ajuste: Ajuste, bruto: string): number | boolean {
  if (ajuste.tipo === 'booleano') {
    if (bruto === 'true' || bruto === 'on' || bruto === '1') return true
    if (bruto === 'false' || bruto === 'off' || bruto === '0' || bruto === '') return false
    throw new ValorInvalidoError(`${ajuste.rotulo}: "${bruto}" não é sim nem não`)
  }

  const n = Number(bruto.replace(',', '.'))
  if (!Number.isFinite(n)) {
    throw new ValorInvalidoError(`${ajuste.rotulo}: "${bruto}" não é número`)
  }
  if (ajuste.tipo === 'inteiro' && !Number.isInteger(n)) {
    throw new ValorInvalidoError(`${ajuste.rotulo} é contado em ${ajuste.unidade ?? 'unidades'} inteiras`)
  }

  const fim = (): string => (ajuste.porQueOLimite ? ` ${ajuste.porQueOLimite}` : '')
  if (ajuste.minimo !== undefined && n < ajuste.minimo) {
    throw new ValorInvalidoError(
      `${ajuste.rotulo}: ${n} está abaixo do mínimo de ${ajuste.minimo}.${fim()}`,
    )
  }
  if (ajuste.maximo !== undefined && n > ajuste.maximo) {
    throw new ValorInvalidoError(
      `${ajuste.rotulo}: ${n} está acima do máximo de ${ajuste.maximo}.${fim()}`,
    )
  }
  return n
}

/**
 * Grava um ajuste e registra a mudança, na MESMA transação.
 *
 * Transação e não duas escritas: um ajuste gravado sem trilha é um ajuste que ninguém
 * consegue explicar depois, e a calibração dos gatilhos perde a única referência que
 * tem para "o número piorou depois que mexeram no limiar".
 *
 * Valor igual ao padrão APAGA a linha em vez de gravar. Assim "voltar ao padrão" é
 * uma operação de verdade, e o padrão continua vivendo num lugar só.
 */
export async function gravarAjuste(
  db: pg.Pool,
  id: Identidade,
  chave: string,
  bruto: string,
  motivo?: string,
): Promise<{ valor: number | boolean; voltouAoPadrao: boolean }> {
  const ajuste = AJUSTE_POR_CHAVE.get(chave)
  if (!ajuste) throw new ValorInvalidoError(`ajuste desconhecido: ${chave}`)
  const valor = validar(ajuste, bruto)

  const cliente = await db.connect()
  try {
    await cliente.query('BEGIN')
    const { rows: antes } = await cliente.query<{ valor: number | boolean }>(
      'SELECT valor FROM ops.configuracao WHERE chave = $1',
      [chave],
    )
    const anterior = antes[0]?.valor ?? ajuste.padrao
    const voltouAoPadrao = valor === ajuste.padrao

    if (voltouAoPadrao) {
      await cliente.query('DELETE FROM ops.configuracao WHERE chave = $1', [chave])
    } else {
      await cliente.query(
        `INSERT INTO ops.configuracao (chave, valor, atualizado_por)
         VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (chave) DO UPDATE
           SET valor = EXCLUDED.valor,
               atualizado_por = EXCLUDED.atualizado_por,
               atualizado_em = now()`,
        [chave, JSON.stringify(valor), id.email],
      )
    }

    if (anterior !== valor) {
      await cliente.query(
        `INSERT INTO ops.mudanca (tipo, chave, valor_antes, valor_depois, quem, motivo)
         VALUES ('configuracao', $1, $2::jsonb, $3::jsonb, $4, $5)`,
        [chave, JSON.stringify(anterior), JSON.stringify(valor), id.email, motivo?.trim() || null],
      )
    }

    await cliente.query('COMMIT')
    return { valor, voltouAoPadrao }
  } catch (err) {
    await cliente.query('ROLLBACK')
    throw err
  } finally {
    cliente.release()
  }
}

// ── Segredos ────────────────────────────────────────────────────────────────

export interface SegredoGravado {
  readonly chave: string
  readonly dica: string
  readonly por: string
  readonly em: Date
  readonly usadoEm: Date | null
}

/**
 * O que está cadastrado — SEM o valor.
 *
 * Note que não existe função que devolva o segredo claro para a tela. Não é
 * esquecimento: exibir um token "para conferir" é o caminho pelo qual ele acaba num
 * print de tela, num compartilhamento de janela ou no cache do navegador. Quem
 * precisa conferir troca o valor; quem precisa usar é o worker.
 */
export async function listarSegredos(db: pg.Pool): Promise<SegredoGravado[]> {
  const { rows } = await db.query<{
    chave: string
    dica: string
    atualizado_por: string
    atualizado_em: Date
    usado_em: Date | null
  }>('SELECT chave, dica, atualizado_por, atualizado_em, usado_em FROM ops.segredo')
  return rows.map((r) => ({
    chave: r.chave,
    dica: r.dica,
    por: r.atualizado_por,
    em: r.atualizado_em,
    usadoEm: r.usado_em,
  }))
}

const SEGREDO_POR_CHAVE = new Map(SEGREDOS.map((s) => [s.chave, s]))

/**
 * Grava um segredo cifrado. A trilha registra QUE mudou, nunca o valor.
 *
 * `valor_antes`/`valor_depois` ficam nulos por CHECK no banco: a trilha não é
 * cifrada, e gravar o token anterior nela desfaria a cifra da tabela ao lado.
 */
export async function gravarSegredo(
  db: pg.Pool,
  id: Identidade,
  chave: string,
  claro: string,
  motivo: string,
): Promise<void> {
  if (!SEGREDO_POR_CHAVE.has(chave)) throw new ValorInvalidoError(`segredo desconhecido: ${chave}`)
  const limpo = claro.trim()
  if (limpo.length < 8) {
    throw new ValorInvalidoError(
      'segredo com menos de 8 caracteres não parece token — confira se colou o valor inteiro',
    )
  }
  if (motivo.trim().length < 10) throw new MotivoObrigatorioError('segredo')

  const cliente = await db.connect()
  try {
    await cliente.query('BEGIN')
    await cliente.query(
      `INSERT INTO ops.segredo (chave, valor_cifrado, dica, atualizado_por)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (chave) DO UPDATE
         SET valor_cifrado = EXCLUDED.valor_cifrado,
             dica = EXCLUDED.dica,
             atualizado_por = EXCLUDED.atualizado_por,
             atualizado_em = now(),
             -- usado_em NÃO é zerado: saber que a integração usava o segredo antigo
             -- ontem é o que diferencia "trocaram a chave" de "isto nunca funcionou".
             usado_em = ops.segredo.usado_em`,
      [chave, cifrar(limpo), dica(limpo), id.email],
    )
    await cliente.query(
      `INSERT INTO ops.mudanca (tipo, chave, quem, motivo) VALUES ('segredo', $1, $2, $3)`,
      [chave, id.email, motivo.trim()],
    )
    await cliente.query('COMMIT')
  } catch (err) {
    await cliente.query('ROLLBACK')
    throw err
  } finally {
    cliente.release()
  }
}

/** Apaga um segredo, com motivo. A trilha guarda que existiu. */
export async function apagarSegredo(
  db: pg.Pool,
  id: Identidade,
  chave: string,
  motivo: string,
): Promise<void> {
  if (motivo.trim().length < 10) throw new MotivoObrigatorioError('segredo')
  const cliente = await db.connect()
  try {
    await cliente.query('BEGIN')
    await cliente.query('DELETE FROM ops.segredo WHERE chave = $1', [chave])
    await cliente.query(
      `INSERT INTO ops.mudanca (tipo, chave, quem, motivo) VALUES ('segredo', $1, $2, $3)`,
      [chave, id.email, `apagado: ${motivo.trim()}`],
    )
    await cliente.query('COMMIT')
  } catch (err) {
    await cliente.query('ROLLBACK')
    throw err
  } finally {
    cliente.release()
  }
}
