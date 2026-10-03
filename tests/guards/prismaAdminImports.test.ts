import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `prismaAdmin` bypasses row-level security. Only auth and platform-admin code may
 * use it; every business module must go through `withTenant()`.
 */
const ALLOWED = ['src/core/db/prisma.ts', 'src/modules/auth/', 'src/modules/platform-admin/', 'src/generated/'];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('prismaAdmin import guard', () => {
  it('is only referenced from auth / platform-admin code', () => {
    const offenders = walk('src')
      .map((file) => relative('.', file).split(sep).join('/'))
      .filter((file) => !ALLOWED.some((allowed) => file === allowed || file.startsWith(allowed)))
      .filter((file) => /\bprismaAdmin\b/.test(readFileSync(file, 'utf8')));
    expect(offenders, `prismaAdmin used outside allowed modules: ${offenders.join(', ')}`).toEqual([]);
  });
});
