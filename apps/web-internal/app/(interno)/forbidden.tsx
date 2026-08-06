import { AlloyalLogo, Card } from '@pulse/ui'
import Link from 'next/link'

/**
 * 403 — autenticado, sem acesso.
 *
 * Distinto do 401 de propósito: aqui o problema não é entrar, é o papel. Dizer
 * "acesso negado" sem dizer o caminho devolve a pessoa ao ponto de partida, e é
 * o que faz alguém abrir um ticket para o time errado.
 *
 * Cobre TRÊS casos, e o texto precisa servir aos três:
 *
 *   · autenticou e não tem papel nenhum — `SemPapelError`, quem nunca foi
 *     cadastrado. QUALQUER conta @alloyal.com.br chega até aqui, porque o
 *     oauth2-proxy filtra só por domínio; quem barra de fato é o papel.
 *   · tem papel, mas o acesso está SUSPENSO — `AcessoSuspensoError`, alguém
 *     desativou a pessoa em Configurações → Usuários. Os papéis continuam lá.
 *   · tem papel ativo, mas não este acesso — `exigir()` recusou a permissão.
 *
 * `forbidden()` do Next não carrega dado do erro, então esta tela não sabe QUAL
 * dos três aconteceu. O texto cobre os três em vez de adivinhar um — dizer "você
 * não tem papel" a quem está suspenso manda a pessoa para a conversa errada.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ A versão anterior mandava pedir inclusão num grupo `pulse-*` do Google      │
 * │ Workspace. Estava ERRADO: papel vive em `ops.user_role` e se concede em     │
 * │ Configurações → Papéis. A tela mandava a pessoa para quem administra o      │
 * │ Workspace, que não tem como resolver — o pedido morria lá.                  │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export default function SemPermissao() {
  return (
    <main className="mx-auto flex min-h-screen max-w-[52ch] flex-col justify-center px-5">
      <AlloyalLogo className="mb-6 h-7" />
      <Card title="Sem acesso a esta área">
        <p className="text-[13.5px] leading-relaxed text-ink-2">
          Você entrou com a sua conta Alloyal, mas ela não está com acesso a esta tela. Pode ser
          que ainda não tenha papel, que o papel não cubra esta área, ou que o acesso esteja
          suspenso.
        </p>
        <p className="mt-3 text-[13.5px] leading-relaxed text-ink-2">
          Quem administra o Pulse resolve os três casos em{' '}
          <strong className="font-semibold text-ink">Configurações</strong> — papel em{' '}
          <strong className="font-semibold text-ink">Papéis</strong>, suspensão em{' '}
          <strong className="font-semibold text-ink">Usuários</strong>. Peça dizendo qual tela
          você precisa usar: o papel certo depende disso.
        </p>
        <Link
          href="/"
          className="mt-4 inline-block text-[13px] font-semibold text-purple-700 hover:text-purple-500"
        >
          Voltar ao início →
        </Link>
      </Card>
    </main>
  )
}
