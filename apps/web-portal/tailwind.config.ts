import { alloyalPreset } from '@pulse/ui/tailwind-preset'
import type { Config } from 'tailwindcss'

/**
 * Portal do cliente. MESMO tema da superfície interna — o design system é da
 * Alloyal, não do Pulse.
 *
 * O que difere aqui é a densidade, não a marca: o gestor do cliente entra
 * algumas vezes por ano, e a tela dele pode respirar. A ferramenta interna é
 * usada seis horas por dia e por isso é densa.
 */
const config: Config = {
  presets: [alloyalPreset as Config],
  content: ['./app/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
}

export default config
