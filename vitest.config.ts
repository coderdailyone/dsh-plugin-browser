import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 60_000,
    // Browser launches shouldn't race other files for CPU/Chromium.
    fileParallelism: false,
  },
})
