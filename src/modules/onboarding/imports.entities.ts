/**
 * Excel / CSV import — one definition per entity: the template columns (with English / Roman
 * Urdu / Urdu labels and notes), how a sheet row becomes the body of the matching create
 * endpoint (validated with THAT endpoint's Zod schema), the business rules the create
 * services enforce (worker type active, daily rate, unique phone / name, material group), and
 * the bulk insert used by commit.
 */
import type { z } from 'zod';
import type { Tx } from '../../core/db/withTenant.js';
import { createClientBody } from '../clients/clients.schema.js';
import { OTHER_WORKER_TYPE, SUBCONTRACT_KEYS } from '../master-data/catalog.js';
import { createMaterialBody, createSubcontractorBody, createSupplierBody, createWorkerBody } from '../master-data/master-data.schema.js';

export const IMPORT_ENTITIES = ['workers', 'subcontractors', 'suppliers', 'materials', 'clients'] as const;
export type ImportEntity = (typeof IMPORT_ENTITIES)[number];

export interface L3 {
  en: string;
  roman: string;
  urdu: string;
}
const L = (en: string, roman: string, urdu: string): L3 => ({ en, roman, urdu });

export interface ImportColumn {
  key: string;
  required: boolean;
  label: L3;
  note: L3;
  example: string;
  /** Kept as text in the template (phone numbers, NTN — Excel would drop the leading 0). */
  text?: boolean;
}

export interface Choice {
  value: string;
  labels: string[];
}

/** Company data the rows are checked against (loaded once per file). */
export interface Lookups {
  /** Normalised unique values already in the company (phones or names). */
  taken: Set<string>;
  workerTypes: Map<string, { key: string; ratePaisa: bigint | null; isActive: boolean }>;
  trades: Map<string, string>;
  groups: Map<string, { id: string; code: string; name: string; section: string }>;
  /** Allowed values shown on the template's Instructions sheet. */
  choices: Record<string, Choice[]>;
}

export interface CellError {
  column: string;
  message: string;
}

export interface EntityDef<S extends z.ZodType = z.ZodType> {
  entity: ImportEntity;
  /** The create endpoint's permission — an import is many creates. */
  permission: string;
  label: L3;
  columns: ImportColumn[];
  schema: S;
  /** Zod body field → template column. */
  fieldColumn: Record<string, string>;
  /** The unique column (phone / name) and the error when it is taken. */
  unique: { column: string; message: string };
  loadLookups(tx: Tx): Promise<Lookups>;
  /** Sheet values → create body (+ conversion errors). */
  toBody(values: Record<string, string>, lookups: Lookups): { body: Record<string, unknown>; errors: CellError[] };
  /** Business rules after Zod (same as the create service). */
  check?(parsed: z.output<S>, values: Record<string, string>, lookups: Lookups): CellError[];
  /** Normalised unique value of a parsed row (null = nothing to compare, e.g. no phone). */
  uniqueOf(parsed: z.output<S>): string | null;
  /** Inserts the rows; returns their ids. */
  insert(tx: Tx, a: { tenantId: string; userId: string }, rows: Array<z.output<S>>, lookups: Lookups): Promise<string[]>;
}

const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, ' ');
const opt = (v: string | undefined) => (v === undefined || v.trim() === '' ? undefined : v.trim());

/** "1,600", "Rs 1600", "1600.50" → paisa string; '' → undefined; garbage → error. */
export function rupeesToPaisa(v: string | undefined): { paisa?: string; error?: string } {
  const s = opt(v);
  if (s === undefined) return {};
  const cleaned = s.replace(/rs\.?|pkr|,|\s/gi, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return { error: 'Enter the amount in rupees, e.g. 1600' };
  return { paisa: String(Math.round(Number(cleaned) * 100)) };
}

const NAME = (example: string): ImportColumn => ({
  key: 'name',
  required: true,
  label: L('Name', 'Naam', 'نام'),
  note: L('Full name (2–80 letters).', 'Poora naam (2–80 huroof).', 'پورا نام (2 سے 80 حروف)۔'),
  example,
});
const PHONE = (required: boolean, mobileOnly: boolean): ImportColumn => ({
  key: 'phone',
  required,
  text: true,
  label: L('Phone', 'Phone number', 'فون نمبر'),
  note: mobileOnly
    ? L('Mobile number, e.g. 03001234567. Must not repeat.', 'Mobile number, misaal 03001234567. Dobara na aaye.', 'موبائل نمبر، مثلاً 03001234567۔ دوبارہ نہ آئے۔')
    : L('Mobile or landline, e.g. 03001234567 or 042-35761234.', 'Mobile ya landline, misaal 03001234567 ya 042-35761234.', 'موبائل یا لینڈ لائن، مثلاً 03001234567 یا 042-35761234۔'),
  example: mobileOnly ? '03001234567' : '042-35761234',
});
const NOTES: ImportColumn = {
  key: 'notes',
  required: false,
  label: L('Notes', 'Notes', 'نوٹس'),
  note: L('Anything else (optional).', 'Koi aur baat (zaroori nahi).', 'کوئی اور بات (اختیاری)۔'),
  example: '',
};

async function laborLookups(tx: Tx, kind: 'DAILY' | 'SUBCONTRACT') {
  return tx.laborRate.findMany({ where: { kind }, select: { key: true, label: true, labelRoman: true, labelUrdu: true, ratePaisa: true, isActive: true }, orderBy: { key: 'asc' } });
}

function emptyLookups(): Lookups {
  return { taken: new Set(), workerTypes: new Map(), trades: new Map(), groups: new Map(), choices: {} };
}

// ─── Workers ────────────────────────────────────────────────────────────────

const workers: EntityDef<typeof createWorkerBody> = {
  entity: 'workers',
  permission: 'masterdata.worker.create',
  label: L('Workers', 'Mazdoor', 'مزدور'),
  columns: [
    NAME('Ustad Akram'),
    {
      key: 'type',
      required: true,
      label: L('Worker type', 'Kaam ki qisam', 'کام کی قسم'),
      note: L('A worker type of your company (see the Instructions sheet), e.g. MISTRI or Mason.', 'Aap ki company ki worker type (Instructions sheet dekhein), misaal MISTRI.', 'آپ کی کمپنی کی ورکر ٹائپ (ہدایات شیٹ دیکھیں)، مثلاً مستری۔'),
      example: 'MISTRI',
    },
    PHONE(false, true),
    {
      key: 'dailyRate',
      required: false,
      label: L('Daily rate (Rs)', 'Dihari (Rs)', 'دیہاڑی (روپے)'),
      note: L('Rupees per day. Empty = the rate of the worker type.', 'Rozana rupay. Khaali = worker type ka rate.', 'روزانہ روپے۔ خالی = ورکر ٹائپ کا ریٹ۔'),
      example: '2800',
    },
    NOTES,
  ],
  schema: createWorkerBody,
  fieldColumn: { name: 'name', type: 'type', phone: 'phone', dailyRatePaisa: 'dailyRate', notes: 'notes' },
  unique: { column: 'phone', message: 'Another worker already has this phone number' },
  async loadLookups(tx) {
    const l = emptyLookups();
    for (const w of await tx.worker.findMany({ where: { phone: { not: null } }, select: { phone: true } })) l.taken.add(w.phone!);
    const types = await laborLookups(tx, 'DAILY');
    for (const t of types) {
      const v = { key: t.key, ratePaisa: t.ratePaisa, isActive: t.isActive };
      for (const k of [t.key, t.label, t.labelRoman, t.labelUrdu]) if (k) l.workerTypes.set(norm(k), v);
    }
    l.workerTypes.set(norm(OTHER_WORKER_TYPE), { key: OTHER_WORKER_TYPE, ratePaisa: null, isActive: true });
    l.choices['type'] = [
      ...types.filter((t) => t.isActive).map((t) => ({ value: t.key, labels: [t.label, t.labelRoman, t.labelUrdu].filter((x): x is string => Boolean(x)) })),
      { value: OTHER_WORKER_TYPE, labels: ['Other (daily rate required)'] },
    ];
    return l;
  },
  toBody(v, l) {
    const errors: CellError[] = [];
    const rate = rupeesToPaisa(v['dailyRate']);
    if (rate.error) errors.push({ column: 'dailyRate', message: rate.error });
    const typeText = opt(v['type']);
    const type = typeText ? (l.workerTypes.get(norm(typeText))?.key ?? typeText.toUpperCase().replace(/[\s-]+/g, '_')) : undefined;
    return { body: { name: v['name'], type, phone: opt(v['phone']), dailyRatePaisa: rate.paisa, notes: opt(v['notes']) }, errors };
  },
  uniqueOf: (p) => p.phone ?? null,
  async insert(tx, a, rows, l) {
    const created = await tx.worker.createManyAndReturn({
      data: rows.map((r) => ({
        tenantId: a.tenantId,
        name: r.name,
        type: r.type,
        phone: r.phone ?? null,
        dailyRatePaisa: r.dailyRatePaisa ?? l.workerTypes.get(norm(r.type))?.ratePaisa ?? 0n,
        notes: r.notes ?? null,
        createdById: a.userId,
      })),
      select: { id: true },
    });
    return created.map((c) => c.id);
  },
};

// Worker rules from createWorkerTx: an ACTIVE type (or OTHER), and a daily rate when the type has none.
workers.check = (parsed, _values, l) => {
  const type = l.workerTypes.get(norm(parsed.type));
  if (!type) return [{ column: 'type', message: 'Unknown worker type — use one from the Instructions sheet' }];
  if (!type.isActive) return [{ column: 'type', message: 'This worker type is no longer active' }];
  if (parsed.dailyRatePaisa === undefined && type.ratePaisa === null) return [{ column: 'dailyRate', message: 'Enter a daily rate — there is no labour rate for this worker type' }];
  return [];
};

// ─── Sub-contractors ────────────────────────────────────────────────────────

const subcontractors: EntityDef<typeof createSubcontractorBody> = {
  entity: 'subcontractors',
  permission: 'masterdata.subcontractor.create',
  label: L('Sub-contractors', 'Thekedar (sub)', 'ذیلی ٹھیکیدار'),
  columns: [
    NAME('Ustad Sharif Shuttering'),
    {
      key: 'trade',
      required: true,
      label: L('Trade', 'Kaam', 'کام'),
      note: L('One of the trades on the Instructions sheet, e.g. SHUTTERING.', 'Instructions sheet wala kaam, misaal SHUTTERING.', 'ہدایات شیٹ والا کام، مثلاً شٹرنگ۔'),
      example: 'SHUTTERING',
    },
    PHONE(false, false),
    NOTES,
  ],
  schema: createSubcontractorBody,
  fieldColumn: { name: 'name', trade: 'trade', phone: 'phone', notes: 'notes' },
  unique: { column: 'name', message: 'A sub-contractor with this name already exists' },
  async loadLookups(tx) {
    const l = emptyLookups();
    for (const s of await tx.subcontractor.findMany({ select: { name: true } })) l.taken.add(norm(s.name));
    const rates = await laborLookups(tx, 'SUBCONTRACT');
    for (const k of SUBCONTRACT_KEYS) l.trades.set(norm(k), k);
    for (const r of rates) if ((SUBCONTRACT_KEYS as readonly string[]).includes(r.key)) for (const k of [r.label, r.labelRoman, r.labelUrdu]) if (k) l.trades.set(norm(k), r.key);
    l.choices['trade'] = SUBCONTRACT_KEYS.map((k) => {
      const r = rates.find((x) => x.key === k);
      return { value: k, labels: r ? [r.label, r.labelRoman, r.labelUrdu].filter((x): x is string => Boolean(x)) : [] };
    });
    return l;
  },
  toBody(v, l) {
    const t = opt(v['trade']);
    return { body: { name: v['name'], trade: t ? (l.trades.get(norm(t)) ?? t.toUpperCase().replace(/[\s-]+/g, '_')) : undefined, phone: opt(v['phone']), notes: opt(v['notes']) }, errors: [] };
  },
  uniqueOf: (p) => norm(p.name),
  async insert(tx, a, rows) {
    const created = await tx.subcontractor.createManyAndReturn({
      data: rows.map((r) => ({ tenantId: a.tenantId, name: r.name, trade: r.trade, phone: r.phone ?? null, notes: r.notes ?? null })),
      select: { id: true },
    });
    return created.map((c) => c.id);
  },
};

// ─── Suppliers ──────────────────────────────────────────────────────────────

const suppliers: EntityDef<typeof createSupplierBody> = {
  entity: 'suppliers',
  permission: 'masterdata.supplier.create',
  label: L('Suppliers', 'Suppliers', 'سپلائرز'),
  columns: [
    NAME('Al-Madina Cement Agency'),
    {
      key: 'category',
      required: true,
      label: L('Category', 'Kis cheez ka supplier', 'کیٹیگری'),
      note: L('What they supply, e.g. Cement, Steel, Sand & Bajri.', 'Kya dete hain, misaal Cement, Sarya, Ret bajri.', 'کیا دیتے ہیں، مثلاً سیمنٹ، سریا، ریت بجری۔'),
      example: 'Cement',
    },
    PHONE(false, false),
    { key: 'city', required: false, label: L('City', 'Shehar', 'شہر'), note: L('City (optional).', 'Shehar (zaroori nahi).', 'شہر (اختیاری)۔'), example: 'Lahore' },
    { key: 'address', required: false, label: L('Address', 'Pata', 'پتہ'), note: L('Shop address (optional).', 'Dukaan ka pata (zaroori nahi).', 'دکان کا پتہ (اختیاری)۔'), example: '' },
    { key: 'ntn', required: false, text: true, label: L('NTN', 'NTN', 'این ٹی این'), note: L('National Tax Number like 1234567-8 (optional).', 'NTN jaise 1234567-8 (zaroori nahi).', 'این ٹی این جیسے 1234567-8 (اختیاری)۔'), example: '' },
    NOTES,
  ],
  schema: createSupplierBody,
  fieldColumn: { name: 'name', category: 'category', phone: 'phone', city: 'city', address: 'address', ntn: 'ntn', notes: 'notes' },
  unique: { column: 'name', message: 'A supplier with this name already exists' },
  async loadLookups(tx) {
    const l = emptyLookups();
    for (const s of await tx.supplier.findMany({ select: { name: true } })) l.taken.add(norm(s.name));
    return l;
  },
  toBody: (v) => ({
    body: { name: v['name'], category: v['category'], phone: opt(v['phone']), city: opt(v['city']), address: opt(v['address']), ntn: opt(v['ntn']), notes: opt(v['notes']) },
    errors: [],
  }),
  uniqueOf: (p) => norm(p.name),
  async insert(tx, a, rows) {
    const created = await tx.supplier.createManyAndReturn({
      data: rows.map((r) => ({ tenantId: a.tenantId, name: r.name, category: r.category, phone: r.phone ?? null, city: r.city ?? null, address: r.address ?? null, ntn: r.ntn ?? null, notes: r.notes ?? null })),
      select: { id: true },
    });
    return created.map((c) => c.id);
  },
};

// ─── Materials (custom) ─────────────────────────────────────────────────────

const materials: EntityDef<typeof createMaterialBody> = {
  entity: 'materials',
  permission: 'masterdata.material.create',
  label: L('Materials', 'Material', 'میٹیریل'),
  columns: [
    NAME('Cement Fauji OPC'),
    {
      key: 'group',
      required: true,
      label: L('Group', 'Group', 'گروپ'),
      note: L('A material group from the Instructions sheet, e.g. CEMENT or Cement.', 'Instructions sheet wala group, misaal CEMENT.', 'ہدایات شیٹ والا گروپ، مثلاً سیمنٹ۔'),
      example: 'CEMENT',
    },
    { key: 'unit', required: true, label: L('Unit', 'Unit (paimana)', 'یونٹ'), note: L('How it is counted, e.g. bag, nos, cft, ton.', 'Kaise gina jata hai, misaal bag, nos, cft.', 'کیسے گنا جاتا ہے، مثلاً بوری، عدد، مکعب فٹ۔'), example: 'bag' },
    { key: 'unitDetail', required: false, label: L('Unit detail', 'Unit tafseel', 'یونٹ تفصیل'), note: L('e.g. 1 bag = 50 kg (optional).', 'Misaal 1 bag = 50 kg (zaroori nahi).', 'مثلاً 1 بوری = 50 کلو (اختیاری)۔'), example: '1 bag = 50 kg' },
    {
      key: 'supplyCategory',
      required: false,
      label: L('Supply category', 'Supply category', 'سپلائی کیٹیگری'),
      note: L('GREY_STRUCTURE or FINISHING. Empty = from the group.', 'GREY_STRUCTURE ya FINISHING. Khaali = group se.', 'گرے اسٹرکچر یا فنشنگ۔ خالی = گروپ سے۔'),
      example: '',
    },
  ],
  schema: createMaterialBody,
  fieldColumn: { name: 'name', groupId: 'group', unit: 'unit', unitDetail: 'unitDetail', supplyCategory: 'supplyCategory' },
  unique: { column: 'name', message: 'A material with this name already exists' },
  async loadLookups(tx) {
    const l = emptyLookups();
    for (const m of await tx.material.findMany({ select: { name: true } })) l.taken.add(norm(m.name));
    const groups = await tx.materialGroup.findMany({ orderBy: { sortOrder: 'asc' } });
    for (const g of groups) for (const k of [g.code, g.name]) l.groups.set(norm(k), { id: g.id, code: g.code, name: g.name, section: g.section });
    l.choices['group'] = groups.map((g) => ({ value: g.code, labels: [g.name] }));
    l.choices['supplyCategory'] = [
      { value: 'GREY_STRUCTURE', labels: ['Grey structure'] },
      { value: 'FINISHING', labels: ['Finishing'] },
    ];
    return l;
  },
  toBody(v, l) {
    const errors: CellError[] = [];
    const g = opt(v['group']);
    const group = g ? l.groups.get(norm(g)) : undefined;
    if (g && !group) errors.push({ column: 'group', message: 'Unknown material group — use one from the Instructions sheet' });
    const sc = opt(v['supplyCategory']);
    return {
      body: {
        name: v['name'],
        // A placeholder id keeps Zod from reporting the group twice when it is unknown.
        groupId: group?.id ?? (g ? '00000000-0000-7000-8000-000000000000' : undefined),
        unit: v['unit'],
        unitDetail: opt(v['unitDetail']),
        supplyCategory: sc ? sc.toUpperCase().replace(/[\s-]+/g, '_') : undefined,
      },
      errors,
    };
  },
  uniqueOf: (p) => norm(p.name),
  async insert(tx, a, rows, l) {
    const sections = new Map([...l.groups.values()].map((g) => [g.id, g.section]));
    const created = await tx.material.createManyAndReturn({
      data: rows.map((r) => ({
        tenantId: a.tenantId,
        groupId: r.groupId,
        name: r.name,
        unit: r.unit,
        unitDetail: r.unitDetail ?? null,
        altUnits: r.altUnits,
        supplyCategory: r.supplyCategory ?? (sections.get(r.groupId) === 'CIVIL' ? 'GREY_STRUCTURE' : 'FINISHING'),
        source: 'COMPANY' as const,
        createdById: a.userId,
      })),
      select: { id: true },
    });
    return created.map((c) => c.id);
  },
};

// ─── Clients ────────────────────────────────────────────────────────────────

const clients: EntityDef<typeof createClientBody> = {
  entity: 'clients',
  permission: 'clients.client.create',
  label: L('Clients', 'Clients (maalikaan)', 'کلائنٹس'),
  columns: [
    NAME('Ahmed Raza'),
    { ...PHONE(true, false), note: L('Mobile or landline; each client once.', 'Mobile ya landline; har client ek dafa.', 'موبائل یا لینڈ لائن؛ ہر کلائنٹ ایک بار۔'), example: '03331234567' },
    { key: 'email', required: false, label: L('Email', 'Email', 'ای میل'), note: L('Email (optional).', 'Email (zaroori nahi).', 'ای میل (اختیاری)۔'), example: '' },
    { key: 'address', required: false, label: L('Address', 'Pata', 'پتہ'), note: L('Address (optional).', 'Pata (zaroori nahi).', 'پتہ (اختیاری)۔'), example: 'House 12, Block B, Gulberg III, Lahore' },
    NOTES,
  ],
  schema: createClientBody,
  fieldColumn: { name: 'name', phone: 'phone', email: 'email', address: 'address', notes: 'notes' },
  unique: { column: 'phone', message: 'Another client already has this phone number' },
  async loadLookups(tx) {
    const l = emptyLookups();
    for (const c of await tx.client.findMany({ select: { phone: true } })) l.taken.add(c.phone);
    return l;
  },
  toBody: (v) => ({ body: { name: v['name'], phone: v['phone'], email: opt(v['email']), address: opt(v['address']), notes: opt(v['notes']) }, errors: [] }),
  uniqueOf: (p) => p.phone,
  async insert(tx, a, rows) {
    const created = await tx.client.createManyAndReturn({
      data: rows.map((r) => ({ tenantId: a.tenantId, name: r.name, phone: r.phone, email: r.email ?? null, address: r.address ?? null, notes: r.notes ?? null, createdById: a.userId })),
      select: { id: true },
    });
    return created.map((c) => c.id);
  },
};

export const ENTITY_DEFS: Record<ImportEntity, EntityDef> = {
  workers: workers as unknown as EntityDef,
  subcontractors: subcontractors as unknown as EntityDef,
  suppliers: suppliers as unknown as EntityDef,
  materials: materials as unknown as EntityDef,
  clients: clients as unknown as EntityDef,
};
