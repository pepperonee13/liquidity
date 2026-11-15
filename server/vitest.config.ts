import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: { FX_URL: '', PUBLIC_URL: 'http://localhost:3000' },
  },
});
