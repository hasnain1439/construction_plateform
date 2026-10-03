import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { defineConfig } from 'vitest/config';

// Tests run against a separate database configured in .env.test (see .env.test.example).
if (!existsSync('.env.test')) {
  throw new Error('Missing .env.test — copy .env.test.example and set the postgres password.');
}
const testEnv = parse(readFileSync('.env.test'));
Object.assign(process.env, testEnv);

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    env: testEnv,
    globalSetup: ['tests/setup/globalSetup.ts'],
    // One shared Postgres database: run files one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
