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
| 1 | A: Step 11 API · B: Step 17 API + web · C: Step 16 API | in progress |
| 2 | D: Step 11 web · E: Step 12 API + web · F: Step 13 API | next |
| 3 | G: Step 13 web · H: Step 15 API + web · I: Step 16 web + demand planner + idle alert | — |
| 4 | J: Step 14 API + web · K: Mobile for 13/15/16/17 | — |
| 5 | L: Step 18 reports, tax, polish | — |
| QA | Automated + visual QA in parallel, fix wave, re-test | — |

## Decisions
- Step 11 extends the existing estimate module (`src/modules/estimate`) instead of a new `estimation/` folder: the hard-coded defaults become the Rulebook (platform → company → project layers), the live estimate becomes saved revisions.
- Steps run in dependency order in parallel waves (owner approved), not strictly 11 → 18.
- Screenshots move to the QA phase (owner approved).

## Log
- 2026-10-16: Wave 0 set up. Test storage folder now named after the test database (vitest.config.ts) so parallel checkouts don't delete each other's files.
- 2026-10-16: Step 16 part 1 (API, agent C, branch p23/s16api): equipment register + ledger, transfers with counted receiving (gap → loss), yard rentals → supplier ledger, losses, daily internal hire + rent → P&L EQUIPMENT, sync tables + 2 push mutations, migration 20261102090000_equipment, keys equipment.view|manage, equipment.transfer.create, equipment.receiving.create, equipment.rental.manage, equipment.loss.create|approve (brief names move / loss.report / loss.charge mapped to catalogue actions). Tests 698 → 707. Contract: PHASE_2_3_CONTRACTS.md → Step 16 (demand planner + idle alert proposed for Wave 3).
