import { AlloyalLogo, Btn, Card, Field } from '@ops/ui'

/**
 * Entrada por magic link (porta primária — ADR-011).
 *
 * Sem senha: o gestor do cliente acessa o clube algumas vezes por ano, e senha
 * usada duas vezes por semestre é senha esquecida ou anotada.
 *
 * Mesma marca da superfície interna, densidade diferente. Quem entra aqui entra
 * raramente e não conhece a ferramenta — a tela respira, e cada frase supõe zero
 * familiaridade.
 */
export default function Page() {
  return (
    <main className="mx-auto flex min-h-screen max-w-[46ch] flex-col justify-center px-5 py-10">
      <AlloyalLogo className="mb-7 h-8" />
      <Card title="Seu clube Alloyal">
        <p className="text-[13.5px] leading-relaxed text-ink-2">
          Informe o e-mail cadastrado e enviaremos um link de acesso.
        </p>
        <form method="post" action="/api/acesso" className="mt-4 grid gap-3">
          <Field label="E-mail" name="email" type="email" required autoComplete="email" />
          <Btn type="submit">Receber link</Btn>
        </form>
        <p className="mt-3 text-[12px] text-ink-3">
          O link vale por 20 minutos e só funciona uma vez.
        </p>
      </Card>
    </main>
  )
}
