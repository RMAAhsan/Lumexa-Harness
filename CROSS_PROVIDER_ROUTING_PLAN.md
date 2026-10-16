# Plan: Cross-Provider Routing for the Lumexa Harness

Repo: `lunexa-Ai/curs-pm-api`, harness at `services/harness/src`.

**Goal:** let the harness ("the brain") send a task to either OpenAI or Claude, whichever gives the best output at the lowest cost.

---

## Why the router blocks it today

The block isn't really in the router. It's in the call sites. Every platform LLM call is written directly against one SDK, for example `src/modules/prd/detectIntegrations.ts:194`:

```ts
client.messages.create({
  model: routeModel(task.prd('detect-integrations'), 'claude-haiku-4-5-20251001'),
  tools: [DETECTION_TOOL],
  tool_choice: { type: 'tool', name: 'report_integrations' },
  system,
  messages,
})
```

If the router returned a `gpt-…` model here, the Anthropic client would send it to Anthropic and fail. So `route.ts:71,80` skips any model from a different provider (`sameFamily`). Lifting that check alone would break things. Each call first needs a way to run on either provider.

**The pieces already exist:**

- `src/modules/admin/codegen/connectionProfile.ts` has `resolveBackend()`, `buildAnthropicClient()`, `buildOpenAIClient()`, `upstreamModel()` and `acceptsReasoningEffort()`.
- `src/modules/design-preview/imageBriefs.ts:204` (`textTurn`) already sends the same request to either provider. It's just private to that file.

---

## Step 1: one function that can call either provider

Create `src/lib/llm/complete.ts`, grown from `textTurn`:

```ts
complete({
  task, defaultModel, override?,
  system, messages, maxTokens,
  tool?: { name, description, schema },
  images?,
}) → {
  model,
  text?,
  toolInput?,
  usage: { inputTokens, outputTokens, cacheReadTokens },
  costUsd,
}
```

- It asks the brain for a model, saying the call can run on either provider (`portable: true`).
- It then branches on `resolveBackend(model).provider`:
  - **Anthropic:** `messages.create` with a forced `tool_choice`.
  - **OpenAI:** `responses.create` with a function tool and a forced `tool_choice`. It sends `reasoning` only where `acceptsReasoningEffort()` allows it, which avoids the 400 errors noted in `connectionProfile.ts`.
- It returns the same result shape either way. A caller that reads `toolInput` gets the same object from both providers.
- The returned cost and usage feed the existing cost reporting, so routing decisions show up with real dollar amounts.

---

## Step 2: the harness learns which calls can switch providers

All changes are in `services/harness/src`:

- **`catalog.ts`:** each model gets `caps: { forcedTool, vision, reasoning }`. Each task can state what it needs, for example `doc-extract` needs `vision`.
- **`route.ts`:** replace `sameFamily` with `canServe(target, defaultModel, { portable, needs })`:
  - The same provider is always allowed.
  - A different provider is allowed only if the call site is portable **and** the target model has every capability the task needs.
  - Otherwise the router skips it and records the reason in the decision log, so it shows up in the admin view.
- **`brain.ts` / `Brain.model()`:** takes a `portable` flag. Plain `routeModel()` callers keep `portable: false`, so nothing changes for code that hasn't been moved over.
- **Not changed:** `planCheapFirst`, the codegen steps, chat and repairs. They run inside a Claude Agent SDK session, which only works with Anthropic models (`route.ts:113` and the header of `connectionProfile.ts` both say so). They stay Claude-only on purpose.

---

## Step 3: move the low-risk calls first

Start with the eight "classifier" calls. They're all Haiku, all use a forced tool, all have small outputs, and the outputs are easy to compare.

| Task | File |
|---|---|
| `prd:detect-integrations` | `src/modules/prd/detectIntegrations.ts:194` |
| `prd:capability-gate` | `src/modules/prd/capabilityGate.ts:304` |
| `prd:capabilities` | `src/modules/prd/prdCapabilities.ts:158` |
| `intake:capability-needs` | `src/modules/intake/capabilityNeeds.ts:188` |
| `ops:deploy-target` | `src/services/deployTargetDetector.ts:128` |
| `ops:app-upgrade` | `src/services/appUpgradeDetector.ts:88` |
| `ops:integration-switch` | `src/services/integrationSwitch.ts:633` |
| `ops:integration-removal` | `src/services/integrationRemoval.ts:853` |

Each move should be about 15 lines, replacing `client.messages.create` plus the `tool_use` parsing with `complete()`. The default model stays the same, so **behaviour doesn't change until a policy says otherwise.**

**Later (a separate step):** PRD writing, design and doc-extract. They have long prompts tuned for Claude, so they carry more quality risk.

---

## Step 4: show it's at least as good before switching

1. **Offline replay.** Add a script (`scripts/harness-replay.ts`) that takes about 100 stored inputs per classifier task, runs the current Haiku model and an OpenAI candidate, and reports how often they agree, plus cost and latency.
2. **Live experiment.** Run the candidate for 10–20% of projects using the existing `experiments` policy. The project-id bucketing and the per-decision tags of which group a call was in already exist.

   ```json
   {
     "experiments": [
       { "id": "deploy-target-openai", "task": "ops:deploy-target",
         "model": "<openai-candidate>", "percent": 20 }
     ]
   }
   ```

3. **Scorecard.** Add a section to `scorecard.sql` for classifier tasks. The current scorecard only measures whole builds, so this needs the output agreement rate and cost per call, broken down by experiment group.
4. **Rule.** Only once the experiment holds quality, make the candidate the default for that task:

   ```json
   { "rules": [ { "task": "ops:deploy-target", "model": "<openai-candidate>",
                  "reason": "experiment deploy-target-openai: same quality, lower cost" } ] }
   ```

---

## Step 5: pricing and tests

**Pricing.** Every new OpenAI model has to go into all three of these:

- `services/harness/src/catalog.ts`
- `BACKENDS` in `src/modules/admin/codegen/connectionProfile.ts`
- the runner's `shared/costCalc.ts`

If it's missing from `costCalc.ts`, its spend is reported at the wrong rate.

**Tests:**

- `tests/unit/harness.test.ts`:
  - Switching provider is rejected when the call isn't portable.
  - It's allowed when the call is portable and the model has the needed capabilities.
  - It's skipped, with a recorded reason, when a capability is missing.
  - The precedence order is unchanged.
- New `complete.test.ts`: mock both SDKs and check that a forced-tool call returns the same `toolInput` and usage from each provider.

---

## Risks

- **Prompts tuned for Claude.** The classifier prompts may do worse on GPT, so they don't switch until the replay script shows agreement.
- **Prompt caching works differently between the providers.** The classifier prompts are short, so it barely matters for them. It matters for PRD writing, which is one reason that comes later.
- **Automatic failover to the other provider when one is down is a separate feature.** The README keeps it out of routing on purpose, and the adapter makes it easy to add later.

---

## Order of work

1. **Step 1** (adapter) and **Step 2** (harness), with tests.
2. Move **one** call site, `ops:deploy-target`, from start to finish, then run the replay script.
3. Move the other seven classifier call sites.
4. Run the experiment, then the scorecard, then promote to a rule.
5. Later: PRD, design and doc-extract.

## Open decision

**Which OpenAI model should be the cheap candidate against Haiku?** The current mappings include `gpt-4o-mini`, but the harness catalog doesn't list it yet. Compare candidates by price from the existing pricing tables before choosing.
