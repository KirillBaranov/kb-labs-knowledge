import { defineConfig } from 'vitest/config'
import nodePreset from '@kb-labs/devkit/vitest/node.js'

export default defineConfig({
  ...nodePreset,
  test: {
    ...nodePreset.test,
    include: ['src/**/*.test.ts'],
  },
})
