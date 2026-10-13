/**
 * Copies existing attachment files to the S3-compatible bucket and points the Attachment rows at
 * the new keys. Idempotent: an object already in the bucket is not uploaded again, and a row is
 * only updated while it still has its old key — safe to re-run after an interruption.
 * Source files are NOT deleted (keep them until you have checked the new storage).
 *
 *   npm run storage:migrate -- --from local --to s3 --dry-run
 *   npm run storage:migrate -- --from local --to s3
 *   npm run storage:migrate -- --from cloudinary --to s3 [--tenant <tenantId>] [--batch 100]
 *
 * Needs S3_BUCKET / S3_REGION (+ S3_ENDPOINT, keys…) in the environment; STORAGE_PROVIDER itself
 * may still be local / cloudinary while you migrate.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { env } from '../src/config/env.js';
import { disconnectDatabases, prismaAdmin } from '../src/core/db/prisma.js';
import { CloudinaryStorageProvider, isCloudinaryKey, parseCloudinaryKey } from '../src/modules/attachments/cloudinary.provider.js';
import { EXTENSIONS } from '../src/modules/attachments/fileTypes.js';
import { isS3Key, S3StorageProvider, s3Key } from '../src/modules/attachments/s3.provider.js';
import { LocalStorageProvider, s3ConfigFromEnv, type StorageProvider } from '../src/modules/attachments/storage.provider.js';

export type SourceName = 'local' | 'cloudinary';

export interface MigrateOptions {
  from: SourceName;
  to: 's3';
  dryRun?: boolean;
  tenantId?: string;
  batchSize?: number;
}

export interface MigrateDeps {
  target: S3StorageProvider;
  /** Reads a source file's bytes. */
  read: (storageKey: string) => Promise<Buffer>;
  log?: (line: string) => void;
}

export interface MigrateSummary {
  scanned: number;
  copied: number;
  alreadyInTarget: number;
  updated: number;
  failed: Array<{ id: string; error: string }>;
}

/** Canonical key `tenantId/yyyy/mm/<id>.<ext>` for an existing row's file. */
export function canonicalKeyFor(row: { id: string; tenantId: string; storageKey: string; mimeType: string; createdAt: Date }): string {
  if (isCloudinaryKey(row.storageKey)) {
    const { publicId } = parseCloudinaryKey(row.storageKey);
    // construction/<tenant>/<yyyy>/<mm>/<id>[.ext]
    const [, tenantId, yyyy, mm, file] = publicId.split('/');
    const ext = file!.includes('.') ? file!.slice(file!.indexOf('.') + 1) : (EXTENSIONS[row.mimeType] ?? 'bin');
    return `${tenantId}/${yyyy}/${mm}/${row.id}.${ext}`;
  }
  return row.storageKey;
}

function isSourceKey(from: SourceName, key: string): boolean {
  if (from === 'cloudinary') return isCloudinaryKey(key);
  return !isCloudinaryKey(key) && !isS3Key(key);
}

export async function migrateStorage(opts: MigrateOptions, deps: MigrateDeps): Promise<MigrateSummary> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const batch = opts.batchSize ?? 100;
  const summary: MigrateSummary = { scanned: 0, copied: 0, alreadyInTarget: 0, updated: 0, failed: [] };
  const where = {
    ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
    ...(opts.from === 'cloudinary' ? { storageKey: { startsWith: 'cloudinary:' } } : { NOT: [{ storageKey: { startsWith: 'cloudinary:' } }, { storageKey: { startsWith: 's3:' } }] }),
  };

  let cursor: string | undefined;
  for (;;) {
    const rows = await prismaAdmin.attachment.findMany({
      where: { ...where, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { id: true, tenantId: true, storageKey: true, mimeType: true, createdAt: true },
      orderBy: { id: 'asc' },
      take: batch,
    });
    if (!rows.length) break;
    cursor = rows.at(-1)!.id;

    for (const row of rows) {
      if (!isSourceKey(opts.from, row.storageKey)) continue;
      summary.scanned += 1;
      try {
        const canonical = canonicalKeyFor(row);
        const newKey = s3Key(canonical);
        const present = await deps.target.exists(newKey);
        if (opts.dryRun) {
          log(`[dry-run] ${row.id}  ${row.storageKey} → ${newKey}${present ? ' (already in bucket)' : ''}`);
          if (present) summary.alreadyInTarget += 1;
          continue;
        }
        if (present) {
          summary.alreadyInTarget += 1;
        } else {
          const bytes = await deps.read(row.storageKey);
          await deps.target.put(canonical, bytes, row.mimeType);
          summary.copied += 1;
        }
        // Only while the row still has its old key (another run may have moved it already).
        const { count } = await prismaAdmin.attachment.updateMany({ where: { id: row.id, storageKey: row.storageKey }, data: { storageKey: newKey } });
        summary.updated += count;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        summary.failed.push({ id: row.id, error });
        log(`FAILED ${row.id}: ${error}`);
      }
    }
  }
  return summary;
}

export function sourceReader(from: SourceName): (key: string) => Promise<Buffer> {
  if (from === 'local') {
    const local = new LocalStorageProvider(env.STORAGE_DIR);
    return async (key) => {
      const { stream } = await local.open(key);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
      return Buffer.concat(chunks);
    };
  }
  if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) {
    throw new Error('--from cloudinary needs CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET');
  }
  const cloudinary: StorageProvider = new CloudinaryStorageProvider({
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    apiKey: env.CLOUDINARY_API_KEY,
    apiSecret: env.CLOUDINARY_API_SECRET,
  });
  return async (key) => {
    const { url } = await cloudinary.getSignedUrl(key, 300);
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Cloudinary download failed: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };
}

function parseArgs(argv: string[]): MigrateOptions {
  const value = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const from = value('--from');
  const to = value('--to');
  if (from !== 'local' && from !== 'cloudinary') throw new Error('--from must be local or cloudinary');
  if (to !== 's3') throw new Error('--to must be s3');
  const batch = value('--batch');
  return { from, to, dryRun: argv.includes('--dry-run'), tenantId: value('--tenant'), batchSize: batch ? Math.max(1, Number(batch)) : undefined };
}

const isMain = Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1]!)).href === import.meta.url;

if (isMain) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (!env.S3_BUCKET || !env.S3_REGION) throw new Error('Set S3_BUCKET and S3_REGION (and S3_ENDPOINT / keys as needed) first');
    const target = new S3StorageProvider(s3ConfigFromEnv());
    console.log(`Storage migration ${opts.from} → s3 (bucket ${env.S3_BUCKET})${opts.dryRun ? ' — DRY RUN, nothing is changed' : ''}`);
    const s = await migrateStorage(opts, { target, read: sourceReader(opts.from) });
    console.log(
      `Done: ${s.scanned} files, ${s.copied} copied, ${s.alreadyInTarget} already in the bucket, ${s.updated} rows updated, ${s.failed.length} failed.` +
        (s.failed.length ? ' Re-run to retry the failed ones.' : ''),
    );
    if (!opts.dryRun && s.updated) console.log('Source files were kept. Delete them only after checking the app shows the files from the new storage.');
    if (s.failed.length) process.exitCode = 1;
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await disconnectDatabases();
  }
}
