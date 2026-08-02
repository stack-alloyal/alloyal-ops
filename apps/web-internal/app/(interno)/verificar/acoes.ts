'use server'

import { assinarDispositivo, type RecusaDeCodigo } from '@pulse/auth'
import { conferir, pedirCodigo } from '@pulse/config'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

import { pool } from '../../../lib/db'
import { identidadeDaSessao } from '../../../lib/guarda'
import { mailer, segredoDaVerificacao, verificacaoAtiva } from '../../../lib/verificacao'

/**
 * Manda (ou remanda) o código para o e-mail DA SESSÃO.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ O e-mail NÃO vem do formulário — vem da identidade já autenticada.         │
 * │                                                                            │
 * │ Aceitar e-mail digitado transformaria esta ação num disparador de e-mail    │
 * │ para qualquer endereço, acionável por quem chegasse à tela; e seria a porta │
 * │ para pedir o código de OUTRA pessoa.                                       │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Devolve a mensagem já pronta para a tela, ou null quando saiu sem novidade.
 */
export async function garantirCodigo(): Promise<string | null> {
  const id = await identidadeDaSessao()
  const r = await pedirCodigo(pool(), mailer(), id.email, segredoDaVerificacao())
  if (r.enviado) return null
  const seg = Math.ceil((r.esperarMs ?? 0) / 1000)
  return `Um código já foi enviado agora há pouco. Espere ${seg}s para pedir outro.`
}

const MENSAGEM: Record<RecusaDeCodigo, string> = {
  sem_codigo: 'Nenhum código em aberto. Peça um novo.',
  expirado: 'Este código expirou. Peça um novo.',
  travado: 'Tentativas demais neste código. Peça um novo.',
  invalido: 'Código incorreto.',
}

/**
 * Um formulário, dois botões.
 *
 * `Btn` carrega `name`/`value` no submit justamente para isto: a escolha entre
 * "confirmar" e "reenviar" viaja no POST, e a tela funciona sem uma linha de
 * JavaScript. Numa porta de entrada isso não é purismo — quem chega com JS lento
 * ou bloqueado precisa conseguir entrar.
 *
 * O resultado volta pela URL porque exibir erro sem `useActionState` exigiria
 * componente de cliente, que é justamente o que se está evitando.
 */
export async function agir(form: FormData): Promise<void> {
  if (!verificacaoAtiva()) redirect('/')
  const id = await identidadeDaSessao()

  if (String(form.get('acao') ?? '') === 'reenviar') {
    const aviso = await garantirCodigo()
    redirect(aviso ? `/verificar?aviso=${encodeURIComponent(aviso)}` : '/verificar?enviado=1')
  }

  const digitado = String(form.get('codigo') ?? '')
  if (!/^\s*[0-9]{6}\s*$/.test(digitado)) {
    // Recusa ANTES de gastar tentativa: quem digitou 5 dígitos errou de digitação,
    // não de código, e queimar uma das 5 tentativas por isso pune o engano errado.
    redirect(`/verificar?erro=${encodeURIComponent('O código tem 6 dígitos.')}`)
  }

  const r = await conferir(pool(), id.email, digitado, segredoDaVerificacao())
  if (!r.ok) redirect(`/verificar?erro=${encodeURIComponent(MENSAGEM[r.motivo])}`)

  // Acertou: este dispositivo fica marcado por 30 dias. `HttpOnly` mantém o cookie
  // fora do alcance de script na página; `SameSite=Lax` impede que ele viaje numa
  // requisição partida de outro site.
  const { nome, valor, maxIdadeSeg } = assinarDispositivo(
    id.email,
    segredoDaVerificacao(),
    new Date(),
  )
  ;(await cookies()).set(nome, valor, {
    path: '/',
    maxAge: maxIdadeSeg,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  })

  redirect('/')
}
