# FRONTEND_SPEC — proposed updates (Step 18)

`FRONTEND_SPEC.md` lives in the web repo (`construction-web/docs/FRONTEND_SPEC.md`, last changed at Phase 1 · Step 9). The Step 18 PDF / docs agent works in the API repo only, so the changes are written here for the integrator to apply to the web repo. They bring the spec up to the finished product (Phase 1 + pilot + Phase 2 + 3, Steps 11–18), taken from `construction-web/src/lib/navigation.ts` on `feature/phase-2-3`.

Apply as follows: replace the **ROLES** and **NAVIGATION** sections with the text below, and add **PART 9** and **PART 10** after PART 8. Everything else in the spec (stack, rules, design tokens, folder structure, Parts 1–8, seed accounts) stays as it is.

---

## ROLES (from backend)
- THEKEDAR (company owner): every permission key in the company; cannot be limited.
- PM (office account) and MUNSHI (site account, phone OTP): what they may do comes only from **permission keys** in `/auth/me` (`permissions`, `permissionRoles[]`) — role templates (Administrator, Project Manager, Munshi, Accountant, Store Keeper, or custom) plus per-user ALLOW / DENY overrides. The web never decides on the account role; `canAccess()` in `src/lib/permissions.ts` checks keys (`P`, `ANY`, `ALL` helpers in `navigation.ts`).
- Field permissions decide which money appears at all: `fields.rates` (rates, purchase / stock values), `fields.amounts` (billing money), `fields.profit` (P&L, margins), `fields.contract` (contract value, price). The API leaves the keys out; screens must render "—" / hide the column, never `0`.
- Scope: a grant is ASSIGNED_PROJECTS or ALL_PROJECTS; a project outside the scope answers 404 (show the not-found page, not an error toast).
- PLATFORM_ADMIN: separate `/admin` console, separate login and tokens.

## NAVIGATION (put in `src/lib/navigation.ts`; drives IconRail, Flyout and CommandSearch)
Each item: id, label (en + roman-ur + urdu), icon, href, `access` (permission rule; hides the item), `available` (false → ComingSoon page). Everything below is available unless marked ComingSoon.

**Company mode rail → flyout items**
- Dashboard → Company Overview (a MUNSHI gets the Site Dashboard) · My Approvals · Alerts & Notifications
- Projects → All Projects · New Project · Closed & Archived
- Sales → Clients (Owners) · Quote Pipeline (board + table) · New Quote (inputs | live internal + customer view) · Win / Loss Insights — `sales.quote.*` (Step 12)
- Suppliers & Stock → All Suppliers · Purchases · Purchase Returns · Store Stock · Dispatches (Sent to Sites) · Shortages · Supplier Ledger · Purchase Orders · Supplier Payments
- Workforce → Workers Directory · Worker Types · Sub-contractors
- Equipment → Allocation Map · Owned Equipment · Rentals · Movements · Loss & Damage · Hire & Rent Charges · Shuttering Demand — `equipment.*` (Step 16)
- Finance → Receivables (+ ageing) · Cash Flow Outlook · Profit & Loss (projected margin from Step 14) · Cash Floats Overview
- Reports → Project Summary · Material Audit · Labor & Advances · Cash Book · Supplier Ageing · Receivables Ageing · Stock Valuation · Delay Analysis · Variance Report · Change Order Register · Equipment Utilisation · Snag Summary (Step 18; each with a project picker that opens the per-project book) · WHT Summary · Tax-wise Invoice Register (`tax.view` + `fields.amounts`) — every report exports CSV / Excel / PDF
- Team → Members · Invitations · Devices · Roles & Permissions
- Settings → Company Profile · Opening Balances · Materials · Price List · Labor Rates · Rulebook (company overrides) · Payment Templates · Holidays · Audit Log · Alerts & Limits (incl. control thresholds, idle-equipment days, Ramadan) · Tax (Step 18) · Subscription

**Project mode rail → flyout items** (top of rail: "← All projects", project name + status badge)
- Overview → Project Summary (revised contract, revised end date, change orders)
- Planning → Site Setup · Floors & Rooms · Supply Split · Estimate (BoQ) · Estimate Revisions · Owner Shopping List — Step 11
- Schedule → Gantt · Milestones & Quotas · Stoppage Days · Plan Versions — Step 13
- Site → Daily Logs & Photos · Incoming Material · Deliveries · Material Usage (optional milestone) · Site Stock · Stock Counts & Transfers · Equipment on Site
- Labor → Team on Site · Attendance Register · Sub-contractor Accounts · Work Measurements · Advances · Weekly Settlements
- Cash Book → Site Expenses · Cash Floats · Top-up Requests · Cash Counts & Handover
- Change Orders → All Change Orders · New Change Order · Site Instructions — Step 15
- Billing → Payment Schedule · Invoices & Running Bills (tax card + preview when tax is on) · Payments Received (WHT, certificate) · Owner Statement
- Control → Material Variance · Cost Variance · Burn Rate vs Progress · Delay Analysis — Step 14
- Documents & Closeout → Drawings · Snag List · Handover · Retention — Step 17

**Super Admin console rail**
Overview · Companies · Company Data · Payments (badge = pending count) · Plans · Material Catalog · Holiday Calendar · Audit Logs · Rulebook (versions) · Communication (ComingSoon) · Security (ComingSoon)

---

## PART 9 — Phase 2 + 3 screens (built)
- **Estimate (Step 11)**: BoQ by section with traces (rate-free without `fields.rates`), revisions (generate / regenerate / line override / approve / compare, "rates outdated" banner), owner shopping list (never money), BoQ + shopping-list PDFs.
- **Sales (Step 12)**: pipeline board, quote detail (revisions compare, activity, send with WhatsApp text, lost reason, won → `/projects/new?id=…&tab=5`), insights.
- **Schedule (Step 13)**: Gantt from the approved estimate, milestones & quotas, stoppage days (approve / reject), plan versions, delay breakdown.
- **Control (Step 14)**: variance tables + charts, burn rate vs progress chart, delay analysis, control alerts on the dashboard.
- **Change orders (Step 15)**: builder (mini BoQ, markup, days impact, affected milestones), status flow with proof, slip PDF + WhatsApp, site instructions → CO.
- **Equipment (Step 16)**: ledger views, transfers with counted receiving, rentals, losses, charges, shuttering demand planner, idle rented equipment panel.
- **Closeout (Step 17)**: drawings with revisions, snag list with photos and cost attribution, handover checklist + owner sign-off + certificate PDF, retention.
- **Reports + tax (Step 18)**: five new reports + per-project books, WHT summary, tax-wise invoice register, Settings → Tax, project tax override, invoice tax line, payment WHT certificate.

## PART 10 — PDFs (all produced by the API)
- The web never builds PDFs: it calls the endpoint and opens / shares the signed link from `{ url, expiresAt, whatsappText, clientPhone }` (reports: `{ url, expiresAt, format, mimeType }`). Pass `?lang=en|roman|ur` from the language picker when the user chooses one; otherwise the API uses the user's own language.
- Every PDF has the same letterhead (logo, company name, address, phone, NTN — STRN on tax reports — document title, number, date), A4 margins and a footer with the generated-on date and "Page X of Y". Urdu PDFs are right-to-left with an embedded Nastaliq font.
- Owner-facing PDFs (customer quotation, change order slip, invoice, receipt, owner statement, handover certificate, owner shopping list) never contain costs, overheads, contingency, margins or markups — safe to share on WhatsApp. Internal PDFs (quote costing and estimate BoQ — both printed "Internal document — not for the client" — and report files) must not be offered as a WhatsApp share to the owner.
- A missing PDF engine answers `503 PDF_UNAVAILABLE` — show "PDF can't be made right now, try again in a minute" and keep the screen usable.
- Company logo, address, phone and NTN come from Settings → Company Profile, STRN from Settings → Tax: the empty-state hint on those pages should say they appear on every PDF.
