/**
 * Excel / CSV import of workers, sub-contractors, suppliers, custom materials and clients.
 *
 *   template → GET  /imports/:entity/template   (xlsx: Data + Instructions sheets)
 *   preview  → POST /imports/:entity/preview    (multipart `file`; parses + validates, writes nothing)
 *   commit   → POST /imports/:entity/commit     (the SAME file again; all-or-nothing by default)
 *
 * Stateless by design: commit re-uploads the file instead of using a cached preview, so it
 * works behind several API instances, keeps nothing between requests, and validates again
 * against the data as it is at commit time. Every row goes through the create endpoint's own
 * Zod schema plus the create service's rules; the whole file is written in one transaction.
 * Master data has no plan limits (plans limit active projects and office users only).
 */
import { writeAudit } from '../../core/audit/audit.js';
import { getCtx } from '../../core/context/requestContext.js';
import { Prisma } from '../../core/db/prisma.js';
import { withTenant } from '../../core/db/withTenant.js';
import { BadRequest, Conflict } from '../../core/errors/AppError.js';
import { ENTITY_DEFS, type CellError, type EntityDef, type ImportEntity, type Lookups } from './imports.entities.js';
import { buildTemplate, headerKey, readSheet, type Sheet } from './imports.file.js';

export interface UploadedSheetFile {
  buffer: Buffer;
  originalname: string;
}

function current() {
  const ctx = getCtx();
  return { tenantId: ctx.tenantId!, userId: ctx.userId! };
}

const fileRequired = () => new BadRequest('FILE_REQUIRED', 'Attach the filled template as `file` (.xlsx or .csv)');

export async function template(entity: ImportEntity): Promise<{ fileName: string; buffer: Buffer }> {
  const def = ENTITY_DEFS[entity];
  const lookups = await withTenant(current().tenantId, (tx) => def.loadLookups(tx));
  return { fileName: `${entity}-import-template.xlsx`, buffer: await buildTemplate(def, lookups) };
}

interface CheckedRow {
  rowNumber: number;
  values: Record<string, string>;
  errors: CellError[];
  parsed?: unknown;
}

interface Checked {
  columns: Array<{ key: string; label: string; labelRoman: string; labelUrdu: string; required: boolean }>;
  unknownColumns: string[];
  skippedExampleRows: number;
  rows: CheckedRow[];
}

/** Matches the sheet's headers to the entity columns (by key or any of its three labels). */
function mapHeaders(def: EntityDef, sheet: Sheet) {
  const index = new Map<string, number>();
  const unknown: string[] = [];
  sheet.headers.forEach((h, i) => {
    if (!h) return;
    const k = headerKey(h);
    const col = def.columns.find((c) => [c.key, c.label.en, c.label.roman, c.label.urdu].some((alias) => headerKey(alias) === k));
    if (col && !index.has(col.key)) index.set(col.key, i);
    else unknown.push(h);
  });
  const missing = def.columns.filter((c) => c.required && !index.has(c.key)).map((c) => c.key);
  if (missing.length) {
    throw new BadRequest('MISSING_COLUMNS', `The file is missing required columns: ${missing.join(', ')} — download the template`, { missing });
  }
  return { index, unknown };
}

function check(def: EntityDef, sheet: Sheet, lookups: Lookups): Checked {
  const { index, unknown } = mapHeaders(def, sheet);
  const seen = new Map<string, number>();
  const rows: CheckedRow[] = [];
  let skippedExampleRows = 0;
  for (const r of sheet.rows) {
    const values: Record<string, string> = {};
    for (const c of def.columns) {
      const i = index.get(c.key);
      values[c.key] = i === undefined ? '' : (r.cells[i] ?? '').trim();
    }
    if (Object.values(values).every((v) => v === '')) continue;
    if (Object.values(values).some((v) => /\(example\b/i.test(v))) {
      skippedExampleRows++;
      continue;
    }
    const { body, errors } = def.toBody(values, lookups);
    const parsed = def.schema.safeParse(body);
    const flagged = new Set(errors.map((e) => e.column));
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? '');
        const column = def.fieldColumn[field] ?? field ?? 'row';
        if (flagged.has(column)) continue;
        flagged.add(column);
        const empty = values[column] === '' || values[column] === undefined;
        errors.push({ column, message: empty && def.columns.find((c) => c.key === column)?.required ? 'Required' : issue.message });
      }
    } else if (!errors.length) {
      errors.push(...(def.check?.(parsed.data, values, lookups) ?? []));
      const u = def.uniqueOf(parsed.data);
      if (!errors.length && u !== null) {
        if (lookups.taken.has(u)) errors.push({ column: def.unique.column, message: def.unique.message });
        else if (seen.has(u)) errors.push({ column: def.unique.column, message: `Repeated in this file (row ${seen.get(u)})` });
        else seen.set(u, r.rowNumber);
      }
    }
    rows.push({ rowNumber: r.rowNumber, values, errors, ...(parsed.success && !errors.length ? { parsed: parsed.data } : {}) });
  }
  return {
    columns: def.columns.map((c) => ({ key: c.key, label: c.label.en, labelRoman: c.label.roman, labelUrdu: c.label.urdu, required: c.required })),
    unknownColumns: unknown,
    skippedExampleRows,
    rows,
  };
}

function summary(entity: ImportEntity, fileName: string, c: Checked) {
  const invalid = c.rows.filter((r) => r.errors.length).length;
  return {
    entity,
    fileName,
    columns: c.columns,
    unknownColumns: c.unknownColumns,
    skippedExampleRows: c.skippedExampleRows,
    totalRows: c.rows.length,
    validRows: c.rows.length - invalid,
    invalidRows: invalid,
  };
}

export async function preview(entity: ImportEntity, file: UploadedSheetFile | undefined) {
  if (!file) throw fileRequired();
  const def = ENTITY_DEFS[entity];
  const sheet = await readSheet(file);
  return withTenant(current().tenantId, async (tx) => {
    const c = check(def, sheet, await def.loadLookups(tx));
    return {
      ...summary(entity, file.originalname, c),
      rows: c.rows.map((r) => ({ rowNumber: r.rowNumber, values: r.values, errors: r.errors, valid: r.errors.length === 0 })),
    };
  });
}

/**
 * All-or-nothing by default: any row with an error → 400 IMPORT_HAS_ERRORS and nothing is
 * written. `skipInvalid` writes only the valid rows. One transaction, one audit row.
 */
export async function commit(entity: ImportEntity, file: UploadedSheetFile | undefined, opts: { skipInvalid: boolean }) {
  if (!file) throw fileRequired();
  const def = ENTITY_DEFS[entity];
  const a = current();
  const sheet = await readSheet(file);
  return withTenant(
    a.tenantId,
    async (tx) => {
      const lookups = await def.loadLookups(tx);
      const c = check(def, sheet, lookups);
      const s = summary(entity, file.originalname, c);
      const bad = c.rows.filter((r) => r.errors.length);
      if (bad.length && !opts.skipInvalid) {
        throw new BadRequest('IMPORT_HAS_ERRORS', `${bad.length} row(s) have errors — fix them or import only the valid rows`, {
          invalidRows: bad.length,
          validRows: s.validRows,
          rows: bad.slice(0, 200).map((r) => ({ rowNumber: r.rowNumber, errors: r.errors })),
        });
      }
      const good = c.rows.filter((r) => !r.errors.length);
      if (!good.length) throw new BadRequest('NOTHING_TO_IMPORT', 'The file has no rows to import');
      const ids = await def.insert(tx, a, good.map((r) => r.parsed), lookups);
      await writeAudit(tx, {
        tenantId: a.tenantId,
        actorType: 'USER',
        actorId: a.userId,
        action: `import.${entity}`,
        entityType: 'Import',
        entityId: a.tenantId,
        details: { fileName: file.originalname, created: ids.length, skipped: bad.length, ids },
      });
      return { entity, fileName: file.originalname, created: ids.length, skipped: bad.length, ids };
    },
    { timeout: 60_000 },
  ).catch((err: unknown) => {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new Conflict('IMPORT_CONFLICT', 'Someone added one of these records in the meantime — preview the file again');
    }
    throw err;
  });
}
