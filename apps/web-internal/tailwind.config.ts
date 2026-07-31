import type { Config } from 'tailwindcss'
import animate from 'tailwindcss-animate'

/**
 * Design system Alloyal — o MESMO arquivo do alloyal-publi, copiado de propósito.
 *
 * Roxo #6A18E5 = ação; laranja #FF7A00 = marca/acento. Tokens semânticos shadcn
 * (via HSL em tokens.css) + paleta Alloyal crua.
 *
 * É cópia e não aproximação porque o objetivo é que quem abre o Ops depois do
 * Publi não perceba que trocou de produto: mesmas classes, mesmos números,
 * mesmas sombras. Aproximar geraria dois roxos parecidos, que é pior que dois
 * roxos diferentes — ninguém sabe qual é o certo.
 *
 * Ao divergir de Publi, divergir aqui e anotar o porquê.
 */
const config: Config = {
  darkMode: ['class'],
  content: ['./app/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
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

        // ---- Paleta Alloyal ----
        bg: '#F6F6F8',
        surface: { DEFAULT: '#FFFFFF', 2: '#FBFBFC' },
        line: { DEFAULT: '#ECECEF', strong: '#E0E0E6' },
        ink: { DEFAULT: '#16161A', 2: '#5B5B66', 3: '#9A9AA6', 4: '#BFBFC8' },
        purple: {
          50: '#F3ECFE', 100: '#E3D2FB', 200: '#C9A8F6', 300: '#A66FEF',
          400: '#8A3FEA', 500: '#6A18E5', 700: '#5512B8', 800: '#410D8C',
          900: '#2E0962', DEFAULT: '#6A18E5',
        },
        orange: {
          50: '#FFF3E8', 100: '#FFD9B3', 300: '#FFB870', 500: '#FF7A00',
          700: '#B45309', DEFAULT: '#FF7A00',
        },
        green: { DEFAULT: '#16A34A', 50: '#E9F7EF' },
        amber: { DEFAULT: '#F59E0B', 50: '#FEF4E2' },
        red: { DEFAULT: '#DC2626', 50: '#FCEBEB' },
        health: { on: '#16A34A', risk: '#F59E0B', off: '#DC2626' },
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

export default config
