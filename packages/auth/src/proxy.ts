/**
 * Identidade vinda do oauth2-proxy.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ DECISÃO DE ARQUITETURA — ADR-016                                          │
 * │                                                                            │
 * │ O PRD v1.0 previa OIDC dentro da aplicação, validando o claim `hd` do ID  │
 * │ token. A VM já resolve isso de outro jeito: oauth2-proxy v7 com            │
 * │ `--provider=google --email-domain=alloyal.com.br`, em modo auth_request    │
 * │ atrás do Nginx Proxy Manager, exatamente como Hub, Radar, Enable e Publi.  │
 * │                                                                            │
 * │ Seguir o padrão da casa em vez de implementar OIDC de novo: menos código,  │
 * │ um só lugar para revogar sessão, e o Google — não a nossa aplicação — é    │
 * │ quem verifica o e-mail. A preocupação com `hd` do PRD vale para OIDC feito │
 * │ à mão, onde se confia num e-mail não verificado; com o provider google do  │
 * │ oauth2-proxy o e-mail vem verificado pelo próprio Google.                  │
 * │                                                                            │
 * │ O QUE ISSO CUSTA, e que precisa de controle explícito:                     │
 * │                                                                            │
 * │ autenticação passa a ser por CABEÇALHO HTTP. Cabeçalho é falsificável por  │
 * │ quem consegue falar direto com a aplicação, sem passar pelo proxy. Duas     │
 * │ defesas, ambas obrigatórias:                                               │
 * │                                                                            │
 * │  1. a aplicação NÃO publica porta para fora — só escuta na rede Docker     │
 * │     `proxy-net` (ver infra/docker-compose.yml);                            │
 * │  2. esta função só aceita o cabeçalho quando a conexão vem de uma faixa    │
 * │     confiável. Fora dela, ela IGNORA a identidade e trata como anônimo.    │
 * │                                                                            │
 * │ Sem a defesa 2, um contêiner comprometido em qualquer outra rede da VM      │
 * │ vira administrador do Ops com um único cabeçalho.                          │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

import { ehPapel, permissoesDe, type Papel, type Permissoes } from './papeis.js'

/** Cabeçalhos que o oauth2-proxy injeta com `--set-xauthrequest=true`. */
export const HEADER_EMAIL = 'x-auth-request-email'
export const HEADER_USER = 'x-auth-request-user'

export interface Identidade {
  readonly email: string
  readonly papeis: readonly Papel[]
  readonly permissoes: Permissoes
}

export class NaoAutenticadoError extends Error {
  constructor(motivo: string) {
    super(`Não autenticado: ${motivo}`)
    this.name = 'NaoAutenticadoError'
  }
}

export interface OpcoesProxy {
  /** Faixas CIDR de onde o proxy fala com a aplicação. */
  readonly faixasConfiaveis: readonly string[]
  /** Domínio obrigatório do e-mail. Segunda barreira, além do proxy. */
  readonly dominio: string
  /** Resolve papéis a partir de `ops.user_role`. */
  readonly papeisDe: (email: string) => Promise<readonly string[]>
}

/** Verifica se um IPv4 pertence a um CIDR. Sem dependência externa de propósito. */
export function ipEmFaixa(ip: string, cidr: string): boolean {
  const [rede, bitsStr] = cidr.split('/')
  if (!rede || !bitsStr) return false
  const bits = Number(bitsStr)
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false

  const paraInt = (valor: string): number | null => {
    const partes = valor.split('.')
    if (partes.length !== 4) return null
    let n = 0
    for (const p of partes) {
      const octeto = Number(p)
      if (!Number.isInteger(octeto) || octeto < 0 || octeto > 255) return null
      n = (n << 8) | octeto
    }
    return n >>> 0
  }

  const alvo = paraInt(ip.replace(/^::ffff:/, ''))
  const base = paraInt(rede)
  if (alvo === null || base === null) return false

  const mascara = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (alvo & mascara) === (base & mascara)
}

/**
 * Resolve a identidade da requisição.
 *
 * Lança `NaoAutenticadoError` — nunca devolve identidade parcial ou anônima
 * silenciosa. Falha fechada, igual à resolução de tenant no banco.
 */
export async function identidadeDaRequisicao(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  ipDeOrigem: string | undefined,
  opts: OpcoesProxy,
): Promise<Identidade> {
  if (!ipDeOrigem || !opts.faixasConfiaveis.some((faixa) => ipEmFaixa(ipDeOrigem, faixa))) {
    throw new NaoAutenticadoError(
      `origem ${ipDeOrigem ?? 'desconhecida'} fora da faixa do proxy; cabeçalho de identidade ignorado`,
    )
  }

  const bruto = headers[HEADER_EMAIL]
  const email = (Array.isArray(bruto) ? bruto[0] : bruto)?.trim().toLowerCase()
  if (!email) throw new NaoAutenticadoError('cabeçalho de identidade ausente')

  if (!email.endsWith(`@${opts.dominio}`)) {
    throw new NaoAutenticadoError(`domínio não autorizado: ${email}`)
  }

  const papeis = (await opts.papeisDe(email)).filter(ehPapel)
  if (papeis.length === 0) {
    // Pessoa autenticada e sem grupo não é erro de infraestrutura: é alguém que
    // ainda não foi adicionada a um grupo do Workspace. A mensagem tem que dizer
    // isso, porque a alternativa é um 403 que ninguém sabe como resolver.
    throw new NaoAutenticadoError(
      `${email} autenticado mas sem papel. Adicione a pessoa a um grupo ops-* no Google Workspace.`,
    )
  }

  return { email, papeis, permissoes: permissoesDe(papeis) }
}
