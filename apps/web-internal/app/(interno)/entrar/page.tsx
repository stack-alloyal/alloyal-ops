import { Login } from '@pulse/ui'
import { headers } from 'next/headers'

import { autenticado } from '../../../lib/guarda'

/**
 * A porta de entrada, servida como PÁGINA e não como interrupção.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ POR QUE NÃO BASTA O `unauthorized.tsx`:                                    │
 * │                                                                            │
 * │ `unauthorized()` é uma interrupção lançada no meio da renderização, e o     │
 * │ Next resolve isso num boundary de suspense: o `<body>` sai com 184 bytes    │
 * │ — um `<template>` vazio — e o conteúdo chega depois, por script, que o      │
 * │ navegador precisa executar para mover para o lugar.                        │
 * │                                                                            │
 * │ Medido nesta instalação, na mesma requisição: página normal = 17.209 bytes  │
 * │ de HTML e 31 âncoras reais; a mesma tela por `unauthorized()` = 0 âncoras.  │
 * │ Numa tela de LOGIN isso é o defeito mais caro possível — quem chega com JS  │
 * │ lento ou bloqueado não vê porta nenhuma. É o mesmo defeito que já tinha     │
 * │ tirado o `<a>` do `BotaoGoogle` quando ele era `'use client'`, por outro    │
 * │ caminho; conferir o HTML da resposta é o único jeito de vê-lo.             │
 * │                                                                            │
 * │ O `unauthorized.tsx` CONTINUA existindo para quem chega à aplicação sem     │
 * │ passar pelo proxy. Esta rota é para onde o proxy manda quem não tem sessão. │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * O `x-pulse-rd` é passado CRU: quem filtra é o `BotaoGoogle`, via `rotaInterna`.
 */
export default async function Entrar() {
  const h = await headers()

  // Já entrou e voltou aqui pelo histórico do navegador: mandar para dentro é
  // melhor que mostrar "entrar" a quem já está dentro.
  if (await autenticado()) {
    const { redirect } = await import('next/navigation')
    redirect('/')
  }

  return <Login rd={h.get('x-pulse-rd')} />
}
