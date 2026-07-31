/**
 * O catálogo do que o admin pode mudar sem deploy.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ Cada entrada declara LIMITE e EFEITO, e as duas coisas são de segurança    │
 * │ operacional, não de conveniência:                                          │
 * │                                                                            │
 * │   Limite — `teto_fila = 0` esvazia a fila do time inteiro e pareceria um    │
 * │   defeito do produto. `k_minimo_empresas = 1` publica o número de UM        │
 * │   concorrente no relatório de outro cliente. O campo aceitar qualquer valor │
 * │   transforma um erro de digitação em incidente.                            │
 * │                                                                            │
 * │   Efeito — sem a frase que diz o que muda, ninguém mexe (e o ajuste não     │
 * │   serve para nada) ou alguém mexe sem saber (e o ajuste é pior que nada).   │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * O padrão fica no CÓDIGO e não na tabela. Chave ausente = padrão, e é o que permite
 * subir o sistema num banco vazio e ainda ter comportamento correto — semear
 * configuração faria o padrão existir em dois lugares, e dois lugares divergem.
 */

export type TipoAjuste = 'inteiro' | 'fracao' | 'booleano'

export interface Ajuste {
  readonly chave: string
  readonly rotulo: string
  readonly grupo: 'fila' | 'gatilhos' | 'relatorio' | 'contratos' | 'qualidade'
  readonly tipo: TipoAjuste
  readonly padrao: number | boolean
  readonly minimo?: number
  readonly maximo?: number
  readonly unidade?: string
  /** O que muda na operação quando este valor muda. Aparece na tela. */
  readonly efeito: string
  /** Por que existe limite. Aparece quando o valor é recusado. */
  readonly porQueOLimite?: string
  /** Onde o valor é lido. O portão confere que este caminho existe. */
  readonly lidoEm: string
}

export const CATALOGO: readonly Ajuste[] = [
  // ── Fila de trabalho ──────────────────────────────────────────────────────
  {
    chave: 'fila.teto_por_pessoa',
    rotulo: 'Teto de itens por pessoa',
    grupo: 'fila',
    tipo: 'inteiro',
    padrao: 12,
    minimo: 3,
    maximo: 40,
    unidade: 'itens',
    efeito:
      'Quantos itens abertos cada CSM pode ter ao mesmo tempo. O que passa do teto vai '
      + 'para o backlog e continua contado — não desaparece.',
    porQueOLimite:
      'Abaixo de 3 a fila não cabe um dia de trabalho e o CSM volta a trabalhar por '
      + 'planilha. Acima de 40 a fila deixa de ser fila e volta a ser lista, que é o '
      + 'problema que ela resolve.',
    lidoEm: 'apps/worker/src/fila.ts',
  },
  {
    chave: 'fila.dias_de_sombra',
    rotulo: 'Dias em modo sombra antes de promover',
    grupo: 'fila',
    tipo: 'inteiro',
    padrao: 14,
    minimo: 7,
    maximo: 90,
    unidade: 'dias',
    efeito:
      'Quanto tempo um gatilho novo gera item invisível antes de entrar na fila do time. '
      + 'Serve para medir volume e falso positivo antes de custar atenção de alguém.',
    porQueOLimite:
      'Menos de 7 dias não cobre uma semana completa de operação, e o volume de '
      + 'segunda-feira não parece com o de sexta.',
    lidoEm: 'packages/success/src/calibracao.ts',
  },

  // ── Gatilhos ──────────────────────────────────────────────────────────────
  {
    chave: 'gatilhos.atraso_item_financeiro',
    rotulo: 'Atraso que vira item financeiro',
    grupo: 'gatilhos',
    tipo: 'inteiro',
    padrao: 30,
    minimo: 5,
    maximo: 120,
    unidade: 'dias',
    efeito:
      'A partir de quantos dias de atraso a conta gera item de cobrança (G-01). É '
      + 'TAMBÉM o teto do churn silencioso (G-07): abaixo desse atraso a conta que '
      + 'parou de usar é tratada como desengajamento, acima é tratada como cobrança.',
    porQueOLimite:
      'O valor serve a dois gatilhos ao mesmo tempo, e é o que impede G-01 e G-07 de '
      + 'gerarem dois itens para o mesmo fato — foi um defeito real, com 4 contas em 40 '
      + 'duplicadas. Mudar aqui move os dois juntos, de propósito.',
    lidoEm: 'packages/metrics/src/gatilhos.ts',
  },
  {
    chave: 'gatilhos.janela_renovacao_dias',
    rotulo: 'Antecedência da janela de renovação',
    grupo: 'gatilhos',
    tipo: 'inteiro',
    padrao: 90,
    minimo: 30,
    maximo: 180,
    unidade: 'dias',
    efeito:
      'Quantos dias antes do fim da vigência a renovação abre e vira item (G-09). '
      + 'Precisa ser maior que o aviso prévio do contrato, senão a janela abre depois '
      + 'de o cliente já poder sair sem multa.',
    lidoEm: 'packages/success/src/renovacao.ts',
  },

  // ── Relatório do cliente ──────────────────────────────────────────────────
  {
    chave: 'relatorio.k_minimo_empresas',
    rotulo: 'Mínimo de empresas no benchmark',
    grupo: 'relatorio',
    tipo: 'inteiro',
    padrao: 5,
    minimo: 5,
    maximo: 50,
    unidade: 'empresas',
    efeito:
      'Quantas empresas o recorte precisa ter para o comparativo aparecer no relatório '
      + 'do cliente. Abaixo disso a linha é SUPRIMIDA e explicada, nunca omitida.',
    porQueOLimite:
      'O mínimo do mínimo é 5 e não pode baixar: com 4 empresas, quem conhece o mercado '
      + 'deduz quem são; com 2, a mediana É o número do concorrente. Este é o único '
      + 'agregado que sai da empresa contendo dado derivado de outros clientes.',
    lidoEm: 'packages/success/src/benchmark.ts',
  },
  {
    chave: 'relatorio.k_minimo_pessoas',
    rotulo: 'Mínimo de pessoas no benchmark',
    grupo: 'relatorio',
    tipo: 'inteiro',
    padrao: 50,
    minimo: 50,
    maximo: 5000,
    unidade: 'pessoas',
    efeito:
      'A segunda condição do k-anonimato, que vale JUNTO com a de empresas. Cinco '
      + 'empresas de 6 vidas dão um número que descreve 30 pessoas.',
    porQueOLimite: 'Mesmo motivo do mínimo de empresas: 50 é piso, não sugestão.',
    lidoEm: 'packages/success/src/benchmark.ts',
  },
  {
    chave: 'relatorio.meses_de_evolucao',
    rotulo: 'Meses na tabela de evolução',
    grupo: 'relatorio',
    tipo: 'inteiro',
    padrao: 12,
    minimo: 3,
    maximo: 24,
    unidade: 'meses',
    efeito: 'Quantos meses aparecem na evolução do relatório. Mais meses, mais páginas no PDF.',
    lidoEm: 'packages/success/src/relatorio.ts',
  },

  // ── Datas contratuais ─────────────────────────────────────────────────────
  {
    chave: 'contratos.antecedencia_vencimento',
    rotulo: 'Antecedência do vencimento de contrato',
    grupo: 'contratos',
    tipo: 'inteiro',
    padrao: 90,
    minimo: 15,
    maximo: 365,
    unidade: 'dias',
    efeito:
      'Quantos dias antes do vencimento a data vira item de trabalho (C-02). Antecedência '
      + 'grande demais enche a fila com o que ainda não é urgente.',
    porQueOLimite:
      'A antecedência por tipo de data existe porque sem ela o gerador criou 54 itens de '
      + 'reajuste para 120 contas. O que fica só no calendário é contado e dito.',
    lidoEm: 'apps/worker/src/contratual.ts',
  },
  {
    chave: 'contratos.antecedencia_reajuste',
    rotulo: 'Antecedência do reajuste',
    grupo: 'contratos',
    tipo: 'inteiro',
    padrao: 45,
    minimo: 15,
    maximo: 180,
    unidade: 'dias',
    efeito: 'Quantos dias antes do mês de reajuste a data vira item (C-03).',
    lidoEm: 'apps/worker/src/contratual.ts',
  },
  {
    chave: 'contratos.horizonte_calendario',
    rotulo: 'Horizonte do calendário contratual',
    grupo: 'contratos',
    tipo: 'inteiro',
    padrao: 6,
    minimo: 1,
    maximo: 24,
    unidade: 'meses',
    efeito: 'Quantos meses à frente o calendário contratual mostra.',
    lidoEm: 'packages/contratos/src/calendario.ts',
  },

  // ── Qualidade de dado ─────────────────────────────────────────────────────
  {
    chave: 'qualidade.banda_completude',
    rotulo: 'Banda de variação da completude',
    grupo: 'qualidade',
    tipo: 'fracao',
    padrao: 0.2,
    minimo: 0.05,
    maximo: 0.9,
    unidade: 'fração',
    efeito:
      'Quanto a contagem de um ciclo pode variar em relação à anterior antes de o '
      + 'snapshot ser marcado como PARCIAL. Marcar não bloqueia: o número sai com '
      + 'ressalva, nunca some.',
    porQueOLimite:
      'Banda apertada demais marca tudo como parcial e a marca perde significado. '
      + 'Acima de 0,9 nada é marcado e a marca deixa de existir.',
    lidoEm: 'apps/worker/src/quality.ts',
  },
  {
    chave: 'qualidade.teto_falso_positivo',
    rotulo: 'Teto de falso positivo do gatilho',
    grupo: 'qualidade',
    tipo: 'fracao',
    padrao: 0.2,
    minimo: 0.05,
    maximo: 0.6,
    unidade: 'fração',
    efeito:
      'Acima desta fração de itens fechados como "não era problema", a tela de '
      + 'calibração recomenda revisar ou despromover o gatilho.',
    porQueOLimite:
      'Um gatilho que erra mais de 20% ensina o time a ignorar a fila — e uma fila '
      + 'ignorada é pior que nenhuma fila, porque dá a impressão de cobertura.',
    lidoEm: 'packages/success/src/calibracao.ts',
  },
]

/** Segredos que o admin cadastra. O valor NUNCA volta para a tela. */
export interface Segredo {
  readonly chave: string
  readonly rotulo: string
  readonly ondeConseguir: string
  /** O que deixa de funcionar sem ele. */
  readonly semEle: string
  /** Se a perda por ausência é irrecuperável, o texto explica por quê. */
  readonly irrecuperavel?: string
}

export const SEGREDOS: readonly Segredo[] = [
  {
    chave: 'hubspot.token',
    rotulo: 'Token do HubSpot (leitura de deals)',
    ondeConseguir: 'HubSpot → Configurações → Integrações → Private Apps → escopo de leitura de deals',
    semEle: 'Os ciclos C4 e C5 não rodam: contratos e eventos de MRR não entram.',
    irrecuperavel:
      'O C5 captura evento de MRR por webhook. Evento que acontece enquanto o token não '
      + 'existe NÃO é reconstruível depois — cada dia de espera é um dia de histórico '
      + 'de receita que nunca vai existir.',
  },
  {
    chave: 'hubspot.webhook_secret',
    rotulo: 'Segredo de assinatura do webhook do HubSpot',
    ondeConseguir: 'Mesma Private App, aba de webhooks',
    semEle: 'O webhook do C5 é recusado: sem verificar assinatura, qualquer um posta evento de MRR falso.',
  },
  {
    chave: 'clevertap.account_id',
    rotulo: 'Account ID do CleverTap',
    ondeConseguir: 'CleverTap → Settings → Project → Account ID',
    semEle: 'O ciclo C6 não roda e o sinal de engajamento (S-ENG) fica neutro e sinalizado.',
    irrecuperavel:
      'A propriedade de conta precisa começar a ser enviada para o histórico existir. '
      + 'Engajamento de mês que passou sem a propriedade não volta.',
  },
  {
    chave: 'clevertap.passcode',
    rotulo: 'Passcode do CleverTap',
    ondeConseguir: 'CleverTap → Settings → Project → Passcode',
    semEle:
      'O ciclo C6 não autentica: o Account ID sozinho não abre a API. Sem os dois, o sinal '
      + 'de engajamento (S-ENG) fica neutro e sinalizado em toda conta.',
  },
  {
    chave: 'clevertap.region',
    rotulo: 'Região do CleverTap',
    ondeConseguir: 'CleverTap → Settings → Project — é o prefixo do host da sua conta (us1, eu1, in1, sg1, aps3)',
    semEle:
      'A sonda e o ciclo C6 assumem us1. Com a conta em outra região, o pedido vai para '
      + 'a conta errada e volta 401 — que se lê como passcode errado, e alguém troca um '
      + 'passcode que estava certo.',
  },
  {
    chave: 'omie.app_key',
    rotulo: 'App Key do Omie',
    ondeConseguir: 'Omie → Configurações → API → Chaves de integração',
    semEle: 'O ciclo C8 não roda: adimplência não entra, e o sinal financeiro fica neutro.',
  },
  {
    chave: 'omie.app_secret',
    rotulo: 'App Secret do Omie',
    ondeConseguir: 'Mesma tela do App Key, no Omie',
    semEle:
      'O ciclo C8 não autentica: a App Key sozinha não abre a API. Sem adimplência, os '
      + 'gatilhos financeiros (G-01, G-02, G-03) não têm o que avaliar.',
  },
  {
    chave: 'replica.url',
    rotulo: 'URL da réplica de leitura',
    ondeConseguir: 'Infra — credencial somente-leitura e rota de rede liberada',
    semEle:
      'Os ciclos C1, C2 e C3 não rodam. É o acesso que troca massa sintética por dado '
      + 'real: sem ele, todo número de adesão, cobertura e transação descreve o gerador.',
  },
  {
    chave: 'smtp.url',
    rotulo: 'SMTP para envio do relatório',
    ondeConseguir: 'Provedor de e-mail transacional',
    semEle: 'O relatório é composto, revisado e congelado, mas o envio é manual.',
  },
]

export const POR_GRUPO = {
  fila: 'Fila de trabalho',
  gatilhos: 'Gatilhos',
  relatorio: 'Relatório do cliente',
  contratos: 'Datas contratuais',
  qualidade: 'Qualidade de dado',
} as const

export const AJUSTE_POR_CHAVE = new Map(CATALOGO.map((a) => [a.chave, a]))
