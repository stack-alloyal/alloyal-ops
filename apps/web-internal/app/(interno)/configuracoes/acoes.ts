'use server'

import {
  MotivoObrigatorioError,
  UltimoAdminError,
  ValorInvalidoError,
  apagarSegredo,
  conceder,
  gravarAjuste,
  gravarSegredo,
  revogar,
  testarConexao,
  definirAtivo,
  registrarPessoa,
  UltimoAcessoAtivoError,} from '@pulse/config'
import { redirect } from 'next/navigation'

import { pool } from '../../../lib/db'
import { exigir } from '../../../lib/guarda'

/**
 * As ações de configuração.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ Todas exigem `configurar`, e a checagem é AQUI e não na tela: Server Action │
 * │ é endpoint POST, e esconder o formulário de quem não pode não impede o POST.│
 * │ O pen test desta sessão provou exatamente isso em outra parte do sistema.   │
 * │                                                                            │
 * │ E nenhuma delas devolve o valor de um segredo. Não é omissão: a única forma │
 * │ de um token não aparecer num print de tela é ele nunca voltar à tela.       │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * O padrão de erro é redirect com mensagem, e não exceção: quem está configurando
 * precisa ler o que deu errado no lugar onde estava, não numa página de erro que perde
 * o formulário preenchido.
 */

const voltar = (rota: string, chave: string, texto: string): never =>
  redirect(`${rota}?${chave}=${encodeURIComponent(texto)}`)

/** Erros esperados viram mensagem; o resto sobe, porque é defeito nosso. */
function mensagemDe(err: unknown): string | null {
  if (
    err instanceof ValorInvalidoError ||
    err instanceof MotivoObrigatorioError ||
    err instanceof UltimoAdminError ||
    // Sem esta linha a trava do último admin ATIVO sobe como 500 em vez de virar
    // mensagem na tela — e quem tentou suspender não descobre por que não pôde.
    err instanceof UltimoAcessoAtivoError
  ) {
    return err.message
  }
  return null
}

export async function salvarAjuste(dados: FormData): Promise<void> {
  const id = await exigir((p) => p.configurar, 'configuração da plataforma')
  const chave = String(dados.get('chave') ?? '')
  const valor = String(dados.get('valor') ?? '')
  const motivo = String(dados.get('motivo') ?? '')

  try {
    const r = await gravarAjuste(pool(), id, chave, valor, motivo)
    voltar(
      '/configuracoes',
      'ok',
      r.voltouAoPadrao
        ? `${chave} voltou ao padrão do código.`
        : `${chave} agora é ${String(r.valor)}. A próxima rodada já usa.`,
    )
  } catch (err) {
    const m = mensagemDe(err)
    if (m) voltar('/configuracoes', 'erro', m)
    throw err
  }
}

export async function salvarSegredo(dados: FormData): Promise<void> {
  const id = await exigir((p) => p.configurar, 'segredos de integração')
  const chave = String(dados.get('chave') ?? '')
  const valor = String(dados.get('valor') ?? '')
  const motivo = String(dados.get('motivo') ?? '')

  try {
    await gravarSegredo(pool(), id, chave, valor, motivo)
    // A mensagem confirma QUE gravou e não O QUE gravou.
    voltar('/configuracoes/segredos', 'ok', `${chave} gravado e cifrado.`)
  } catch (err) {
    const m = mensagemDe(err)
    if (m) voltar('/configuracoes/segredos', 'erro', m)
    // Erro de cifra (chave mestra ausente, por exemplo) tem mensagem acionável e
    // não contém o valor — pode ir para a tela.
    if (err instanceof Error && /PULSE_CHAVE_MESTRA|cifr/i.test(err.message)) {
      voltar('/configuracoes/segredos', 'erro', err.message)
    }
    throw err
  }
}

export async function removerSegredo(dados: FormData): Promise<void> {
  const id = await exigir((p) => p.configurar, 'segredos de integração')
  const chave = String(dados.get('chave') ?? '')
  const motivo = String(dados.get('motivo') ?? '')
  try {
    await apagarSegredo(pool(), id, chave, motivo)
    voltar('/configuracoes/segredos', 'ok', `${chave} apagado.`)
  } catch (err) {
    const m = mensagemDe(err)
    if (m) voltar('/configuracoes/segredos', 'erro', m)
    throw err
  }
}

export async function darPapel(dados: FormData): Promise<void> {
  const id = await exigir((p) => p.configurar, 'gestão de acessos')
  const email = String(dados.get('email') ?? '')
  const papel = String(dados.get('papel') ?? '')
  const motivo = String(dados.get('motivo') ?? '')
  try {
    await conceder(pool(), id, email, papel, motivo)
    voltar('/configuracoes/papeis', 'ok', `${papel} concedido a ${email.trim().toLowerCase()}.`)
  } catch (err) {
    const m = mensagemDe(err)
    if (m) voltar('/configuracoes/papeis', 'erro', m)
    throw err
  }
}

export async function tirarPapel(dados: FormData): Promise<void> {
  const id = await exigir((p) => p.configurar, 'gestão de acessos')
  const email = String(dados.get('email') ?? '')
  const papel = String(dados.get('papel') ?? '')
  const motivo = String(dados.get('motivo') ?? '')
  try {
    await revogar(pool(), id, email, papel, motivo)
    voltar('/configuracoes/papeis', 'ok', `${papel} removido de ${email.trim().toLowerCase()}.`)
  } catch (err) {
    const m = mensagemDe(err)
    if (m) voltar('/configuracoes/papeis', 'erro', m)
    throw err
  }
}

/**
 * Testa a credencial contra a API do fornecedor, agora.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ Sem isto, quem cola um token descobre que ele está errado quando um ciclo    │
 * │ falha de madrugada — e o alarme diz "C4 falhou", não "o token está sem       │
 * │ escopo de leitura de deals". A distância entre colar e saber era de horas.   │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * O diagnóstico volta pela URL. É informação de operação, não segredo: nenhuma sonda
 * devolve o valor da credencial, só o que o fornecedor respondeu sobre ela.
 */
export async function verificarConexao(dados: FormData): Promise<void> {
  await exigir((p) => p.configurar, 'teste de conexão')
  const integracao = String(dados.get('integracao') ?? '')
  const r = await testarConexao(pool(), integracao)
  voltar(
    '/configuracoes/segredos',
    r.estado === 'ok' ? 'ok' : 'erro',
    `${integracao}: ${r.diagnostico} (${r.duracaoMs} ms)`,
  )
}

export async function cadastrarPessoa(dados: FormData): Promise<void> {
  const id = await exigir((p) => p.configurar, 'gestão de usuários')
  const email = String(dados.get('email') ?? '')
  const nome = String(dados.get('nome') ?? '')
  try {
    await registrarPessoa(pool(), id.email, email, nome)
    voltar(
      '/configuracoes/usuarios',
      'ok',
      `${email.trim().toLowerCase()} cadastrada. Ela ainda NÃO tem acesso — falta dar um papel.`,
    )
  } catch (err) {
    const m = mensagemDe(err)
    if (m) voltar('/configuracoes/usuarios', 'erro', m)
    throw err
  }
}

/**
 * Suspende ou reativa.
 *
 * O motivo é obrigatório na camada de dados, e é de propósito: suspensão é a única
 * mudança de acesso que não deixa rastro no papel — sem o motivo escrito, ninguém
 * descobre depois por que a pessoa parou de entrar.
 */
export async function alternarAcesso(dados: FormData): Promise<void> {
  const id = await exigir((p) => p.configurar, 'gestão de usuários')
  const email = String(dados.get('email') ?? '')
  const ativar = String(dados.get('ativar') ?? '') === '1'
  const motivo = String(dados.get('motivo') ?? '')
  try {
    await definirAtivo(pool(), id, email, ativar, motivo)
    voltar(
      '/configuracoes/usuarios',
      'ok',
      `${email.trim().toLowerCase()} ${ativar ? 'reativada' : 'suspensa'}.`,
    )
  } catch (err) {
    const m = mensagemDe(err)
    if (m) voltar('/configuracoes/usuarios', 'erro', m)
    throw err
  }
}
