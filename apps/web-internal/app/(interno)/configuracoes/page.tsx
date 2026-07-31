import { CATALOGO, POR_GRUPO, chavesOrfas, gravados, lerConfiguracao } from '@pulse/config'
import { Aviso, Badge, Btn, Card, Field } from '@pulse/ui'
import { KeyRound, ScrollText, Users } from 'lucide-react'
import Link from 'next/link'

import { salvarAjuste } from './acoes'
import { Corpo, Topo } from '../casca'
import { pool } from '../../../lib/db'
import { exigir } from '../../../lib/guarda'

export const dynamic = 'force-dynamic'

/**
 * Configurações — o que o admin muda sem chamar o dev.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ Cada campo mostra três coisas, e as três são necessárias:                  │
 * │                                                                            │
 * │   O EFEITO — o que muda na operação. Sem isso ninguém mexe (e o ajuste não  │
 * │   serve) ou alguém mexe sem saber (e o ajuste é pior que nada).             │
 * │                                                                            │
 * │   O LIMITE, com o motivo. "Valor inválido" faz a pessoa tentar às cegas.    │
 * │                                                                            │
 * │   SE ESTÁ NO PADRÃO ou foi mudado, por quem e quando. É o que responde "o   │
 * │   número piorou depois que mexeram" — e sem isso a calibração dos gatilhos  │
 * │   perde a única referência que tem.                                        │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * O motivo é opcional aqui e OBRIGATÓRIO em papel e segredo: mudar um limiar é
 * reversível e visível no número; mudar acesso não aparece em nenhum número.
 */
export default async function Configuracoes({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; erro?: string }>
}) {
  await exigir((p) => p.configurar, 'configuração da plataforma')
  const q = await searchParams
  const [efetiva, mudados, orfas] = await Promise.all([
    lerConfiguracao(pool()),
    gravados(pool()),
    chavesOrfas(pool()),
  ])

  const grupos = Object.keys(POR_GRUPO) as (keyof typeof POR_GRUPO)[]
  const quantosMudados = CATALOGO.filter((a) => mudados.has(a.chave)).length

  return (
    <>
      <Topo
        href="/configuracoes"
        acoes={
          <span className="flex items-center gap-3 text-[13px]">
            <Link
              href="/configuracoes/papeis"
              className="inline-flex items-center gap-1 font-semibold text-purple-700 hover:text-purple-500"
            >
              <Users className="h-[14px] w-[14px]" />
              Acessos
            </Link>
            <Link
              href="/configuracoes/segredos"
              className="inline-flex items-center gap-1 font-semibold text-purple-700 hover:text-purple-500"
            >
              <KeyRound className="h-[14px] w-[14px]" />
              Segredos
            </Link>
            <Link
              href="/configuracoes/historico"
              className="inline-flex items-center gap-1 font-semibold text-purple-700 hover:text-purple-500"
            >
              <ScrollText className="h-[14px] w-[14px]" />
              Histórico
            </Link>
            <span className="text-ink-2">
              {quantosMudados} de {CATALOGO.length} fora do padrão
            </span>
          </span>
        }
      />
      <Corpo className="grid gap-5">
        {q.erro && (
          <Aviso tom="erro" papel="alert">
            {q.erro}
          </Aviso>
        )}
        {q.ok && (
          <Aviso tom="ok" papel="status">
            {q.ok}
          </Aviso>
        )}

        {orfas.length > 0 && (
          /* Chave gravada que saiu do código. Não é erro nem some sozinha: quem
             configurou precisa saber que o valor está lá sem efeito nenhum. */
          <Aviso tom="alerta">
            {orfas.length} chave(s) gravada(s) que não existem mais no código:{' '}
            <strong className="font-semibold">{orfas.join(', ')}</strong>. Não têm efeito — o
            código que as lia foi removido.
          </Aviso>
        )}

        <p className="max-w-[80ch] text-[13px] leading-relaxed text-ink-2">
          Cada valor abaixo vale <strong className="font-semibold">na próxima rodada</strong> do
          worker — não é preciso reiniciar nada. Campo em branco não é zero: para voltar ao padrão,
          escreva o valor padrão que está indicado. Toda mudança fica no{' '}
          <Link href="/configuracoes/historico" className="font-semibold text-purple-700">
            histórico
          </Link>
          , com quem mudou e quando.
        </p>

        {grupos.map((g) => {
          const doGrupo = CATALOGO.filter((a) => a.grupo === g)
          if (doGrupo.length === 0) return null
          return (
            <Card key={g} title={POR_GRUPO[g]}>
              <div className="grid gap-5">
                {doGrupo.map((a) => {
                  const gravado = mudados.get(a.chave)
                  const atual = efetiva[a.chave]
                  return (
                    <form key={a.chave} action={salvarAjuste} className="grid gap-2">
                      <input type="hidden" name="chave" value={a.chave} />
                      <div className="flex flex-wrap items-baseline gap-2">
                        <strong className="text-[13.5px] font-bold text-ink">{a.rotulo}</strong>
                        <code className="text-[11.5px] text-ink-3">{a.chave}</code>
                        {gravado ? (
                          <Badge tone="indigo">
                            mudado por {gravado.por.split('@')[0]} em{' '}
                            {new Date(gravado.em).toLocaleDateString('pt-BR')}
                          </Badge>
                        ) : (
                          <Badge>no padrão</Badge>
                        )}
                      </div>

                      <p className="max-w-[80ch] text-[13px] leading-relaxed text-ink-2">
                        {a.efeito}
                      </p>

                      <div className="flex flex-wrap items-end gap-3">
                        <div className="w-[9em]">
                          <Field
                            label={a.unidade ?? 'valor'}
                            name="valor"
                            defaultValue={String(atual)}
                            inputMode={a.tipo === 'fracao' ? 'decimal' : 'numeric'}
                            required
                          />
                        </div>
                        <div className="min-w-[20em] flex-1">
                          <Field
                            label="Motivo (opcional, mas ajuda quem for comparar depois)"
                            name="motivo"
                            placeholder="ex.: fila estourando no time do Sudeste"
                          />
                        </div>
                        <Btn type="submit">Salvar</Btn>
                      </div>

                      <p className="text-[12px] text-ink-3">
                        Padrão <strong className="font-semibold">{String(a.padrao)}</strong>
                        {a.minimo !== undefined && ` · mínimo ${a.minimo}`}
                        {a.maximo !== undefined && ` · máximo ${a.maximo}`}
                        {a.porQueOLimite && ` — ${a.porQueOLimite}`}
                      </p>
                    </form>
                  )
                })}
              </div>
            </Card>
          )
        })}
      </Corpo>
    </>
  )
}
