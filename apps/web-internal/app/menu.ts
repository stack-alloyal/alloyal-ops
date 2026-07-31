import {
  BookOpen,
  CalendarCheck,
  Database,
  DoorOpen,
  FileText,
  Inbox,
  SlidersHorizontal,
  Wallet,
} from 'lucide-react'

/**
 * O menu do Ops.
 *
 * Fica em módulo próprio porque é lido pela casca (servidor) e pela nav
 * (cliente). Cada item declara o que a tela RESPONDE, e não só como se chama:
 * tela de operação sem essa frase vira painel que ninguém sabe para que abre.
 */
export interface ItemDeMenu {
  href: string
  rotulo: string
  icone: typeof Inbox
  proposito: string
}

export const MENU: readonly ItemDeMenu[] = [
  { href: '/', rotulo: 'Minha fila', icone: Inbox, proposito: 'O que fazer agora' },
  {
    href: '/renovacoes',
    rotulo: 'Renovações',
    icone: CalendarCheck,
    proposito: 'Janela de 90 dias, com a previsão medida',
  },
  { href: '/saidas', rotulo: 'Saídas', icone: DoorOpen, proposito: 'Churn real, com as quatro datas' },
  { href: '/receita', rotulo: 'Receita', icone: Wallet, proposito: 'Cascata e fechamento mensal' },
  {
    href: '/contratos',
    rotulo: 'Contratos',
    icone: FileText,
    proposito: 'O que vale hoje, com procedência',
  },
  {
    href: '/biblioteca',
    rotulo: 'Biblioteca',
    icone: BookOpen,
    proposito: 'Playbooks versionados, publicados sem deploy',
  },
  {
    href: '/gatilhos',
    rotulo: 'Gatilhos',
    icone: SlidersHorizontal,
    proposito: 'Calibração e modo sombra',
  },
  { href: '/dados', rotulo: 'Dados', icone: Database, proposito: 'Pipeline de captação' },
]

/**
 * O item de menu que corresponde a uma rota.
 *
 * Ordena por especificidade antes de casar: `/` casaria com tudo se viesse
 * primeiro, e a fila ficaria destacada em todas as telas.
 */
export function itemAtivo(pathname: string): ItemDeMenu | undefined {
  const ordenado = [...MENU].sort((a, b) => b.href.length - a.href.length)
  return ordenado.find((m) => (m.href === '/' ? pathname === '/' : pathname.startsWith(m.href)))
}
