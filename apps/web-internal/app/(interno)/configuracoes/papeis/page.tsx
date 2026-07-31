import { PAPEIS, PERMISSOES, type Papel, type Permissoes } from '@pulse/auth'
import { listarPessoas } from '@pulse/config'
import { Aviso, Badge, Btn, Card, Field, Select, Table } from '@pulse/ui'
import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'

import { darPapel, tirarPapel } from '../acoes'
import { Corpo, Topo } from '../../casca'
import { pool } from '../../../../lib/db'
import { exigir } from '../../../../lib/guarda'

export const dynamic = 'force-dynamic'

/**
 * Acessos — quem tem o quê, e o que isso significa de fato.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ A tela mostra as permissões EFETIVAS, já com a união dos papéis aplicada,   │
 * │ e não a lista de papéis para o leitor somar de cabeça. Papel duplo é        │
 * │ exatamente onde alguém erra ao estimar o acesso de outra pessoa: quem tem    │
 * │ `pulse-csm` + `pulse-financeiro` vê a base toda, e ninguém deduz isso lendo     │
 * │ "csm, financeiro".                                                         │
 * │                                                                            │
 * │ E mostra a matriz de referência ao lado. Sem ela, "aprovaDistrato: cs" é    │
 * │ um valor que só quem leu o código entende.                                 │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Motivo é obrigatório nas duas operações. Mudança de acesso não aparece em número
 * nenhum: se não estiver escrita, ninguém consegue explicá-la numa auditoria.
 */

const ESCOPO: Record<string, string> = {
  nenhum: 'nada',
  carteira: 'a carteira dele',
  base: 'a base toda',
}

const DISTRATO: Record<string, string> = {
  nao: '—',
  cs: 'CS',
  financeiro: 'Financeiro',
}

/** As permissões em texto que uma pessoa não-técnica lê. */
function comoFrase(p: Permissoes): string {
  const partes = [
    `contas: ${ESCOPO[p.contas] ?? p.contas}`,
    `fila: ${ESCOPO[p.fila] ?? p.fila}`,
    `receita: ${ESCOPO[p.receita] ?? p.receita}`,
  ]
  if (p.configurar) partes.push('configura a plataforma')
  if (p.aprovaDistrato !== 'nao') partes.push(`aprova distrato (${DISTRATO[p.aprovaDistrato]})`)
  if (p.dadoIndividual) partes.push('vê dado individual (auditado)')
  return partes.join(' · ')
}

export default async function Acessos({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; erro?: string }>
}) {
  const eu = await exigir((p) => p.configurar, 'gestão de acessos')
  const q = await searchParams
  const pessoas = await listarPessoas(pool())

  const admins = pessoas.filter((p) => p.permissoes.configurar)
  const semPapelUtil = pessoas.filter((p) => p.papeis.length === 0)

  return (
    <>
      <Topo
        href="/configuracoes"
        titulo="Acessos"
        proposito="quem vê o quê, e desde quando"
        acoes={
          <Link
            href="/configuracoes"
            className="inline-flex items-center gap-1 text-[13px] font-semibold text-purple-700 hover:text-purple-500"
          >
            <ArrowLeft className="h-[14px] w-[14px]" />
            Configurações
          </Link>
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

        {admins.length === 1 && (
          /* Um administrador só é ponto único de falha: se essa pessoa sair de férias
             sem passar o acesso, ninguém consegue conceder acesso a mais ninguém. */
          <Aviso tom="alerta">
            Só <strong className="font-semibold">{admins[0]?.email}</strong> pode configurar a
            plataforma. Com uma pessoa só, férias ou saída dela travam qualquer mudança de acesso —
            e o conserto volta a ser SQL manual no banco.
          </Aviso>
        )}

        {semPapelUtil.length > 0 && (
          <Aviso tom="alerta">
            {semPapelUtil.length} pessoa(s) sem papel válido:{' '}
            {semPapelUtil.map((p) => p.email).join(', ')}. Elas autenticam e não veem nada.
          </Aviso>
        )}

        <Card title={`Pessoas com acesso · ${pessoas.length}`}>
          <Table
            cols={['Pessoa', 'Papéis', 'O que isso dá', 'Desde', '']}
            vazio={
              <>
                Nenhuma pessoa cadastrada. Sem papel, quem autentica pelo Google vê a tela de
                permissão — não um erro.
              </>
            }
            rows={pessoas.map((p) => [
              <>
                <span className="font-semibold text-ink">{p.email.split('@')[0]}</span>
                <span className="text-ink-3">@{p.email.split('@')[1]}</span>
                {p.email === eu.email && (
                  <span className="ml-2 text-[11.5px] text-ink-3">(você)</span>
                )}
              </>,
              <span className="flex flex-wrap gap-1">
                {p.papeis.map((papel) => (
                  <Badge key={papel} tone={PERMISSOES[papel].configurar ? 'indigo' : 'slate'}>
                    {papel.replace('ops-', '')}
                  </Badge>
                ))}
              </span>,
              /* O resultado EFETIVO, não a soma para o leitor fazer. */
              <span className="text-[12.5px] text-ink-2">{comoFrase(p.permissoes)}</span>,
              <span className="text-[12.5px] tabular-nums text-ink-3">
                {p.concedidoEm ? new Date(p.concedidoEm).toLocaleDateString('pt-BR') : '—'}
                {/* NULL aqui se lê como "não sabemos", que é a verdade das linhas
                    semeadas antes de existir trilha — e não como "o sistema deu". */}
                {p.concedidoPor.every((x) => x === null) && (
                  <span className="mt-0.5 block text-[11px] text-ink-4">origem não registrada</span>
                )}
              </span>,
              <details className="text-[12.5px]">
                <summary className="cursor-pointer select-none text-ink-3 hover:text-ink-2">
                  remover papel
                </summary>
                <div className="mt-2 grid gap-2">
                  {p.papeis.map((papel) => (
                    <form key={papel} action={tirarPapel} className="flex flex-wrap items-end gap-2">
                      <input type="hidden" name="email" value={p.email} />
                      <input type="hidden" name="papel" value={papel} />
                      <div className="min-w-[16em] flex-1">
                        <Field
                          label={`Motivo para tirar ${papel.replace('ops-', '')}`}
                          name="motivo"
                          minLength={10}
                          required
                          placeholder="ex.: saiu da empresa em 31/07"
                        />
                      </div>
                      <Btn type="submit" variant="danger">
                        Remover
                      </Btn>
                    </form>
                  ))}
                </div>
              </details>,
            ])}
          />
        </Card>

        <Card title="Dar acesso a alguém">
          <form action={darPapel} className="grid gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="E-mail @alloyal.com.br"
                name="email"
                type="email"
                required
                placeholder="nome.sobrenome@alloyal.com.br"
              />
              <Select label="Papel" name="papel" required>
                {PAPEIS.map((p) => (
                  <option key={p} value={p}>
                    {p.replace('ops-', '')} — {comoFrase(PERMISSOES[p as Papel])}
                  </option>
                ))}
              </Select>
            </div>
            <Field
              label="Motivo (obrigatório)"
              name="motivo"
              minLength={10}
              required
              placeholder="ex.: entrou no time de CS em 01/08, carteira do Sudeste"
            />
            <div className="flex flex-wrap items-center gap-3">
              <Btn type="submit">Conceder</Btn>
              <span className="text-[12.5px] text-ink-3">
                O papel aqui decide o que a pessoa vê DEPOIS de entrar. Quem autoriza a entrada
                continua sendo o grupo <code className="text-[11.5px]">pulse-*</code> no Google
                Workspace — as duas coisas são separadas de propósito, para dar ou tirar acesso a
                uma tela sem mexer no grupo.
              </span>
            </div>
          </form>
        </Card>

        <Card title="A matriz de referência">
          {/* Sem isto, "aprovaDistrato: cs" é um valor que só quem leu o código
              entende — e quem concede acesso não é quem leu o código. */}
          <Table
            cols={['Papel', 'Contas', 'Fila', 'Receita', 'Configura', 'Distrato', 'Individual']}
            rows={PAPEIS.map((p) => {
              const perm = PERMISSOES[p as Papel]
              return [
                <span className="font-semibold">{p.replace('ops-', '')}</span>,
                <span className="text-[12.5px]">{ESCOPO[perm.contas]}</span>,
                <span className="text-[12.5px]">{ESCOPO[perm.fila]}</span>,
                <span className="text-[12.5px]">{ESCOPO[perm.receita]}</span>,
                perm.configurar ? <Badge tone="indigo">sim</Badge> : <span className="text-ink-4">—</span>,
                perm.aprovaDistrato === 'nao' ? (
                  <span className="text-ink-4">—</span>
                ) : (
                  <Badge tone="amber">{DISTRATO[perm.aprovaDistrato]}</Badge>
                ),
                perm.dadoIndividual ? (
                  <Badge tone="red">auditado</Badge>
                ) : (
                  <span className="text-ink-4">—</span>
                ),
              ]
            })}
          />
          <p className="mt-3 max-w-[80ch] text-[13px] leading-relaxed text-ink-2">
            Papéis se somam pelo <strong className="font-semibold">maior</strong> escopo: quem tem
            dois papéis fica com o acesso mais amplo de cada linha, não com a média. É por isso que a
            coluna “o que isso dá” da tabela de cima mostra o resultado e não os papéis.
          </p>
        </Card>
      </Corpo>
    </>
  )
}
