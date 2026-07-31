/**
 * Leitura de um ajuste configurável, com o padrão do código como rede.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ Vive em `@pulse/auth` e não em `@pulse/config` por uma razão de dependência: o   │
 * │ `@pulse/config` serve a TELA de administração e conhece o catálogo inteiro;    │
 * │ `metrics`, `success`, `contratos` e o worker só precisam LER um número. Fazer │
 * │ todos eles dependerem do pacote da tela inverteria a seta — domínio          │
 * │ conhecendo administração — e é o tipo de aresta que depois impede o mesmo    │
 * │ cálculo de rodar num contexto sem tela.                                     │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * A validação é repetida aqui de propósito. `@pulse/config` valida na ESCRITA, mas um
 * `INSERT` manual no banco passa por cima dela — e um teto de fila igual a zero
 * esvaziaria a fila do time inteiro sem ninguém suspeitar da configuração. Valor fora
 * da faixa é ignorado e o padrão vale.
 */

/** O mínimo de um pool ou client do pg — para não arrastar o tipo inteiro. */
export interface Consultavel {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>
}

export interface FaixaDoAjuste {
  readonly padrao: number
  readonly minimo: number
  readonly maximo: number
  /** `true` recusa fracionário. */
  readonly inteiro?: boolean
}

/**
 * Lê um número configurado. Nunca lança: falha de leitura devolve o padrão.
 *
 * Não lançar é decisão deliberada. Estas chaves são lidas dentro de ciclos do worker e
 * de renderização de tela; uma exceção aqui derrubaria o cálculo inteiro por causa de
 * um ajuste — e o modo de falha certo para "não sei o valor configurado" é usar o
 * valor que sempre funcionou.
 */
export async function numeroConfigurado(
  db: Consultavel,
  chave: string,
  faixa: FaixaDoAjuste,
): Promise<number> {
  let bruto: unknown
  try {
    const { rows } = await db.query('SELECT valor FROM ops.configuracao WHERE chave = $1', [chave])
    bruto = (rows[0] as { valor?: unknown } | undefined)?.valor
  } catch {
    // Tabela ausente (banco antes da 0016) ou permissão negada. O padrão vale.
    return faixa.padrao
  }
  return dentroDaFaixa(bruto, faixa) ? Number(bruto) : faixa.padrao
}

/** A validação, separada para o teste poder exercê-la sem banco. */
export function dentroDaFaixa(bruto: unknown, faixa: FaixaDoAjuste): boolean {
  const n = typeof bruto === 'string' ? Number(bruto) : bruto
  if (typeof n !== 'number' || !Number.isFinite(n)) return false
  if (faixa.inteiro && !Number.isInteger(n)) return false
  return n >= faixa.minimo && n <= faixa.maximo
}

/**
 * Vários ajustes numa consulta só.
 *
 * Uma ida ao banco por chave seria 11 consultas por rodada de ciclo. Aqui as faixas
 * chegam juntas e cada valor é validado individualmente — uma chave adulterada não
 * contamina as outras.
 */
export async function numerosConfigurados<K extends string>(
  db: Consultavel,
  faixas: Readonly<Record<K, FaixaDoAjuste>>,
): Promise<Record<K, number>> {
  const chaves = Object.keys(faixas) as K[]
  const efetivo = {} as Record<K, number>
  for (const k of chaves) efetivo[k] = faixas[k].padrao

  try {
    const { rows } = await db.query(
      'SELECT chave, valor FROM ops.configuracao WHERE chave = ANY($1)',
      [chaves],
    )
    for (const r of rows as { chave: K; valor: unknown }[]) {
      const faixa = faixas[r.chave]
      if (faixa && dentroDaFaixa(r.valor, faixa)) efetivo[r.chave] = Number(r.valor)
    }
  } catch {
    // Mesmo motivo do singular: o padrão vale.
  }
  return efetivo
}
