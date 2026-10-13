/**
 * Prints the permission each company route needs (Markdown table), from the live Express app.
 *   npx tsx scripts/permission-routes.ts
 */
import { createApp } from '../src/app.js';
import { listRoutes } from '../src/core/http/routeList.js';
import { disconnectDatabases } from '../src/core/db/prisma.js';

const rows = listRoutes(createApp()).filter((r) => !/^\/api\/v1\/(auth|admin)\//.test(r.path) && !r.path.endsWith('/:token/accept') && !r.path.endsWith('/:id/file'));
console.log('| Method | Path | Permission |\n|---|---|---|');
for (const r of rows) {
  const perm = r.permissions.map((p) => p.keys.map((k) => `\`${k}\``).join(p.any ? ' or ' : ' + ')).join(' + ') || '— (any company user)';
  console.log(`| ${r.method.toUpperCase()} | \`${r.path.replace('/api/v1', '')}\` | ${perm} |`);
}
await disconnectDatabases();
