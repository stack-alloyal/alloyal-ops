import { listarPessoas } from '@pulse/config'
import { Aviso, Badge, Btn, Card, Field, Table } from '@pulse/ui'
import { ArrowLeft, ShieldCheck } from 'lucide-react'
import Link from 'next/link'

import { alternarAcesso, cadastrarPessoa } from '../acoes'
import { Topo } from '../../casca'
import { CorpoDeConfiguracao } from '../submenu'
import { exigir } from '../../../../lib/guarda'
import { pool } from '../../../../lib/db'

export const dynamic = 'force-dynamic'

/**
 * Gestão de usuários, no padrão do `Usuarios.tsx` do Publi.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ DUAS TELAS, E NÃO UMA — a divisão é deliberada:                            │
 * │                                                                            │
 * │   /configuracoes/usuarios  QUEM existe: nome, e-mail, acesso ativo         │
 * │   /configuracoes/papeis    O QUE cada um vê: papel e permissão efetiva     │
 * │                                                                            │
 * │ São perguntas diferentes e ritmos diferentes. Suspender alguém que saiu de  │
 * │ férias é urgente e não deve exigir navegar por uma matriz de permissão;     │
 * │ revisar quem enxerga receita é auditoria, e não deve ficar ao lado de um    │
 * │ botão de suspender. O Publi separa igual.                                  │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ O QUE NÃO VEIO DO PUBLI: "reenviar convite".                               │
 * │                                                                            │
 * │ Lá o cadastro dispara e-mail de convite. Aqui a porta é o SSO do Google:    │
 * │ não existe convite para reenviar — a pessoa entra com a conta corporativa e │
 * │ o que decide o acesso é o papel. Um botão "reenviar convite" que não manda  │
 * │ convite nenhum seria pior que a ausência dele.                             │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export default async function Usuarios({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; erro?: string }>
}) {
  const eu = await exigir((p) => p.configurar, 'gestão de usuários')
  const q = await searchParams
  const pessoas = await listarPessoas(pool())

  const ativas = pessoas.filter((p) => p.ativo)
  const suspensas = pessoas.filter((p) => !p.ativo)
  const semPapel = pessoas.filter((p) => p.papeis.length === 0)
  const semNome = pessoas.filter((p) => !p.nome)
  const adminsAtivos = ativas.filter((p) => p.permissoes.configurar)

  return (
    <>
      <Topo
        href="/configuracoes"
        titulo="Usuários"
        proposito="quem existe, e quem está com acesso ativo"
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
      <CorpoDeConfiguracao atual="/configuracoes/usuarios">
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

        {adminsAtivos.length === 1 && (
          /* Mesma razão da tela de papéis: um administrador ativo só é ponto único
             de falha. Aqui o risco é maior, porque SUSPENDER também chega a esse
             estado — e a trava em `definirAtivo` recusa, mas avisar antes evita a
             tentativa. */
          <Aviso tom="alerta">
            Só <strong className="font-semibold">{adminsAtivos[0]?.email}</strong> tem acesso ativo
            de configuração. Suspender essa pessoa travaria qualquer mudança de acesso — a trava
            recusa, mas vale ter uma segunda antes de precisar dela.
          </Aviso>
        )}

        {semPapel.length > 0 && (
          <Aviso tom="alerta">
            {semPapel.length} pessoa(s) cadastrada(s) sem papel:{' '}
            {semPapel.map((p) => p.email).join(', ')}. Elas entram pelo Google e veem a tela de
            permissão — cadastrar não dá acesso, quem dá é o papel.
          </Aviso>
        )}

        <Card
          title={`Pessoas · ${pessoas.length}`}
          actions={
            <Link
              href="/configuracoes/papeis"
              className="inline-flex items-center gap-1 text-[13px] font-semibold text-purple-700 hover:text-purple-500"
            >
              <ShieldCheck className="h-[14px] w-[14px]" />
              Papéis e permissões
            </Link>
          }
        >
          <Table
            cols={['Pessoa', 'Papéis', 'Acesso', '']}
            vazio={<>Ninguém cadastrado ainda.</>}
            rows={pessoas.map((p) => [
              <>
                <div className="font-semibold text-ink">
                  {p.nome ?? p.email.split('@')[0]}
                  {p.email === eu.email && (
                    <span className="ml-2 text-[11.5px] font-normal text-ink-3">(você)</span>
                  )}
                </div>
                <div className="text-[12.5px] text-ink-3">{p.email}</div>
                {!p.nome && (
                  <div className="mt-0.5 text-[11.5px] text-amber-700">sem nome preenchido</div>
                )}
              </>,
              p.papeis.length ? (
                <div className="flex flex-wrap gap-1">
                  {p.papeis.map((r) => (
                    <Badge key={r} tone="indigo">
                      {r.replace(/^pulse-/, '')}
                    </Badge>
                  ))}
                </div>
              ) : (
                <span className="text-[12.5px] text-ink-3">nenhum</span>
              ),
              <Badge tone={p.ativo ? 'green' : 'red'}>{p.ativo ? 'ativo' : 'suspenso'}</Badge>,
              /* O motivo vai no MESMO formulário do botão, e não numa etapa depois:
                 confirmação em dois passos é onde o motivo vira "asdf". Aqui ele é
                 obrigatório na camada de dados, então o botão sem motivo volta com
                 erro — e o campo fica ao lado, preenchido pela pessoa certa. */
              <form action={alternarAcesso} className="flex items-end justify-end gap-2">
                <input type="hidden" name="email" value={p.email} />
                <input type="hidden" name="ativar" value={p.ativo ? '0' : '1'} />
                <Field
                  name="motivo"
                  label="Motivo"
                  placeholder={p.ativo ? 'por que suspender' : 'por que reativar'}
                  className="w-[190px]"
                  required
                  minLength={10}
                />
                {/* A própria linha diz o que o clique faz. Sem isso, "Suspender" na
                    sua linha é um botão que desloga na hora e não avisa — e a trava
                    do último admin só protege o caso terminal, não este. */}
                <Btn type="submit" variant={p.ativo ? 'danger' : 'primary'}>
                  {p.ativo
                    ? p.email === eu.email
                      ? 'Suspender MEU acesso'
                      : 'Suspender'
                    : 'Reativar'}
                </Btn>
              </form>,
            ])}
          />
          <p className="mt-3 text-[12px] leading-relaxed text-ink-3">
            Suspender corta o acesso na hora e <strong className="text-ink">preserva os papéis</strong>
            . É o que serve para férias, licença e desligamento em análise — reativar devolve
            exatamente o que a pessoa tinha, sem ninguém reconstruir de memória.
            {suspensas.length > 0 && ` Hoje: ${suspensas.length} suspensa(s).`}
          </p>
        </Card>

        <Card title="Cadastrar pessoa">
          <form action={cadastrarPessoa} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
            <Field
              name="email"
              type="email"
              label="E-mail (@alloyal.com.br)"
              placeholder="nome@alloyal.com.br"
              required
            />
            <Field name="nome" label="Nome" placeholder="Como aparece no header" />
            <div className="flex items-end">
              <Btn type="submit">Cadastrar</Btn>
            </div>
          </form>
          <p className="mt-3 text-[12px] leading-relaxed text-ink-3">
            Cadastrar <strong className="text-ink">não dá acesso</strong>. Serve para o nome
            aparecer no header e para a pessoa existir antes de receber papel. Quem libera o acesso
            é <Link href="/configuracoes/papeis" className="font-semibold text-purple-700">Papéis</Link>
            {semNome.length > 0 && ` — e ${semNome.length} pessoa(s) hoje aparecem pelo e-mail, por falta de nome`}.
          </p>
        </Card>
      </CorpoDeConfiguracao>
    </>
  )
}
