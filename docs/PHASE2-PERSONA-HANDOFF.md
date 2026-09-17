# Over18 — Phase 2 Avatar-Derived Persona Handoff

What was built, why each decision went the way it did, what is decided versus
still open, and what has genuinely been verified versus merely typechecked.

Written 2026-09-17 against `claude/phase-2-development-xpwu42` @ `6e74183`.
Every file path and line reference was read from the working tree.

---

## 0. Read this first: which repository, and what is deployed

**Nothing here is deployed anywhere.** This work lives in
`jackwalsh88/chatbotP2`, not in `NewMotive8/Over18`.

| | |
|---|---|
| This work | `jackwalsh88/chatbotP2`, branch `claude/phase-2-development-xpwu42` |
| Baseline for the PR | `phase-1-baseline` @ `2bd52f6` — an untouched copy of Over18's `epic-11-ops` |
| Production | still `NewMotive8/Over18` @ `epic-11-ops`, unchanged and untouched |

`chatbotP2` was EMPTY at the start of this work. Over18's `epic-11-ops` was
cloned into it as a one-time copy (read-only; nothing was ever pushed to
Over18), and Phase 2 was built on top. So `2bd52f6` is the last commit that
is also in Over18, and everything after it is new.

**An unresolved logistics decision, and it is the first thing worth settling:**
how this reaches production. Three options, none of them started —

1. keep developing in `chatbotP2` and merge back to Over18 later (Over18
   becomes the stale copy in the meantime);
2. port this branch into Over18 now — cleanest for shipping, but it is 12
   commits on top of an imported history, so likely a squash or cherry-pick
   rather than a merge;
3. treat Over18 as production and `chatbotP2` as the Phase 2 workshop
   indefinitely — workable, but say so explicitly or two codebases diverge
   silently.

Whoever owns the Railway deployment should pick. Nothing in the code depends
on the answer.

---

## 1. What this feature does

A character's avatar photo produces her structured fictional life — age,
occupation, life stage, daily routine, recurring worries, how she jokes, how
she flirts — which is persisted, compiled deterministically into prose, and
rendered into the chat prompt's `WHO SHE IS` and `HER VOICE` sections.

The hypothesis under test (from the Phase 2 handoff): replies are generic
because the model does not know enough about the character's ordinary life,
not because the behaviour architecture is wrong.

**That hypothesis has NOT been tested yet.** See §6.

---

## 2. Architecture, and what was deliberately not touched

The Phase 1 separation is intact:

> Character data says WHO she is. Code says HOW she talks.

`conversationStyle` and the stored `systemPrompt` still never reach the
model. `llm.test.ts`'s assertion to that effect passes unmodified, and
`prompt-builder.test.ts`'s 31 pinned cases pass unmodified.

```
photo (canonical reference asset)
  └─ character-persona-generator.ts     vision call → structured JSON
       └─ character-persona-service.ts  validate, merge, persist
            └─ character-persona-compiler.ts   structured data → prose
                 └─ prompt-builder.ts    WHO SHE IS + HER VOICE only
```

| New file | Responsibility |
|---|---|
| `packages/shared/src/index.ts` | `CharacterPersona`, `ProposedCharacterProfile` types |
| `apps/api/src/llm/vision-types.ts` | multi-part (text+image) message contract |
| `apps/api/src/llm/openai-compatible-vision.ts` | vision adapter |
| `apps/api/src/services/character-persona-generator.ts` | the vision call, prompt, parsing, validators |
| `apps/api/src/services/character-persona-service.ts` | validation, persistence, regeneration, pin/release |
| `apps/api/src/services/character-persona-compiler.ts` | deterministic persona → prose |
| `apps/web/src/admin/characterPersona.ts` | React-free form/diff logic |

`llm/types.ts` and `llm/openai-compatible.ts` were **not** widened. They are
shared with live chat and Autofill; the vision path got its own contract and
its own near-duplicate adapter rather than changing code every chat message
depends on.

### Database

One new table, `character_personas`, one row per character (migration
`0025_pale_the_liberteens.sql`):

- `persona` jsonb — the current structured identity, generated fields and
  admin edits already merged
- `edited_fields` text[] — which keys a human wrote by hand
- `source_asset_id` — which reference image produced the current content
- `generated_at` — null until generation has succeeded once

---

## 3. Decisions, and the reasoning behind each

### 3.1 The photo outranks the written bio

Originally the reverse: the generator treated `shortBio` as binding truth.
Inverted on the product owner's call, and the reasoning is sound — the bios
are the known weak artifact. Phase 1 measured 13 of 18 generated profiles
explicitly directing poetic speech and 12 of 18 sharing one "quietly
intense" archetype. The photo is also what users actually see. Protecting
the bio against the photo protects the worse of the two.

The current profile is still supplied to the generator as material to KEEP
WHERE IT FITS, so accepting a rewrite does not discard usable operator
detail.

### 3.2 Writing the bio is a proposal, never an automatic overwrite — except where nothing can be lost

Generation persists the persona and RETURNS a proposed bio/personality/
interests. Then, per field:

- the field is **empty** → written automatically (writing into a blank
  destroys nothing, so it needs no permission)
- the field **has text** → returned for review, shown side-by-side, accepted
  or discarded by a human

So a quick-created character (blank profile by construction) is fully
automatic — which is what the autopilot workflow needs — and a hand-written
one still gets a comparison. One code path, decided per field.

The reason a human is in the loop at all: Autofill has never written to the
database, deliberately, so re-rolling it cannot destroy an operator's work.
`shortBio`/`personality`/`interests` are exactly the fields a human
hand-writes.

### 3.3 Hand-edited persona fields are skipped by regeneration — and can be released

`character-persona-service.ts:310` — `if (editedFields.includes(key)) continue;`

**This is not a lock on editing.** Any field can be retyped and re-saved at
any time. The only thing `editedFields` does is make regeneration skip that
key. (This was a real point of confusion; the earlier description of it as a
"permanent per-field lock" was wrong and caused a false alarm.)

Because the roster is meant to run mostly on autopilot, the pin is now
visible and reversible: each pinned field shows a "yours" badge and a
"release" link, plus "Release all" for the character. Release clears the
PIN, not the text — the generated value it would revert to is not stored
anywhere, so blanking the operator's words immediately would cost them
something for nothing.

### 3.4 An imperative/style validator, because the bio reaches the model

`readsAsInstruction()` in `character-persona-generator.ts`.

`shortBio` and `personality` render into `WHO SHE IS`. A photo-derived bio
reading "respond with poetic restraint" would therefore be a behavioural
order sitting beside the code-owned behaviour layer — the exact defect
Phase 1 spent 126 measured calls removing, reachable by a brand new route.
Second-person address and style/speech nouns (tone, cadence, phrasing,
diction) are rejected per field, server-side. A rejected proposal costs
nothing: the persona still saves.

The Phase 2 roadmap in the chat handoff lists this validator as Phase 2
work. It is conservative on purpose — a false positive discards one
proposal, a false negative costs the architecture.

### 3.5 Reply length is keyed to the relationship, not to a number

`conversationStage()` in `prompt-builder.ts`, from the existing
`ReplyContext.priorMessageCount`. No schema, no state, no new plumbing; the
deterministic provider has always used that field.

Three stages — under 4 prior messages `new`, under 20 `early`, beyond that
`established` — each with its own wording. Brief at the start, more of
herself as it warms, open once comfortable.

**No sentence count, word count or maximum appears anywhere**, and a test
asserts that across all three stages. Phase 1 measured and rejected two
attempts at a budget ("usually two to four sentences", then "match his
length", which answered a question about her family in 86 characters and
took the warmth with it). Neither can quietly return.

The count itself never reaches the model — the server derives the stage and
the prompt states where they are, the same way it states a media decision.

**The thresholds are a considered guess, not a measurement.** They live in
one function so re-tuning after a real evaluation is a one-line change.

### 3.6 Why the behaviour layer was touched at all

The Phase 2 handoff says not to rewrite the five shared principles during
this work, and they were not rewritten — all four always-on principles are
byte-identical and asserted at every stage.

One rule was ADDED, and the justification is that Phase 2 caused the fault
it fixes. Identity used to be a bio and a few interests; it is now that plus
seventeen persona fields. Handed all of it, the first live reply was two
hundred words of inventory — age, occupation, hobbies, and her own
`personality` field paraphrased back — on the very first message. More
identity data produced a bigger list, not a better person. Every stage
variant keeps a "a detail at a time" guard for that reason.

This is the change most deserving of scrutiny, and it rests on a sample of
ONE live reply. The Phase 1 methodology (126 calls, two deliberately
opposite characters, three prompt variants) is a far stronger basis. If it
should be re-measured before it stays, that is the right instinct.

---

## 4. Configuration

No new required configuration. One key covers everything.

```
LLM_BASE_URL=https://api.x.ai/v1
LLM_MODEL=grok-4.20-0309-non-reasoning
LLM_API_KEY=<xai key>
LLM_TIMEOUT_MS=60000
PERSONA_VISION_MODEL=grok-4.6
PERSONA_VISION_TIMEOUT_MS=120000
```

Findings behind that split, from live testing:

- **Every Grok chat model accepts image input** (`{text, image}`, confirmed
  against `/v1/language-models`). No separate vision provider is needed, and
  `grok-2-vision-*` no longer exists — do not trust older model names.
- **`grok-4.6` is too slow for chat.** It exceeded the 30s default and
  produced a 502 `ai_unavailable`. The non-reasoning variant answered the
  same request in 0.5s. Reasoning models are the wrong tool where latency is
  the product.
- `PERSONA_VISION_*` exists so persona generation can use the better, slower
  model while chat uses the fast one. Unset, they inherit `LLM_*`.

---

## 5. Three pre-existing bugs fixed in passing

None of these are Phase 2's; all three were hit while setting up a local
Windows environment.

1. **`npm run db:seed` silently did nothing on Windows** (`5859b47`). The
   direct-invocation guard compared `import.meta.url` against
   `` `file://${process.argv[1]}` ``. On Windows those never match
   (`file:///C:/…` vs `C:\…`), so the script exited 0 having seeded nothing,
   with no error. Correct on Linux and Railway, which is why it went
   unnoticed. Now compares resolved paths via `fileURLToPath`.

2. **`npm run dev` failed on a fresh clone** (`f98064f`). `packages/shared`
   publishes from `dist/`, which does not exist until built, and only
   `build`/`typecheck` built it first. A new contributor's first command
   crashed with an error naming a package.json exports problem rather than
   the actual missing step. Added a `predev` hook.

3. **Seeded reference assets point at files that do not exist.** Not fixed —
   flagged. `MARIA_PORTRAIT_URL` is `/media/maria/portrait.png`; that folder
   contains only `hero.jpg`. Other seeded references are `placehold.co`
   URLs. So no seeded character can be used for photo generation without
   uploading a real image first, and admin reference tiles render broken
   locally.

---

## 6. What is verified, and what is not

### Verified live, end to end, against real Postgres and real Grok

- Chat produces real Grok replies; persona data demonstrably reaches the
  model (a persona-only occupation appeared in her reply while her seeded
  bio said something else)
- Persona edits persist with correct types — `age` as a number, arrays as
  arrays
- `edited_fields` records exactly the fields typed into, and re-saving an
  untouched form does not inflate it
- Regeneration walks past unreadable reference images, reads the uploaded
  one, and reaches the AI call
- The admin UI renders correctly (screenshot-verified, including the
  proposal panel and release controls)

### NOT verified

- **The comparative evaluation was never run.** This is the important gap:
  identical probes to a character WITH a persona versus one WITHOUT, to see
  whether their worlds actually differ. Per the Phase 2 handoff's own
  success criterion, that is the verdict on whether this feature worked.
  Suggested probes are in that document (§15). Luna has a persona; Sage and
  Ember do not.
- **`character-persona-service.test.ts` has never executed.** It is written
  against the real test-DB harness and typechecks, but no Postgres was
  reachable in the environment it was written in. Run it against a `*_test`
  database before trusting it. It covers the most safety-critical property —
  that an explicitly edited field survives regeneration.
- The stage thresholds (§3.5) are unmeasured.
- One live reply informed the anti-recital rule (§3.6).

### Test counts

~80 API tests and 846 web tests pass. All 31 pinned `prompt-builder.test.ts`
cases and `llm.test.ts`'s systemPrompt assertions pass **unmodified** — they
are the regression gate for the behaviour layer.

---

## 7. Open decisions for whoever picks this up

1. **Repository/deployment path** — §0. Settle first.
2. **The auto-apply behaviour** (§3.2) writes to `characters` without a
   click when a field is empty. Reversible, and nobody has reviewed it.
3. **The stage-based length rule** (§3.5, §3.6) touches the measured
   behaviour layer on thin evidence. Commit `a86dff3` is one file; `fdfc4a2`
   is its predecessor. Either can be reverted alone.
4. **Whether `editedFields` should exist at all**, now that the bio flow
   uses propose-and-accept instead. Two mechanisms do similar jobs; one
   might be enough.

## 8. Known cosmetic gaps

- The persona edit form is a ~1500px single column of 17 full-width inputs,
  while the read-only view beside it is a tidy two-column grid. Two columns
  would halve it.
- "Interests (persona)" is a developer label — it exists only to distinguish
  the field from the character's own `interests`. "Other interests" would be
  honest.

## 9. Housekeeping

An xAI API key was pasted into the working chat transcript during testing
and should be rotated in the xAI console.
