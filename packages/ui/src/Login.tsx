import { AlloyalLogo } from './AlloyalLogo'
import { BotaoGoogle } from './BotaoGoogle'
import { cn } from './base'

/**
 * A tela de login, na mesma composição do Allvoice (Hub).
 *
 * Dois painéis: marca à esquerda (escuro, com o gradiente roxo→laranja), entrada à
 * direita. Em telas estreitas o painel de marca sai e a marca reaparece acima do
 * título — o login precisa funcionar no celular de quem está fora do escritório.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ O que veio do Allvoice: a composição, o gradiente e o botão do Google.     │
 * │ O que NÃO veio: os seis cinzas em hex inline. `#1E1E28`, `#FAFAFB` e       │
 * │ `#9A9AAE` já têm equivalente em `--ink`, `--surface-2` e `--ink-3` — copiá-│
 * │ los criaria cinzas concorrentes, e "dois cinzas parecidos são piores que   │
 * │ dois diferentes" é a regra do design system da casa. Só `--escuro` é novo, │
 * │ porque superfície escura é um papel que o Pulse não tinha.                   │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Nada aqui autentica: o botão leva ao `/oauth2/start` do oauth2-proxy, e quem
 * decide identidade é o proxy mais a verificação de papel no banco. Esta tela é a
 * porta, não a fechadura.
 */

export interface LoginProps {
  /** Rota de retorno depois do login, quando quem chama sabe qual é. */
  readonly rd?: string
  /** Título do painel de entrada. */
  readonly titulo?: string
  /** A frase do painel de marca. Duas linhas no máximo — é headline, não parágrafo. */
  readonly chamada?: readonly string[]
  /** O que o produto faz, em uma frase. */
  readonly descricao?: string
  /** As ferramentas, como etiquetas. Vazio esconde a faixa. */
  readonly etiquetas?: readonly string[]
  /** Domínio exigido. Aparece em dois lugares porque é a causa nº 1 de recusa. */
  readonly dominio?: string
  readonly className?: string
}

export function Login({
  titulo = 'Entrar no Alloyal Pulse',
  chamada = ['O time interno opera o negócio', 'num só lugar.'],
  descricao = 'Fila de trabalho, carteira, receita, contratos e relatórios sobre uma base de dados única e governada.',
  etiquetas = ['Fila de trabalho', 'Carteira', 'Receita', 'Contratos', 'Relatórios'],
  dominio = '@alloyal.com.br',
  rd,
  className,
}: LoginProps) {
  return (
    <div className={cn('grid min-h-screen md:grid-cols-2', className)}>
      {/* ── Painel de marca ──
             `hidden md:flex`: num celular ele consumiria a tela toda e empurraria o
             botão para fora do primeiro rolar. A marca reaparece do outro lado. */}
      <aside className="pulse-marca relative hidden overflow-hidden p-14 text-white md:flex md:flex-col md:justify-between">
        {/* Wordmark no laranja da marca + nome do produto em branco, que é a mesma
            leitura do Allvoice ("Alloyal" + "Hub" no acento). O laranja tem contraste
            de sobra sobre `--escuro`, e repintar o logotipo de branco perderia a única
            cor que identifica a casa neste painel. */}
        <div className="relative flex items-center gap-3">
          <AlloyalLogo className="h-6" />
          <span className="text-[17px] font-bold tracking-tight">Pulse</span>
        </div>

        <div className="relative">
          <h1 className="text-[32px] font-bold leading-[1.15] tracking-[-0.03em]">
            {chamada.map((linha) => (
              <span key={linha} className="block">
                {linha}
              </span>
            ))}
          </h1>
          <p className="mt-4 max-w-md text-[15px] leading-relaxed text-white/60">{descricao}</p>

          {etiquetas.length > 0 && (
            <div className="mt-6 flex flex-wrap gap-2">
              {etiquetas.map((e) => (
                <span
                  key={e}
                  className="rounded-full border border-white/15 px-3 py-1.5 text-[12.5px] text-white/80"
                >
                  {e}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="relative text-[12px] text-white/40">
          Alloyal · acesso restrito a colaboradores
        </div>
      </aside>

      {/* ── Painel de entrada ── */}
      <main className="flex items-center justify-center bg-surface-2 p-6">
        <div className="w-full max-w-[360px]">
          <div className="mb-6 flex items-center gap-2.5 md:hidden">
            <AlloyalLogo className="h-6" />
            <span className="text-[16px] font-bold text-ink">Pulse</span>
          </div>

          <h2 className="text-[25px] font-bold tracking-[-0.02em] text-ink">{titulo}</h2>
          <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">
            Use sua conta Google corporativa{' '}
            <strong className="font-semibold text-ink">{dominio}</strong> para acessar.
          </p>

          <BotaoGoogle {...(rd ? { rd } : {})} />

          {/* Dito de novo, e de propósito: entrar com a conta pessoal é a causa nº 1
              de recusa, e quem já clicou não volta a ler o parágrafo de cima. */}
          <p className="mt-4 text-center text-[11.5px] text-ink-3">
            Acesso restrito a contas {dominio}
          </p>

          {/* O papel é a SEGUNDA barreira, e a que confunde: a pessoa entra no Google
              com sucesso e ainda assim não vê nada. Dizer isso antes evita o ticket. */}
          <p className="mt-6 border-t border-line pt-4 text-[11.5px] leading-relaxed text-ink-3">
            O acesso a cada área vem dos grupos <code className="text-[11px]">pulse-*</code> do Google
            Workspace. Autenticar sem estar num grupo mostra a tela de permissão, não um erro.
          </p>
        </div>
      </main>
    </div>
  )
}
