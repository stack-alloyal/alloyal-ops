import { calibracao, prontoParaPromover, MINIMO_PARA_TAXA } from '@ops/success'

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

const VEREDITO: Record<string, { rotulo: string; estado: string }> = {
  ok: { rotulo: 'dentro do estimado', estado: 'ok' },
  acima: { rotulo: 'acima do estimado', estado: 'falha' },
  abaixo: { rotulo: 'abaixo do estimado', estado: 'parcial' },
  sem_dados: { rotulo: 'sem itens ainda', estado: 'pendente' },
  sem_estimativa: { rotulo: 'volume não estimável', estado: 'pendente' },
}

export default async function Calibracao() {
  // Quem julga a promoção é quem responde pela fila do time.
  const id = await exigir((p) => p.configurar || p.fila === 'base', 'calibração dos gatilhos')
  const { contas, janelaDias, linhas } = await calibracao(pool())

  const emSombra = linhas.filter((l) => !l.promovido && l.itens > 0)
  const prontos = emSombra.filter((l) => prontoParaPromover(l).pronto)

  return (
    <section>
      <h1>Calibração dos gatilhos</h1>
      <p className="painel__resumo">
        {contas} contas · janela de {janelaDias} dias · {linhas.filter((l) => l.promovido).length} de{' '}
        {linhas.length} promovidos
        {prontos.length > 0 && (
          <>
            {' · '}
            <strong data-estado="ok">
              {prontos.length} pronto(s) para promover
            </strong>
          </>
        )}
      </p>

      <table className="painel__ciclos">
        <thead>
          <tr>
            <th>Gatilho</th>
            <th>Volume /100 contas</th>
            <th>Estimado</th>
            <th>Falso positivo</th>
            <th>Situação</th>
          </tr>
        </thead>
        <tbody>
          {linhas.map((l) => {
            const v = VEREDITO[l.veredito] ?? VEREDITO['sem_dados']!
            const p = prontoParaPromover(l)
            return (
              <tr key={l.gatilho}>
                <td>
                  <strong>{l.gatilho}</strong> · {l.familia}
                  <small>{l.proposito}</small>
                </td>
                <td className="num">
                  {l.porCemContas ?? '—'}
                  {l.itens > 0 && <small>{l.itens} itens</small>}
                </td>
                <td className="num">
                  {l.estimado ? `${l.estimado[0]}–${l.estimado[1]}` : '—'}
                  <small data-estado={v.estado}>{v.rotulo}</small>
                </td>
                <td className="num">
                  {/* Fração com poucos fechamentos é ruído: 1 em 3 vira "33%" e
                      reprova um gatilho bom. Dizer que falta base é mais honesto. */}
                  {l.taxaFalsoPositivo !== null ? (
                    <span data-estado={l.taxaFalsoPositivo > 0.2 ? 'falha' : 'ok'}>
                      {Math.round(l.taxaFalsoPositivo * 100)}%
                    </span>
                  ) : (
                    <span data-estado="pendente">—</span>
                  )}
                  <small>
                    {l.fechados} fechado(s)
                    {l.fechados < MINIMO_PARA_TAXA && l.itens > 0 && `, mínimo ${MINIMO_PARA_TAXA}`}
                  </small>
                </td>
                <td>
                  {/* Três estados distintos, e confundi-los esconde problema:
                      sem fonte é pipeline faltando; sem ocorrência é base boa. */}
                  {l.fonteAusente ? (
                    <span data-estado="pendente">aguardando {l.fonteAusente}</span>
                  ) : l.promovido && l.veredito === 'acima' ? (
                    /* Verde ao lado de "acima do estimado" na mesma linha é
                       sinal contraditório. Gatilho já promovido e fora da faixa
                       é exatamente o caso de recalibrar da tabela de riscos —
                       e ninguém o revisa se a tela disser que está tudo bem. */
                    <span data-estado="falha">
                      na fila do time · volume acima do estimado, revisar o limiar
                    </span>
                  ) : l.promovido ? (
                    <span data-estado="ok">na fila do time</span>
                  ) : l.itens === 0 ? (
                    <span data-estado="ok">implementado · nenhuma conta se enquadrou</span>
                  ) : p.pronto ? (
                    <span data-estado="ok">pronto para promover</span>
                  ) : (
                    <span data-estado="parcial">sombra · {p.porque}</span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <p className="painel__nota">
        A promoção é manual: ligar a flag <code>gatilho:G-xx</code> em{' '}
        <code>ops.feature_flag</code>. Esta tela mede e recomenda — não promove sozinha,
        porque o custo de promover um gatilho ruidoso é o time parar de confiar na fila
        inteira, e disso não se volta com um ajuste de limiar.
        {id.permissoes.configurar &&
          ' Rodando contra massa sintética, o volume aqui mede o gerador de dados, não a precisão do gatilho — o número que decide é o da base real.'}
      </p>
    </section>
  )
}
