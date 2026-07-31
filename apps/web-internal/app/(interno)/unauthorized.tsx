import { AlloyalLogo, Aviso, Card } from '@ops/ui'

/**
 * 401 — não autenticado.
 *
 * Estado que ENSINA: quem chega aqui em produção provavelmente perdeu a sessão
 * do Google; quem chega em desenvolvimento provavelmente está sem o segredo do
 * proxy. As duas causas têm saídas diferentes, e a tela diz as duas.
 */
export default function NaoAutenticado() {
  return (
    <main className="mx-auto flex min-h-screen max-w-[52ch] flex-col justify-center px-5">
      <AlloyalLogo className="mb-6 h-7" />
      <Card title="Sessão não reconhecida">
        <p className="text-[13.5px] leading-relaxed text-ink-2">
          Esta área exige login com uma conta <strong className="font-semibold">@alloyal.com.br</strong>.
          Se você já entrou, a sessão pode ter expirado — recarregue a página para autenticar de
          novo.
        </p>
        <div className="mt-4">
          <Aviso>
            Rodando local? A superfície interna precisa do segredo do proxy, ou de{' '}
            <code className="rounded bg-surface px-1 py-0.5 text-[12px]">OPS_DEV_EMAIL</code> fora
            de produção.
          </Aviso>
        </div>
      </Card>
    </main>
  )
}
