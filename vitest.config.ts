import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'ui/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: false,
  },
});
