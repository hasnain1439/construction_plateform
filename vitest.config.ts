import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { defineConfig } from 'vitest/config';

// Tests run against a separate database configured in .env.test (see .env.test.example).
if (!existsSync('.env.test')) {
  throw new Error('Missing .env.test — copy .env.test.example and set the postgres password.');
}
const testEnv = parse(readFileSync('.env.test'));
// Uploaded test files go to the OS temp folder (removed after the run), never into the project.
testEnv['STORAGE_DIR'] = join(tmpdir(), 'construction-platform-tests', 'storage');
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
