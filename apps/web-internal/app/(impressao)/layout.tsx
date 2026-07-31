import '@pulse/ui/estilo.css'

import type { ReactNode } from 'react'

export const metadata = { title: 'Relatório Alloyal', description: 'Versão de impressão' }

/**
 * Layout raiz da impressão: sem casca, sem navegação, sem nada de operação interna.
 *
 * O que sai daqui é o que o cliente lê. Um menu impresso no rodapé de um PDF enviado
 * ao gestor de RH é processo interno escapando para fora — e é o tipo de vazamento que
 * ninguém revisa porque a tela "estava certa".
 */
export default function LayoutImpressao({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  )
}
