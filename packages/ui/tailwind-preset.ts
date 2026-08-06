import type { Config } from 'tailwindcss'
import animate from 'tailwindcss-animate'

/**
 * Preset Tailwind do Alloyal — o MESMO tema do alloyal-publi, copiado de propósito.
 *
 * É PRESET e não config: as duas aplicações do repositório (interna e portal do
 * cliente) usam o mesmo tema e declaram apenas o próprio `content`. Duas cópias
 * do tema divergiriam no primeiro ajuste de cor feito com pressa.
 *
 * Roxo #6A18E5 = ação; laranja #FF7A00 = marca/acento. Tokens semânticos shadcn
 * (via HSL em tokens.css) + paleta Alloyal crua.
 *
 * É cópia e não aproximação porque o objetivo é que quem abre o Pulse depois do
 * Publi não perceba que trocou de produto: mesmas classes, mesmos números,
 * mesmas sombras. Aproximar geraria dois roxos parecidos, que é pior que dois
 * roxos diferentes — ninguém sabe qual é o certo.
 *
 * Ao divergir de Publi, divergir aqui e anotar o porquê.
 */
export const alloyalPreset: Partial<Config> = {
  darkMode: ['class'],
  theme: {
    container: {
      center: true,
      padding: '1.5rem',
      screens: { '2xl': '1400px' },
    },
    extend: {
      colors: {
        // shadcn semânticos
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
        secondary: { DEFAULT: 'hsl(var(--secondary))', foreground: 'hsl(var(--secondary-foreground))' },
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
        destructive: { DEFAULT: 'hsl(var(--destructive))', foreground: 'hsl(var(--destructive-foreground))' },
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
        popover: { DEFAULT: 'hsl(var(--popover))', foreground: 'hsl(var(--popover-foreground))' },

        // ┌───────────────────────────────────────────────────────────────────┐
        // │ PALETA DO DS ALLOYAL 2026, tokens extraídos do artefato do design.   │
        // │                                                                      │
        // │ Os NOMES semânticos são os que as telas já usam — `ink`, `surface`,   │
        // │ `line`, `purple`, `orange`, `green`, `amber`, `red`. Só os VALORES    │
        // │ mudaram. Renomear obrigaria a tocar em quinze telas sem ganhar nada:  │
        // │ o que importa é a cor que sai, não a palavra escrita no código.       │
        // │                                                                      │
        // │ O roxo 500 já era o do DS (#6A18E5). O resto da rampa não era.        │
        // └───────────────────────────────────────────────────────────────────┘
        bg: '#F2F4F7',
        surface: { DEFAULT: '#FFFFFF', 2: '#FCFCFD' },
        line: { DEFAULT: '#E4E7EC', strong: '#D0D5DD' },
        // A escala de texto. O DS chama de dark/inverse; aqui segue `ink` porque é
        // o que as telas escrevem — a cor é a mesma.
        ink: { DEFAULT: '#111111', 2: '#475467', 3: '#98A2B3', 4: '#D0D5DD' },
        purple: {
          50: '#F3ECFE', 100: '#E3D2FB', 200: '#C9A8F6',
          300: '#9B64EE', 400: '#8846EA', 500: '#6A18E5',
          600: '#6016D0', 700: '#4B11A3', 800: '#3A0D7E', 900: '#2E0962',
          DEFAULT: '#6A18E5',
        },
        orange: {
          50: '#FEF0E4', 100: '#FCD9BC',
          300: '#F9A263', 400: '#F89045', 500: '#F67416',
          600: '#E06A14', 700: '#AF5210',
          DEFAULT: '#F67416',
        },
        // ── Semânticos, com o par fundo/tinta que o DS define ──────────────
        // `amber` tem tinta PRÓPRIA (#806600) porque o amarelo do DS não passa
        // contraste como texto. Usar o mesmo tom nos dois lugares deixaria o aviso
        // ilegível justamente quando ele importa.
        green: { DEFAULT: '#317131', 50: '#E9F2E9', ink: '#317131' },
        amber: { DEFAULT: '#E6B800', 50: '#FDF6DF', ink: '#806600' },
        red: { DEFAULT: '#B03B3B', 50: '#F7EAEA', ink: '#B03B3B' },
        blue: { DEFAULT: '#1684FD', 50: '#E7F2FE', ink: '#0268D4' },
        tertiary: { DEFAULT: '#2389BB' },
        health: { on: '#317131', risk: '#E6B800', off: '#B03B3B' },
        // ── Acentos decorativos do DS ──────────────────────────────────────
        // Diferenciam item de lista e etiqueta, NUNCA significam saúde ou estado —
        // isso é dos semânticos acima. Cinza e roxo são os únicos escuros o
        // bastante para servir de texto.
        acento: {
          azul: '#1CCEDF', verde: '#ABC499', laranja: '#FFA447', rosa: '#F95FAC',
          roxo: '#7A3ACC', vermelho: '#FF8080', amarelo: '#FFDD80', cinza: '#565656',
        },
      },
      borderRadius: { sm: '7px', md: '10px', lg: '14px', xl: '18px' },
      boxShadow: {
        sm: '0 1px 2px rgba(20,18,30,.05), 0 1px 3px rgba(20,18,30,.04)',
        md: '0 2px 6px rgba(20,18,30,.06), 0 8px 24px rgba(20,18,30,.05)',
        pop: '0 12px 40px rgba(20,18,30,.16), 0 0 0 1px rgba(20,18,30,.05)',
      },
      fontFamily: { sans: ['var(--font-inter)', 'Inter', 'system-ui', 'sans-serif'] },
      fontSize: {
        kpi: ['30px', { lineHeight: '1', letterSpacing: '-0.03em', fontWeight: '700' }],
        h1: ['22px', { lineHeight: '1.2', letterSpacing: '-0.025em', fontWeight: '700' }],
        title: ['17px', { lineHeight: '1.2', letterSpacing: '-0.02em', fontWeight: '700' }],
        // ── Escala do DS Alloyal 2026 ────────────────────────────────────
        // O DS proíbe `font-size` solto: tamanho vem por classe, e cada uma tem
        // peso e entrelinha próprios. Aqui elas viram `text-t1`, `text-b2` etc.
        t1: ['1.375rem', { lineHeight: '1.75rem', fontWeight: '700' }],
        t2: ['1rem', { lineHeight: '1.5rem', letterSpacing: '.15px', fontWeight: '500' }],
        t3: ['0.875rem', { lineHeight: '1.25rem', letterSpacing: '.1px', fontWeight: '500' }],
        b1: ['1rem', { lineHeight: '1.5rem', letterSpacing: '.5px', fontWeight: '400' }],
        b2: ['0.875rem', { lineHeight: '1.25rem', letterSpacing: '.25px', fontWeight: '400' }],
        b3: ['0.75rem', { lineHeight: '1rem', letterSpacing: '.4px', fontWeight: '400' }],
        l1: ['0.875rem', { lineHeight: '1.25rem', letterSpacing: '.1px', fontWeight: '700' }],
        l2: ['0.875rem', { lineHeight: '1.25rem', letterSpacing: '.1px', fontWeight: '500' }],
      },
      keyframes: {
        'accordion-down': { from: { height: '0' }, to: { height: 'var(--radix-accordion-content-height)' } },
        'accordion-up': { from: { height: 'var(--radix-accordion-content-height)' }, to: { height: '0' } },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  // Import ESM em vez do require() do Publi: o lint deste repo proíbe require,
  // e o plugin é o mesmo.
  plugins: [animate],
}

export default alloyalPreset
