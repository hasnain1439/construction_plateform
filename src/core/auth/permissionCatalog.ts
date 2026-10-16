/**
 * THE permission catalogue — the single source of every company permission key.
 *
 * Key format `<module>.<resource>.<action>`; actions are view / create / edit / approve / manage
 * (manage = settings, configuration and owner-level corrections). `fields.*` keys are FIELD
 * permissions: they don't open routes, they decide which values serializers keep (rates, money
 * amounts, profit, contract values) — on REST and in offline sync.
 *
 * - THEKEDAR (owner) always has every key, with scope ALL_PROJECTS and no approval limit.
 * - `ownerOnly` keys can never be granted to anyone else (roles or overrides).
 * - `scoped` keys are about project data: a grant says ASSIGNED_PROJECTS (default) or ALL_PROJECTS.
 * - `limit` keys accept an optional `maxAmountPaisa` (approval limit); above it → 403
 *   APPROVAL_LIMIT_EXCEEDED (the owner approves).
 *
 * The default role templates ("Administrator", "Project Manager", "Munshi", …) are defined at the
 * bottom. Project Manager / Munshi reproduce the access the old role checks gave (see
 * tests/permissions/parity.test.ts); Administrator = every key except the ownerOnly ones.
 */

export interface PermissionLabel {
  en: string;
  roman: string;
  urdu: string;
}

export interface PermissionDef {
  key: string;
  module: PermissionModule;
  label: PermissionLabel;
  description: string;
  ownerOnly?: boolean;
  scoped?: boolean;
  limit?: boolean;
  /** FIELD permission (data visibility) rather than an action. */
  field?: boolean;
}

export const PERMISSION_MODULES = {
  projects: { en: 'Projects', roman: 'Projects', urdu: 'پراجیکٹس' },
  clients: { en: 'Clients', roman: 'Clients (maalikaan)', urdu: 'کلائنٹس' },
  labor: { en: 'Labour', roman: 'Mazdoor / Labour', urdu: 'مزدور' },
  cashbook: { en: 'Site cash', roman: 'Site cash (kharcha)', urdu: 'سائٹ کیش' },
  procurement: { en: 'Purchases & dispatch', roman: 'Khareedari aur dispatch', urdu: 'خریداری اور ڈسپیچ' },
  inventory: { en: 'Stock', roman: 'Stock (maal)', urdu: 'اسٹاک' },
  billing: { en: 'Billing', roman: 'Billing', urdu: 'بلنگ' },
  finance: { en: 'Finance & reports', roman: 'Finance aur reports', urdu: 'فنانس اور رپورٹس' },
  dashboard: { en: 'Dashboards', roman: 'Dashboard', urdu: 'ڈیش بورڈ' },
  approvals: { en: 'Approvals', roman: 'Approvals (manzoori)', urdu: 'منظوریاں' },
  dailylog: { en: 'Daily logs', roman: 'Rozana log', urdu: 'روزانہ لاگ' },
  masterdata: { en: 'Master data', roman: 'Master data', urdu: 'ماسٹر ڈیٹا' },
  team: { en: 'Team', roman: 'Team', urdu: 'ٹیم' },
  company: { en: 'Company', roman: 'Company', urdu: 'کمپنی' },
  subscription: { en: 'Subscription', roman: 'Subscription', urdu: 'سبسکرپشن' },
  fields: { en: 'Data visibility', roman: 'Kya nazar aaye', urdu: 'کیا نظر آئے' },
  // Step 11
  estimate: { en: 'Estimates', roman: 'Estimate (takhmeena)', urdu: 'تخمینہ' },
  rulebook: { en: 'Estimation rulebook', roman: 'Estimate ke qawaid', urdu: 'تخمینے کے قواعد' },
} as const satisfies Record<string, PermissionLabel>;

export type PermissionModule = keyof typeof PERMISSION_MODULES;

const L = (en: string, roman: string, urdu: string): PermissionLabel => ({ en, roman, urdu });
type Opts = Pick<PermissionDef, 'ownerOnly' | 'scoped' | 'limit' | 'field'>;
const def = (key: string, label: PermissionLabel, description: string, opts: Opts = {}): PermissionDef => ({
  key,
  module: key.split('.')[0] as PermissionModule,
  label,
  description,
  ...opts,
});
const S = { scoped: true } as const;
const SL = { scoped: true, limit: true } as const;

export const PERMISSION_CATALOG: readonly PermissionDef[] = [
  // ─── Projects ──────────────────────────────────────────────────────────────
  def('projects.project.view', L('View projects', 'Projects dekhna', 'پراجیکٹس دیکھنا'), 'Project list and detail, floors.', S),
  def('projects.project.create', L('Create projects', 'Naya project banana', 'نیا پراجیکٹ بنانا'), 'Start a draft project (the creator is assigned to it).'),
  def('projects.project.edit', L('Edit projects', 'Project mein tabdeeli', 'پراجیکٹ میں تبدیلی'), 'Wizard tabs (basic, contract, plot & structure, coverage), floors, rooms, openings, review.', S),
  def('projects.project.approve', L('Activate projects', 'Project activate karna', 'پراجیکٹ ایکٹیویٹ کرنا'), 'Activate a reviewed draft (counts against the plan).', S),
  def('projects.project.manage', L('Change project status / delete drafts', 'Project ka status / draft delete', 'پراجیکٹ کا اسٹیٹس / ڈرافٹ ڈیلیٹ'), 'Close-out, hand over, close, reopen; delete a draft.', S),
  def('projects.team.manage', L('Assign project team', 'Project team muqarrar karna', 'پراجیکٹ ٹیم مقرر کرنا'), 'Choose the PM and munshis of a project.', S),
  def('projects.estimate.view', L('View estimate (BoQ)', 'Estimate (BoQ) dekhna', 'تخمینہ (BoQ) دیکھنا'), 'Grey-structure material estimate of a project (rates and amounts follow the data-visibility permissions).', S),
  def('projects.estimate.manage', L('Change estimate settings', 'Estimate ki settings badalna', 'تخمینے کی سیٹنگز بدلنا'), 'Change the assumptions of a project estimate (wall / slab thickness, mixes, steel, wastage, labour rate); generate / regenerate draft estimate revisions and change their lines.', S),

  // ─── Step 11 · Estimates + rulebook ────────────────────────────────────────
  def('estimate.revision.approve', L('Approve estimates', 'Estimate manzoor karna', 'تخمینہ منظور کرنا'), 'Approve a draft estimate revision: its rates and rulebook are frozen and the previous approved revision is superseded.', S),
  def('rulebook.override.view', L('View estimation rulebook', 'Estimate ke qawaid dekhna', 'تخمینے کے قواعد دیکھنا'), 'The rule-of-thumb values the estimates use (platform rulebook + company values).'),
  def('rulebook.override.manage', L('Change company rulebook values', 'Company ke qawaid badalna', 'کمپنی کے قواعد بدلنا'), 'Set the company own values for rulebook parameters (within the safe range).'),

  // ─── Clients ───────────────────────────────────────────────────────────────
  def('clients.client.view', L('View clients', 'Clients dekhna', 'کلائنٹس دیکھنا'), 'Project owners (clients) list and detail.'),
  def('clients.client.create', L('Add clients', 'Client shamil karna', 'کلائنٹ شامل کرنا'), 'Add a client.'),
  def('clients.client.edit', L('Edit clients', 'Client mein tabdeeli', 'کلائنٹ میں تبدیلی'), 'Change a client.'),

  // ─── Labour ────────────────────────────────────────────────────────────────
  def('labor.team.view', L('View team on site', 'Site ki team dekhna', 'سائٹ کی ٹیم دیکھنا'), 'Workers and sub-contractors assigned to a project.', S),
  def('labor.team.create', L('Add workers to a project', 'Mazdoor project mein dalna', 'مزدور پراجیکٹ میں ڈالنا'), 'Assign a worker to a project.', S),
  def('labor.team.edit', L('Change / remove project workers', 'Project mazdoor tabdeel / hatana', 'پراجیکٹ مزدور تبدیل / ہٹانا'), 'Rate override, end or remove a project worker.', S),
  def('labor.attendance.view', L('View hazri', 'Hazri dekhna', 'حاضری دیکھنا'), 'Attendance grid and today’s hazri.', S),
  def('labor.attendance.create', L('Mark hazri', 'Hazri lagana', 'حاضری لگانا'), 'Mark or change attendance (offline-safe).', S),
  def('labor.measurement.view', L('View work measurements', 'Naap (measurement) dekhna', 'پیمائش دیکھنا'), 'Measured work of sub-contractors.', S),
  def('labor.measurement.create', L('Record work measurements', 'Naap darj karna', 'پیمائش درج کرنا'), 'Record measured work.', S),
  def('labor.measurement.approve', L('Verify measurements', 'Naap verify karna', 'پیمائش کی تصدیق'), 'Verify or reject measured work (adds work value).', SL),
  def('labor.advance.view', L('View peshgi', 'Peshgi dekhna', 'پیشگی دیکھنا'), 'Advances given to workers and sub-contractors.', S),
  def('labor.advance.create', L('Give peshgi', 'Peshgi dena', 'پیشگی دینا'), 'Record an advance.', S),
  def('labor.settlement.view', L('View wage settlements', 'Hafta wari hisaab dekhna', 'ہفتہ وار حساب دیکھنا'), 'Weekly wage settlements of a project.', S),
  def('labor.settlement.create', L('Prepare wage settlements', 'Hafta wari hisaab banana', 'ہفتہ وار حساب بنانا'), 'Generate and submit a weekly settlement.', S),
  def('labor.settlement.edit', L('Adjust settlement lines', 'Hisaab ki line tabdeel karna', 'حساب کی لائن تبدیل کرنا'), 'Change days / overtime / peshgi of a settlement line.', S),
  def('labor.settlement.approve', L('Approve wage settlements', 'Hafta wari hisaab manzoor karna', 'ہفتہ وار حساب منظور کرنا'), 'Approve or return a settlement; company-wide settlement list.', SL),
  def('labor.wagepayment.create', L('Pay wages', 'Mazdoori ada karna', 'مزدوری ادا کرنا'), 'Pay an approved settlement (site cash for site staff).', S),
  def('labor.subcontract.create', L('Assign sub-contractors', 'Theka dena', 'ٹھیکہ دینا'), 'Assign a sub-contractor to a project.', S),
  def('labor.subcontract.edit', L('Edit sub-contracts', 'Theka tabdeel karna', 'ٹھیکہ تبدیل کرنا'), 'Change an assignment, record lump-sum progress.', S),
  def('labor.subcontractpayment.create', L('Pay sub-contractors', 'Thekedar ko adayegi', 'ٹھیکیدار کو ادائیگی'), 'Pay a sub-contractor (a company setting can still stop non-owners).', S),
  def('labor.subcontract.manage', L('Sub-contractor deductions', 'Theke se katauti', 'ٹھیکے سے کٹوتی'), 'Deduct from a sub-contractor, charge a shortage loss to one.', S),
  def('labor.account.view', L('View sub-contract accounts', 'Thekon ka hisaab dekhna', 'ٹھیکوں کا حساب دیکھنا'), 'Sub-contract accounts and ledgers, worker / sub-contractor summaries.', S),

  // ─── Site cash ─────────────────────────────────────────────────────────────
  def('cashbook.account.view', L('View cash accounts', 'Cash account dekhna', 'کیش اکاؤنٹ دیکھنا'), 'Cash accounts, entries, counts and project cash book (own account for site staff); acknowledge a float.', S),
  def('cashbook.float.view', L('View cash floats', 'Cash floats dekhna', 'کیش فلوٹس دیکھنا'), 'Who holds how much site cash (finance → cash floats).', S),
  def('cashbook.float.manage', L('Send cash floats', 'Cash float bhejna', 'کیش فلوٹ بھیجنا'), 'Send cash to a munshi or project manager.'),
  def('cashbook.expense.view', L('View kharcha', 'Kharcha dekhna', 'خرچہ دیکھنا'), 'Site expenses.', S),
  def('cashbook.expense.create', L('Add kharcha', 'Kharcha darj karna', 'خرچہ درج کرنا'), 'Record a site expense.', S),
  def('cashbook.expense.approve', L('Approve kharcha', 'Kharcha manzoor karna', 'خرچہ منظور کرنا'), 'Approve or reject kharcha above the company limit.', SL),
  def('cashbook.topup.view', L('View top-up requests', 'Top-up darkhwast dekhna', 'ٹاپ اپ درخواست دیکھنا'), 'Requests for more site cash.', S),
  def('cashbook.topup.create', L('Ask for a top-up', 'Top-up mangna', 'ٹاپ اپ مانگنا'), 'Ask the owner for more cash.', S),
  def('cashbook.topup.approve', L('Approve top-ups', 'Top-up manzoor karna', 'ٹاپ اپ منظور کرنا'), 'Send or reject a requested top-up.', { limit: true }),
  def('cashbook.count.create', L('Count cash', 'Cash ginna', 'کیش گننا'), 'Record a cash count.', S),
  def('cashbook.handover.create', L('Hand over cash', 'Cash hawale karna', 'کیش حوالے کرنا'), 'Hand cash over to another holder.', S),

  // ─── Purchases & dispatch ──────────────────────────────────────────────────
  def('procurement.order.view', L('View purchase orders', 'Purchase orders dekhna', 'پرچیز آرڈرز دیکھنا'), 'Purchase orders.', S),
  def('procurement.order.create', L('Manage purchase orders', 'Purchase order banana', 'پرچیز آرڈر بنانا'), 'Create, change and cancel purchase orders.', S),
  def('procurement.purchase.view', L('View purchases', 'Khareedari dekhna', 'خریداری دیکھنا'), 'Purchases (site staff: their sites’ deliveries, no rates).', S),
  def('procurement.purchase.create', L('Record purchases', 'Khareedari darj karna', 'خریداری درج کرنا'), 'Record a purchase (site staff: site purchase without rates).', S),
  def('procurement.purchase.edit', L('Set purchase rates', 'Khareedari ke rate lagana', 'خریداری کے ریٹ لگانا'), 'Set the rates of a pending-rate purchase.', S),
  def('procurement.purchase.manage', L('Correct purchases', 'Khareedari durust karna', 'خریداری درست کرنا'), 'Corrections to saved purchases.', S),
  def('procurement.return.view', L('View purchase returns', 'Wapsi dekhna', 'واپسی دیکھنا'), 'Returns to suppliers.', S),
  def('procurement.return.create', L('Return to supplier', 'Supplier ko wapsi', 'سپلائر کو واپسی'), 'Return purchased material.', S),
  def('procurement.receiving.create', L('Receive deliveries', 'Maal wasool karna', 'مال وصول کرنا'), 'Receive a dispatch or a site delivery (count).', S),
  def('procurement.dispatch.view', L('View dispatches', 'Dispatch dekhna', 'ڈسپیچ دیکھنا'), 'Dispatches and incoming material.', S),
  def('procurement.dispatch.create', L('Dispatch material', 'Maal bhejna', 'مال بھیجنا'), 'Send material to a site, cancel a dispatch.', S),
  def('procurement.shortage.view', L('View shortages', 'Kami dekhna', 'کمی دیکھنا'), 'Shortages found on receiving.', S),
  def('procurement.shortage.approve', L('Resolve shortages', 'Kami ka faisla', 'کمی کا فیصلہ'), 'Decide what happens to a shortage.', S),
  def('procurement.ledger.view', L('View supplier ledger', 'Supplier khata dekhna', 'سپلائر کھاتہ دیکھنا'), 'Supplier ledger and udhaar.'),
  def('procurement.payment.view', L('View supplier payments', 'Supplier adayegi dekhna', 'سپلائر ادائیگی دیکھنا'), 'Payments made to suppliers.'),
  def('procurement.payment.create', L('Pay suppliers', 'Supplier ko adayegi', 'سپلائر کو ادائیگی'), 'Record a supplier payment.', { limit: true }),
  def('procurement.payment.manage', L('Supplier cheque status', 'Supplier cheque status', 'سپلائر چیک اسٹیٹس'), 'Mark supplier cheques cleared or bounced.'),

  // ─── Stock ─────────────────────────────────────────────────────────────────
  def('inventory.stock.view', L('View site stock', 'Site ka stock dekhna', 'سائٹ کا اسٹاک دیکھنا'), 'Stock locations, project stock, material usage.', S),
  def('inventory.store.view', L('View store stock', 'Store ka stock dekhna', 'اسٹور کا اسٹاک دیکھنا'), 'Central store stock and the movement log.'),
  def('inventory.store.manage', L('Manage the store', 'Store ka intezam', 'اسٹور کا انتظام'), 'Low-stock levels, counting the central store, dispatching from it.'),
  def('inventory.count.view', L('View stock counts', 'Stock ginti dekhna', 'اسٹاک گنتی دیکھنا'), 'Stock counts.', S),
  def('inventory.count.create', L('Count stock', 'Stock ginna', 'اسٹاک گننا'), 'Record a site stock count.', S),
  def('inventory.usage.create', L('Record material usage', 'Maal ka istemal darj karna', 'مال کا استعمال درج کرنا'), 'Record material used on site.', S),
  def('inventory.ownerdelivery.view', L('View owner deliveries', 'Maalik ka maal dekhna', 'مالک کا مال دیکھنا'), 'Material delivered by the client.', S),
  def('inventory.ownerdelivery.create', L('Record owner deliveries', 'Maalik ka maal darj karna', 'مالک کا مال درج کرنا'), 'Record material delivered by the client.', S),

  // ─── Billing ───────────────────────────────────────────────────────────────
  def('billing.invoice.view', L('View billing', 'Billing dekhna', 'بلنگ دیکھنا'), 'Billing stages, running-bill progress, invoices, project receivables, owner statement.', S),
  def('billing.invoice.create', L('Prepare invoices', 'Bill tayyar karna', 'بل تیار کرنا'), 'Mark stages ready, running-bill progress, draft invoices.', S),
  def('billing.invoice.approve', L('Issue / cancel invoices', 'Bill jari / mansookh karna', 'بل جاری / منسوخ کرنا'), 'Issue or cancel invoices.', SL),
  def('billing.stage.manage', L('Edit billing stages', 'Billing stages tabdeel karna', 'بلنگ اسٹیجز تبدیل کرنا'), 'Change a billing stage.', S),
  def('billing.payment.view', L('View owner payments', 'Maalik ki adayegi dekhna', 'مالک کی ادائیگی دیکھنا'), 'Payments received from clients, receipts.', S),
  def('billing.payment.create', L('Record owner payments', 'Maalik ki adayegi darj karna', 'مالک کی ادائیگی درج کرنا'), 'Record a client payment (a company setting can still stop non-owners).', S),
  def('billing.payment.manage', L('Owner cheque status', 'Maalik ka cheque status', 'مالک کا چیک اسٹیٹس'), 'Mark client cheques cleared or bounced.', S),

  // ─── Finance & reports ─────────────────────────────────────────────────────
  def('finance.receivables.view', L('Company receivables', 'Company ki wasooliyan', 'کمپنی کی وصولیاں'), 'Receivables and ageing across all projects, billing events.'),
  def('finance.cashflow.view', L('Cash-flow outlook', 'Cash-flow andaza', 'کیش فلو اندازہ'), 'Cash-flow outlook.'),
  def('finance.pnl.view', L('Profit & loss', 'Nafa nuqsan', 'نفع نقصان'), 'P&L of projects.', S),
  def('finance.reports.view', L('Reports', 'Reports', 'رپورٹس'), 'Project reports (money columns follow the data-visibility permissions).', S),
  def('finance.companyreports.view', L('Company money reports', 'Company ki maali reports', 'کمپنی کی مالی رپورٹس'), 'Supplier ageing, receivables ageing and stock valuation reports.'),

  // ─── Dashboards / approvals / daily logs ───────────────────────────────────
  def('dashboard.overview.view', L('Office dashboard', 'Office dashboard', 'آفس ڈیش بورڈ'), 'Company overview and labour overview.', S),
  def('dashboard.site.view', L('Site dashboard', 'Site dashboard', 'سائٹ ڈیش بورڈ'), 'The site dashboard of a project.', S),
  def('approvals.inbox.view', L('Approvals inbox', 'Approvals inbox', 'منظوریوں کا ان باکس'), 'One inbox of everything waiting (items follow the matching approve permissions).', S),
  def('dailylog.log.view', L('View daily logs', 'Rozana log dekhna', 'روزانہ لاگ دیکھنا'), 'Daily logs of a project.', S),
  def('dailylog.log.create', L('Write daily logs', 'Rozana log likhna', 'روزانہ لاگ لکھنا'), 'Write or change your daily log.', S),

  // ─── Master data ───────────────────────────────────────────────────────────
  def('masterdata.material.view', L('View materials', 'Materials dekhna', 'میٹیریلز دیکھنا'), 'Material list (never rates).'),
  def('masterdata.material.create', L('Add materials', 'Material shamil karna', 'میٹیریل شامل کرنا'), 'Add custom materials.'),
  def('masterdata.material.edit', L('Edit materials', 'Material tabdeel karna', 'میٹیریل تبدیل کرنا'), 'Change materials, see hidden ones.'),
  def('masterdata.material.manage', L('Hide / delete materials', 'Material chupana / delete', 'میٹیریل چھپانا / ڈیلیٹ'), 'Hide, show or delete materials.'),
  def('masterdata.pricelist.view', L('View price list', 'Rate list dekhna', 'ریٹ لسٹ دیکھنا'), 'Quality categories, material rates and rate history.'),
  def('masterdata.pricelist.manage', L('Manage price list', 'Rate list ka intezam', 'ریٹ لسٹ کا انتظام'), 'Quality categories and material rates.'),
  def('masterdata.laborrate.view', L('View labour rates', 'Mazdoori rates dekhna', 'مزدوری ریٹس دیکھنا'), 'Labour rates and worker types.'),
  def('masterdata.laborrate.manage', L('Manage labour rates', 'Mazdoori rates ka intezam', 'مزدوری ریٹس کا انتظام'), 'Labour rates and worker types.'),
  def('masterdata.template.view', L('View payment templates', 'Payment templates dekhna', 'پیمنٹ ٹیمپلیٹس دیکھنا'), 'Billing-stage payment templates.'),
  def('masterdata.template.manage', L('Manage payment templates', 'Payment templates ka intezam', 'پیمنٹ ٹیمپلیٹس کا انتظام'), 'Create, change and delete payment templates.'),
  def('masterdata.supplier.view', L('View suppliers', 'Suppliers dekhna', 'سپلائرز دیکھنا'), 'Supplier list and detail, supplier rates (rates also need fields.rates).'),
  def('masterdata.supplier.create', L('Add suppliers', 'Supplier shamil karna', 'سپلائر شامل کرنا'), 'Add a supplier.'),
  def('masterdata.supplier.edit', L('Edit suppliers', 'Supplier tabdeel karna', 'سپلائر تبدیل کرنا'), 'Change a supplier.'),
  def('masterdata.supplier.manage', L('Manage suppliers', 'Suppliers ka intezam', 'سپلائرز کا انتظام'), 'Activate / deactivate suppliers, set supplier rates.'),
  def('masterdata.worker.view', L('View workers', 'Mazdoor dekhna', 'مزدور دیکھنا'), 'Workers directory.'),
  def('masterdata.worker.create', L('Add workers', 'Naya mazdoor', 'نیا مزدور'), 'Add a worker.'),
  def('masterdata.worker.edit', L('Edit workers', 'Mazdoor tabdeel karna', 'مزدور تبدیل کرنا'), 'Change, deactivate and activate workers.'),
  def('masterdata.subcontractor.view', L('View sub-contractors', 'Thekedar (sub) dekhna', 'ذیلی ٹھیکیدار دیکھنا'), 'Sub-contractor list.'),
  def('masterdata.subcontractor.create', L('Add sub-contractors', 'Thekedar (sub) shamil karna', 'ذیلی ٹھیکیدار شامل کرنا'), 'Add a sub-contractor.'),
  def('masterdata.subcontractor.edit', L('Edit sub-contractors', 'Thekedar (sub) tabdeel karna', 'ذیلی ٹھیکیدار تبدیل کرنا'), 'Change, deactivate and activate sub-contractors.'),

  // ─── Team / company / subscription ─────────────────────────────────────────
  def('team.member.view', L('View team members', 'Team dekhna', 'ٹیم دیکھنا'), 'List of company users.'),
  def('team.member.manage', L('Manage team & permissions', 'Team aur ijazat ka intezam', 'ٹیم اور اجازت کا انتظام'), 'Invite, edit, deactivate users, devices, roles and permissions (never an owner, never owner-only permissions).'),
  def('company.profile.view', L('View company profile', 'Company profile dekhna', 'کمپنی پروفائل دیکھنا'), 'Company name, NTN, logo, contact.'),
  def('company.settings.manage', L('Company profile & settings', 'Company profile aur settings', 'کمپنی پروفائل اور سیٹنگز'), 'Change the company profile and settings.', { ownerOnly: true }),
  def('company.audit.view', L('View audit log', 'Audit log dekhna', 'آڈٹ لاگ دیکھنا'), 'Who changed what in the company, including changes made by platform support.', { ownerOnly: true }),
  def('company.opening.manage', L('Opening balances', 'Opening balance (pehle ka hisaab)', 'ابتدائی بیلنس'), 'Enter the opening balances (supplier udhaar, cash in hand, store stock, worker peshgi) once per item; they lock after saving.'),
  def('company.holiday.manage', L('Manage holidays', 'Chhuttiyon ka intezam', 'چھٹیوں کا انتظام'), 'Add or delete company holidays.'),
  def('subscription.manage', L('Subscription & payments', 'Subscription aur adayegi', 'سبسکرپشن اور ادائیگی'), 'Plan, subscription payments, plan changes.', { ownerOnly: true }),

  // ─── Field permissions (data visibility) ───────────────────────────────────
  def('fields.rates', L('See rates & stock values', 'Rates aur stock ki qeemat dekhna', 'ریٹس اور اسٹاک کی قیمت دیکھنا'), 'Material / supplier / sub-contract rates, purchase amounts, stock values, supplier balances.', { field: true }),
  def('fields.amounts', L('See billing & money amounts', 'Billing aur raqam dekhna', 'بلنگ اور رقم دیکھنا'), 'Billing amounts, invoices, receivables, money KPIs.', { field: true }),
  def('fields.profit', L('See profit', 'Nafa dekhna', 'نفع دیکھنا'), 'Profit, margins and own money invested.', { field: true }),
  def('fields.contract', L('See contract values', 'Theke ki raqam dekhna', 'ٹھیکے کی رقم دیکھنا'), 'Project contract value, rate and stage amounts.', { field: true }),
];

export type PermissionKey = string;
export const PERMISSION_KEYS: readonly string[] = PERMISSION_CATALOG.map((p) => p.key);
export const CATALOG_BY_KEY: ReadonlyMap<string, PermissionDef> = new Map(PERMISSION_CATALOG.map((p) => [p.key, p]));
export const OWNER_ONLY_KEYS: ReadonlySet<string> = new Set(PERMISSION_CATALOG.filter((p) => p.ownerOnly).map((p) => p.key));
export const FIELD_KEYS = ['fields.rates', 'fields.amounts', 'fields.profit', 'fields.contract'] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];

export const isPermissionKey = (key: string): boolean => CATALOG_BY_KEY.has(key);

// ─── Default role templates ──────────────────────────────────────────────────

export type BaseRole = 'PM' | 'MUNSHI' | 'OTHER';
export type PermissionScope = 'ASSIGNED_PROJECTS' | 'ALL_PROJECTS';

export interface TemplateGrant {
  key: string;
  scope?: PermissionScope;
  maxAmountPaisa?: bigint | null;
}

export interface RoleTemplate {
  key: string;
  name: PermissionLabel;
  baseRole: BaseRole;
  description: string;
  grants: TemplateGrant[];
}

/** What a Munshi could do before permissions existed (site work on assigned projects). */
const MUNSHI_KEYS = [
  'projects.project.view',
  'labor.team.view',
  'labor.team.create',
  'labor.attendance.view',
  'labor.attendance.create',
  'labor.measurement.view',
  'labor.measurement.create',
  'labor.advance.view',
  'labor.advance.create',
  'labor.settlement.view',
  'labor.settlement.create',
  'labor.wagepayment.create',
  'cashbook.account.view',
  'cashbook.expense.view',
  'cashbook.expense.create',
  'cashbook.topup.view',
  'cashbook.topup.create',
  'cashbook.count.create',
  'cashbook.handover.create',
  'procurement.purchase.view',
  'procurement.purchase.create',
  'procurement.receiving.create',
  'procurement.dispatch.view',
  'inventory.stock.view',
  'inventory.count.view',
  'inventory.count.create',
  'inventory.usage.create',
  'inventory.ownerdelivery.view',
  'inventory.ownerdelivery.create',
  'dashboard.site.view',
  'dailylog.log.view',
  'dailylog.log.create',
  'masterdata.material.view',
  'masterdata.laborrate.view',
  'masterdata.worker.view',
  'masterdata.worker.create',
  'masterdata.subcontractor.view',
];

/** What a PM could do before permissions existed, WITHOUT canSeeFinancials. */
const PM_KEYS = [
  ...MUNSHI_KEYS,
  'projects.project.create',
  'projects.project.edit',
  'projects.project.approve',
  'projects.estimate.view',
  'projects.estimate.manage',
  'rulebook.override.view',
  'clients.client.view',
  'clients.client.create',
  'clients.client.edit',
  'labor.team.edit',
  'labor.measurement.approve',
  'labor.settlement.edit',
  'labor.settlement.approve',
  'labor.subcontract.create',
  'labor.subcontract.edit',
  'labor.subcontractpayment.create',
  'labor.account.view',
  'cashbook.float.view',
  'cashbook.expense.approve',
  'procurement.order.view',
  'procurement.order.create',
  'procurement.purchase.edit',
  'procurement.return.view',
  'procurement.return.create',
  'procurement.dispatch.create',
  'procurement.shortage.view',
  'procurement.ledger.view',
  'procurement.payment.view',
  'inventory.store.view',
  'finance.reports.view',
  'dashboard.overview.view',
  'approvals.inbox.view',
  'masterdata.material.create',
  'masterdata.material.edit',
  'masterdata.pricelist.view',
  'masterdata.template.view',
  'masterdata.supplier.view',
  'masterdata.supplier.create',
  'masterdata.supplier.edit',
  'masterdata.worker.edit',
  'masterdata.subcontractor.create',
  'masterdata.subcontractor.edit',
  'team.member.view',
  'company.profile.view',
  'fields.rates',
];

/**
 * The old `canSeeFinancials` flag of a PM (billing.view + profit.view). Migrated PMs get these
 * as ALLOW overrides; `PATCH /users/:id { canSeeFinancials }` still sets / removes them.
 */
export const FINANCIAL_BUNDLE = [
  'billing.invoice.view',
  'billing.invoice.create',
  'billing.payment.view',
  'billing.payment.create',
  'finance.pnl.view',
  'fields.amounts',
  'fields.profit',
  'fields.contract',
];

export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    key: 'ADMINISTRATOR',
    name: L('Administrator', 'Admin', 'ایڈمن'),
    baseRole: 'PM',
    description:
      'Office account with every permission except the owner-only ones (company settings, audit log, subscription): all projects, no approval limits, every amount visible.',
    // Every catalogue key except ownerOnly; scoped keys on ALL_PROJECTS; no approval limits.
    grants: PERMISSION_CATALOG.filter((p) => !p.ownerOnly).map((p) => ({ key: p.key, ...(p.scoped ? { scope: 'ALL_PROJECTS' as const } : {}) })),
  },
  {
    key: 'PROJECT_MANAGER',
    name: L('Project Manager', 'Project Manager', 'پراجیکٹ مینیجر'),
    baseRole: 'PM',
    description: 'Office user: projects, team on site, purchases, rates and approvals of assigned projects. No billing or profit (add them per user).',
    grants: PM_KEYS.map((key) => ({ key })),
  },
  {
    key: 'MUNSHI',
    name: L('Munshi', 'Munshi', 'منشی'),
    baseRole: 'MUNSHI',
    description: 'Site supervisor on the mobile app: hazri, material, site cash, daily logs of assigned projects. Never rates or money totals.',
    grants: MUNSHI_KEYS.map((key) => ({ key })),
  },
  {
    key: 'ACCOUNTANT',
    name: L('Accountant', 'Accountant', 'اکاؤنٹنٹ'),
    baseRole: 'OTHER',
    description: 'Office accounts: billing, owner and supplier payments, cash, receivables and reports across all projects. No project or site changes.',
    grants: [
      'projects.project.view',
      'projects.estimate.view',
      'clients.client.view',
      'labor.settlement.view',
      'labor.advance.view',
      'labor.account.view',
      'cashbook.account.view',
      'cashbook.float.view',
      'cashbook.expense.view',
      'cashbook.topup.view',
      'procurement.purchase.view',
      'procurement.return.view',
      'procurement.ledger.view',
      'procurement.payment.view',
      'billing.invoice.view',
      'billing.invoice.create',
      'billing.payment.view',
      'billing.payment.create',
      'finance.pnl.view',
      'finance.reports.view',
      'dashboard.overview.view',
      'approvals.inbox.view',
      'masterdata.supplier.view',
      'company.profile.view',
      'fields.rates',
      'fields.amounts',
      'fields.contract',
    ].map((key) => ({ key, ...(CATALOG_BY_KEY.get(key)?.scoped ? { scope: 'ALL_PROJECTS' as const } : {}) })),
  },
  {
    key: 'STORE_KEEPER',
    name: L('Store Keeper', 'Store Keeper', 'اسٹور کیپر'),
    baseRole: 'OTHER',
    description: 'Material: purchases at the store and sites, receiving, dispatch, stock counts and usage of assigned projects. No rates.',
    grants: [
      'projects.project.view',
      'procurement.purchase.view',
      'procurement.purchase.create',
      'procurement.receiving.create',
      'procurement.dispatch.view',
      'procurement.dispatch.create',
      'procurement.shortage.view',
      'inventory.stock.view',
      'inventory.store.view',
      'inventory.store.manage',
      'inventory.count.view',
      'inventory.count.create',
      'inventory.usage.create',
      'inventory.ownerdelivery.view',
      'inventory.ownerdelivery.create',
      'dashboard.site.view',
      'dailylog.log.view',
      'dailylog.log.create',
      'masterdata.material.view',
    ].map((key) => ({ key })),
  },
];

export const TEMPLATE_BY_KEY: ReadonlyMap<string, RoleTemplate> = new Map(ROLE_TEMPLATES.map((t) => [t.key, t]));
/** System template a user of this account type gets by default. */
export const DEFAULT_TEMPLATE_FOR: Record<'PM' | 'MUNSHI', string> = { PM: 'PROJECT_MANAGER', MUNSHI: 'MUNSHI' };

// Fail fast on typos in templates / bundles (runs once at import).
for (const k of [...FINANCIAL_BUNDLE, ...ROLE_TEMPLATES.flatMap((t) => t.grants.map((g) => g.key))]) {
  if (!CATALOG_BY_KEY.has(k)) throw new Error(`Unknown permission key in a template: ${k}`);
  if (OWNER_ONLY_KEYS.has(k)) throw new Error(`Owner-only key in a template: ${k}`);
}
if (new Set(PERMISSION_KEYS).size !== PERMISSION_KEYS.length) throw new Error('Duplicate permission key');
