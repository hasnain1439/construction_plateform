import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { api, bearer, loginMobile, loginMunshi, SEED, useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();
const owner = async () => bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);
const pm = async () => bearer((await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password)).accessToken);

/** Binary response body for supertest. */
const binary = (res: NodeJS.ReadableStream, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

const csv = (lines: string[]) => Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8');

async function xlsx(headers: string[], rows: string[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Data');
  ws.addRow(headers);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const post = (path: string, auth: Record<string, string>, file: Buffer, name = 'file.csv') => api().post(path).set(auth).attach('file', file, name);

describe('imports: template', () => {
  it('downloads an xlsx with headers, an example row and a three-language Instructions sheet', async () => {
    const res = await api().get('/api/v1/imports/workers/template').set(await owner()).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toContain('workers-import-template.xlsx');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as Buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Data', 'Instructions']);
    const data = wb.getWorksheet('Data')!;
    expect(data.getRow(1).getCell(1).value).toBe('Name (Naam) *');
    expect(String(data.getRow(1).getCell(1).note ? JSON.stringify(data.getRow(1).getCell(1).note) : '')).toContain('پورا نام');
    expect(String(data.getRow(2).getCell(1).value)).toContain('(example');
    const info = wb.getWorksheet('Instructions')!;
    const allowed = info.getColumn(6).values.map(String).join('\n');
    expect(allowed).toContain('MISTRI'); // the company's own worker types

    for (const entity of ['subcontractors', 'suppliers', 'materials', 'clients']) {
      expect((await api().get(`/api/v1/imports/${entity}/template`).set(await owner())).status).toBe(200);
    }
  });
});

describe('imports: preview and commit', () => {
  it('preview flags every bad row (zod + business rules + duplicates) and writes nothing', async () => {
    const tenantId = seeded().malik.id;
    const existing = await prismaAdmin.worker.findFirstOrThrow({ where: { tenantId, phone: { not: null } } });
    const before = await prismaAdmin.worker.count({ where: { tenantId } });
    const file = csv([
      'Name (Naam),Worker type,Phone,Daily rate (Rs),Notes',
      'Ustad Akram (example — delete this row),MISTRI,03001234567,2800,',
      'Riaz Ahmed,MAZDOOR,0300-1112299,,new',
      'X,MAZDOOR,,,',
      'Kashif,PLUMBER,,,',
      'Sajid,OTHER,,,',
      `Tariq,Mason,${existing.phone!.replace('+92', '0')},1600,`,
      'Bashir,MAZDOOR,03001112299,abc,',
    ]);
    const res = await post('/api/v1/imports/workers/preview', await owner(), file, 'workers.csv');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const d = res.body.data;
    expect(d).toMatchObject({ entity: 'workers', skippedExampleRows: 1, totalRows: 6, validRows: 1, invalidRows: 5 });
    const byName = Object.fromEntries(d.rows.map((r: { values: { name: string }; errors: unknown[] }) => [r.values.name, r.errors]));
    expect(byName['Riaz Ahmed']).toEqual([]);
    expect(byName['X']).toEqual([{ column: 'name', message: 'Name is too short' }]);
    expect(byName['Kashif']).toEqual([{ column: 'type', message: expect.stringContaining('Unknown worker type') }]);
    expect(byName['Sajid']).toEqual([{ column: 'dailyRate', message: expect.stringContaining('daily rate') }]);
    expect(byName['Tariq']).toEqual([{ column: 'phone', message: 'Another worker already has this phone number' }]);
    expect(byName['Bashir']).toEqual([{ column: 'dailyRate', message: 'Enter the amount in rupees, e.g. 1600' }]);
    expect(await prismaAdmin.worker.count({ where: { tenantId } })).toBe(before);
  });

  it('commit is all-or-nothing; skipInvalid imports only the valid rows; one audit row', async () => {
    const tenantId = seeded().malik.id;
    const auth = await owner();
    const before = await prismaAdmin.supplier.count({ where: { tenantId } });
    const file = await xlsx(
      ['Name (Naam) *', 'Category (Kis cheez ka supplier) *', 'Phone (Phone number)', 'City (Shehar)', 'NTN'],
      [
        ['Gujranwala Steel House', 'Steel', '055-3851234', 'Gujranwala', '1234567-8'],
        ['Rehman Sand Supply', 'Sand & Bajri', '03214445566', 'Lahore', ''],
        ['Gujranwala Steel House', 'Steel', '', '', ''], // repeated in the file
        ['Bad NTN Traders', 'Paint', '', '', '12-3'],
      ],
    );
    const all = await post('/api/v1/imports/suppliers/commit', auth, file, 'suppliers.xlsx');
    expect(all.status).toBe(400);
    expect(all.body.error.code).toBe('IMPORT_HAS_ERRORS');
    expect(all.body.error.details).toMatchObject({ invalidRows: 2, validRows: 2 });
    expect(all.body.error.details.rows.map((r: { rowNumber: number }) => r.rowNumber)).toEqual([4, 5]);
    expect(await prismaAdmin.supplier.count({ where: { tenantId } })).toBe(before);

    const some = await post('/api/v1/imports/suppliers/commit?skipInvalid=true', auth, file, 'suppliers.xlsx');
    expect(some.status, JSON.stringify(some.body)).toBe(201);
    expect(some.body.data).toMatchObject({ entity: 'suppliers', created: 2, skipped: 2 });
    expect(await prismaAdmin.supplier.count({ where: { tenantId } })).toBe(before + 2);
    const steel = await prismaAdmin.supplier.findFirstOrThrow({ where: { tenantId, name: 'Gujranwala Steel House' } });
    expect(steel).toMatchObject({ phone: '+92553851234', ntn: '1234567-8', city: 'Gujranwala' });
    const audit = await prismaAdmin.auditLog.findFirstOrThrow({ where: { tenantId, action: 'import.suppliers' } });
    expect(audit.details).toMatchObject({ created: 2, skipped: 2, fileName: 'suppliers.xlsx' });

    // The same file again: now every row is a duplicate of the company's data.
    const again = await post('/api/v1/imports/suppliers/preview', auth, file, 'suppliers.xlsx');
    expect(again.body.data.validRows).toBe(0);
  });

  it('imports clients, custom materials and sub-contractors with their own rules', async () => {
    const tenantId = seeded().malik.id;
    const auth = await pm();
    const clients = await post('/api/v1/imports/clients/commit', auth, csv(['Name,Phone,Email', 'Naveed Akhtar,0300-7654321,NAVEED@example.pk', 'Shahzad Butt,042-35881122,']));
    expect(clients.status, JSON.stringify(clients.body)).toBe(201);
    expect(await prismaAdmin.client.findFirst({ where: { tenantId, phone: '+923007654321' } })).toMatchObject({ email: 'naveed@example.pk' });

    const materials = await post('/api/v1/imports/materials/preview', auth, csv(['Name,Group,Unit', 'Fauji Cement OPC,Cement,bag', 'Glass blocks,GLASS,nos', 'Cement OPC,CEMENT,bag']));
    expect(materials.body.data.rows.map((r: { errors: Array<{ column: string }> }) => r.errors.map((e) => e.column))).toEqual([[], ['group'], ['name']]);

    const subs = await post('/api/v1/imports/subcontractors/commit', auth, csv(['Name,Trade', 'Ustad Rafiq Plaster,plaster']));
    expect(subs.status, JSON.stringify(subs.body)).toBe(201);
    expect(await prismaAdmin.subcontractor.findFirst({ where: { tenantId, name: 'Ustad Rafiq Plaster' } })).toMatchObject({ trade: 'PLASTER' });
  });

  it('file problems: missing file, missing columns, wrong type, too large', async () => {
    const auth = await owner();
    const none = await api().post('/api/v1/imports/workers/preview').set(auth).send({});
    expect(none.body.error.code).toBe('FILE_REQUIRED');
    const cols = await post('/api/v1/imports/workers/preview', auth, csv(['Phone', '03001112233']));
    expect(cols.body.error).toMatchObject({ code: 'MISSING_COLUMNS', details: { missing: ['name', 'type'] } });
    const pdf = await post('/api/v1/imports/workers/preview', auth, Buffer.from('%PDF-1.4'), 'x.pdf');
    expect(pdf.body.error.code).toBe('INVALID_FILE_TYPE');
    const big = await post('/api/v1/imports/workers/preview', auth, Buffer.alloc(2 * 1024 * 1024 + 10, 0x41), 'big.csv');
    expect(big.body.error.code).toBe('FILE_TOO_LARGE');
  });

  it('needs the create permission of the entity', async () => {
    const munshi = bearer((await loginMunshi(seeded().malik.id)).accessToken);
    const res = await post('/api/v1/imports/suppliers/preview', munshi, csv(['Name,Category', 'A Traders,Cement']));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'PERMISSION_DENIED', details: { permission: 'masterdata.supplier.create' } });
    expect((await api().get('/api/v1/imports/clients/template').set(munshi)).status).toBe(403);
  });
});
