import { calibracao, prontoParaPromover, MINIMO_PARA_TAXA } from '@ops/success'
import { Badge, Card, Table, cn } from '@ops/ui'

import { Corpo, Topo } from '../casca'
import { pool } from '../../lib/db'
import { exigir } from '../../lib/guarda'

export const dynamic = 'force-dynamic'

/**
 * Calibração dos gatilhos — onde a liderança decide a promoção.
 *
 * O modo sombra dura 14 dias e termina numa DECISÃO. Sem esta tela, a decisão
 * seria uma impressão de quem não abriu os itens; com ela, é a comparação entre
 * o volume que o gatilho produz e o volume que o PRD estimou antes de existir
 * código, mais a taxa de falso positivo que só o time fechando itens produz.
 *
 * A tela não promove nada sozinha. Ela diz "pronto" ou diz por que não — e a
 * flag continua sendo ligada à mão, por uma pessoa, deliberadamente.
 */

const VEREDITO: Record<
  string,
  { rotulo: string; tom: 'green' | 'red' | 'amber' | 'slate' }
> = {
  ok: { rotulo: 'dentro do estimado', tom: 'green' },
  acima: { rotulo: 'acima do estimado', tom: 'red' },
  abaixo: { rotulo: 'abaixo do estimado', tom: 'amber' },
  sem_dados: { rotulo: 'sem itens ainda', tom: 'slate' },
  sem_estimativa: { rotulo: 'volume não estimável', tom: 'slate' },
}

export default async function Calibracao() {
  // Quem julga a promoção é quem responde pela fila do time.
  const id = await exigir((p) => p.configurar || p.fila === 'base', 'calibração dos gatilhos')
  const { contas, janelaDias, linhas } = await calibracao(pool())

  const emSombra = linhas.filter((l) => !l.promovido && l.itens > 0)
  const prontos = emSombra.filter((l) => prontoParaPromover(l).pronto)
  const promovidos = linhas.filter((l) => l.promovido).length

  return (
    <>
      <Topo
        href="/gatilhos"
        acoes={
          <span className="text-[13px] text-ink-2">
            {contas} contas · janela de {janelaDias} d · {promovidos} de {linhas.length} promovidos
            {prontos.length > 0 && (
              <>
                {' · '}
                <strong className="font-semibold text-green">
                  {prontos.length} pronto(s) para promover
                </strong>
              </>
            )}
          </span>
        }
      />
      <Corpo className="grid gap-5">
        <Card>
          <Table
            cols={['Gatilho', 'Volume /100 contas', 'Estimado', 'Falso positivo', 'Situação']}
            rows={linhas.map((l) => {
              const v = VEREDITO[l.veredito] ?? VEREDITO['sem_dados']!
              const p = prontoParaPromover(l)
              return [
                <>
                  <span className="font-semibold">{l.gatilho}</span>
                  <span className="text-ink-3"> · {l.familia}</span>
                  <span className="mt-0.5 block max-w-[46ch] text-[12px] text-ink-3">
                    {l.proposito}
                  </span>
                </>,
                <>
                  <span className="tabular-nums">{l.porCemContas ?? '—'}</span>
                  {l.itens > 0 && (
                    <span className="mt-0.5 block text-[11.5px] text-ink-3">{l.itens} itens</span>
                  )}
                </>,
                <>
                  <span className="tabular-nums">
                    {l.estimado ? `${l.estimado[0]}–${l.estimado[1]}` : '—'}
                  </span>
                  <span className="mt-1 block">
                    <Badge tone={v.tom}>{v.rotulo}</Badge>
                  </span>
                </>,
                <>
                  {/* Fração com poucos fechamentos é ruído: 1 em 3 vira "33%" e
                      reprova um gatilho bom. Dizer que falta base é mais honesto. */}
                  <span
                    className={cn(
                      'tabular-nums',
                      l.taxaFalsoPositivo !== null && l.taxaFalsoPositivo > 0.2
                        ? 'font-semibold text-red'
                        : l.taxaFalsoPositivo !== null
                          ? 'text-green'
                          : 'text-ink-3',
                    )}
                  >
                    {l.taxaFalsoPositivo !== null
                      ? `${Math.round(l.taxaFalsoPositivo * 100)}%`
                      : '—'}
                  </span>
                  <span className="mt-0.5 block text-[11.5px] text-ink-3">
                    {l.fechados} fechado(s)
                    {l.fechados < MINIMO_PARA_TAXA &&
                      l.itens > 0 &&
                      `, mínimo ${MINIMO_PARA_TAXA}`}
                  </span>
                </>,
                /* Três estados distintos, e confundi-los esconde problema: sem
                   fonte é pipeline faltando; sem ocorrência é base boa. */
                l.fonteAusente ? (
                  <span className="text-[12.5px] text-ink-3">aguardando {l.fonteAusente}</span>
                ) : l.promovido && l.veredito === 'acima' ? (
                  /* Verde ao lado de "acima do estimado" na mesma linha é sinal
                     contraditório. Gatilho já promovido e fora da faixa é
                     exatamente o caso de recalibrar da tabela de riscos — e
                     ninguém o revisa se a tela disser que está tudo bem. */
                  <span className="text-[12.5px] font-semibold text-red">
                    na fila do time · volume acima do estimado, revisar o limiar
                  </span>
                ) : l.promovido ? (
                  <Badge tone="green">na fila do time</Badge>
                ) : l.itens === 0 ? (
                  <span className="text-[12.5px] text-ink-2">
                    implementado · nenhuma conta se enquadrou
                  </span>
                ) : p.pronto ? (
                  <Badge tone="green">pronto para promover</Badge>
                ) : (
                  <span className="text-[12.5px] text-amber-700">sombra · {p.porque}</span>
                ),
              ]
            })}
          />
        </Card>

        <p className="max-w-[80ch] text-[13px] leading-relaxed text-ink-2">
          A promoção é manual: ligar a flag{' '}
          <code className="rounded bg-surface-2 px-1 py-0.5 text-[12px]">gatilho:G-xx</code> em{' '}
          <code className="rounded bg-surface-2 px-1 py-0.5 text-[12px]">ops.feature_flag</code>.
          Esta tela mede e recomenda — não promove sozinha, porque o custo de promover um gatilho
          ruidoso é o time parar de confiar na fila inteira, e disso não se volta com um ajuste de
          limiar.
          {id.permissoes.configurar &&
            ' Rodando contra massa sintética, o volume aqui mede o gerador de dados, não a precisão do gatilho — o número que decide é o da base real.'}
        </p>
      </Corpo>
    </>
  )
}
