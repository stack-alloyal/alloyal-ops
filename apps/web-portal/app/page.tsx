/**
 * Entrada por magic link (porta primária — ADR-011).
 *
 * Sem senha: o gestor do cliente acessa o clube algumas vezes por ano, e senha
 * usada duas vezes por semestre é senha esquecida ou anotada.
 */
export default function Page() {
  return (
    <main>
      <h1>Seu clube Alloyal</h1>
      <p>Informe o e-mail cadastrado e enviaremos um link de acesso.</p>
      <form method="post" action="/api/acesso">
        <label htmlFor="email">E-mail</label>
        <input id="email" name="email" type="email" required autoComplete="email" />
        <button type="submit">Receber link</button>
      </form>
      <p>
        <small>O link vale por 20 minutos e só funciona uma vez.</small>
      </p>
    </main>
  )
}
