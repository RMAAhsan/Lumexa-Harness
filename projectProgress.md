# Lumexa Harness: project progress

_Last updated: 2026-10-15. Start here next session._

**2026-10-15:** generated apps now put their Docker Postgres on host port **5433** (`docker-compose.yml`, `server/.env.example`, the REPORT.md setup line), so they no longer clash with the local Postgres on 5432. The harness's own build-time databases already used random ports.

**2026-10-15:** prices checked against the official docs. Sonnet 5.5 cache reads cost $0.10, not $0.20 (fixed). `gpt-5.6` was **not a real OpenAI model ID**: the code review could never have run on GPT. It is now `gpt-6.1-sol` ($2 / $10, $4 / $15 above 272K tokens). `gpt-image-1` shuts down on 2026-10-23 and was replaced by `gpt-image-2`. `npm run ping` and a test image both passed.

**2026-10-15:** repairs now detect **no progress** (idea taken from ARICode, `/home/ahsan/codebase/Lumexa Harness`). Before and after each repair the harness compares the failure output, ignoring timings, ports and ids (`failureSignature` in `verify.ts`). If nothing changed, it skips the middle of the chain and goes straight to the last model, which is told what the previous attempt tried (`Router.nextRepairAttempt`, `repairPrompt`). REPORT.md shows such attempts as `no change`.

**2026-10-15:** added `try-app.sh`. Testing it found a template bug: `npm run setup` could fail on a fresh database because `docker compose up --wait` returned before Postgres finished initialising. The template's `docker-compose.yml` now has a `pg_isready` health check.

## What this is

A TypeScript harness in `/home/ahsan/codebase/Harness`. Give it a prompt, text file or PDF, and it plans, designs, builds, tests, reviews and screenshots a full-stack app, then writes `REPORT.md` with the cost, the models used and the design score.

- **Run:** `./run.sh "<prompt or path to .pdf/.txt>" --name <slug> --budget <usd>` (default $10)
- **Check keys:** `npm run ping` (all models, plus the Unsplash/Pexels keys)
- **Tests:** `npm test` (37 tests, about 4 min; needs Docker; no API cost)
- **Try a generated app:** `./try-app.sh [run name or folder]` (default: latest run) installs, starts its database, runs its tests, builds, starts it on :3001 and prints the demo logins. `--test-only` skips starting it; `--stop` stops its database
- **Free disk:** `npm run clean` removes old runs' `node_modules`; add `--all` or `--dry-run`
- **Output:** `runs/<timestamp>-<name>/` contains `REPORT.md`, `app/`, `screenshots/`, `ledger.json`, `decisions.json`, `plan.json`, `design.json`, `visual.json`, `run.log`

## Stacks it generates

The planner picks the platform from the request:

| Platform | Contents |
|---|---|
| **web** | `server/` (Express 4 + Prisma 6.19 + PostgreSQL 16) + `client/` (React 18 + Vite + Tailwind 3 + UI kit) |
| **mobile** | `server/` + `mobile/` (Expo SDK 52 + React Native 0.76 + expo-router 4; one codebase for iOS and Android) |
| **both** | website at `/`, the app's web build at `/app`, one shared API |

Every app ships with:
- Stripe payments (`server/src/payments.js`), with a simulated mode when there's no key
- JWT auth helpers and an idempotent seed with demo accounts
- `docker-compose.yml` and `npm run setup`
- generated migrations (`prisma/migrations/0_init`)
- media in `server/public/media`, served at `/media`

Rule: **never drop a requested feature.** External services get their real SDK, keys in env vars, and a working fallback when the keys are missing.

## Pipeline (`src/pipeline/run.ts`)

1. **Plan** (Opus): spec, platform, demo accounts, 3–8 tasks
2. **Design** (Opus): palette, fonts, layout per page → `theme.css` / `theme.js` + `DESIGN.md`
3. **Scaffold** (no LLM): templates, a Postgres container per run, `npm install`, brand fonts for mobile
4. **Build** each task, then **Verify** (no LLM): API tests, client/mobile build, smoke test on a fresh database. If verify fails, **Repair** Haiku → Sonnet → Opus.
5. **Code review** (GPT 5.6) → Sonnet fixes the high/medium findings
6. **Visual QA**, up to 4 rounds: Chromium screenshots (logged in with the demo accounts) → Opus scores against the brief → Opus fixes using the reviewed screenshots and a live `screenshot` tool. A round that lowers the score is reverted. **Target 9/10.**
7. **Final verify** → **Migrations** (generated, then applied to a fresh database to prove them) → **REPORT.md**

## Models and routing

`config/models.json` (catalog and prices) and `config/routing.json` (which model runs each step):

| Step | Model |
|---|---|
| plan, design | Opus 5.5 (high effort) |
| backend tasks | easy → Haiku 5.5 · medium → Sonnet 5.5 · hard → Opus 5.5 |
| UI tasks | Opus 5.5 (`build.ui`) |
| repairs | Haiku → Sonnet → Opus |
| code review | GPT 6.1 Sol (`gpt-6.1-sol`; Sonnet if no OpenAI key) |
| code-review fixes | Sonnet 5.5 |
| visual review | Opus 5.5 (GPT 6.1 Sol if no Anthropic key) |
| design fixes | Opus 5.5 |
| images | `gpt-image-2` (generation only) |

Automatic switches:
- **Learning:** a model passing fewer than 50% of a kind of task (after ≥4 tries, in `runs/history.jsonl`) is replaced by the next stronger one. Fable 5.1 is reachable only this way.
- **Missing keys:** the step uses its fallback model.

**All prices are verified** (2026-10-15) against the official Anthropic and OpenAI pricing pages. Re-check them when adding a model.

## Media

- `get_image`: Unsplash → Pexels → OpenAI generation → Openverse (illustrations are generated first)
- `get_video`: Pexels HD mp4 + poster frame (needs `PEXELS_API_KEY`)
- Limits: 24 images, 3 videos per run (`config/routing.json` → `limits`)
- Credits go to `server/public/media/CREDITS.md`, and the report lists them

## Keys (`.env`)

| Key | Status |
|---|---|
| `ANTHROPIC_API_KEY` | ✓ set |
| `OPENAI_API_KEY` | ✓ set |
| `UNSPLASH_ACCESS_KEY` | ✓ set |
| `PEXELS_API_KEY` | ✓ set |

## Runs so far

| Run | Result |
|---|---|
| `kite-v3` (`runs/20261014-161459-kite-v3`) | ✅ verified, $9.08, web, 53 API tests, design 6/10. Built **before** the media tools, the capture fix and the 9/10 bar. Part of the low score was a capture bug (fixed): the course cards were present, but they were screenshotted before their fade-in played. The real weakness was placeholder images. |
| `kite-v2` | Stopped partway (harness error), partial report only. |

kite-v3's **backend is running** on http://localhost:3001 (its DB is in Docker on port **5433**, changed from 5432 because a local Postgres uses 5432).
- Stop it: `pkill -f "node server/src/index.js"`, then `docker compose down` in its `app/` folder
- Demo logins: `admin@kiteseychelles.com` / `Admin123!` · `staff@…` / `Staff123!` · `student@…` / `Student123!`

## Next steps (start here)

1. ~~Add Unsplash/Pexels keys~~ done (ping passes).
2. ~~Free disk~~ done: 17 GB free on 2026-10-15.
3. **Re-run the kite blueprint** with everything new:
   `./run.sh "/home/ahsan/Downloads/Lumexa — From Idea to Working Software, Guaranteed.pdf" --name kite-v4 --budget 100`
   Then compare its REPORT.md with kite-v3: design score, media, cost.
4. **OpenAI:** prices are done. Still open: decide which other OpenAI models to add and test (`gpt-5.3-codex`, `gpt-5.6-sol/terra/luna`, `gpt-6-astra/luna`, `gpt-6-sol`). For example, route medium backend tasks to a GPT model and compare reports.

## Open ideas / known limits

- **Mobile verification is not on-device:** it uses the Expo web build at phone size, with no iOS/Android simulator. Store builds need `eas build` and accounts.
- **Visual review doesn't click through flows:** behaviour is covered by API tests and smoke tests.
- **Not a security sandbox:** agent commands run as your user, confined to the app folder with dangerous commands blocked. Use Docker if prompts come from other people.
- **Prisma 7 upgrade later:** the harness pins 6.19, because 7 changed how it connects to the database.
- **Prisma's AI-agent guard:** Prisma blocks destructive commands (`--force-reset`) when it runs under an AI agent. The harness never needs them: tests empty their own tables, and agents are blocked from reset, drop and data-loss commands. Don't bypass the guard.

## Earlier artifacts

- `CROSS_PROVIDER_ROUTING_PLAN.md`: the earlier plan for cross-provider routing inside Lumexa's old `services/harness`. That folder was deleted on 2026-10-15; the Brain inside Lumexa (below) replaced the idea.

## 2026-10-15 — large PRD input fixes
- Plan output limit 32k → 64k (`src/pipeline/run.ts`): a 77k-char PRD was cut off at 32k.
- Planner prompt: long requirement documents are planned as their FIRST RELEASE (MVP / phase 1); left-out modules are named in the plan summary.
- Ledger: structured calls that fail after being billed (cut off, refusal, incomplete) now throw `BilledCallError` with their usage, and the gateway records the cost before rethrowing (the cut-off plan used to report $0.00).

## 2026-10-15/16 — Lumexa integration: the Brain

This harness's ideas now live INSIDE Lumexa (`/home/ahsan/codebase/lunexa-Ai`, branch
`OCT-15-HARNESS-INTERATION`, everything uncommitted on purpose). The standalone
harness stays as it is; this section is the record of what was built there.

### What "the Brain" is
A plug-in module at `curs-pm-api/src/modules/brain/`: it decides which model runs
each AI task from one rule set (`config/defaults.ts`), runs Claude and OpenAI
through one client (`adapters/`), prices every call from one catalog
(`core/catalog.ts`, official list prices), and records every call to
`ai_prompt_logs` (`plugins/trace.ts`). Behaviour is added as plug-ins with hooks
(beforeDecide/afterDecide/beforeRun/afterRun/onError), so later features
(self-learning, RAG, A/B) attach without touching the core.

**Switch:** only logged-in users listed in `BRAIN_TEST_USERS` (emails/ids, in
`curs-pm-api/.env.staging`) get the Brain; everyone else is untouched. Run the
API with `pnpm staging` (NOT `pnpm dev`, which uses the production `.env`).

### Done and tested live (staging DB, local app)
1. **Wizard:** every step from idea to use cases goes through the Brain with its
   OWN prompts (`wizard/prompts.ts`, 14 stages) — fast steps on Haiku 5.5,
   careful ones on Sonnet 5.5, OpenAI as fallback. Measured: 10 calls, ~$0.03,
   46 s of model time per wizard run. Content-policy and image reading stay on
   the old path on purpose.
2. **PRD:** the Brain picks the model (Opus 5.5, fallback GPT 6.1 Sol) and
   writes it with its own system prompt over the in-code template (section
   layout and build-spec marker kept exactly). $0.42–0.65, 2.5–4 min.
3. **Route contract, capability needs, integration detection, capability
   gate, tickets:** Brain prompts and models.
4. **Designs:** two extra gallery options, **Brain A** (Opus 5.5) and **Brain
   B** (GPT 6.1 Sol), from the Brain's design studio (`design/`): reference
   screenshots → art direction → real photos → build → page shown as soon as it
   exists → Chrome screenshots → critic → patch rounds in the background.
   Learned: Opus at medium effort writes 60k-token pages and gets cut off
   (two $3 losses); builders now run at low effort with a page-size rule, and
   patches run on Sonnet. Brain B: 8–10 min, $0.5–0.9, critic 6/10.
5. **Codegen (built 2026-10-16, not yet run live):**
   - Boilerplate `harness` at `services/live-preview-runner/templates/coding-agent-boilerplate/harness/`
     = fullcodeV2's skeleton and infra (deploy files, auth, kits' anchor files)
     minus its 42 KB of agent instructions; plus a 2 KB rules file, backend
     tests (node:test + supertest over HTTP against the live dev backend),
     `common/Section.tsx`. 109 files; trimming candidates listed in the chat
     (datetime/format helpers, half the shadcn kit, SEO runtime) — trim after
     the first real build shows what goes unused.
   - Engine `services/live-preview-runner/src/builder/variants/harness/`:
     `brief.ts` (the Brain's brief: model/effort/turn/dollar caps per stage,
     price table), `prompts.ts` (planner, task, repair, design conversion,
     visual critic — the Brain's own, `PROMPT_VERSION`), `session.ts` (ONE
     fresh Agent SDK session per task, Agent/Task tools off), `verify.ts`
     (deploy checks + backend tests + live probes; `failureSignature` for
     no-progress detection), `visual.ts` (viewport screenshots per page and
     role, critic with Read), `flow.ts` (plan → tokens/approved design →
     imagery → tasks with verify/repair → deploy gate → schema+seed → visual
     round → artifact; events the project page already reads; Brain trace rows
     via `DB.insertAiPromptLog`).
   - Platform: `src/modules/brain/codegen/brief.ts` builds the brief from
     `codegen.*` rules (plan Opus; tasks Haiku/Sonnet/Opus by difficulty, UI
     Opus; repair Haiku→Sonnet→Opus; $12 hard cap); `startInitialBuildOnRunner`
     picks the harness boilerplate for Brain users, stamps `build.inputJson.brain`,
     sends `brain` in the session payload (wire types on both sides).
   - Checks: API + runner `tsc` clean; 54 Brain unit tests pass; boilerplate
     dry run green (install, prisma, tsc, vite build, seed, boot, login, 3/3
     tests). Runner's Playwright needed Chromium build 1228 (installed locally).

### Decisions taken with the user
- Brain uses its OWN prompts per step (ideas from the admin-panel prompts).
- Codegen: own boilerplate named `harness` + own loop; Brain builds REPLACE the
  normal build for test users (no side-by-side); compare with the last-60-days
  averages (~$22 per fullcode build, 80–85 % of it cache reads from one warm
  session) and the user's eyes; runner cost bugs fixed only under the switch.
- Claude Agent SDK per task (Claude models only in codegen for now); Lumexa's
  current stack (React 19, Tailwind 4, TS). No commits until told.

### How to run a Brain build locally
Runner: `cd curs-pm-api/services/live-preview-runner && pnpm dev` (:8080;
its `.env` matches the API's token and DBs). API: `pnpm staging`. Web:
`pnpm dev`. Log in as the test user, open a web project with a PRD, Start
build. Watch `[harness] …` in the runner terminal (also
`/tmp/live-preview-runner.log`); preview at
`http://app-<id8>-live.lvh.me:8080`. Do not edit runner files during a build
(`tsx watch` restarts it). Expect 30–60 min, $6–10, never above $12.

### Open items
- First live harness build, then: tune caps against the SDK's own cost meter
  (logged beside ours), trim the boilerplate, decide on a second visual round.
- `e2eVerify` after deploy still runs only for `fullcodeV2`; Codegen Lab has
  no harness tab; `connectionProfile.ts` BACKENDS still lists a non-existent
  `gpt-5.6`.
- GPT builders in codegen would need the harness's own tool loop (the Agent
  SDK is Anthropic-only).
- Security: this folder's `.env.example` holds REAL Anthropic and OpenAI keys
  (noticed 2026-10-16) — rotate them and blank the file.


## 2026-10-16 (night) — Lumexa Brain: items 2–7 of the blueprint, end to end

Built while the user slept, under three rules: no database command of any
kind, production untouched, nothing committed. Everything lives uncommitted in
`curs-pm-api` (branch `OCT-15-HARNESS-INTERATION`). The authoritative status
table is `curs-pm-api/src/modules/brain/BLUEPRINT.md` §10.

### What changed (runner `services/live-preview-runner/src/builder/variants/harness/`)
- `spec.ts` — the one input (`Spec`: product + hash, routes, design, accounts,
  seams, source). `specFromProject` is the only wizard-aware code.
- `stack.ts` — the React/Express adapter: markers, files, frozen list,
  ownership per role, module file conventions, checks. A second stack = a
  second adapter.
- `prompts.ts` (`harness-3`) — plan v3: `contract.endpoints` (request/response
  shapes, errors, module), `contract.pages` (component, data, actions, nav,
  fromDesign), `modules` (slugs, waves, dependsOn, routers); `checkPlan`
  normalises/synthesises leads/orders dependencies. Role prompts: planner
  (PM), backend lead, frontend lead (mocks from the contract), dev (BE/FE),
  QA (tests from the contract alone), integrator, repair, critic (per-page
  scores), polisher.
- `ownership.ts` — PreToolUse hooks: owned globs, frozen platform files,
  shell writes into others' files, git discards. Denials name the owner.
- `team.ts` — `sizeTeam` + `runLanes` (parallel ≤ maxParallel, dependency
  order, `verifyAfter` so a backend lane waits for its QA tests).
- `integrate.ts` — deterministic: mount routers at the backend marker,
  register pages at the right App.tsx marker (replaces the "/" redirect),
  nav links per bucket (admin behind `user.isAdmin`), landing anchors from
  module summaries ("nav: Label → #id"), mocks off. Idempotent.
- `polish.ts` — wave 5: every page desktop + phone → critic (batched ≤ 18
  shots) → one polisher per module in parallel → revert on lower score or
  broken types; stops at 9/10, round limit, budget or 15 min.
- `designStandard.ts` — UI/UX Pro Max condensed (CRITICAL/HIGH rules +
  landing patterns) for the roles the brief names.
- `visual.ts` — per-page scores, all pages, both viewports; `verify.ts` —
  `verifyLane` (side tsc + module tests + own public probes).
- `flow.ts` — waves 0–5, progressive mounting as lanes land, lane repair
  ladder + one escalation to a stronger model, integration agent only when
  the code integration's verification fails, `HARNESS_WAVE/LANE/
  INTEGRATION/PREVIEW_LIVE/POLISH` events, `docs/PLAN.json`, `docs/CONTRACT.md`,
  `docs/LEDGER.json`.
- `preplan.ts` + `POST /__control/brain/plan` — the plan before the click.
- `brief.ts` v2 (roles, escalation, team, skills, limits, pre-click plan;
  older briefs widened). `session.ts` takes per-lane hooks.
- Template: `frontend/src/mocks/{flag,index}.ts`, apiClient mock switch,
  CLAUDE.md team rules. Runner `npm test` (node:test via tsx): 11 tests.

### What changed (platform `curs-pm-api/src/modules/brain/`)
- `config/profiles.ts` — model skill profiles + roles (data). Route = the
  cheapest model that passes the role's gate; `escalationFor`,
  `repairLadder`. Gates: dev.backend 6/8/9, dev.frontend 7/7.5/9, critic 9,
  polish 9, plan 9. Haiku takes easy backend + easy QA; Sonnet ordinary
  pages; Opus leads/hard/critic/polish; Fable only by escalation.
- `config/defaults.ts` — `codegen.role.<role>.<difficulty>` rules generated
  from the profiles; `codegen.build` cap $15; version `code-2026-10-16`.
- `codegen/brief.ts` v2, `codegen/team.ts` (`sizeTeam`), `codegen/preplan.ts`
  (background pre-plan for Brain users on project creation and when the
  build spec is filed; stored as `intakeData.brain_plan` with the blueprint
  hash; orchestrator passes it as `brief.plan`). `livePreviewClient.brainPlan`.
- `BENCHMARK.md` + `scripts/brainBenchmark.ts` (read-only report).
- Tests: `tests/unit/brain*.test.ts` 59 pass; API + runner `tsc` clean.

### Not done / to watch tomorrow
- No real build ran tonight (would have touched the DB). The first build is
  the integration test of the whole chain: watch the lane events, the
  integrator warnings and the ledger.
- Design conversion before the click (blueprint item 6) is not pre-click; it
  runs as a wave-2 module in parallel.
- Parallel lanes restart nodemon often; transient test failures retry once.
  `HARNESS_MAX_PARALLEL` caps sessions if rate limits bite.
- Older watcher script `scratchpad/watch-build.sh` still reads
  `HARNESS_TASK`/`BUILD_PLAN_GENERATED.tasks` — both still emitted.

## 2026-10-16 (day) — first Brain build on the team engine, and the fixes it paid for

Build PRJ2026-ZMXID7 (12 modules): preview live 24.3 min, $18.35; FE-6 skipped
at the old $15 cap, polish skipped. Repairs were $6.5, of which $3.9 was the
integrator's own bug (stray `} />` in App.tsx; nav links inserted inside a
guidance comment) and $2.5 backend devs that never ran their QA tests (routers
were mounted only after the lane). Fixed in the runner + API (see
curs-pm-api/src/modules/brain/BLUEPRINT.md §11): whole-line route replacement,
single-line nav markers, comment-aware insertion, ownership-aware lane gate
(external failures are not repaired), routers pre-mounted as stubs, definition
of done in the dev prompt, resume-the-engineer as the first repair rung,
Sonnet→Opus→Fable ladder without jumps, scaled working budget + hard ceiling
with in-flight caps reserved, contract examples, ledger failure detail.
Verified: runner tsc + 16 engine tests, API tsc + 59 Brain unit tests, and a
real tsc of the template after the integrator ran on it. Nothing committed.
Second build of the day failed at planning (error_max_turns, $0): `allowedTools: []`
does not disable Agent SDK tools (it is the permission allow-list); fixed with
`tools: []` in the runner's agentText.ts + output cap 64k. See BLUEPRINT §11 addendum.
