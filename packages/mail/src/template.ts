/**
 * Template dos e-mails transacionais do Pulse.
 *
 * Mesmo formato do Allvoice e do Alloyal Metas: cartão de 480px, cabeçalho com o
 * gradiente roxo→laranja, rodapé em cinza. Quem recebe um e-mail do Pulse
 * reconhece a casa.
 *
 * ds-excecao: e-mail não tem variável CSS — cliente de e-mail não resolve var(),
 * e Gmail e Outlook descartam <style> inteiro, então cor tem que ser hex literal
 * em atributo style. Os valores abaixo são cópia dos tokens de estilo.css, não
 * aproximação, e mudam junto com eles.
 *
 * Roxo #6A18E5 = ação · Laranja #FF7A00 = marca.
 */

/** Os mesmos valores de `packages/ui/src/estilo.css`. Se mudarem lá, mudam aqui. */
const COR = {
  roxo: '#6A18E5',
  laranja: '#FF7A00',
  fundo: '#f6f6f8',
  superficie: '#ffffff',
  linha: '#ececef',
  tinta: '#16161a',
  tinta2: '#5b5b66',
  tinta3: '#9a9aa6',
} as const

export function escaparHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * href seguro para atributo: só http/https/mailto.
 *
 * Neutraliza `javascript:` e `data:`. Hoje nenhuma URL de e-mail do Pulse vem de
 * fonte não confiável — e é justamente por isso que a checagem entra agora, e não
 * no dia em que vier.
 */
export function hrefSeguro(url: string): string {
  const u = String(url ?? '').trim()
  if (!/^(https?:|mailto:)/i.test(u)) return '#'
  return escaparHtml(u)
}

export interface CorpoDeEmail {
  /** Escapado. */
  readonly saudacao?: string
  /** Inserido como HTML — quem chama garante a segurança. */
  readonly corpoHtml: string
  readonly acao?: { readonly rotulo: string; readonly url: string }
  /** Escapado. */
  readonly rodape?: string
}

export function montarEmail(entrada: CorpoDeEmail): string {
  const saudacao = entrada.saudacao
    ? `<p style="margin:0 0 12px;font-size:15px">${escaparHtml(entrada.saudacao)}</p>`
    : ''
  const acao = entrada.acao
    ? `<a href="${hrefSeguro(entrada.acao.url)}" style="display:inline-block;background:${COR.roxo};color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:15px;font-weight:600;margin-top:4px">${escaparHtml(entrada.acao.rotulo)}</a>`
    : ''
  const rodape = entrada.rodape
    ? `<tr><td style="padding:20px 24px 28px"><p style="margin:0;font-size:12px;color:${COR.tinta2};line-height:1.5">${escaparHtml(entrada.rodape)}</p></td></tr>`
    : ''

  return `<!doctype html>
<html lang="pt-BR">
<body style="margin:0;background:${COR.fundo};font-family:Inter,Segoe UI,Arial,sans-serif;color:${COR.tinta}">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:${COR.superficie};border-radius:12px;overflow:hidden;border:1px solid ${COR.linha}">
        <tr>
          <td style="background:linear-gradient(120deg,${COR.roxo},${COR.laranja});padding:20px 24px">
            <span style="color:#fff;font-size:16px;font-weight:700">Alloyal Pulse</span>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 24px 8px;font-size:15px;line-height:1.5">
            ${saudacao}
            ${entrada.corpoHtml}
            ${acao}
          </td>
        </tr>
        ${rodape}
      </table>
      <p style="margin:16px 0 0;font-size:11px;color:${COR.tinta3}">Alloyal Pulse · operação interna</p>
    </td></tr>
  </table>
</body>
</html>`
}
