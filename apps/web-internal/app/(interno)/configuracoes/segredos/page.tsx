import { chaveMestraConfigurada } from '@pulse/auth'
import { INTEGRACAO_DA_CHAVE, INTEGRACOES_SONDAVEIS, SEGREDOS, listarSegredos } from '@pulse/config'
import { Aviso, Badge, Btn, Card, Field } from '@pulse/ui'
import { ArrowLeft, Lock, PlugZap } from 'lucide-react'
import Link from 'next/link'

import { removerSegredo, salvarSegredo, verificarConexao } from '../acoes'
import { Topo } from '../../casca'
import { CorpoDeConfiguracao } from '../submenu'
import { pool } from '../../../../lib/db'
import { exigir } from '../../../../lib/guarda'

export const dynamic = 'force-dynamic'

/**
 * Segredos de integração — cadastrar sem nunca ler de volta.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ Não existe caminho nesta tela que mostre um token. Não é omissão de         │
 * │ funcionalidade: exibir um segredo "para conferir" é o caminho pelo qual ele │
 * │ acaba num print de tela, num compartilhamento de janela numa reunião, ou no │
 * │ cache do navegador de uma máquina compartilhada.                           │
 * │                                                                            │
 * │ Para saber QUAL token está lá, a tela mostra as 4 últimas letras. Quatro dá │
 * │ para confirmar "é o que eu cadastrei" e não dá para reconstruir. Quem       │
 * │ precisa conferir o valor inteiro troca o valor — é mais rápido e não vaza.  │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * O `pulse_portal` não tem GRANT nenhum nesta tabela, e o `pulse_api` (que serve esta
 * tela) tem INSERT/UPDATE/DELETE mas NÃO tem SELECT do valor cifrado. Um defeito de
 * código aqui não consegue devolver token nem por acidente.
 */
export default async function Segredos({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; erro?: string }>
}) {
  await exigir((p) => p.configurar, 'segredos de integração')
  const q = await searchParams
  const gravados = await listarSegredos(pool())
  const porChave = new Map(gravados.map((g) => [g.chave, g]))
  const temChave = chaveMestraConfigurada()

  const faltando = SEGREDOS.filter((s) => !porChave.has(s.chave))
  const irrecuperaveisFaltando = faltando.filter((s) => s.irrecuperavel)

  return (
    <>
      <Topo
        href="/configuracoes"
        titulo="Segredos de integração"
        proposito="cifrados no banco, nunca exibidos"
        acoes={
          <span className="flex items-center gap-3 text-[13px]">
            <span className="text-ink-2">
              {gravados.length} de {SEGREDOS.length} cadastrados
            </span>
            <Link
              href="/configuracoes"
              className="inline-flex items-center gap-1 font-semibold text-purple-700 hover:text-purple-500"
            >
              <ArrowLeft className="h-[14px] w-[14px]" />
              Configurações
            </Link>
          </span>
        }
      />
      <CorpoDeConfiguracao atual="/configuracoes/segredos">
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

        {!temChave && (
          /* Sem a chave mestra nada pode ser gravado. Dizer isso ANTES de a pessoa
             colar um token é o que evita ela achar que o token foi aceito. */
          <Aviso tom="erro" papel="alert">
            <strong className="font-semibold">PULSE_CHAVE_MESTRA não está configurada</strong> nesta
            instância. Nenhum segredo pode ser gravado nem usado até ela existir. Gere com{' '}
            <code className="rounded bg-surface px-1 py-0.5 text-[12px]">openssl rand -base64 32</code>{' '}
            e guarde no SOPS (<code className="text-[12px]">infra/secrets</code>) — nunca no
            repositório em texto claro.
          </Aviso>
        )}

        {irrecuperaveisFaltando.length > 0 && (
          /* Estes são os que custam por DIA de espera, e o custo não é reversível.
             Um aviso genérico de "faltam segredos" trataria isso como igual ao resto. */
          <Aviso tom="erro">
            <strong className="font-semibold">
              {irrecuperaveisFaltando.length} segredo(s) cuja ausência causa perda irrecuperável:
            </strong>{' '}
            {irrecuperaveisFaltando.map((s) => s.chave).join(', ')}. Cada dia sem eles é histórico
            que não vai existir depois — não é atraso, é perda.
          </Aviso>
        )}

        <p className="max-w-[80ch] text-[13px] leading-relaxed text-ink-2">
          Os valores são cifrados com AES-256-GCM antes de tocar o banco, com chave que vive fora
          dele. <strong className="font-semibold">Nenhuma tela mostra um segredo de volta</strong> —
          nem esta. Para confirmar qual valor está gravado, compare as 4 últimas letras; para trocar,
          cole o novo.
        </p>

        {/* O teste por INTEGRAÇÃO e não por segredo: a credencial do CleverTap são três
            campos, e testar um sozinho não diz nada. Quem lê a tela pensa em "o
            CleverTap está funcionando?", não em "o passcode está certo?". */}
        <Card title="Testar as conexões agora">
          <div className="flex flex-wrap items-center gap-3">
            {INTEGRACOES_SONDAVEIS.map((i) => {
              const chaves = SEGREDOS.filter((s) => INTEGRACAO_DA_CHAVE[s.chave] === i)
              const cadastradas = chaves.filter((s) => porChave.has(s.chave)).length
              return (
                <form key={i} action={verificarConexao}>
                  <input type="hidden" name="integracao" value={i} />
                  <Btn type="submit" variant="ghost">
                    <PlugZap className="mr-1 inline h-[14px] w-[14px]" />
                    {i} · {cadastradas}/{chaves.length}
                  </Btn>
                </form>
              )
            })}
          </div>
          <p className="mt-3 max-w-[80ch] text-[13px] leading-relaxed text-ink-2">
            A sonda faz a menor leitura possível na API do fornecedor e diz o que ele
            respondeu. Ela distingue <strong className="font-semibold">token recusado</strong>{' '}
            de <strong className="font-semibold">fornecedor fora do ar</strong> — as duas
            pedem ações opostas, e &ldquo;falhou&rdquo; sem a distinção faz alguém trocar um
            token que estava certo.
          </p>
        </Card>

        <div className="grid gap-4">
          {SEGREDOS.map((s) => {
            const g = porChave.get(s.chave)
            return (
              <Card
                key={s.chave}
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    {s.rotulo}
                    {g ? (
                      <Badge tone="green">
                        <Lock className="mr-1 inline h-[11px] w-[11px]" />
                        cadastrado · termina em {g.dica}
                      </Badge>
                    ) : s.irrecuperavel ? (
                      <Badge tone="red">faltando · perda irrecuperável</Badge>
                    ) : (
                      <Badge tone="amber">faltando</Badge>
                    )}
                  </span>
                }
              >
                <div className="grid gap-3">
                  <p className="max-w-[80ch] text-[13px] leading-relaxed text-ink-2">
                    <strong className="font-semibold">Sem ele:</strong> {s.semEle}
                  </p>
                  {s.irrecuperavel && (
                    <p className="max-w-[80ch] rounded-md border border-red/30 bg-red-50 px-3 py-2 text-[12.5px] leading-relaxed text-red">
                      {s.irrecuperavel}
                    </p>
                  )}
                  <p className="text-[12.5px] text-ink-3">
                    <strong className="font-semibold">Onde conseguir:</strong> {s.ondeConseguir}
                  </p>

                  {g && (
                    <p className="text-[12px] tabular-nums text-ink-3">
                      Gravado por {g.por} em {new Date(g.em).toLocaleString('pt-BR')} ·{' '}
                      {/* "nunca usado" num segredo cadastrado há semanas é o sinal de que
                          o ciclo que deveria usá-lo não está rodando. */}
                      {g.usadoEm
                        ? `usado pela última vez em ${new Date(g.usadoEm).toLocaleString('pt-BR')}`
                        : 'nunca usado por nenhum ciclo'}
                    </p>
                  )}

                  <form action={salvarSegredo} className="flex flex-wrap items-end gap-3">
                    <input type="hidden" name="chave" value={s.chave} />
                    <div className="min-w-[22em] flex-1">
                      <Field
                        label={g ? 'Novo valor (substitui o atual)' : 'Valor'}
                        name="valor"
                        // `type="password"` para não ficar legível na tela de quem está
                        // com o navegador projetado numa reunião.
                        type="password"
                        autoComplete="off"
                        minLength={8}
                        required
                        placeholder="cole o valor aqui"
                        disabled={!temChave}
                      />
                    </div>
                    <div className="min-w-[18em] flex-1">
                      <Field
                        label="Motivo (obrigatório)"
                        name="motivo"
                        minLength={10}
                        required
                        placeholder={g ? 'ex.: rotação trimestral' : 'ex.: primeira configuração'}
                        disabled={!temChave}
                      />
                    </div>
                    <Btn type="submit" disabled={!temChave}>
                      {g ? 'Substituir' : 'Gravar'}
                    </Btn>
                  </form>

                  {g && (
                    <details className="text-[12.5px]">
                      <summary className="cursor-pointer select-none text-ink-3 hover:text-ink-2">
                        apagar este segredo
                      </summary>
                      <form action={removerSegredo} className="mt-2 flex flex-wrap items-end gap-2">
                        <input type="hidden" name="chave" value={s.chave} />
                        <div className="min-w-[18em] flex-1">
                          <Field
                            label="Motivo (obrigatório)"
                            name="motivo"
                            minLength={10}
                            required
                            placeholder="ex.: integração desativada, conta encerrada no fornecedor"
                          />
                        </div>
                        <Btn type="submit" variant="danger">
                          Apagar
                        </Btn>
                      </form>
                      <p className="mt-2 max-w-[70ch] text-[12px] text-ink-3">
                        Apagar não desfaz o que a integração já capturou, e a trilha guarda que o
                        segredo existiu — mas o ciclo que dependia dele para de rodar na próxima
                        execução.
                      </p>
                    </details>
                  )}
                </div>
              </Card>
            )
          })}
        </div>
      </CorpoDeConfiguracao>
    </>
  )
}
