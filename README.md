# Lumexa Harness

Give it a prompt, a text file or a PDF. You get back a working app on one of two stacks, chosen from your request:

- **Website:** Express + Prisma/PostgreSQL + React/Tailwind
- **iOS + Android app:** the same backend + React Native (Expo)
- **Both:** a website and an app on one API

Any feature you ask for gets built. External services (Stripe payments, email, SMS…) are integrated with real SDKs and a working fallback mode when no keys are set.

The app Before you get it, the app has passed its own tests, build and smoke test, been reviewed by a second model family, and been **looked at in a real browser** and scored for design. Each run also writes a `REPORT.md` with the full workflow, the model used at each step and why, what every call cost, and screenshots of the result.

```bash
cp .env.example .env          # add ANTHROPIC_API_KEY (required) and OPENAI_API_KEY (optional)
npm install
npm run ping                  # one tiny call per configured model: checks keys + model access (< $0.01)

./run.sh "Build a recipe manager: users sign up, save recipes with ingredients and steps, search by ingredient"
```

**Needs:** Node 20+, **Docker** (each run gets its own PostgreSQL container, removed when the run ends), and about 2 GB of free disk space per run. `npm run clean` removes old runs' `node_modules` (reinstall with `npm install` in that app folder).

The result is in `runs/<timestamp>-<name>/`:

| File | What it is |
|---|---|
| `REPORT.md` | **Read this first.** Status, cost summary, workflow diagram, models step by step with the reason for each, design direction, visual QA scores with screenshots, cost by model/phase/provider/task |
| `app/` | The generated app (see "Run the app" in the report: `npm run setup && npm run build && npm start`) |
| `screenshots/` | Every visual QA round, desktop and mobile |
| `ledger.json` | Every LLM call: model requested and served, tokens, cost, duration |
| `decisions.json` | Every routing decision and its reasons |
| `plan.json` / `design.json` / `review.json` / `visual.json` | Spec, art direction, code review, design reviews |

Options: `--budget 20` (default $10; the run stops cleanly if spend reaches it). `--name kite` sets the folder name. `--no-review` skips the code review. `--no-visual` skips the design phase and the screenshot reviews. `--file idea.pdf` (or just the file path) reads the prompt from a .txt, .md or .pdf file. If you press Ctrl+C, the run still writes a partial report.

## How it works

```
prompt
  │
  ▼
PLAN ─────────── Opus 5.5: data model, API, pages, demo accounts, 3–7 tasks rated easy/medium/hard
  │
DESIGN ───────── Opus 5.5: art direction for this brand: palette (3 × 11-step scales), fonts,
  │              corner style, layout + composition per page → theme.css, Google Fonts, DESIGN.md
  │
SCAFFOLD ─────── no LLM: Express+Prisma+React+Tailwind template with a UI kit, design tokens applied,
  │              PostgreSQL container started, npm install
  │
for each task:
  BUILD ───────── by difficulty: easy→Haiku 5.5, medium→Sonnet 5.5, hard→Opus 5.5 (agent with file/shell tools)
  VERIFY ──────── no LLM: API tests on a test database · vite build · smoke (new DB → schema → seed → start → hit endpoints)
  REPAIR ──────── if verify fails: Haiku → Sonnet → Opus, re-verifying after each
  │
CODE REVIEW ──── GPT 5.6 (other model family) → Sonnet fixes high/medium findings → verify
  │
VISUAL QA ────── up to 3 rounds: start the app → Chromium screenshots of every page (logged in as the
  │              demo accounts where needed) + broken images/console errors → Opus scores the design 1–10
  │              against the brief → below 8: Sonnet fixes the issues → verify → screenshot again
  │
FINAL VERIFY ─── (+ repair if needed)
  │
MIGRATIONS ───── no LLM: prisma/migrations/0_init generated from the final schema and proven on a fresh DB
  │
REPORT.md
```

### The brain (`src/brain/router.ts`)

The brain chooses a model for every step from three things, and logs the reason each time:

1. **Config** (`config/routing.json`): the model for each phase. Build steps are chosen by task difficulty.
2. **Learning** (`runs/history.jsonl`): if a model passes less than 50% of a kind of task (after at least 4 tries), the brain moves to the next stronger model and says so in the report.
3. **Availability**: if a model's provider has no API key, it uses the configured fallback.

Routing doesn't use an LLM: it's deterministic and costs nothing. Each task stays on one model, because switching models mid-task loses the prompt cache.

### Why the design is better than a typical generated app

- **A design phase before any code**: a brand-specific art direction, not a generic SaaS look. It's turned into actual tokens (colors, fonts, radius) that every component uses, plus a brief every builder agent follows.
- **A polished UI kit** in the template (Button, Card, form fields, Modal, Toast, EmptyState, Skeleton, Reveal animations, a sticky blurred nav), so agents compose pages from good parts instead of starting from scratch.
- **Visual QA in a real browser.** The harness looks at the result instead of trusting the code. A vision model scores the screenshots and lists specific fixes, and broken images and console errors are caught automatically. The report shows the score after each round, plus the screenshots.

### Database

- Every app uses **PostgreSQL + Prisma**: `server/prisma/schema.prisma`, idempotent `seed.js` with demo accounts, and migrations in `prisma/migrations/`.
- Tests run against a separate test database. Each test file empties its tables, so **nothing ever needs a destructive reset**. Agents are blocked from `prisma migrate reset`, `--force-reset`, `--accept-data-loss` and `DROP`.
- The app ships with `docker-compose.yml` and `npm run setup` (start Postgres, apply migrations, seed).

## Configuration

- `config/routing.json` sets the model for each phase (any model from `models.json`, either provider), plus the limits:
  - `visualRounds` (default 2 fix rounds) and `visualTargetScore` (default 8/10)
  - `agentMaxTurns`, `maxReviewFixes`
- `config/models.json` lists the models, providers, tiers and prices (USD per 1M tokens). Claude prices are current list prices. **The OpenAI prices are placeholders** (`priceVerified: false`), so set the real ones.

## Development

```bash
npm run check     # typecheck + 27 tests; the end-to-end test uses scripted models (no API cost) but a real
                  # Postgres container, real npm install, real Chromium screenshots (~90s, needs Docker)
```

| Path | Role |
|---|---|
| `src/cli.ts` | Entry point (`./run.sh`) |
| `src/pipeline/run.ts` | The workflow |
| `src/pipeline/design.ts` / `visual.ts` | Design phase, screenshot capture and vision review |
| `src/pipeline/verify.ts` | Tests, build, smoke |
| `src/infra/postgres.ts` | The per-run PostgreSQL container |
| `src/brain/` | Router and outcome history |
| `src/llm/` | Gateway (budget + ledger), Anthropic and OpenAI adapters (text, tools, images) |
| `src/agent/` | Agent loop and sandboxed tools |
| `src/report/report.ts` | Generates `REPORT.md` |
| `templates/express-react/` | The app skeleton: Express + Prisma + React + Tailwind + UI kit |

## Limits to know

- **Agent commands run as your user** inside the app folder (paths can't leave it, and dangerous commands are blocked), but it is **not a security sandbox**. If prompts come from other people, run the harness in Docker.
- **The vision review sees screenshots, not interactions.** It doesn't click through flows. The API tests and smoke test cover behaviour, not the UI flows.
- **Photos come from the web** (Unsplash links) or are replaced by gradients. Broken links are detected and sent for fixing, but your own brand photos should be added through the app's admin or content files.

## Payments and other services

Every app has `server/src/payments.js` (Stripe Checkout, refunds, webhook). Without `STRIPE_SECRET_KEY` it runs in **simulated mode**: checkouts succeed instantly through the same code path, so you can demo it and the tests pass. Add test keys from the Stripe dashboard to `server/.env` for real card payments. Other services follow the same rule: real SDK, keys in `server/.env.example`, a working fallback without keys.

## Mobile apps

Mobile runs produce `mobile/`, an Expo SDK 52 app (one codebase for iOS and Android). The harness checks it by bundling its web build, serving it from the API and screenshotting it at phone size. It cannot run an iPhone or Android simulator here. Try it on your phone with the Expo Go app (`npm run dev:mobile`). Store builds use `npx eas build`.

## Design bar: 9/10

Design is held to **9/10** (`visualTargetScore` in `config/routing.json`):

- **Opus builds every UI task** (`build.ui`) and does every design fix (`design_fix`).
- **Up to 4 screenshot → review → fix rounds** (`visualRounds`). The fix agent sees the reviewed screenshots and checks its own changes with a live `screenshot` tool.
- **A round that lowers the score is undone**, so the best version ships.
- **The report says plainly** whether the shipped design met the target (`🎨 Design 9/10: meets the target` / `⚠️ … below the target`).

## Real photos and video

Agents get `get_image` and `get_video` tools instead of placeholders. Add keys to `.env`:

```
UNSPLASH_ACCESS_KEY=...   # unsplash.com/developers: photos
PEXELS_API_KEY=...        # pexels.com/api: photos + HD videos (get_video needs this key)
```

- **Photos** come from Unsplash, then Pexels, then OpenAI generation, then Openverse.
- **Illustrations** are generated first.
- **Video** comes from Pexels: HD mp4 up to 1920px, with a poster frame.
- **Storage:** files are saved to `server/public/media` and served at `/media/<file>` for the website and the app. Credits go to `CREDITS.md`, and the report lists them.
- **Checking keys:** `npm run ping` checks both keys.
