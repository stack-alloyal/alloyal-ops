import { AlloyalLogo, Aviso, Btn, Card, Field } from '@pulse/ui'
import { redirect } from 'next/navigation'

import { identidadeDaSessao } from '../../../lib/guarda'
import { dispositivoVerificado, verificacaoAtiva } from '../../../lib/verificacao'
import { agir, garantirCodigo } from './acoes'

/**
 * Segunda etapa da entrada: o código que chegou por e-mail.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ POR QUE ESTA TELA NÃO USA `exigir`:                                        │
 * │                                                                            │
 * │ `exigir` redireciona para cá quem ainda não verificou. Usá-lo aqui faria    │
 * │ `/verificar` redirecionar para `/verificar` — laço fechado, e o campo do    │
 * │ código nunca apareceria. Usa `identidadeDaSessao`, que resolve quem é sem   │
 * │ cobrar a segunda etapa.                                                    │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Nenhum componente de cliente: os dois botões carregam a escolha no `name`/`value`
 * do submit, e a mensagem volta pela URL. Quem chega com JS lento ou bloqueado
 * ainda entra — numa porta de entrada isso não é purismo.
 */
export default async function Verificar({
  searchParams,
}: {
  searchParams: Promise<{ erro?: string; aviso?: string; enviado?: string }>
}) {
  // Desligado ou inerte: ninguém deve ficar preso numa tela que não faz nada.
  if (!verificacaoAtiva()) redirect('/')

  const id = await identidadeDaSessao()

  // Já verificado neste dispositivo — chegou por link velho ou botão de voltar.
  // Mandar de volta é melhor que pedir código de novo.
  if (await dispositivoVerificado(id.email)) redirect('/')

  const q = await searchParams

  // O primeiro código sai sozinho: chegar aqui e ter que pedir antes de receber
  // qualquer coisa faz a pessoa procurar na caixa um código que ninguém mandou.
  //
  // Mandar daqui é seguro porque o intervalo de reenvio é a trava de idempotência:
  // recarregar a página dentro de 1 minuto não gera código novo nem e-mail novo —
  // devolve "espere Xs". Sem essa trava, um F5 seguido invalidaria o código que já
  // está a caminho e a pessoa digitaria para sempre o do e-mail anterior.
  const avisoDoEnvio = q.erro ? null : await garantirCodigo()

  return (
    <main className="mx-auto flex min-h-screen max-w-[46ch] flex-col justify-center px-5">
      <AlloyalLogo className="mb-6 h-7" />
      <Card title="Confirme que é você">
        <p className="text-[13.5px] leading-relaxed text-ink-2">
          Enviamos um código de 6 dígitos para{' '}
          <strong className="font-semibold text-ink">{id.email}</strong>. Ele vale por 10 minutos.
        </p>

        <form action={agir} className="mt-5">
          <Field
            name="codigo"
            label="Código de 6 dígitos"
            inputMode="numeric"
            // `one-time-code` faz o iOS e o Chrome oferecerem o código do e-mail
            // no próprio teclado. Sem isso a pessoa alterna entre dois aplicativos
            // para copiar seis dígitos.
            autoComplete="one-time-code"
            maxLength={6}
            // Sem `required`: ele bloquearia o submit de "Reenviar" com o campo
            // vazio, que é exatamente quando a pessoa clica nele. Quem confere é
            // o servidor, que já recusa o que não tem 6 dígitos.
          />

          {q.erro ? (
            <div className="mt-3">
              <Aviso tom="erro" papel="alert">
                {q.erro}
              </Aviso>
            </div>
          ) : null}
          {!q.erro && (q.aviso || avisoDoEnvio) ? (
            <div className="mt-3">
              <Aviso tom="alerta" papel="status">
                {q.aviso ?? avisoDoEnvio}
              </Aviso>
            </div>
          ) : null}
          {!q.erro && !q.aviso && !avisoDoEnvio && q.enviado ? (
            <div className="mt-3">
              <Aviso tom="ok" papel="status">
                Código novo enviado.
              </Aviso>
            </div>
          ) : null}

          <div className="mt-5 flex items-center gap-3">
            <Btn type="submit" name="acao" value="confirmar">
              Confirmar
            </Btn>
            <Btn type="submit" variant="ghost" name="acao" value="reenviar">
              Reenviar código
            </Btn>
          </div>
        </form>

        <p className="mt-6 border-t border-line pt-4 text-[11.5px] leading-relaxed text-ink-3">
          Entrar com o Google prova que você tem a conta. O código prova que você tem a caixa de
          e-mail — e é o que impede que alguém entre no seu lugar sem nunca receber nada.
        </p>
      </Card>
    </main>
  )
}
