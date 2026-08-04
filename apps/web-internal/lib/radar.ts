import 'server-only'

/**
 * Cliente do Alloyal Radar — a central de bugs, melhorias e features da casa
 * (radar.alloyal.com.br), onde Hub, Enable, Metas, Publi e agora o Pulse
 * despejam o que quebrou e o que mudou.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ O PROJETO NÃO VIAJA NO CORPO DA REQUISIÇÃO — quem o define é o TOKEN.      │
 * │                                                                            │
 * │ O Radar tem um token por produto (`RADAR_TOKEN_PULSE` lá, este             │
 * │ `RADAR_SERVICE_TOKEN` aqui) e escopa cada chamada ao projeto do token. Não │
 * │ é detalhe de implementação deles: é o que limita o estrago de um vazamento │
 * │ daqui a um único projeto. Mandar `projeto=pulse` no corpo seria pedir para │
 * │ o Radar confiar no cliente, e o token deixaria de ser fronteira.           │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * `server-only`: o token é credencial de serviço e nunca pode chegar ao
 * navegador. Quem fala com este módulo são as Server Actions de
 * `app/(interno)/radar/acoes.ts`, e a tela só vê o resultado.
 *
 * O Radar é ACESSÓRIO ao Pulse. Ele fora do ar não pode atrasar nem derrubar
 * uma tela de operação — por isso todo caminho de leitura tem prazo curto e
 * devolve lista vazia no erro, e nada aqui é chamado durante a renderização de
 * uma página (só sob clique).
 */

const RADAR_PADRAO = 'https://radar.alloyal.com.br'

/**
 * Prazo de cada chamada.
 *
 * Sem prazo, o `fetch` do Node espera o TCP desistir — o que passa de um minuto
 * e transforma "o Radar está lento" em "o painel de reportar travou".
 */
const PRAZO_MS = 6000

export type TipoDeReport = 'bug' | 'melhoria' | 'feature'
export type Criticidade = 'baixa' | 'media' | 'alta' | 'urgente'
export type StatusDaDemanda =
  | 'aberto'
  | 'em_andamento'
  /** Parada esperando uma definição de quem abriu — a bola está com ela. */
  | 'aguardando_retorno'
  | 'realizado'
  | 'recusado'

/** Os limites são os do Radar (`lib/demandas.ts` e `lib/anexos.ts` lá). */
export const MAX_TITULO = 200
export const MAX_DESCRICAO = 5000
export const MAX_ANEXOS = 10
export const MAX_ANEXO_BYTES = 10 * 1024 * 1024

export interface Novidade {
  id: string
  protocolo: number | null
  projeto: string
  tipo: TipoDeReport
  notaDeRelease: string
  publicadoEm: string
}

export interface Demanda {
  id: string
  protocolo: number
  tipo: TipoDeReport
  criticidade: Criticidade
  status: StatusDaDemanda
  titulo: string
  autor: string
  previsaoSolucao: string | null
  notaDeRelease: string | null
  detalheResolucao: string | null
  /** O que o time aguarda de quem abriu, e a resposta já dada. */
  pendencia: string | null
  devolutiva: string | null
  createdAt: string
  updatedAt: string
}

export interface RespostaDoReport {
  ok: boolean
  protocolo?: number
  erro?: string
  /** O Radar aceita a demanda e recusa o anexo; os dois fatos cabem na resposta. */
  avisoAnexos?: string
}

/**
 * Configuração, ou `null` quando a integração não está ligada.
 *
 * Ausência de token é estado LEGÍTIMO — é assim que roda quem sobe o Pulse
 * local sem os segredos —, e por isso não lança: a leitura devolve vazio e o
 * envio devolve um erro em português. O que não pode acontecer é o widget
 * quebrar a tela por causa de um segredo que não é dele.
 */
function configuracao(): { url: string; token: string } | null {
  const token = process.env['RADAR_SERVICE_TOKEN']
  if (!token) return null
  return { url: process.env['RADAR_URL'] ?? RADAR_PADRAO, token }
}

export function radarConfigurado(): boolean {
  return configuracao() !== null
}

/**
 * A base do Radar, para montar o link de uma demanda.
 *
 * O painel só LÊ o que está pendente; responder é lá — e sem o link a pessoa
 * descobre que precisa responder e não descobre onde.
 */
export function urlDoRadar(): string {
  return configuracao()?.url ?? RADAR_PADRAO
}

async function ler<T>(caminho: string, revalidar: number | false): Promise<T[]> {
  const cfg = configuracao()
  if (!cfg) return []
  try {
    const res = await fetch(`${cfg.url}${caminho}`, {
      headers: { 'x-radar-token': cfg.token },
      signal: AbortSignal.timeout(PRAZO_MS),
      ...(revalidar === false ? { cache: 'no-store' as const } : { next: { revalidate: revalidar } }),
    })
    if (!res.ok) return []
    return (await res.json()) as T[]
  } catch {
    // Radar fora do ar, DNS, prazo estourado. Lista vazia é o comportamento
    // certo para um acessório: a tela some, a operação continua.
    return []
  }
}

/** As novidades do Pulse já publicadas no Radar. */
export function listarNovidades(): Promise<Novidade[]> {
  // 5 min de cache: o ✨ é consultado a cada abertura de tela, e a novidade é
  // publicada por gente — nenhuma delas some por chegar cinco minutos depois.
  return ler<Novidade>('/api/ext/novidades', 300)
}

/** Todos os reports do Pulse, com o status atual. */
export function listarDemandas(): Promise<Demanda[]> {
  // Sem cache: quem acabou de reportar reabre o painel para ver o próprio item,
  // e uma lista de cinco minutos atrás leria como "não registrou".
  return ler<Demanda>('/api/ext/demandas-list', false)
}

/**
 * Cria um report no Radar.
 *
 * Multipart porque o que mais ajuda num relato de bug é o print — e é o que a
 * pessoa tem na mão, colado do clipboard. O `autor` vem da identidade da
 * sessão, resolvida na Server Action; nunca de campo de formulário.
 */
export async function enviarReport(dados: {
  autor: string
  tipo: string
  criticidade: string
  titulo: string
  descricao: string
  anexos: File[]
}): Promise<RespostaDoReport> {
  const cfg = configuracao()
  if (!cfg) return { ok: false, erro: 'A integração com o Radar não está configurada nesta instância.' }

  const corpo = new FormData()
  corpo.set('autor', dados.autor)
  corpo.set('tipo', dados.tipo)
  corpo.set('criticidade', dados.criticidade)
  corpo.set('titulo', dados.titulo)
  corpo.set('descricao', dados.descricao)
  for (const arquivo of dados.anexos.slice(0, MAX_ANEXOS)) corpo.append('anexos', arquivo)

  try {
    const res = await fetch(`${cfg.url}/api/ext/demandas`, {
      method: 'POST',
      headers: { 'x-radar-token': cfg.token },
      body: corpo,
      // Prazo maior que o da leitura: aqui sobe arquivo, e 6 s derrubaria print
      // grande em conexão ruim depois de a pessoa já ter escrito tudo.
      signal: AbortSignal.timeout(30000),
    })
    const json = (await res.json().catch(() => ({}))) as {
      protocolo?: number
      error?: string
      avisoAnexos?: string
    }
    if (!res.ok) {
      // O Radar devolve a mensagem em português (validação, limite de taxa).
      // Repassar é melhor que traduzir: "muitas demandas em pouco tempo" diz o
      // que fazer, e um "erro 429" genérico não diz nada.
      return { ok: false, erro: json.error ?? `O Radar recusou o envio (HTTP ${res.status}).` }
    }
    return {
      ok: true,
      ...(json.protocolo === undefined ? {} : { protocolo: json.protocolo }),
      ...(json.avisoAnexos === undefined ? {} : { avisoAnexos: json.avisoAnexos }),
    }
  } catch {
    // Aqui o silêncio seria mentira: a pessoa escreveu o relato e precisa saber
    // que ele NÃO foi registrado — diferente da leitura, que pode voltar vazia.
    return { ok: false, erro: 'Não foi possível falar com o Radar. Tente de novo em instantes.' }
  }
}
