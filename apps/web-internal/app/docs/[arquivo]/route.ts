import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { NaoAutenticadoError, SemPapelError } from '@pulse/auth'
import { forbidden, unauthorized } from 'next/navigation'

import { identidade } from '../../../lib/identidade'

/**
 * Serve os documentos internos em HTML — atrás da identidade, não do `public/`.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ POR QUE NÃO É ARQUIVO ESTÁTICO EM `public/`, COMO ERA:                     │
 * │                                                                            │
 * │ Porque arquivo em `public/` NÃO passa pela resolução de identidade. Medido  │
 * │ na stack de pé: uma pessoa SUSPENSA levava 403 em `/carteira` e ainda lia   │
 * │ o documento com 200. A suspensão existe para casos como desligamento em    │
 * │ análise — e cortar o app mas não o material interno é meia suspensão.      │
 * │                                                                            │
 * │ Passando por aqui, a identidade é resolvida: sem sessão dá 401, suspenso    │
 * │ dá 403. E papel continua NÃO sendo exigido — era o pedido original, "aberto │
 * │ a todos que entrarem pelo SSO do Google".                                  │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ POR QUE `SemPapelError` É ENGOLIDA AQUI, E SÓ AQUI:                        │
 * │                                                                            │
 * │ `identidadeDaSessao` (o caminho normal das telas) transforma falta de papel │
 * │ em 403 — e usá-la aqui QUEBROU o requisito: usuário novo, sem papel, passou │
 * │ a levar 403 no documento. Medido: 403 onde tinha que ser 200.               │
 * │                                                                            │
 * │ Então a checagem é montada à mão, e a lista de quem passa é explícita:      │
 * │ sessão válida e não suspenso. Suspensão e falta de sessão continuam         │
 * │ barrando — só a falta de PAPEL é tolerada, porque é justamente o que este   │
 * │ documento quer permitir.                                                   │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ AS FONTES CONTINUAM EM `public/`, e é decisão: são arquivo de fonte, sem   │
 * │ conteúdo de negócio. Trazê-las para cá custaria uma checagem de identidade │
 * │ por fonte, em toda visita, para proteger dois arquivos que não dizem nada. │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

/**
 * Lista fechada, e não caminho livre.
 *
 * Um handler que aceita `params.arquivo` e concatena com a pasta é travessia de
 * caminho esperando acontecer — `..%2f..%2fetc%2fpasswd` chega aqui como texto. Com
 * mapa explícito, o que não está na lista simplesmente não existe.
 */
const DOCUMENTOS: Record<string, string> = {
  'kickoff.html': 'kickoff.html',
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ arquivo: string }> },
): Promise<Response> {
  // Antes de qualquer leitura de disco. A ordem dos catch é a política:
  //   SemPapelError        → PASSA (é o ponto deste documento)
  //   AcessoSuspensoError  → 403, e tudo o mais também
  //   NaoAutenticadoError  → 401
  try {
    await identidade()
  } catch (err) {
    if (err instanceof SemPapelError) {
      // Autenticada pelo Google, ainda sem papel: exatamente o público deste doc.
    } else if (err instanceof NaoAutenticadoError) {
      unauthorized()
    } else {
      forbidden()
    }
  }

  const { arquivo } = await params
  const nome = DOCUMENTOS[arquivo]
  if (!nome) return new Response('não encontrado', { status: 404 })

  // O `server.js` do standalone faz `process.chdir(__dirname)`, então o cwd em
  // produção é `/app/apps/web-internal` — NÃO `/app`. Conferido em
  // `/proc/1/cwd` no contêiner; a primeira versão montava
  // `/app/apps/web-internal/apps/web-internal/...` e devolvia 500.
  //
  // Em `next dev` o cwd é a raiz do app, que dá o mesmo caminho relativo.
  const caminho = join(process.cwd(), 'conteudo', nome)
  let html: string
  try {
    html = await readFile(caminho, 'utf8')
  } catch {
    // Arquivo listado e ausente é defeito de EMPACOTAMENTO, não do pedido — foi
    // exatamente o que aconteceu com `public/` não entrando no standalone. Devolver
    // 404 aqui esconderia isso; 500 com a causa aparece no log.
    return new Response(`documento ${nome} não está no pacote`, { status: 500 })
  }

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Sem cache compartilhado: a resposta depende de QUEM pediu, e um proxy
      // guardando-a serviria o documento a quem foi suspenso depois.
      'Cache-Control': 'private, no-store',
    },
  })
}
