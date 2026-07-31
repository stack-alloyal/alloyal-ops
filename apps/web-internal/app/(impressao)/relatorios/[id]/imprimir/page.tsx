import { listarRelatorios, type ConteudoRelatorio } from '@ops/success'
import { AlloyalLogo, RelatorioCliente } from '@ops/ui'
import { notFound } from 'next/navigation'

import { pool } from '../../../../../lib/db'
import { exigir, temEscopo } from '../../../../../lib/guarda'
import { uuidOu404 } from '../../../../../lib/parametro'

export const dynamic = 'force-dynamic'

/**
 * A versão de impressão do relatório — a que vira PDF.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ Paridade LITERAL com a tela: é o mesmo React, o mesmo componente, o mesmo  │
 * │ DOM. Não existe um segundo renderizador que possa divergir.                │
 * │                                                                           │
 * │ A ideia original era `renderToStaticMarkup` num pacote e Chromium imprimindo│
 * │ o HTML gerado. O Next recusa `react-dom/server` em código da aplicação, e a │
 * │ recusa é transitiva. A saída óbvia — escrever um segundo renderizador só    │
 * │ para o PDF — é exatamente o que o requisito proíbe. Imprimir esta PÁGINA    │
 * │ resolve melhor: o caminho de divergência deixa de existir.                 │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Sem casca, sem navegação, sem link. O que sai daqui é o que o cliente lê, e todo
 * elemento de operação interna que sobrasse na página apareceria no PDF.
 */

const IMPRESSAO = `
  @page { size: A4; margin: 16mm 14mm; }
  /* O token, e não um branco cravado: a tela usa \`--bg\` (cinza claro) e o papel quer
     branco puro, que é exatamente o que \`--surface\` já significa. Um hex aqui deixaria
     esta página de fora de qualquer mudança de paleta. */
  html, body { background: var(--surface) !important; }
  @media print {
    .ops-so-tela { display: none !important; }
    section, li, table { break-inside: avoid; }
  }
  /* Um relatório de uma página cabe em A4; o que passar quebra em blocos inteiros. */
  .ops-folha { max-width: 190mm; margin: 0 auto; padding: 10mm 0; }
  /* Duas linhas reservadas para todo rótulo: no A4 os cartões ficam estreitos, e um
     rótulo que quebra empurra só o seu número para baixo — os três desalinham. */
  .ops-folha [data-rotulo] { min-height: 2.2em; }
`

export default async function Imprimir({ params }: { params: Promise<{ id: string }> }) {
  const identidade = await exigir((p) => temEscopo(p.contas), 'relatório do cliente')
  const { id: idBruto } = await params
  // Formato antes da consulta: id torto virava 500, e 500 previsível esconde o real.
  const id = uuidOu404(idBruto)

  // Pela lista, que já aplica o recorte de carteira: uma leitura por id que ignore o
  // recorte seria um caminho paralelo, e é assim que alguém imprime o relatório de
  // outra carteira pela URL.
  const todos = await listarRelatorios(pool(), identidade)
  const r = todos.find((x) => x.id === id)
  if (!r) notFound()

  const c = r.conteudo as ConteudoRelatorio | null
  if (!c) notFound()

  return (
    <>
      {/* A folha de impressão vai inline: ela é específica desta página e não deve
          entrar no bundle das outras — e `@page` não funciona por classe utilitária. */}
      <style dangerouslySetInnerHTML={{ __html: IMPRESSAO }} />
      <div className="ops-folha">
        <header className="mb-6 flex items-baseline justify-between border-b-2 border-ink pb-2">
          <AlloyalLogo className="h-6" />
          <span className="text-[12px] text-ink-2">
            {c.razaoSocial} · {c.competencia.slice(0, 7)}
          </span>
        </header>

        <RelatorioCliente conteudo={c} frase={r.fraseFinal ?? r.fraseGerada} />

        <footer className="mt-6 border-t border-line pt-2 text-[10px] leading-relaxed text-ink-3">
          Relatório gerado pelo Alloyal Ops
          {r.enviadoEm && ` e enviado em ${new Date(r.enviadoEm).toLocaleDateString('pt-BR')}`}. Os
          números refletem o fechamento da competência e não são recalculados depois do envio.
        </footer>

        {/* Só na tela: instrução para quem abriu a página, que não deve sair no PDF. */}
        <p className="ops-so-tela mt-8 rounded-md border border-dashed border-line-strong bg-surface-2 p-3 text-[12.5px] text-ink-2">
          Esta é a versão de impressão. Use <strong className="font-semibold">Ctrl+P</strong> (ou
          Cmd+P) e salve como PDF para anexar ao e-mail. É o mesmo componente da tela do relatório —
          o que você vê aqui é o que o cliente recebe.
        </p>
      </div>
    </>
  )
}
