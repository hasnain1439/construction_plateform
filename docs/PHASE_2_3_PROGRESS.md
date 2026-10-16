# Phase 2 + 3 (Steps 11–18): progress

Brief: `D:\metaviz\Saas_product\PHASE_2_3_TASK.md` (the owner's task, verbatim).
Integration branch: `feature/phase-2-3` in all three repos (local only; PRs at the end, nothing pushed without the owner's go-ahead).

## How the work is organised
- Development first, QA after. Up to 3 agents at a time (this PC has ~7.5 GB RAM).
- Each agent works in its own git worktree under `D:\metaviz\Saas_product\wt\<agent>\<repo>` on branch `p23/<agent>`, created from `feature/phase-2-3`. `node_modules` is a junction to the main checkout — do not run `npm install` in a worktree; if a step needs a new package, say so in the report (the integrator installs it in the main checkout).
- Each API worktree has its own `.env.test` pointing at its own test database (`construction_<agent>_test`), so parallel test runs never clash. Run tests with `TEST_MAX_WORKERS=2`.
- Agents NEVER run `prisma migrate deploy` against the dev database (`construction`). Only the integrator does, after merging.
- No Playwright screenshots during development; they are taken in the QA phase on the merged app.
- After each wave the integrator merges the `p23/*` branches into `feature/phase-2-3` (local commits, dependency order), resolves shared files, applies migrations to the dev DB and runs every check in every repo.

## Reserved slots (avoid merge clashes)
| Step | Migration folder prefix | Permission key prefix | Web i18n area | API module |
|---|---|---|---|---|
| 11 Estimation | `20261101…` | `estimate.*` / `rulebook.*` (keep existing `projects.estimate.*`) | `src/i18n/areas/estimate/` (existing `projects/estimate`) | `src/modules/estimate` (extend) + `src/modules/rulebook` |
| 16 Equipment | `20261102…` | `equipment.*` | `src/i18n/areas/equipment/` | `src/modules/equipment` |
| 17 Closeout | `20261103…` | `closeout.*` | `src/i18n/areas/closeout/` | `src/modules/closeout` |
| 12 Sales | `20261104…` | `sales.quote.*` | `src/i18n/areas/sales/` | `src/modules/sales` |
| 13 Schedule | `20261105…` | `schedule.*` | `src/i18n/areas/schedule/` | `src/modules/schedule` |
| 15 Change orders | `20261106…` | `changeorder.*` | `src/i18n/areas/changeOrders/` | `src/modules/change-orders` |
| 16b Shuttering demand / idle alert | `20261107…` | `equipment.*` | `src/i18n/areas/equipment/` | `src/modules/equipment` |
| 14 Control & alerts | `20261108…` | `control.*` | `src/i18n/areas/control/` | `src/modules/control` |
| 18 Reports, tax, polish | `20261109…` | `reports.*` / `tax.*` | `src/i18n/areas/reports/` | existing modules |

Shared files — keep edits small and additive (the integrator merges them):
- `prisma/schema.prisma`: add your models in one block with a `// ─── Step N ───` header; don't reorder existing code.
- `src/core/auth/permissionCatalog.ts`: add your keys in one block; template changes as one line per key.
- `prisma/seed.ts`: put seed data in `prisma/seed<Module>.ts` and add ONE call line in `seed.ts`.
- `src/app.ts` / route registration, OpenAPI docs registry: one line per new module.
- `tests/docs.test.ts` path count, `tests/permissions/parity.test.ts`: update; the integrator re-adds counts after merging.
- Web: root dictionaries `src/i18n/en.ts|roman-ur.ts|ur.ts` only import your area; `src/lib/navigation.ts` one block; `src/lib/permissionKeys.ts`.
- `CHANGELOG.md`: one line per change under Unreleased, in a `### Step N` sub-heading.

## API contracts
Each backend agent writes its step's endpoints (method, path, permission, request/response shape, errors) into `D:\metaviz\Saas_product\PHASE_2_3_CONTRACTS.md` under its step heading BEFORE implementing, so web/mobile agents can start from it.

## Status
| Wave | Work | Status |
|---|---|---|
| 0 | Setup (branch, worktrees, test DBs, this file) | done |
| 1 | A: Step 11 API · B: Step 17 API + web · C: Step 16 API | merged: Step 11 API, Step 16 API + web, Step 17 (API + web) in `feature/phase-2-3` |
| 2 | D: Step 11 web · E: Step 12 API + web · F: Step 13 API | merged: Step 13 API; Step 11 web + Step 12 running |
| 3 | G: Step 13 web · H: Step 15 API + web · I: Step 16 web + demand planner + idle alert | — |
| 4 | J: Step 14 API + web · K: Mobile for 13/15/16/17 | — |
| 5 | L: Step 18 reports, tax, polish | — |
| QA | Automated + visual QA in parallel, fix wave, re-test | — |

## Decisions
- Step 11 extends the existing estimate module (`src/modules/estimate`) instead of a new `estimation/` folder: the hard-coded defaults become the Rulebook (platform → company → project layers), the live estimate becomes saved revisions.
- Steps run in dependency order in parallel waves (owner approved), not strictly 11 → 18.
- Screenshots move to the QA phase (owner approved).

## Log
- 2026-10-16: Integration (Wave 2, round 3): merged p23/s13api (API, `1f947c8`) into `feature/phase-2-3`. Conflicts kept both sides: schema User back-relations (Step 11 + Step 13), `app.ts` schedule routers beside equipment / closeout, Munshi template lines (equipment + closeout + schedule), sync push / schema / serializers / tables (equipment + snags / drawings + milestones / stoppages; `MILESTONE_PROGRESS`, `STOPPAGE_LOG`), docs.test BODY_SCHEMAS for Step 13 + 17, parity snapshot, i18n catalog params. Seed order unchanged from the s13 branch (schedule last, after billing + closeout). OpenAPI paths 312 → 326. API tests 782 in 112 files. Dev DB: migration `20261105090000_schedule` applied (`migrate status` up to date), `backfill:permissions` (7 companies), `seedMalikSchedule` for DHA (13 milestones, baseline, 2 plan versions, 1 APPROVED RAIN + 1 PENDING SMOG_BAN stoppage). Web (`437e4de`): schedule.* keys in `permissionKeys.ts` + PM / Munshi / Accountant template snapshots, catalogue fixture + API types regenerated; tsc + eslint clean, web tests 383 in 59 files.
- 2026-10-16: Step 13 API (agent F, `p23/s13api`): schedule generated from the APPROVED estimate (rulebook productivity / curing, company calendar: weekly off days, platform + company holidays, Ramadan factor), frozen baseline + plan versions, re-plan / milestone edit (dry run) / approved stoppages push successors, site progress with the stage-lock warning (billing event PREVIOUS_STAGE_UNPAID `refType MILESTONE`), stoppage days, delay breakdown (Step 15 hook `Schedule.changeOrderDays`), Milestones & Quotas (usage `milestoneId`), sync tables `milestones` / `stoppages` + mutations `MILESTONE_PROGRESS` / `STOPPAGE_LOG`. Migration `20261105090000_schedule`. Permissions `schedule.plan.view|manage`, `schedule.progress.edit`, `schedule.stoppage.create|approve`. Company settings `ramadanDayFactor` / `ramadanPeriods`. Contracts in PHASE_2_3_CONTRACTS.md → Step 13. Step 14 / 16 hooks: `Milestone` (stageKey via stage, plannedStart / End, curingDays, status, progressPercent) and `MilestoneQuota` (planned qty per material) are the inputs for variance and the shuttering demand planner.
- 2026-10-16: Step 12 API + web (agent E, `p23/s12`): quotes / sales pipeline — `Quote` + `QuoteRevision`, quick mode (Step 11 engine + BoQ with area-based room assumptions, `sales/quickMode.ts`), send (customer PDF + WhatsApp), negotiation, lost (reason), won → pre-filled DRAFT project, expiry job `quote-expiry`, insights. Migration `20261104090000_sales_quotes`. Permissions `sales.quote.view|create|edit` (PM; view also Accountant), `sales.quote.approve` (mark won) / `.manage` (delete) Administrator. Seed `prisma/seedSales.ts` (+2 prospect clients → clients test count 8). Web: Sales → Quote Pipeline (board + table), New Quote (inputs | live internal + customer view), Quote Detail (compare, activity, actions; won → `/projects/new?id=…&tab=5`), Win / Loss Insights. Contracts → Step 12.
- 2026-10-16: Step 11 API (agent A, `p23/s11api`): rulebook (platform versions per region + company overrides + project layer), full BoQ builder (14 sections, stage keys for Step 13, traces), saved estimate revisions (generate / regenerate / overrides / approve + supersede / compare / rates outdated), owner shopping list, BoQ + shopping-list PDFs, admin rulebook versions. Migration `20261101090000_estimation_rulebook`. Permissions `estimate.revision.approve`, `rulebook.override.view` (PM), `rulebook.override.manage`. Contracts in PHASE_2_3_CONTRACTS.md → Step 11. Productivity / curing parameters for Step 13 are rulebook keys (`productivity*`, `curingDays*`, group PRODUCTIVITY) — read them with `loadRulebook(tx, tenantId).values`. Lines carry `stageKey` FOUNDATION_PLINTH / GF_STRUCTURE / F1–F3_STRUCTURE / MUMTY_ROOF / PLASTER_MEP / FINISHING.
- 2026-10-16: Wave 0 set up. Test storage folder now named after the test database (vitest.config.ts) so parallel checkouts don't delete each other's files.
- 2026-10-16: Step 16 part 1 (API, agent C, branch p23/s16api): equipment register + ledger, transfers with counted receiving (gap → loss), yard rentals → supplier ledger, losses, daily internal hire + rent → P&L EQUIPMENT, sync tables + 2 push mutations, migration 20261102090000_equipment, keys equipment.view|manage, equipment.transfer.create, equipment.receiving.create, equipment.rental.manage, equipment.loss.create|approve (brief names move / loss.report / loss.charge mapped to catalogue actions). Tests 698 → 707. Contract: PHASE_2_3_CONTRACTS.md → Step 16 (demand planner + idle alert proposed for Wave 3).
- 2026-10-16: Wave 1 · B — Step 17 closeout (API + web) on `p23/s17`: migration `20261103090000_closeout`, module `src/modules/closeout`, 23 routes (16 OpenAPI paths), permissions `closeout.*`, retention reminder job, sync `snags` / `drawings` + `SNAG_CREATE` / `SNAG_FIX`, seed `prisma/seedCloseout.ts`; web Documents & Closeout pages (Drawings, Snag list, Handover, Retention), area `src/i18n/areas/closeout/`. API tests 698 → 706, web 361 → 373. Decisions: REWORK = cost engine source `REWORK` in bucket LOSSES; CHANGE_ORDER stored on the snag only (Step 15 to pick up `Snag.costAttribution = CHANGE_ORDER`); certificate PDF stored as DOCUMENT attachment; snag / drawing / handover project FKs cascade (draft / demo project delete).
- 2026-10-16: Integration (Wave 1, partial): merged p23/s16api + p23/s17 (API) and p23/s17 (web) into `feature/phase-2-3`. Shared files kept both sides (schema back-relations on Tenant / Project / Attachment, catalogue blocks + template lines, app.ts, scheduler jobs `equipment-accrual` 01:30 + `retention-reminders` 02:45, sync tables / push, cost engine EQUIPMENT_HIRE / EQUIPMENT_RENTAL / EQUIPMENT_LOSS + REWORK). OpenAPI paths 296. API tests 715 in 107 files; web 373 (catalogue fixture + permissionKeys + template snapshots now include equipment keys, API types regenerated). Dev DB: migrations 20261102090000_equipment + 20261103090000_closeout applied, `backfill:permissions` run, equipment + closeout demo data seeded for Malik & Sons (idempotent seed functions only). `.gitattributes`: migration SQL forced to LF.
- 2026-10-16: Integration (Wave 1–2): merged p23/s11api (API, `8335ad6`) and p23/s16web (web, `8979a77`) into `feature/phase-2-3`. API: schema Step 11 block + User / Project back-relations next to Step 16 / 17, `app.ts` estimates / rulebook routers + equipment, seed calls (estimates right after projects), docs.test BODY_SCHEMAS for both, OpenAPI paths 296 → 312, parity snapshot both blocks. Migration `20261101090000_estimation_rulebook` sorts before the already-applied equipment / closeout migrations — `migrate deploy` applied it fine on the test and dev DBs (`migrate status`: up to date). Dev DB: `backfill:permissions` (7 companies, roles ~2 each), Step 11 demo data via `seedMalikEstimates` (DHA Rev 1 APPROVED + Rev 2 DRAFT, contingency 7 %; rulebook v1 PUNJAB_KP + KARACHI_SINDH from the migration). API tests 756 in 110 files. Web: Step 16 equipment UI; duplicate equipment keys from the Wave 1 integration removed from `permissionKeys.ts` / `permissionTemplates.ts`, Step 11 keys added (`estimate.revision.approve`, `rulebook.override.view|manage`; PM template gets `rulebook.override.view`), catalogue fixture + API types regenerated from the merged API. Web tests 383 in 59 files; tsc + eslint clean.
