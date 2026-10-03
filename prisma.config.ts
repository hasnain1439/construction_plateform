import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// The Prisma CLI (migrate, studio, seed) connects as the schema owner so it can
// create tables, enable RLS and grant privileges. The running app never uses
// this URL — it connects as app_user / app_admin (see src/config/env.ts).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env['DATABASE_MIGRATION_URL'] ?? process.env['DATABASE_URL'],
  },
});
