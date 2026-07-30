/**
 * 401 — não autenticado.
 *
 * Estado que ENSINA: quem chega aqui em produção provavelmente perdeu a sessão
 * do Google; quem chega em desenvolvimento provavelmente está sem o segredo do
 * proxy. As duas causas têm saídas diferentes, e a tela diz as duas.
 */
export default function NaoAutenticado() {
  return (
    <section className="ops-barrado">
      <h1>Sessão não reconhecida</h1>
      <p>
        Esta área exige login com uma conta <strong>@alloyal.com.br</strong>. Se você
        já entrou, a sessão pode ter expirado — recarregue a página para autenticar
        de novo.
      </p>
      <p>
        <small>
          Rodando local? A superfície interna precisa do segredo do proxy, ou de
          <code> OPS_DEV_EMAIL</code> fora de produção.
        </small>
      </p>
    </section>
  )
}
