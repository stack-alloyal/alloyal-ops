import { AlloyalLogo, Card } from '@pulse/ui'
import Link from 'next/link'

/**
 * 403 — autenticado, sem permissão.
 *
 * Distinto do 401 de propósito: aqui o problema não é entrar, é o papel. Dizer
 * "acesso negado" sem dizer o caminho devolve a pessoa ao ponto de partida, e é
 * o que faz alguém abrir um ticket para o time errado.
 */
export default function SemPermissao() {
  return (
    <main className="mx-auto flex min-h-screen max-w-[52ch] flex-col justify-center px-5">
      <AlloyalLogo className="mb-6 h-7" />
      <Card title="Sem permissão para esta área">
        <p className="text-[13.5px] leading-relaxed text-ink-2">
          Você está autenticado, mas o seu papel não dá acesso a esta tela. Os papéis vêm dos
          grupos <code className="rounded bg-surface-2 px-1 py-0.5 text-[12px]">pulse-*</code> do
          Google Workspace — peça a inclusão no grupo certo a quem administra o Workspace.
        </p>
        <Link
          href="/"
          className="mt-4 inline-block text-[13px] font-semibold text-purple-700 hover:text-purple-500"
        >
          Voltar para a fila →
        </Link>
      </Card>
    </main>
  )
}
