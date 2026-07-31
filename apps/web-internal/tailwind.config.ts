import { alloyalPreset } from '@pulse/ui/tailwind-preset'
import type { Config } from 'tailwindcss'

/** Superfície interna. O tema vem do preset; aqui só o que é desta aplicação. */
const config: Config = {
  presets: [alloyalPreset as Config],
  content: ['./app/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
}

export default config
