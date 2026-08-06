import {
  Building2,
  BookOpen,
  CalendarCheck,
  CalendarDays,
  Database,
  DoorOpen,
  FileBarChart,
  FileText,
  Inbox,
  Settings,
  SlidersHorizontal,
  Users,
  Wallet,
} from "lucide-react";

/**
 * O menu do Pulse.
 *
 * Fica em módulo próprio porque é lido pela casca (servidor) e pela nav
 * (cliente). Cada item declara o que a tela RESPONDE, e não só como se chama:
 * tela de operação sem essa frase vira painel que ninguém sabe para que abre.
 */
export interface ItemDeMenu {
  href: string;
  rotulo: string;
  icone: typeof Inbox;
  proposito: string;
}

export const MENU: readonly ItemDeMenu[] = [
  {
    href: "/",
    rotulo: "Minha fila",
    icone: Inbox,
    proposito: "O que fazer agora",
  },
  {
    href: "/carteira",
    rotulo: "Carteira",
    icone: Users,
    proposito: "Onde eu olho — risco × receita",
  },
  {
    // Item PRÓPRIO e não sub-item da Carteira: as duas respondem perguntas diferentes.
    // A Carteira ordena por risco × receita ("onde eu olho hoje"); esta é o cadastro
    // que veio do core ("quem é a base"). Escondida dentro da outra, ninguém acha.
    href: "/carteira/base",
    rotulo: "Base de clientes",
    icone: Building2,
    proposito: "Main e sub business, como vêm do core",
  },
  {
    href: "/renovacoes",
    rotulo: "Renovações",
    icone: CalendarCheck,
    proposito: "Janela de 90 dias, com a previsão medida",
  },
  {
    href: "/saidas",
    rotulo: "Saídas",
    icone: DoorOpen,
    proposito: "Churn real, com as quatro datas",
  },
  {
    href: "/receita",
    rotulo: "Receita",
    icone: Wallet,
    proposito: "Cascata e fechamento mensal",
  },
  {
    href: "/relatorios",
    rotulo: "Relatórios",
    icone: FileBarChart,
    proposito: "O que o cliente recebe — congelado no envio",
  },
  {
    href: "/contratos",
    rotulo: "Contratos",
    icone: FileText,
    proposito: "O que vale hoje, com procedência",
  },
  {
    href: "/contratos/calendario",
    rotulo: "Calendário",
    icone: CalendarDays,
    proposito: "Nenhuma data crítica descoberta pela data",
  },
  {
    href: "/biblioteca",
    rotulo: "Biblioteca",
    icone: BookOpen,
    proposito: "Playbooks versionados, publicados sem deploy",
  },
  {
    href: "/gatilhos",
    rotulo: "Gatilhos",
    icone: SlidersHorizontal,
    proposito: "Calibração e modo sombra",
  },
  {
    href: "/dados",
    rotulo: "Dados",
    icone: Database,
    proposito: "Pipeline de captação",
  },
  {
    href: "/configuracoes",
    rotulo: "Configurações",
    icone: Settings,
    proposito: "Ajustes, acessos e segredos",
  },
];

/**
 * O item de menu que corresponde a uma rota.
 *
 * Ordena por especificidade antes de casar: `/` casaria com tudo se viesse
 * primeiro, e a fila ficaria destacada em todas as telas.
 */
export function itemAtivo(pathname: string): ItemDeMenu | undefined {
  const ordenado = [...MENU].sort((a, b) => b.href.length - a.href.length);
  return ordenado.find((m) =>
    m.href === "/" ? pathname === "/" : pathname.startsWith(m.href),
  );
}
