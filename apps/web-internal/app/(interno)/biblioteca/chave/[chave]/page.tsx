import { historico } from '@ops/success'
import { Aviso, Badge, Btn, Card } from '@ops/ui'
import { notFound } from 'next/navigation'

import { acaoDespublicar, acaoPublicar } from '../../acoes'
import { Corpo, Topo } from '../../../casca'
import { pool } from '../../../../../lib/db'
import { exigir } from '../../../../../lib/guarda'

export const dynamic = 'force-dynamic'

/**
 * O histórico de versões de uma chave — o que o T11 pede por escrito.
 *
 * A tela existe para responder duas perguntas: qual é o processo hoje, e como ele
 * chegou aqui. A segunda é o que permite discutir uma mudança sem depender da
 * memória de quem estava na reunião.
 */

const DATA = (s: string | null) =>
  s === null ? '—' : new Date(s).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })

export default async function Chave({
  params,
  searchParams,
}: {
  params: Promise<{ chave: string }>
  searchParams: Promise<{ ok?: string; erro?: string }>
}) {
  await exigir((p) => p.configurar, 'biblioteca de playbooks')
  const { chave } = await params
  const q = await searchParams
  const versoes = await historico(pool(), decodeURIComponent(chave))
  if (versoes.length === 0) notFound()

  const vigente = versoes.find((v) => v.estado === 'vigente')

  return (
    <>
      <Topo
        href="/biblioteca"
        titulo={vigente?.titulo ?? versoes[0]!.titulo}
        proposito={decodeURIComponent(chave)}
        acoes={
          vigente ? (
            <form action={acaoDespublicar}>
              <input type="hidden" name="chave" value={vigente.chave} />
              {/* Playbook errado no ar é pior que nenhum, e esperar a substituta
                  ficar pronta é a escolha errada sob pressão. */}
              <Btn type="submit" variant="ghost">
                Tirar do ar
              </Btn>
            </form>
          ) : (
            <Badge tone="amber">nada no ar</Badge>
          )
        }
      />
      <Corpo className="grid gap-4">
        {q.erro && <Aviso tom="erro" papel="alert">{q.erro}</Aviso>}
        {q.ok && <Aviso tom="ok" papel="status">{q.ok}</Aviso>}

        {!vigente && (
          <Aviso tom="alerta">
            Nenhuma versão desta chave está no ar. Itens de trabalho dos gatilhos dela nascem sem
            playbook anexado — o gatilho continua funcionando, mas o CSM improvisa a resposta.
          </Aviso>
        )}

        {versoes.map((v) => (
          <Card
            key={v.id}
            title={
              <span className="flex items-center gap-2">
                Versão {v.versao}
                {v.estado === 'vigente' && <Badge tone="green">no ar</Badge>}
                {v.estado === 'rascunho' && <Badge tone="amber">rascunho</Badge>}
                {v.estado === 'aposentada' && <Badge>aposentada</Badge>}
              </span>
            }
            actions={
              v.estado === 'vigente' ? undefined : (
                <form action={acaoPublicar}>
                  <input type="hidden" name="id" value={v.id} />
                  <Btn type="submit">
                    {v.estado === 'aposentada' ? 'Voltar ao ar' : 'Publicar'}
                  </Btn>
                </form>
              )
            }
          >
            <p className="text-[13.5px] font-semibold text-ink">{v.titulo}</p>
            {/* `whitespace-pre-wrap`: o processo foi escrito com quebras de linha
                de propósito, e um passo por linha é o que o CSM lê no meio de uma
                ligação. Reflow apagaria a estrutura que a pessoa escreveu. */}
            <p className="mt-2 whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink-2">
              {v.conteudo}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[11.5px] text-ink-3">
              {v.gatilhos.map((g) => (
                <Badge key={g}>{g}</Badge>
              ))}
              <span>criada {DATA(v.criadoEm)}</span>
              {v.publicadoPor && (
                <span>
                  · publicada por {v.publicadoPor} em {DATA(v.publicadoEm)}
                </span>
              )}
              {v.substituidoEm && <span>· saiu do ar {DATA(v.substituidoEm)}</span>}
            </div>
          </Card>
        ))}
      </Corpo>
    </>
  )
}
