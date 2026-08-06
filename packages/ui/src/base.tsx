import { clsx, type ClassValue } from 'clsx'
import type React from 'react'
import { twMerge } from 'tailwind-merge'

/**
 * Os componentes base do Alloyal — mesma API do `src/ui.tsx` do alloyal-publi.
 *
 * A assinatura é igual de propósito: quem já mexeu no Publi escreve tela no Pulse
 * sem consultar nada, e uma correção visual feita num lado é portável para o
 * outro por copiar e colar. Onde o Pulse precisa de algo que o Publi não tem — o
 * estado do dado, a faixa de saúde — o acréscimo fica em `Metric` e `Vazio`, e
 * não numa variante nova de `Card` ou `Badge`.
 */

/** Merge de classes Tailwind (padrão shadcn/Metas): a última vence. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export const cx = cn

export function Card({
  title,
  actions,
  children,
  className,
}: {
  title?: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn('rounded-lg border border-line bg-surface shadow-sm', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-[18px] py-[14px]">
          <h2 className="text-[14px] font-bold tracking-[-0.01em] text-ink">{title}</h2>
          <div className="flex gap-2">{actions}</div>
        </header>
      )}
      <div className="p-[18px]">{children}</div>
    </section>
  )
}

export function Btn({
  children,
  onClick,
  type = 'button',
  variant = 'primary',
  disabled,
  name,
  value,
  title,
  className,
}: {
  children: React.ReactNode
  /**
   * Só vale dentro de componente de cliente — e é o que o Publi tem na mesma
   * assinatura. Estava faltando aqui porque a casca inteira era de servidor;
   * quando o painel do Radar chegou, o caminho sem isto era o botão cru, que é
   * exatamente o que `design-system.test.mjs` existe para impedir.
   */
  onClick?: () => void
  type?: 'button' | 'submit'
  variant?: 'primary' | 'ghost' | 'danger'
  disabled?: boolean
  /** `name`/`value` para o botão carregar a escolha no submit, sem JS. */
  name?: string
  value?: string
  title?: string
  className?: string
}) {
  const styles = {
    primary: 'bg-purple-500 text-white hover:bg-purple-700',
    ghost: 'border border-line-strong bg-surface text-ink hover:bg-surface-2',
    danger: 'bg-red text-white hover:bg-red/90',
  }[variant]
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      name={name}
      value={value}
      title={title}
      className={cn(
        'inline-flex h-9 items-center justify-center gap-[7px] whitespace-nowrap rounded-sm px-[14px] text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-[15px]',
        styles,
        className,
      )}
    >
      {children}
    </button>
  )
}

export const inputCls =
  'w-full rounded-sm border border-line-strong bg-surface px-3 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-4 focus:border-purple-500 focus:ring-2 focus:ring-purple-100'

export function Field({
  label,
  className,
  ...props
}: { label?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block text-[13px]">
      {label && <span className="mb-1 block font-medium text-ink-2">{label}</span>}
      <input {...props} className={cn('h-9', inputCls, className)} />
    </label>
  )
}

export function Select({
  label,
  children,
  className,
  ...props
}: { label?: string; children: React.ReactNode } & React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <label className="block text-[13px]">
      {label && <span className="mb-1 block font-medium text-ink-2">{label}</span>}
      <select {...props} className={cn('h-9', inputCls, className)}>
        {children}
      </select>
    </label>
  )
}

/**
 * O campo de texto longo, com o MESMO `inputCls` do `Field`.
 *
 * Existe porque os dois textarea que havia na app copiaram essas classes à mão e já
 * tinham divergido entre si — um em 13px com regra de placeholder, o outro em 13.5px
 * sem. Cópia à mão de token diverge; a única defesa é não haver cópia.
 *
 * `py-2` em vez da altura fixa do `Field`: aqui quem manda é o `rows`.
 */
export function TextArea({
  label,
  className,
  ...props
}: { label?: React.ReactNode } & React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <label className="block text-[13px]">
      {label && <span className="mb-1 block font-medium text-ink-2">{label}</span>}
      <textarea {...props} className={cn('py-2', inputCls, className)} />
    </label>
  )
}

export function Table({
  cols,
  rows,
  vazio = 'sem registros',
  denso = false,
}: {
  cols: React.ReactNode[]
  rows: React.ReactNode[][]
  vazio?: React.ReactNode
  /** Tipo e respiro menores, para a folha A4 — onde a coluna é estreita. */
  denso?: boolean
}) {
  return (
    <div className="overflow-x-auto">
      <table className={cn('w-full', denso ? 'text-[13px]' : 'text-[14px]')}>
        <thead>
          <tr className="border-b border-line text-left text-[10.5px] uppercase tracking-[0.08em] text-ink-3">
            {cols.map((c, i) => (
              <th key={i} className={cn('font-semibold', denso ? 'py-1.5 pr-3' : 'px-3 py-2')}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={cols.length} className="px-3 py-6 text-center text-ink-3">
                {vazio}
              </td>
            </tr>
          )}
          {rows.map((r, i) => (
            <tr
              key={i}
              className={cn(
                'border-b border-line last:border-0',
                /* Sem hover na folha impressa: estado de mouse em papel não existe. */
                !denso && 'hover:bg-surface-2',
              )}
            >
              {r.map((c, j) => (
                <td
                  key={j}
                  className={cn('align-top text-ink', denso ? 'py-1.5 pr-3' : 'px-3 py-2.5')}
                >
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export type Tom = 'slate' | 'green' | 'red' | 'amber' | 'indigo' | 'pink' | 'orange' | 'blue'

export function Badge({ children, tone = 'slate' }: { children: React.ReactNode; tone?: Tom }) {
  const t = {
    slate: 'bg-surface-2 text-ink-2 ring-1 ring-inset ring-line',
    green: 'bg-green-50 text-green',
    red: 'bg-red-50 text-red',
    amber: 'bg-amber-50 text-amber-700',
    indigo: 'bg-purple-50 text-purple-700',
    pink: 'bg-[#FDE7F1] text-[#C0005A]',
    orange: 'bg-orange-50 text-orange-700',
    blue: 'bg-[#E6F0FE] text-[#1D4ED8]',
  }[tone]
  return (
    <span className={cn('inline-block rounded-full px-2 py-0.5 text-[11.5px] font-medium', t)}>
      {children}
    </span>
  )
}

/**
 * O tom de badge para cada faixa de saúde e prioridade.
 *
 * Num mapa só, e não escolhido tela por tela: risco alto pintado de laranja
 * numa tela e de vermelho na outra é como o time deixa de confiar na cor.
 */
export const TOM_POR_FAIXA: Record<string, Tom> = {
  saudavel: 'green',
  atencao: 'amber',
  risco: 'orange',
  critico: 'red',
  // Prioridade de item de trabalho.
  baixa: 'slate',
  media: 'amber',
  alta: 'orange',
  critica: 'red',
}

/** KPI — o número grande do topo da tela. */
export function Kpi({
  rotulo,
  valor,
  nota,
  tom,
}: {
  rotulo: React.ReactNode
  valor: React.ReactNode
  nota?: React.ReactNode
  /** `undefined` = neutro. Cor aqui significa saúde, nunca frescor de dado. */
  tom?: 'green' | 'amber' | 'red'
}) {
  const cor = tom ? { green: 'text-green', amber: 'text-amber', red: 'text-red' }[tom] : 'text-ink'
  return (
    <div className="rounded-lg border border-line bg-surface p-[18px] shadow-sm">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-3">
        {rotulo}
      </div>
      <div className={cn('mt-1.5 text-kpi tabular-nums', cor)}>{valor}</div>
      {nota && <div className="mt-1 text-[12px] text-ink-2">{nota}</div>}
    </div>
  )
}

/** Aviso de faixa inteira — erro, sucesso ou alerta de dado. */
export function Aviso({
  children,
  tom = 'info',
  papel,
}: {
  children: React.ReactNode
  tom?: 'info' | 'ok' | 'alerta' | 'erro'
  papel?: 'alert' | 'status'
}) {
  const t = {
    info: 'border-line bg-surface-2 text-ink-2',
    ok: 'border-green/30 bg-green-50 text-green',
    alerta: 'border-amber/30 bg-amber-50 text-amber-700',
    erro: 'border-red/30 bg-red-50 text-red',
  }[tom]
  return (
    /* `px-3 py-2` é a medida do `ErrorBox` do Publi, de quem este componente é a
       generalização em quatro tons. Antes daqui havia um `py-[11px]` que eu inventei. */
    <div role={papel} className={cn('rounded-md border px-3 py-2 text-[13px]', t)}>
      {children}
    </div>
  )
}
