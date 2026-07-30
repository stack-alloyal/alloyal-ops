/**
 * @ops/contracts — schemas compartilhados entre superfície e servidor.
 *
 * Doc 00, 4.2.
 *
 * Validação com Zod na FRONTEIRA, não no meio. O ponto crítico é o schema de
 * requisição externa: ele é o lugar onde a camada 1 do isolamento de tenant
 * (doc 00, 5.4) é imposta em código.
 */

import { z } from 'zod'

// ─────────────────────────────────────────────────────────────────────────────
// CAMADA 1 DO ISOLAMENTO DE TENANT
//
// Nenhum endpoint externo aceita identificador de cliente. O identificador vem
// EXCLUSIVAMENTE do token de sessão.
//
// `.strict()` faz o schema recusar qualquer campo não declarado. Combinado com
// `CAMPOS_DE_TENANT_PROIBIDOS`, um parâmetro de tenant que apareça em query,
// path, corpo ou cabeçalho não é ignorado em silêncio: é 403 e registro.
//
// A distinção importa. A v1.0 dizia ao mesmo tempo que "nenhum endpoint aceita
// identificador por parâmetro" e que o teste deveria esperar 403 ao enviar um —
// duas coisas incompatíveis. Recusar alto é a escolha certa: ignorar em silêncio
// esconde a tentativa, e tentativa é justamente o que se quer ver no log.
// ─────────────────────────────────────────────────────────────────────────────

export const CAMPOS_DE_TENANT_PROIBIDOS = [
  'account_id',
  'accountId',
  'hubspot_id',
  'hubspotId',
  'hubspot_company_id',
  'cliente',
  'cliente_id',
  'tenant',
  'tenant_id',
  'cnpj',
] as const

export class TenantEmParametroError extends Error {
  constructor(readonly campo: string, readonly onde: string) {
    super(
      `Identificador de cliente recebido em ${onde} ("${campo}"). ` +
        `O tenant vem do token, nunca de parâmetro (doc 00, 5.4, camada 1).`,
    )
    this.name = 'TenantEmParametroError'
  }
}

/**
 * Recusa a requisição externa que carregue identificador de cliente.
 *
 * Chamado antes de qualquer handler externo. Varre query, corpo, path e
 * cabeçalhos — os quatro lugares que o critério de lançamento exige testar.
 */
export function recusarTenantEmParametro(fontes: {
  readonly query?: Record<string, unknown>
  readonly body?: unknown
  readonly params?: Record<string, unknown>
  readonly headers?: Record<string, unknown>
}): void {
  // Normaliza caixa e separadores: `hubspot_company_id`, `hubspotCompanyId` e
  // `HUBSPOT-COMPANY-ID` são a mesma tentativa. Comparar a string literal
  // deixaria a proteção depender da convenção de nomes de quem chamou.
  const normalizar = (chave: string): string =>
    chave
      .toLowerCase()
      .replace(/^x-ops-/, '')
      .replace(/[_-]/g, '')

  const proibidos = new Set<string>(CAMPOS_DE_TENANT_PROIBIDOS.map(normalizar))

  const varrer = (obj: unknown, onde: string, profundidade = 0): void => {
    if (profundidade > 4 || obj === null || typeof obj !== 'object') return
    for (const [chave, valor] of Object.entries(obj as Record<string, unknown>)) {
      if (proibidos.has(normalizar(chave))) throw new TenantEmParametroError(chave, onde)
      varrer(valor, onde, profundidade + 1)
    }
  }

  varrer(fontes.query, 'query string')
  varrer(fontes.params, 'path')
  varrer(fontes.body, 'corpo')
  varrer(fontes.headers, 'cabeçalho')
}

// ─── Requisições do portal ───────────────────────────────────────────────────

export const consultaPortalSchema = z
  .object({
    metrica: z.string().min(1).max(64),
    de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict()

export type ConsultaPortal = z.infer<typeof consultaPortalSchema>

export const solicitarAcessoSchema = z
  .object({
    email: z.string().email().max(254),
  })
  .strict()

// ─── Envelope de resposta ────────────────────────────────────────────────────

export const estadoDadoSchema = z.enum([
  'ok',
  'defasado',
  'parcial',
  'suprimido',
  'em_verificacao',
])

export const lineageSchema = z.object({
  valor: z.number().nullable(),
  metrica: z.string(),
  versao_definicao: z.number().int().positive(),
  competencia: z.string(),
  gerado_em: z.string(),
  fontes: z.array(
    z.object({
      ciclo: z.string(),
      fonte: z.string(),
      atualizado_em: z.string().nullable(),
      status: z.enum(['ok', 'defasado', 'ausente']),
    }),
  ),
  estado: estadoDadoSchema,
  n_base: z.number().int().nonnegative().optional(),
})
