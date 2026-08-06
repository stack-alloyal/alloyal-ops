import 'server-only'

import { COOKIE_DISPOSITIVO, lerCookie, stepUpAtivo, verificarDispositivo } from '@pulse/auth'
import { Mailer } from '@pulse/mail'
import { cookies } from 'next/headers'

/**
 * A verificação por e-mail está valendo NESTA instância?
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ TRAVA ANTI-LOCKOUT — três condições, e a terceira é a que salva.           │
 * │                                                                            │
 * │ Exigir código sem conseguir ENVIAR código tranca todo mundo para fora,      │
 * │ inclusive quem consertaria. Por isso o mailer entra na conta: se a          │
 * │ credencial do Gmail sumir ou expirar, o step-up fica inerte e a plataforma  │
 * │ volta ao SSO puro sozinha, em vez de ficar inacessível.                    │
 * │                                                                            │
 * │ A decisão mora em `stepUpAtivo`, que é pura e testada — aqui só se lê o     │
 * │ ambiente. Mesma razão de `permiteIdentidadeDeDesenvolvimento` ser pura.     │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Saída de emergência: `PULSE_VERIFICACAO_EMAIL=false` e ninguém mais precisa de
 * código, sem alterar código nem migrar nada.
 */
export function verificacaoAtiva(): boolean {
  return stepUpAtivo(
    process.env['PULSE_VERIFICACAO_EMAIL'],
    process.env['PULSE_VERIFICACAO_SEGREDO'],
    mailer().configurado(),
  )
}

let cache: Mailer | null = null
export function mailer(): Mailer {
  cache ??= Mailer.doAmbiente()
  return cache
}

export function segredoDaVerificacao(): string {
  return process.env['PULSE_VERIFICACAO_SEGREDO'] ?? ''
}

/**
 * Este dispositivo já foi verificado por esta pessoa?
 *
 * O e-mail vai DENTRO da carga assinada e é conferido contra o da sessão: sem
 * isso, copiar o cookie de um colega pularia a verificação.
 */
export async function dispositivoVerificado(email: string): Promise<boolean> {
  const bruto = (await cookies()).get(COOKIE_DISPOSITIVO)?.value
  return verificarDispositivo(email, bruto ?? null, segredoDaVerificacao(), new Date())
}

/** Exportado só para o teste de fronteira: a leitura crua do cabeçalho. */
export { lerCookie }
