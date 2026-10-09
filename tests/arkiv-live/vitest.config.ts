import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['tests/arkiv-live/**/*.test.ts'], exclude: ['tests/arkiv-live/safety.test.ts'], testTimeout: 15_000 } });
