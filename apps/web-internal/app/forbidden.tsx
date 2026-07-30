/**
 * 403 — autenticado, sem permissão.
 *
 * Distinto do 401 de propósito: aqui o problema não é entrar, é o papel. Dizer
 * "acesso negado" sem dizer o caminho devolve a pessoa ao ponto de partida, e é
 * o que faz alguém abrir um ticket para o time errado.
 */
export default function SemPermissao() {
  return (
    <section className="ops-barrado">
      <h1>Sem permissão para esta área</h1>
      <p>
        Você está autenticado, mas o seu papel não dá acesso a esta tela. Os papéis
        vêm dos grupos <code>ops-*</code> do Google Workspace — peça a inclusão no
        grupo certo a quem administra o Workspace.
      </p>
    </section>
  )
}
