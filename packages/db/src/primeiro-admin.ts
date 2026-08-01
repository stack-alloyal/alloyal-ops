import pg from 'pg'

/**
 * O primeiro administrador — o impasse do banco vazio.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ Num banco recém-migrado, `ops.user_role` está vazia. A tela que concede    │
 * │ papel exige a permissão `configurar`, e ninguém tem. Quem sobe a plataforma │
 * │ autentica no Google com sucesso e vê a tela de permissão para sempre.      │
 * │                                                                            │
 * │ Sem isto, a saída seria `INSERT` manual no banco — que é exatamente o que  │
 * │ a tela de Configurações existe para eliminar. Um produto cuja implantação  │
 * │ começa com `psql` ensina que `psql` é aceitável.                          │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Recusa rodar num banco que já tem alguém, e é isso que separa "bootstrap" de
 * "porta dos fundos": depois da primeira pessoa, o caminho é a tela, com motivo
 * escrito e trilha.
 */

export class JaTemAdminError extends Error {
  constructor(quantos: number) {
    super(
      `este banco já tem ${quantos} pessoa(s) com acesso — o bootstrap é só para banco ` +
        'vazio. Conceda pelo caminho normal: Configurações → Acessos, que exige motivo e ' +
        'deixa trilha.',
    )
    this.name = 'JaTemAdminError'
  }
}

const DOMINIO = /^[^@\s]+@alloyal\.com\.br$/i

/**
 * Cria a primeira pessoa com `configurar`, e só a primeira.
 *
 * `ops-admin`... não: `pulse-admin` é o papel escolhido porque ele tem `configurar` E
 * `dadoIndividual: 'auditado'`. Para o bootstrap isso é demais — quem sobe a plataforma
 * não precisa ver dado individual de colaborador. `pulse-cs-lead` tem `configurar` sem
 * `dadoIndividual`, e é o mínimo que resolve o impasse.
 *
 * A trilha registra que foi bootstrap, com o nome de quem rodou: uma concessão que
 * aparece sem origem é a que ninguém consegue explicar depois.
 */
export async function primeiroAdmin(
  connectionString: string,
  email: string,
  quemRodou: string,
): Promise<{ email: string; papel: string }> {
  const alvo = email.trim().toLowerCase()
  if (!DOMINIO.test(alvo)) {
    throw new Error(`"${email}" não é um e-mail @alloyal.com.br`)
  }

  const cliente = new pg.Client({ connectionString })
  await cliente.connect()
  try {
    await cliente.query('BEGIN')

    // `FOR UPDATE` na contagem: duas execuções simultâneas criariam dois "primeiros".
    const { rows } = await cliente.query<{ email: string }>(
      'SELECT email FROM ops.user_role FOR UPDATE',
    )
    if (rows.length > 0) throw new JaTemAdminError(new Set(rows.map((r) => r.email)).size)

    const papel = 'pulse-cs-lead'
    await cliente.query(
      `INSERT INTO ops.user_role (email, papel, concedido_por) VALUES ($1, $2, $3)`,
      [alvo, papel, `bootstrap por ${quemRodou}`],
    )
    await cliente.query(
      `INSERT INTO ops.mudanca (tipo, chave, valor_antes, valor_depois, quem, motivo)
       VALUES ('papel', $1, NULL, $2::jsonb, $3, $4)`,
      [
        alvo,
        JSON.stringify(papel),
        `bootstrap por ${quemRodou}`,
        'Primeiro acesso da instalação: banco vazio, e a tela que concede papel exige ' +
          'a permissão que ninguém tinha. A partir daqui, todo acesso passa pela tela.',
      ],
    )
    await cliente.query('COMMIT')
    return { email: alvo, papel }
  } catch (err) {
    await cliente.query('ROLLBACK')
    throw err
  } finally {
    await cliente.end()
  }
}
