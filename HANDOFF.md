# EasyFilla — handoff

Last updated: 2026-07-30 (FINAL BUILD SESSION: 0a-0c, C, D1, D2 and F all DONE; Part 5 SKIPPED, no fixtures exist. 826 assertions, both goldens byte-identical. FIRST LIVE RUN happened: manifest load failure fixed (§7a) and the dropdown commit failure diagnosed + fixed (§7c). Orange theme (§7d) and splash hook (§7e) done. Anthropic still NEVER EXECUTED. Earlier that day: E3d DONE — residual Gemini-direct paths removed, settings UI, per-provider accounting, size-ceiling surfacing. Both goldens byte-identical; 486 assertions. Provider switching is WIRED END TO END but Anthropic has still NEVER been executed — see §1b. Next: verify against a live browser and live keys — see the checklist at the end of §7.)

**Read this before changing anything in `src/lib/ai/` or `src/content-scripts/google-forms/filler.ts`.**
Several facts below have been "corrected" from memory by past sessions and broken
each time. Every one is cited. If you believe a citation is wrong, **re-fetch the
URL** and update this file with the new one — do not change the code on recall.

---

## 1. Gemini transport — ground truth

Owner: `src/lib/ai/transport.ts`. It is the **only** file that knows the wire format.

### History of breakage (do not repeat)

| Session | Change | Reality |
|---|---|---|
| A | Wrote `/v1beta/interactions` claiming an "Interactions API" existed | It **does** exist. A was right. |
| B | "Corrected" it to `models/{model}:generateContent`, calling A a hallucination | **B was wrong.** Regression. |
| C | Restored Interactions, but wrote `response_format: {type:"json_schema", json_schema:…}` | Wrong — that's the OpenAI spelling. |
| C | Fixed to `{type:"text", mime_type:"application/json", schema:…}` | Correct — and identical to what A originally had. |

### Verified facts

- **Interactions API is GA and recommended.**
  `POST https://generativelanguage.googleapis.com/v1beta/interactions`
  <https://ai.google.dev/api/interactions-api>
  <https://ai.google.dev/gemini-api/docs/interactions-overview>

- **`input` is a string OR an array of typed content objects** — *not* `{parts:[…]}`:
  ```json
  "input": [
    { "type": "text",  "text": "…" },
    { "type": "image", "mime_type": "image/png", "data": "<base64>" }
  ]
  ```
  <https://ai.google.dev/gemini-api/docs/migrate-to-interactions>

- **Structured output is `response_format`**, shaped as:
  ```json
  "response_format": { "type": "text", "mime_type": "application/json", "schema": { … } }
  ```
  <https://ai.google.dev/gemini-api/docs/structured-output>
  On the **generateContent** path it is instead `generationConfig.responseMimeType` +
  `generationConfig.responseSchema`. Two different fields; both are implemented.

- **Response shape:** `steps[] → {type:"model_output"} → content[] → {type:"text", text}`,
  plus a convenience `output_text`. `extractOutputText()` tries all three known
  shapes (incl. generateContent's `candidates[]`) rather than trusting one.

- **`thinking_level`** = `minimal | low | medium | high`. **Not** `thinking_budget`.
  `temperature` / `top_p` / `top_k` / `candidate_count` are deprecated and
  deliberately absent everywhere — do not reintroduce them.

- **Schema type casing:** generateContent uses proto3 Schema (uppercase enum,
  `"ARRAY"`). Interactions takes standard JSON Schema (lowercase). One flag
  controls this: `UPPERCASE_SCHEMA_TYPES_ON_INTERACTIONS` in `transport.ts`.
  **SETTLED — the split is correct as built.** Do not "unify" it.

- **`Api-Revision: 2026-05-20`** is sent on the Interactions path only.
  **SETTLED — do not change, do not list as a 400 suspect.** It is documented on
  the Interactions text-generation page. Pinning it is deliberate: there is a
  documented set of breaking changes from May 2026, and an unpinned revision lets
  the request contract move underneath this codebase between sessions.
  <https://ai.google.dev/gemini-api/docs/interactions-overview>

- **Transport fallback:** default Interactions; a **404 falls back to
  generateContent once and locks** for the session (no re-probing, no wasted quota).

> The Files API wire shapes are **NOT** in this list. They are transport code
> that has never been executed — see §1b. Do not promote them here without a
> real request/response to point at.

---

## 1b. IMPLEMENTED BUT NEVER EXECUTED — treat as unproven

Everything above in §1 has at least been exercised against a live endpoint by
some past session. **Nothing in this section has.** It type-checks, it builds,
and it was transcribed from docs fetched **2026-07-28** — that is the entire
basis for it. Transport has been rewritten from memory and broken four times
(§1 table), so this code gets its own section rather than sitting among facts
that were actually observed.

**Do not move anything out of §1b into §1 or into SETTLED until a real request
has been made and its response seen.** Being written down confidently is not
evidence.

### Files API wire references (STAGE 4)

`GeminiPart.uri` is an ADDITIVE third variant beside text and inline bytes.
Nothing about the existing shapes changed; when `uri` is set, `data` is unused.

| Path | Shape | Status |
|---|---|---|
| Interactions | `{ "type": "<kind>", "uri": file.uri, "mime_type": … }` | **Never sent** |
| generateContent | `{ "file_data": { "mime_type": …, "file_uri": … } }` | **Never sent** |

Two different spellings, mirroring the `response_format` / `generationConfig`
split. Plausible, undemonstrated. <https://ai.google.dev/gemini-api/docs/files>

### Upload protocol, polling, and TTL

| Assumption | Source | Risk if wrong |
|---|---|---|
| Two-request resumable upload to `/upload/v1beta/files` with `X-Goog-Upload-Protocol/Command/Header-*` | <https://ai.google.dev/gemini-api/docs/files> | Upload fails outright; error names the file (§4d) |
| **The upload URL arrives in the `x-goog-upload-url` RESPONSE HEADER** | same | ⚠️ **THE MOST LIKELY THING TO BE WRONG.** Reading a cross-origin response header requires the caller to hold host permission for the origin and the server to permit exposure. This is called from the sidepanel (an extension page with `https://generativelanguage.googleapis.com/*`), which *should* bypass CORS entirely — but that has never been observed here. If the header is unreadable, `uploadFile()` throws a message saying exactly that rather than a generic error. Check this FIRST when debugging an upload. |
| `GET /v1beta/files/{id}` returns `state ∈ STATE_UNSPECIFIED\|PROCESSING\|ACTIVE\|FAILED`, and referencing a non-ACTIVE file fails | <https://ai.google.dev/api/files> | `waitForActive()` either never settles (times out with a named reason) or is unnecessary. Never observed. |
| **48-hour TTL**, cache expired 1 h early via `FILE_CACHE_MARGIN_MS` | <https://ai.google.dev/gemini-api/docs/files> | A shorter real TTL means a cached URI 404s mid-request. The server's own `expirationTime` is preferred when present, which is the mitigation — but no server response has ever been parsed. |
| Limits: 2 GB/file, 20 GB/project, **PDFs 50 MB** | same | Pre-upload validation rejects a file the server would have accepted, or vice versa. |

**No upload has ever been performed.** The pure parts (cache expiry, size
validation) are tested in `tests/files-api.test.mjs`; the network half is not,
and was deliberately not faked — a fake would validate the fake.

---

### Anthropic transport — BUILT, NEVER EXECUTED (TASK E2, 2026-07-29)

`src/lib/ai/providers/anthropic-provider.ts` · `anthropic-schema.ts` ·
`src/lib/ai/parity.ts`. Type-checks, builds, **97 assertions passing**.

> ⚠️ **NO LIVE REQUEST HAS EVER BEEN MADE.** Every test asserts a shape this
> code PRODUCES or an error body it CLASSIFIES, using bodies transcribed from
> the docs. That is not the same as the API accepting them. This stays §1b
> material until a real request/response is seen.

> ⚠️ **INERT BY CONSTRUCTION.** `registerProvider` is deliberately NOT called
> at module scope, and nothing outside `providers/` imports this module —
> verified by grep. E3 owns wiring (settings UI, key storage, per-provider
> accounting, cache keys). Until then the Anthropic path is unreachable, which
> is why E2 could not put Gemini at risk.

The doc facts below were fetched 2026-07-28/29 so the next session does not
re-fetch them.

> ⚠️ **The docs MOVED.** `docs.anthropic.com/en/...` now 301-redirects to
> **`platform.claude.com/docs/en/...`**. Fetch the new host directly.

| Fact | Value | Source |
|---|---|---|
| Endpoint | `POST https://api.anthropic.com/v1/messages` | `/docs/en/api/messages` |
| Headers | `content-type: application/json`, `anthropic-version: 2023-06-01`, `x-api-key: <key>` | same |
| Request body | `model`, `max_tokens` (required), `messages[]`, `system`, `tools`, `tool_choice`, `output_config` | same |
| Response | `{id, type:"message", role, model, content[], stop_reason, usage}` | same |
| Content blocks | `{type:"text", text}` and `{type:"tool_use", id, name, input}` | same |
| `stop_reason` | `end_turn` · `max_tokens` · `stop_sequence` · `tool_use` · `pause_turn` · **`refusal`** · `model_context_window_exceeded` | same |
| `usage` | `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` | same |
| Request size cap | **32 MB** for the Messages API (413 `request_too_large`; Cloudflare returns it before the API) | `/docs/en/api/errors` |

#### ✅ USE `output_config`, NOT FORCED TOOL USE

The spec said to prefer a first-class structured-output feature "if it now
exists". **It does**, and it is a much better parity fit than forced tool use:

```json
"output_config": { "format": { "type": "json_schema", "schema": { … } } }
```

**The response arrives as a normal TEXT block containing valid JSON** — not a
`tool_use` block. That means `extractOutputText()`-shaped parsing works the same
way on both providers, which is exactly what §3 parity needs. Constrained
decoding guarantees schema compliance. Supported on Claude 4.5 and later.
<https://platform.claude.com/docs/en/build-with-claude/structured-outputs>

> ⚠️ **SCHEMA REWRITING IS REQUIRED — this is real work, not a passthrough.**
> Anthropic's JSON-schema subset is stricter than Gemini's. A schema adapter
> must:
> - set **`additionalProperties: false` on every object** (mandatory);
> - emit an explicit **`required` array** per object;
> - **strip** unsupported constructs: numeric constraints (`minimum`,
>   `maximum`, `multipleOf`), string constraints (`minLength`, `maxLength`),
>   array constraints beyond `minItems` of 0 or 1, recursive schemas, external
>   `$ref`.
>
> Supported: basic types, `enum` (string/number/bool/null), `const`, `anyOf`,
> `allOf`, string `format` values. **Check `DOSSIER_SCHEMA`, `RESPONSE_SCHEMA`
> and `COMPOSE_SCHEMA` against this list before assuming they pass.** Note the
> casing question is Gemini-only — Anthropic takes standard lowercase JSON
> Schema, so `upperCaseSchemaTypes()` must NOT be applied here.

#### Multimodal

`{"type":"image","source":{"type":"base64","media_type":"image/png","data":"…"}}`
Formats: **JPEG, PNG, GIF, WebP only** (`image/jpeg|png|gif|webp`). Animations
unsupported (first frame only). **Max 10 MB per image base64** on the direct
API; max 8000×8000 px; 100 images/request on 200k-context models, 600 otherwise
— but the **32 MB request cap usually binds first**. Sources may also be
`{type:"url"}` or `{type:"file", file_id}`.
<https://platform.claude.com/docs/en/build-with-claude/vision>

#### Errors → normalized classes (E1)

Body is always `{"type":"error","error":{"type","message"},"request_id"}`.

| HTTP | `error.type` | Normalized class |
|---|---|---|
| 400 | `invalid_request_error` | invalid-request (inspect message for model vs schema) |
| 401 | `authentication_error` | auth — **UNLESS the message mentions CORS / the browser-access header, in which case `browser-access-header-missing`. See the correction below; misclassifying this tells a user their valid key is invalid.** |
| 402 | `billing_error` | quota-or-credit-exhausted |
| 403 | `permission_error` | auth |
| 404 | `not_found_error` | invalid-model |
| 409 | `conflict_error` | invalid-request |
| 413 | `request_too_large` | invalid-request (name the files — E8) |
| 429 | `rate_limit_error` | rate-limit-per-minute (**honour `retry-after`**) |
| 500 | `api_error` | overloaded (retryable) |
| 504 | `timeout_error` | timeout |
| 529 | `overloaded_error` | overloaded |

`stop_reason: "refusal"` → **safety-blocked**. `stop_reason: "max_tokens"` →
truncated output, reduce the batch. Empty `content[]` → empty-response.

#### Rate limits — SHAPED DIFFERENTLY FROM GEMINI (E6)

Headers: `retry-after` (seconds), `anthropic-ratelimit-requests-limit` /
`-remaining` / `-reset` (RFC 3339), and the same triplet for `tokens`,
`input-tokens`, `output-tokens`.

> ⚠️ **There is NO daily request quota and no Pacific-midnight reset.** Limits
> are **RPM / input-tokens-per-minute / output-tokens-per-minute**, replenished
> continuously by a **token bucket**. The long-horizon limit is a **monthly
> spend cap** (Start $500 / Build $1,000 / Scale $200,000), surfaced as **402
> `billing_error`**, not as a 429.
>
> §4c's model — a daily counter rolling over at midnight Pacific — **does not
> apply to Anthropic and must not be reused for it.** Keep counters per
> provider. Anthropic's per-minute limits ARE returned in response headers, so
> unlike Gemini the limit can be *learned from a real response* rather than
> guessed — but until one has been seen, still show "unknown" (§4c).

#### Structured-output JSON Schema subset — the adapter's contract (E2)

Owner: `src/lib/ai/providers/anthropic-schema.ts`. **Transforms what it can,
THROWS on what it cannot. It never drops a constraint silently** — a dropped
constraint on the Stage B schema would let the model return a shape §3
misreads, mislabelling provenance, which is the failure class §3 exists to
prevent.

**SUPPORTED:** `object` `array` `string` `integer` `number` `boolean` `null` ·
`enum` (string/number/bool/null) · `const` · `anyOf` · `allOf` · string
`format` (date-time, time, date, duration, email, hostname, uri, ipv4, ipv6,
uuid) · `minItems` **only 0 or 1** · `required` · `properties` · `items` ·
`description` / `title` · `additionalProperties` **only `false`**.

**REJECTED (throws with a JSON pointer):** recursive schemas · `minimum`
`maximum` `exclusiveMinimum` `exclusiveMaximum` `multipleOf` · `minLength`
`maxLength` `pattern` · `maxItems` `uniqueItems` · `$ref` `$defs`
`definitions` · `oneOf` `not` · `patternProperties` `propertyNames` ·
`if`/`then`/`else` · any unrecognised keyword.

- **The one additive transformation:** `additionalProperties: false` is added
  to every object, because Anthropic requires it.
- **`required` is preserved EXACTLY — never invented.** Forcing a field to be
  required changes what the model must emit; on the Stage B schema that is a
  provenance change, not formatting (§3 permits an EMPTY `snippet` on choice
  questions — empty, not absent).
- **Gemini's casing split cannot leak:** an uppercase `type` is rejected with an
  error naming `upperCaseSchemaTypes()`. That function is a proto3 concern for
  Gemini's generateContent path only (§1).
- ✅ **Both REAL schemas pass**: `DOSSIER_SCHEMA` (Stage A) and `ANSWER_SCHEMA`
  (Stage B, the evidence-bearing one). They use only `type` / `description` /
  `items` / `properties` / `required` / `enum`, all inside the subset.

> ⚠️ **OPEN QUESTION for the first live run.** Whether Anthropic mandates that
> **every** property appear in `required` when `additionalProperties:false` is
> set is NOT stated in the docs. The adapter deliberately does not assume it.
> If a live request 400s on schema validation, this is the first thing to test.

#### PDF / document blocks — Stage A CAN run on Anthropic (E2)

`{"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"…"}}`
<https://platform.claude.com/docs/en/build-with-claude/pdf-support>

- **`application/pdf` only.** PDFs are **`document` blocks, not `image`
  blocks** — a different block type from Gemini, where both are inline data
  with a mime type. Sending a PDF as an image block is a 400.
- **All active models support PDFs on the Claude API, and NO beta header is
  required.** (`pdfs-2024-09-25` exists in the beta list but is legacy.) This
  matters: Stage A exists to read scanned PDFs natively (§2), so if this were
  unsupported Stage A could not run on Anthropic at all. **It is supported.**
- Limits: **32 MB request**, **600 pages** (100 when the context window is
  under 1M tokens), standard PDFs only — no passwords or encryption.
- Sources may also be `{type:"url"}` or `{type:"file", file_id}`.

#### Model list — nothing hardcoded (E2)

`GET https://api.anthropic.com/v1/models?limit=100`
<https://platform.claude.com/docs/en/api/models-list>

Each entry carries a **`capabilities`** object, so support is READ rather than
assumed: `structured_outputs.supported`, `pdf_input.supported`,
`image_input.supported`, plus `max_tokens` and `max_input_tokens`. A model that
cannot do what Stage A/B needs can be excluded at selection time instead of
failing at request time.

#### Anthropic Files API exists (E8)

`POST https://api.anthropic.com/v1/files` behind beta header
`anthropic-beta: files-api-2025-04-14`; referenced as
`{"type":"image"|"document","source":{"type":"file","file_id":"…"}}`. Files-API
request cap 500 MB. **Still: never route a Gemini file URI to Anthropic, or the
reverse.** They are different namespaces on different vendors.

#### ✅ CONFIRMED — the browser-access header, and the 401 trap

**`anthropic-dangerous-direct-browser-access: true`** — sent alongside
`x-api-key`, `anthropic-version: 2023-06-01` and `content-type: application/json`.

It originates from the TypeScript SDK (`anthropic-sdk-typescript` **PR #504**)
and was **undocumented at launch**, which is why it does not appear on the
client-SDKs page. Its absence there is not evidence against it.

> ### ⚠️ A PREVIOUS SESSION RECORDED THE FAILURE MODE WRONGLY. THIS IS THE CORRECTION.
>
> **Omitting the header does NOT produce an opaque CORS/network failure.**
> That was wrong and it was the dangerous kind of wrong.
>
> It returns **HTTP 401** with `type: authentication_error` and a message
> stating that CORS requests must set that header.
>
> Our taxonomy maps 401 → `auth` → *"check your API key"*. So a user with a
> **perfectly valid key** would be told their key is invalid, and would go and
> regenerate a working credential to fix a missing request header. That is a
> false accusation produced by our own error mapping.
>
> **THE CLASSIFIER MUST SPECIAL-CASE THIS.** A 401 whose message mentions CORS
> / this header maps to its own class — **`browser-access-header-missing`** —
> and must **never** surface as an auth failure. The class exists in the E1
> taxonomy for exactly this reason and is not optional.

Because the failure is a clean 401 with a specific body rather than a dead
socket, it is *cheaply detectable* — which is precisely why mapping it onto
`auth` would be an unforced error rather than an unlucky one.

---

### SETTLED — never re-derive these from memory

Four things have each been changed on recall and broken. All four are now correct.
Changing any of them requires a **freshly fetched doc URL** in the commit message.

| Item | State | Citation |
|---|---|---|
| `Api-Revision: 2026-05-20` header | Correct. Documented. **Not** a 400 suspect. | <https://ai.google.dev/gemini-api/docs/interactions-overview> |
| Schema casing split (uppercase on generateContent for proto3 enums, lowercase on Interactions for JSON Schema) | Correct as built | <https://ai.google.dev/gemini-api/docs/structured-output> |
| `response_format: {type:"text", mime_type:"application/json", schema}` | Correct. Rewritten 3×, back to the original right answer. | <https://ai.google.dev/gemini-api/docs/structured-output> |
| The deleted first-person fabrication regex | **Must never return.** Replaced by structural evidence grounding. | see §3 |

## 2. Two-stage architecture

Previously documents + questions went to the model together on **every** report.
That re-paid for the documents each regeneration, capped batch size, and could only
see text a local extractor had already recovered — so scanned PDFs contributed nothing.

### Stage A — dossier build (`src/lib/ai/dossier.ts`)
- Sends **original file bytes** multimodally (`inline_data` base64).
- **There is deliberately no local OCR on this path.** The model reads scans and
  photos natively. Do not "restore" a Tesseract pass here — it only injects its
  own errors. (Tesseract still runs for the *diagnostics* view; that is separate.)
- Produces structured JSON; every scalar carries `source_filename` + `confidence`.
- Cached in `chrome.storage.local` keyed by a **content hash of the file set**, so
  re-uploading a different file under the same name invalidates correctly.
- Model: `gemini-3.5-flash-lite` (high-volume extraction). Answering uses
  `gemini-3.6-flash`. Both overridable.
- Size ceiling measured on **encoded** bytes (`raw × 4/3`) against 18 MB.
  Over that ceiling Stage A now routes through the **Files API** (§4b) instead
  of failing. Below it, files stay inline: an upload costs two extra round trips
  and a 48-hour server-side copy, which is not worth paying for a 200 KB PDF.
- On a safety block (empty 200 + `blockReason`), Stage A retries **once** via
  generateContent with `BLOCK_ONLY_HIGH`, because Interactions does not accept
  custom safety settings and ID photos are plausible false positives.

### Stage B — answering
- Sees the **dossier only**, never raw documents. Chunked (12/request).
- Choice answers must match an option **verbatim**; unmatchable values are
  repaired locally via `resolveToOption` or downgraded — never fuzzy-guessed.
- Partial success is mandatory: answered indices are kept, only failed
  `question_id`s are retried.

### Why Tier 0 no longer outranks the dossier
Tier 0 (local regex/profile extraction) once answered **"Full name" = "Computer
Engineering"**, sourced to a student status letter, pilled "Answered from
documents". Nothing downstream could correct it because Tier 0 short-circuited
the question. Stage A now runs **before** tiering, and on identity/contact keys
`reconcileWithDossier()` decides:

- values agree → Tier 0 keeps it (corroborated)
- one contains the other → longer wins (refinement, not conflict)
- Tier 0 has a verbatim `labelled` match and the dossier isn't high-confidence → Tier 0
- otherwise → **`conflicting_sources`**, both values logged, neither presented

---

## 3. Provenance state machine — the rule that matters

**Status is DERIVED from evidence. It is never assigned alongside a source.**

The bug this exists to prevent: a report where all 14 questions were pilled
"Answered from documents", including seven whose own source line read
`source: you`, and including one whose conflict had already been *detected* and
then overwritten. Root cause was two lines like:

```js
report.states.set(i, "answered_from_documents");
report.sources.set(i, "you");   // ← in the same breath
```

### Rules
- `isDocumentSource()` requires an actual **filename** (`/\.[A-Za-z0-9]{2,5}$/`).
  `"you"`, `"your profile"`, `"your documents"` are **not** documents.
- **No placeholder source strings exist anywhere.** Unknown provenance gets *no*
  source. Do not reintroduce a `|| "your documents"` fallback — that is precisely
  how ungrounded answers came to look attributed.
- Stage B returns `evidence: [{dossier_path, source_filename, snippet}]` per answer.
  Provenance is decided **structurally**, with zero text inspection:
  - non-empty with real filenames → `answered_from_documents`
  - **empty → `needs_user_input`**, for *all* question types
  - several files, same value → **corroboration**, confidence raised, all files listed
  - several files, **different** values → `conflicting_sources`, every candidate
    shown with its filename, none selected
  - Tier 0 vs dossier disagreement → `conflicting_sources` (`reconcileWithDossier`)

  Agreement is decided by `assessEvidenceAgreement()`, comparing each evidence
  entry's `implied_value` (the model emits one per entry — snippets are prose and
  cannot be compared). Normalization is trim / collapse-whitespace / case-fold,
  **plus containment and acronym matching**: "ECE" and "Electrical and Computer
  Engineering" are one fact, not a conflict. That case is a regression test —
  flagging the strongest corroboration in the user's document set for review
  would be a serious false positive. Tests: `node tests/run.mjs`
  (8 agreement cases + the profile-extractor suite, all passing).
- **Choice questions are NOT exempt from evidence.** Only `snippet` may be empty
  for them. An option picked with no cited file is a guess. (Q5/Q7/Q8/Q10 —
  comms channel, OS, VCS, resources — all fabricated under the old exemption.)
- `evidence: []` is a **correct and expected** outcome. The system instruction
  says so explicitly. The model must never invent a claim about the user
  ("no hurdles", "no suggestions") to avoid returning empty.
- ⚠️ **A first-person regex once guarded this. It was deleted and must not return.**
  It downgraded genuinely grounded answers opening with "I am" and missed
  fabrications phrased without those tokens.
- ⚠️ **LENGTH IS A CEILING GOVERNED BY EVIDENCE, NEVER A QUOTA TO FILL.**
  The compose length control (§4g) states an explicit word range to the model.
  That range is subordinate to the grounding rule above: a model told "230–400
  words" with a two-line seed will pad, and **padding on an application form is
  invention** — this exact failure, arriving by a new route.
  The Stage B instruction therefore says the target is a ceiling, that a
  shortfall goes in `gaps`, and that tone changes register only and never adds a
  claim. **This is a grounding invariant, not prompt wording to tune.** If drafts
  come back short, the system is working and the seed was thin; the remedy is a
  better seed, never a louder word target. Do not relax it to make the length
  control "feel more responsive".
- ⚠️ **REQUEST CONCURRENCY IS 1. SETTLED — do not raise it, guarded or
  otherwise.** (Recorded here rather than in §4c because this is the section
  future sessions read for invariants that must not be relaxed. It is a
  request-path rule, not a provenance rule; the mechanism lives in
  `request-queue.ts` and §4c, and the compose-queue consequences in §6b.4.)

  `request-queue.ts` has been concurrency-1 since it was introduced to stop a
  429 retry storm: several independent call paths each fired their own fetch
  with no shared throttle, so the *total* breached the per-minute limit even
  though every individual operation batched correctly. A per-operation batch is
  not enough — only a global gate is.

  A later design proposed a compose queue with concurrency derived from the
  model's RPM. **Rejected, and this is the reasoning so it is not re-litigated:**
  - **Throughput comes from BATCHING, not parallelism.** Stage B already sends
    12 questions per request; D2 returns N variants from ONE request. Those
    levers are already in the design and cost one unit of budget each.
  - **The free-tier DAILY ceiling is the binding constraint, not latency.**
    With a daily allowance in the low tens of requests (§4c — and Google does
    not publish the number), parallelism buys *seconds* on a run whose real
    limit is how many requests exist at all.
  - **The downside is the failure this codebase already paid for.** Trading a
    few seconds for a reintroduced 429 storm — which strands a run for a minute
    or, misclassified, until midnight Pacific — is a bad trade at any speed.

  The provider interface (§6b.2) should still expose the model's per-minute
  limit. **It drives SPACING between sequential requests** (`setChunkSpacingMs`,
  §4c), **not a concurrency count.** If a future session wants faster composes,
  the answer is a bigger batch, not a second in-flight request.
- `assertProvenanceIntegrity()` re-checks the invariant at the **PDF boundary**:
  throws in dev, downgrades + **visible sidepanel notice** in production.
- The **VERIFIED** badge is suppressed whenever any answer is `ai_draft_verify`,
  `conflicting_sources`, or `needs_user_input`; it shows `REVIEW: N drafts, …`.

States: `answered_from_documents · answered_from_profile ("From you — not a
document") · ai_draft_verify · conflicting_sources · needs_user_input ·
manual_only · ready_to_attach · needs_file · error_retry`.

---

## 3b. Field identity and coverage (STAGE 2b/2d/2e)

`src/content-scripts/adapters/identity.ts`.

- **Dedup keys on `frameId + domPath + name/id + accessibleName`, NEVER on label
  text.** Portals repeat labels once per row ("Employer", "Start date"); a
  text-keyed dedup collapses genuinely distinct fields. This is why a 59-field
  form reported ~50% duplicates. Do not "simplify" this to a label Set.
  ⚠️ **UNVERIFIED that this actually fixes the 59-field case.** The dedup logic
  is tested only against **hand-written key strings** (`tests/identity.test.mjs`,
  `tests/frames.test.mjs`) — no DOM, no captured markup, and never against the
  real 59-field form. What is proven: given correct keys, the collapse rule is
  right. What is NOT proven: that `domPath()` + `resolveFieldLabel()` produce
  distinct keys for that form's repeated rows. Re-check this the first time a
  real portal is available; do not record it as passing until then.
- `domPath()` uses tag + nth-of-type, not class names — classes churn between
  renders, structure does not.
- **Accessible-name priority** (`resolveFieldLabel`, generic detector):
  `label[for]` → wrapping `<label>` → `aria-label` → `aria-labelledby` →
  `<legend>` → `placeholder` → nearest preceding text → prettified name/id.
  Nearby-text scraping is deliberately second-to-last: on dense portal layouts
  it reliably picks up the *previous* field's text. `<legend>` was missing and
  is now above `placeholder`.
- **Nav traversal** (`src/lib/i18n/nav-dictionary.ts`) covers en/it/es/fr/de/pt
  (incl. "avanti", "suivant", "siguiente", "seguinte", "weiter") plus ar/am/zh/
  hi/ru/sw. `rel="next"` / `rel="prev"` is honoured as a language-independent
  signal in `nav-resolver.ts`, but **Guard 1 runs first**, so `rel` can never
  promote a submit control. Submit is never clicked, in any language.
- **Coverage report** (`CoverageReport` in `adapters/adapter.ts`) is emitted after
  every generic scan: fields by type, duplicates collapsed, inaccessible frames,
  manual-only count, **choice fields with zero options** (an extraction failure,
  logged as such), and `canvasOrPdfRendered` — canvas/PDF forms have no DOM and
  are stated as a hard limit rather than silently yielding nothing.
- `manual_only` (passwords, payment, login, CAPTCHA) short-circuits before
  tiering and is filtered again when building `questionsForAi`. Verified: it
  never reaches a model request.

## 3c. Frames — `all_frames` scanning and frame-routed filling (STAGE 2a)

Owner: `src/background/frame-registry.ts` (pure logic, no chrome APIs, no DOM),
`src/background/service-worker.ts` (the chrome adapter), and
`src/content-scripts/frame-identity.ts` + `frame-layout.ts` (the in-frame half).

Why it exists: Workday/Taleo/Greenhouse/SuccessFactors render the form inside
cross-origin iframes. Before this, the extension scanned only the top document
and reported **nothing** on those sites.

### The frameId handshake — get this right first

**A content script CANNOT read its own frameId.** No DOM property, no extension
API exposes it from inside a frame; `window.top === window` distinguishes the
main frame and nothing else. It must ask:

```
frame ──FRAME_HELLO {href, isTopWindow}──▶ service worker
                                          reads sender.frameId / sender.url
frame ◀──{frameId, tabId, url}─────────── (browser-supplied; never invented)
frame: setFrameId(frameId)   ← BEFORE anything scans
```

**Nothing in a frame may scan or report before its frameId is known.** Every
identity key begins with frameId (§3b), so two frames that both assumed `0`
would mint colliding keys and the merge's dedup would **delete one frame's real
fields as duplicates of the other's**. `ensureFrameIdentity()` is a single
memoized promise — that IS the queue; handlers arriving mid-handshake await the
same promise instead of racing it. 5 attempts, backoff `0/100/250/600/1200ms`;
on total failure the frame answers `identified: false` with a reason and scans
**nothing**. Visible-and-inaccessible beats invisible-and-wrong.

Do not "simplify" this to `window.top === window ? 0 : <anything>`.

### Registry shape

`Map<tabId, Map<frameId, FrameRecord>>`, exactly as specified.

```ts
FrameRecord {
  tabId, frameId, parentFrameId, url,
  generation,            // ++ on EVERY committed navigation in this frame
  helloAt,               // null until the handshake completes
  scan,                  // FrameScanResult | null — dropped on navigation
  scannedAtGeneration,
  inaccessible,          // InaccessibleFrame | null, with a reason
}
```

`generation` is what makes a stale fill *impossible* rather than merely
unlikely: answers carry the generation they were scanned at, and
`isCurrent(tabId, frameId, generation)` refuses a mismatch by name
(`"frame 3 navigated after the scan (generation 0 → 1)"`).

Lifecycle → `webNavigation.onCommitted` = `noteNavigated` (drop scan, bump
generation); `onCompleted` = late frames get picked up by the next scan;
`onErrorOccurred` = recorded inaccessible; `tabs.onRemoved` = `removeTab`.
There is **no frame-removed event in webNavigation** — removal is detected by
`reconcile(tabId, tree)` against `getAllFrames`, which drops frames absent from
the tree and reports them so their pending answers can be failed with a reason.

**A frame present in the tree but silent is INACCESSIBLE, never silently
omitted.** `classifyInaccessibleFrame()` gives it one of:
`sandboxed-without-allow-scripts` (**permanent — `retryable: false`, do not
retry forever**), `load-error`, `no-host-access` (actionable: the Grant-access
button now requests **child-frame origins too**, not just the top-level one),
`scan-timeout`, `no-content-script`.

### Routing API

Nothing is broadcast. `chrome.tabs.sendMessage(tabId, msg, { frameId })` for
every message that acts on a field — a broadcast lets every frame fuzzy-match
every answer, so two frames with an identically-labelled "Country" both fill it.

| Message | Direction | Routed to |
|---|---|---|
| `FRAME_HELLO` | frame → worker | — (worker reads `sender`) |
| `SCAN_ALL_FRAMES {tabId}` | sidepanel → worker | — (worker fans out) |
| `GET_SECTION_INFO` | worker → each frame | every frame in the tree, in parallel, 2500 ms each |
| `CLICK_NAV` | sidepanel → frame | `merged.navFrameId` |
| `REVEAL_FRAME {iframeIndex}` | sidepanel → frame | each **ancestor**, outermost first |
| `FILL_CURRENT_SECTION` | sidepanel → frame | the frame owning those answers |
| `SCROLL_TO_QUESTION` | sidepanel → frame | the frame owning that question |

**Two-step reveal, and why it is not optional:** a child frame can scroll
*within itself* but **cannot scroll its own `<iframe>` element into view** —
that element lives in the parent's document. So the sidepanel walks the
ancestor chain top-down (`revealFrameChain`), asking each frame to
`scrollIntoView` the iframe holding the next frame down; only then does the
owning frame scroll to the field (`generic/fill.ts`). Without this, widgets
that require visibility fail **silently**.

**A navigated frame is not a failed frame.** A wizard's own "Next" click IS a
navigation, so hard-failing on a generation mismatch would break every
multi-step form. What a navigation actually invalidates is the structural
`identityKey` — computed against the previous document, it may now point at a
different field. So on mismatch the key is **dropped** and the fill falls back
to label matching against the live DOM, with a console line saying so. Hard
failure is reserved for frames that are **gone** or currently **unreadable**;
both name the frame and the reason in the fill report.

**FIX 1 — that fallback REFUSES rather than guesses.** Label text is the least
reliable signal in this codebase (§3b: a 59-field form produced ~50% duplicate
labels, which is the entire reason dedup keys on structure). Falling back to it
is acceptable; silently picking a winner among several matches is not. So an
answer whose key was invalidated (`identityInvalidated`) must produce **exactly
one** candidate above threshold. Zero, or several ⇒ the field is failed with
`"ambiguous label re-match after navigation — …"`, naming the competing fields
— the same stance `liveCard()` takes on ambiguous card re-resolution.
The ordinary path (answers that never had a structural key) is untouched and
still matches greedily. `labelFallbackStats()` counts fallbacks and refusals,
reported at end of run and in the sidepanel status: **a high fallback count
means the fill loop is racing re-renders** — investigate that rather than
loosening the threshold.

`navFrameId` prefers the frame with the most **fillable** (non-manual-only)
fields — a host page whose only field is a login password must not outrank the
frame holding the application. The submit-safety guard (§`nav-resolver`) runs
inside whichever frame is asked and is unchanged, so routing can never promote
a submit control. **Submit is still never clicked, in any frame.**

### Ordering heuristic — and its known failure mode

Each frame reports one document-order sequence covering **both** its own fields
and its child `<iframe>` elements, so a child's questions are **spliced in where
its iframe sits**, not appended after everything. Within a frame the order is
bounding-rect (row bucket 8px, then x) with document order as tiebreak.

Resolving "which of my parent's iframes am I?" has two paths:

1. **`window.frameElement`** — readable only when the parent is same-origin.
   EXACT. It is the only thing that can disambiguate two sibling iframes that
   share one `src`.
2. **src ↔ url matching** — the cross-origin fallback. Progressively looser
   tiers (exact → ignoring `#fragment` → origin+path → origin). A tier
   yielding exactly one candidate wins; a tier yielding **several stops the
   search** — a looser tier cannot disambiguate what a stricter one already
   found twice.

⚠️ **KNOWN FAILURE MODE — redirects.** A frame that redirects after load has a
`url` that no longer matches the `src` its parent still advertises. If the
redirect crossed origins, no tier matches at all. Nothing outside the frames can
bridge that. When it happens the frame is marked `method: "unresolved"`, its
questions are appended after its parent's (deterministically, by depth then
frameId), and an explicit entry lands in `merged.orderingWarnings` and the
console. **The fields are all still reported — only their ORDER is uncertain,
and it says so.** Do not "fix" this by guessing a nearest match.

Dedup runs on the **merged** list via the existing `dedupeByIdentity` — never on
label text (§3b).

### Same-origin iframes: do not re-add descent

`detect.ts`'s `collectSearchRoots()` deliberately **no longer walks into
same-origin iframe documents**. With `all_frames`, that child runs its own
content script and reports its own fields under its own frameId; a parent that
also descended would report them again under the **parent's** frameId with a
path rooted in the child document — a *different* identity key, which dedup
therefore cannot collapse. The result is every same-origin embedded field listed
twice. Shadow-root traversal is unaffected and still happens.

---

## 4. Fill path

`src/content-scripts/google-forms/filler.ts`. **The most fragile layer, and the
only one with no test harness.**

### Google Forms DOM reality
- Dropdown = `div[role="listbox"]`. ⚠️ **CORRECTED 2026-07-31 BY A LIVE RUN (§7c):**
  its `[role="option"]` children **DO exist while the widget is CLOSED** — Google
  keeps them in the DOM at all times. Some builds ALSO render a detached popup, so
  a question-scoped query can still miss them. **Openness is `aria-expanded="true"`,
  NEVER the presence of options.** `.value` does nothing.
- Radio = `div[role="radio"]`, checkbox = `div[role="checkbox"]`; state in
  `aria-checked`. `input.checked = true` has no effect.
- Handlers listen for pointer events → `robustClick()` dispatches
  pointerdown → mousedown → pointerup → mouseup → click.
- Text = native setter (`setNativeValue`) + input/change/blur; frameworks patch `.value`.

### Invariants
- **Strict option matching only**: exact → trimmed/case-insensitive →
  whitespace-normalized → **fail**. Fuzzy matching is banned here; a blank beats
  a confidently wrong selection on a real application.
- **Every write is verified by re-querying the live DOM.** Never read a variable
  written during the fill. `liveCard()` re-resolves an orphaned card by
  **label + ordinal position**, and returns `null` (→ explicit failure,
  "ambiguous card re-resolution") when duplicates remain ambiguous.
- **No fixed sleeps** — everything is `pollUntil`. The single exception is
  `KEYSTROKE_GAP_MS` (inter-keystroke pacing; 200 ArrowDowns in one tick coalesce).
- Long/virtualized lists: `findOptionWithScrolling()` scrolls the popup container
  and re-scans before failing (country lists run 200+ entries).

### Timing constants — all guesses, instrumented
| Constant | Default |
|---|---|
| `OPTION_RENDER_TIMEOUT_MS` | 3000 |
| `ARIA_SETTLE_TIMEOUT_MS` | 1500 |
| `SCROLL_SETTLE_TIMEOUT_MS` | 800 |
| `POLL_INTERVAL_MS` | 60 |
| `LISTBOX_SCROLL_STEPS` | 25 |

Every wait records observed elapsed time; the run logs a `console.table` of
timings plus the slowest wait. **Tune from those numbers, not from intuition.**
A high `orphanFallbacks()` count means the fill path is racing a re-render —
a separate problem worth investigating.

---

## 4b. Shared option harvesting (STAGE 2c)

Owner: `src/content-scripts/shared/options.ts`. **One implementation, consumed
by BOTH the scanner and the fill driver.**

`waitForOptions` and `findOptionWithScrolling` used to live only in
`filler.ts`, so they ran only when FILLING. The scanner therefore emitted
choice questions with zero options whenever a widget rendered its list lazily —
and a choice question with no options cannot be answered at all. The coverage
report named this (`choiceWithNoOptions`) but nothing fixed it.

- **Non-destructive by construction.** `harvestOneWidget()` captures window +
  ancestor scroll positions and the focused element, opens the widget, reads
  `[role="option"]` **document-wide** (portalled popups render far from the
  trigger — §4), closes with Escape then a neutral body pointerdown, and
  restores. A failed restore is logged, never silent. Harvesting runs during a
  SCAN, which the user asked for as a read-only operation.
- **Native `<select>` is never opened** — its `<option>` nodes are already in
  the DOM, and on some platforms opening one hands control to an OS popup that
  cannot be closed programmatically.
- **Never opened:** `manual_only` fields (opening a payment-card or password
  widget is exactly what that flag exists to prevent), and anything matching
  `a[href]`, submit inputs, or `[role="link"]` — the pointer sequence used to
  open a widget is indistinguishable from a real activation.
- **Budget** (`HarvestBudgetTracker`, pure/tested). Both ceilings are checked:
  a generous widget count must not let a slow page stall the scan.

  | Budget | maxWidgets | maxTotalMs | perWidgetTimeoutMs |
  |---|---|---|---|
  | `DEFAULT_HARVEST_BUDGET` (scan) | 8 | 6000 | 1200 |
  | `FILL_TIME_HARVEST_BUDGET` (on demand) | 1 | 5000 | 3000 |

  Fill-time waits LONGER per widget because the field is known to be needed;
  scan-time is speculative. **Budget exhaustion is not a failure** — remaining
  fields are marked `optionsPending` and harvested on demand at fill time
  (`harvestOptionsForFill`). The alternative was a 40-second scan.
- **`choiceWithNoOptions` now means "zero options AFTER a harvest attempt"** —
  a strictly stronger claim than before, and still an extraction failure.
  `optionsPending` is the separate, non-failure counter. `applyHarvestToCoverage()`
  recomputes both after the pass, so "extraction failure" is only ever claimed
  about a widget we actually opened.

---

## 4c. Request budget and quota defence (STAGE 3)

Owner: `src/lib/ai/request-budget.ts` (pure, tested) + `quota-store.ts`
(chrome.storage) + the counter in `request-queue.ts`.

### The quota model — VERIFIED, not assumed

> "Requests per day (RPD) quotas reset at **midnight Pacific time**."
> <https://ai.google.dev/gemini-api/docs/rate-limits> (fetched 2026-07-28)

That is why every window is keyed on the **Pacific calendar date**
(`pacificDayKey`, via the `America/Los_Angeles` IANA zone so PST/PDT is the
platform's problem). A UTC or local-date key rolls the counter over at the
wrong moment, and a hardcoded UTC-8 is an hour wrong for two-thirds of the year.

### The numeric limit is deliberately UNKNOWN

The rate-limits page does **not** publish free-tier RPD per model. It points at
the AI Studio dashboard, says limits "are not guaranteed and actual capacity may
vary", and the free-tier Flash allowance has already been cut once (widely
reported 250 → 20 RPD, Dec 2025).

So `limit` starts `null` and the UI says **"N requests used today (daily limit
unknown)"** rather than inventing a denominator. A limit becomes known only by:
1. the user setting one, or
2. `extractObservedLimit()` reading it out of a real 429's QuotaFailure, or
3. `noteDailyQuotaExhausted()` — when the daily quota IS hit, the count so far
   *was* the allowance.

**Do not hardcode a number here.** Guessing produces exactly the
confident-but-wrong reporting the rest of this file exists to prevent.

### The classifier bug that was found and fixed

The old test was `/per[_ -]?day|perday|daily|free[_ -]?tier/` — which treats
**any** free-tier violation as daily. But `free_tier` appears in Google's
per-MINUTE metrics too:

```
generativelanguage.googleapis.com/generate_content_free_tier_requests
GenerateRequestsPerMinutePerProjectPerModel-FreeTier   ← per minute
GenerateRequestsPerDayPerProjectPerModel-FreeTier      ← per day
```

So a per-minute free-tier 429 was classified **non-retryable** and the run
stopped dead on something that would have cleared in 60 seconds.
`classifyQuotaWindow()` now checks window tokens **before** the bare free-tier
wording, and treats a short server `retryDelay` as proof of a per-minute window.

### The rest

- **Counter** increments at the single gated chokepoint in `request-queue.ts`,
  which every request including retries passes through. Counting per feature drifts.
- **Chunk spacing** (`setChunkSpacingMs`, default 1100 ms) between sequential
  dispatches, so chunked answering cannot trip the per-minute limit that caused
  the retry in the first place.
- **Pre-flight** runs after the (free) scan and **before Stage A spends
  anything**. The question count there is an UPPER BOUND — tiering has not run
  yet and only reduces it, which is the safe side to err on. Verdicts:
  `ok` / `tight` / `exceeds` / `unknown-limit`. Only `exceeds` prompts, offering
  **"answer the first N now"** sized to the remaining budget, or cancel with
  nothing spent. Deferred questions become `needs_user_input` with a logged
  reason — a capped run is visibly capped.
- **On daily exhaustion: never retry.** Completed work is kept, the reset time
  is surfaced, and switching model/key is offered.

---

## 4d. Files API (STAGE 4)

> ⚠️ **This whole section is §1b material: implemented, never executed.** No
> upload has ever been performed. Every shape was fetched from live docs on
> 2026-07-28; none has been confirmed by a real response. See §1b for the
> per-assumption risk table, especially the `x-goog-upload-url` header.

Owner: `src/lib/ai/files-api.ts`. **Do not rewrite from memory — that is how §1
got broken four times.**

<https://ai.google.dev/gemini-api/docs/files> ·
<https://ai.google.dev/api/files>

- **Upload is resumable and takes two requests.**
  1. `POST https://generativelanguage.googleapis.com/upload/v1beta/files` with
     `X-Goog-Upload-Protocol: resumable`, `X-Goog-Upload-Command: start`,
     `X-Goog-Upload-Header-Content-Length`, `X-Goog-Upload-Header-Content-Type`,
     body `{"file":{"display_name":…}}`.
     → the upload URL comes back in the **`x-goog-upload-url` RESPONSE HEADER**,
     not the body. Reading a cross-origin response header needs a context with
     host permission for the origin (an extension page — a content script could
     not do this).
  2. `POST <that url>` with `X-Goog-Upload-Offset: 0`,
     `X-Goog-Upload-Command: upload, finalize`, raw bytes.
- **Poll until ACTIVE.** `GET https://generativelanguage.googleapis.com/v1beta/files/{id}`.
  States: `STATE_UNSPECIFIED | PROCESSING | ACTIVE | FAILED`. **Large PDFs sit
  in PROCESSING and referencing one early fails** — `waitForActive()` is not
  politeness, it is the difference between working and a confusing 400.
- **TTL: files are stored for 48 hours.** The URI cache
  (`easyfilla.fileUploads.v1`) keys on the same per-file content hash the
  dossier cache uses, and expires **one hour early** (`FILE_CACHE_MARGIN_MS`) so
  a rebuild inside the window never references a URI that lapses mid-request.
  A server-supplied `expirationTime` overrides the 48 h default when present.
- **Documented limits:** 2 GB per file, 20 GB per project, **PDFs 50 MB**.
  `checkUploadable()` validates every file BEFORE uploading any, so a set with
  one 60 MB PDF fails naming that file rather than after three slow uploads.
  The PDF cap is applied by extension too — phone-exported PDFs often arrive
  with an empty MIME type.
- **Upload failures name the file and the reason** (`FileUploadError`), never a
  generic AI error: "upload failed" does not tell the user which of six
  documents to fix.
- Which path each file took is logged per file (`uploadMethod` / `filesApiUsed`).

---

## 4e. Permissions — final set and store justification

> Task letters are reused across sessions. This was "TASK D" of the
> permission-hygiene session — NOT the compose-queue TASK D specified in §6b.

Broad **static** host permissions mean a more alarming install prompt and
heavier CWS review. A previous session widened `docs.google.com/forms/*` to
`docs.google.com/*` to reach Forms' Drive-picker child frames — legitimate in
motive, but it granted static access to Docs, Sheets, Slides and Drive. That is
reverted; the breadth now lives in `optional_host_permissions`, requested at
runtime from the Grant-access button's own click gesture.

| Entry | Kind | Justification (store-submission ready) |
|---|---|---|
| `activeTab` | permission | Acts on the tab the user explicitly invoked the side panel on. |
| `scripting` | permission | Injects the form scanner into the current tab (and its frames) on user action; tabs open before install get no declarative script. |
| `storage` | permission | Local-only: API key, profile, document dossier cache, uploaded-file URI cache, daily request ledger. Nothing is sent anywhere except the user's own Gemini key. |
| `sidePanel` | permission | The entire UI is the side panel. |
| `webNavigation` | permission | Enumerates the frame tree (`getAllFrames`) so forms inside cross-origin iframes are found, and detects frame navigation/removal so answers are never written into a stale frame (§3c). Used for frame bookkeeping only — no browsing history is read or stored. |
| `https://docs.google.com/forms/*` | **static** host | The one site with a dedicated adapter. Narrowest pattern that covers it. |
| `https://generativelanguage.googleapis.com/*` | **static** host | The Gemini endpoint the extension calls with the user's own key. Cannot be optional: there is no user gesture at connection-test/report time. |
| `https://*/*`, `http://*/*` | **optional** host | Requested per-origin at runtime, only for the site the user is actually filling, and only from the Grant-access button. Not shown at install. |
| content_scripts `matches: https://docs.google.com/forms/*` | declarative | `all_frames` + `match_about_blank` (§3c). Same narrow pattern. **NOT `match_origin_as_fallback`** — Chrome rejects that flag alongside a path narrower than `*`; see §7a. |

**Host-permission matching is PATH-sensitive** (`patternCoversUrl`).
`https://docs.google.com/forms/*` does **not** cover
`https://docs.google.com/picker`, which is exactly where Forms puts its
Drive-picker child frame. An origin-only check called that frame "covered",
classified its silence as `no-content-script`, and buried the one actionable
message. Verified by test: an ungranted child origin is reported
`no-host-access` with a "grant access" reason, and stops being blamed on
permissions once granted.

---

## 4f. Release hardening

> This was "TASK B" of the release-hardening session — NOT the length/tone
> TASK B in §4g. Letters are per-session; sections are the stable reference.

### B1 — API key: where it lives and what an attacker can read

**Stored in `chrome.storage.local` under `geminiApiKey`, in PLAIN TEXT.**
Deliberately not `chrome.storage.sync`, which would replicate it to every device
on the user's Chrome account.

**Audited paths (all grep-verified clean):**

| Boundary | Result |
|---|---|
| Any file under `src/content-scripts/` | **No reference to the key.** Structurally unreachable. |
| Any message type in `src/lib/messaging/` or `src/types/` | **Key is not a field on any message.** |
| `src/background/` (the service worker) | **Never handles it** — the worker does not import the AI client at all. |
| Page/MAIN world | **No `world: "MAIN"` injection exists anywhere**, so it cannot reach page JS. |
| Console | No log statement references it. |

It is read only inside `src/lib/ai/*`, which runs in **extension pages**
(sidepanel, options), and travels only in the `x-goog-api-key` header direct to
Google. The options input is `type="password"`, `autocomplete="off"`.

`hasGeminiApiKey()` was added so callers that only need "is one configured?"
(the first-run hint) never materialise the string.

⚠️ **What an attacker with local profile access can read:** everything, in plain
text — the key, the dossier, and the profile, which may contain passport
number, national ID, DOB and address. Chrome does not encrypt extension storage,
and adding our own would mean storing the encryption key beside the data. This
is stated plainly in `privacy-policy.md` rather than papered over.

### B4 — console hygiene, and the leak that was found

`src/lib/debug.ts`. Summary blocks (coverage, tier distribution, fill-timing
`console.table`, transport summary) stay ON — each exists because a specific
silent failure was only diagnosable once it printed. Per-field/per-frame chatter
is gated behind `debugLog()`, **default off**, toggled in Options → Diagnostics.

**A real leak was found and removed:** `sidepanel.ts` logged the *entire
extracted text of every uploaded document* on every upload — passport numbers,
national IDs, addresses, DOBs. A user pasting their console into a bug report was
pasting their identity documents. It now logs the character count only.

Also value-scrubbed: the Tier-0 resolution log, the conflicting-sources warning,
and the committed-answer log now print the field/key/source but **never the
value**. The rule is absolute and is not a function of the debug flag:
**the API key and document contents are never written to the console at any
level.** `debugLog` is a volume control, not a confidentiality boundary.

### B5 — MV3 termination

| State | Where it lives | Survives worker death? |
|---|---|---|
| Cached per-frame scans | Worker memory | No — and it does not matter. `scanAllFrames` re-enumerates and re-fans-out every call. |
| **Frame generation counters** | Worker memory → **now mirrored to `chrome.storage.session`** | **Yes (new).** |
| Daily quota ledger | `chrome.storage.local` | Yes. The in-memory mirror lives in the sidepanel, not the worker. |
| Approved answers | Sidepanel memory | No — **deliberately.** Answers derived from ID documents are not written to disk. Closing the panel discards them. |

The generation counters are the §3c stale-fill guard. Losing them reset every
frame to 0, which made pre-restart answers look mismatched — *safe* (they
degrade to the FIX 1 strict-label path) but needlessly lossy across an idle gap
the user never saw. `exportGenerations`/`importGenerations` now persist them.
**A restore never LOWERS a live counter** — this worker's own observation is
newer than anything on disk. `storage.session`, not `local`: they describe
currently-open tabs and are meaningless after a browser restart.

### B6 — dead code removed, and one inert feature found

Removed: `OPTIONS_NOT_HARVESTED`, `hasConfidentNext`, `debugEnabled`,
`debugWarn`, `alwaysWarn` (all zero call sites).

**`setChunkSpacingMs` was exported but never called** — STAGE 3's "configurable
spacing" was inert, so chunked runs still fired back-to-back. It is now derived
from the selected model's `assumedRpm` at the same point `setQueueRpm` is set,
so switching models re-paces both together: `(60000 / rpm) * 0.9`.

**`setDailyLimit` was exported but had no UI**, while the pre-flight message
already told users to "set it in Options". Options now has the field, so the
message is no longer a promise the app doesn't keep.

Every declared permission is used; see §4e for the justification table.

---

## 4g. Compose UX — expectation setting and mode controls (DONE)

> "TASK A + TASK B" of the compose-UX session. The unbuilt remainder of that
> session (C, D, E, F) is specified in §6b.

Owner: `src/lib/ui-prefs.ts` (pure data + pure functions, tested),
`src/sidepanel/index.html`, `sidepanel.css`, `sidepanel.ts`, `options.*`.

### TASK A — the input-quality note

Output quality is bounded by input quality, and nothing in the interface said
so. The note now appears three times, from **one constant** so the copies
cannot drift (`INPUT_QUALITY_NOTE`, `…_SHORT_FILES`, `…_SHORT_SEED`):

| Placement | Dismissible? | Why there |
|---|---|---|
| Splash, during the intro animation | **Yes**, persisted to `chrome.storage.local` under `easyfilla.inputQualityNoteDismissed` | First impression |
| Beside the upload zone (`#input-note-files`) | **No** | The moment uploading is actionable |
| Beside every seed box (built in `buildComposeControls`) | **No** | The moment seed-writing is actionable |

- **The splash note does not delay or block the splash.** It is a plain
  `hidden` toggle; the MIN/MAX dismissal timers are untouched and the animation
  stays exactly as skippable. If storage is slow and the splash has already
  gone, nothing is shown — correct, not a bug.
- **`#splash` is no longer `aria-hidden` as a whole.** It used to be, which
  would have hidden the note from assistive tech entirely. `aria-hidden` moved
  onto the decorative logo/bars; the note is `role="note"` and announced.
- Contrast on the splash is ≈14.5:1. `prefers-reduced-motion` removes the
  note's fade.
- **Do not make the two inline copies dismissible.** A user who dismissed the
  splash note weeks ago still needs the advice at the point of action; that is
  the entire reason there are three placements and not one.

### TASK B — length and tone as INDEPENDENT axes

They used to be one entangled control ("shorter" also read as terser and less
formal), which made **a short FORMAL answer inexpressible**. Now two separate
segmented radiogroups, per question.

**Word targets — the contract.** Length is a reproducible RANGE, never an
adjective: "make it shorter" told the model nothing checkable and produced
answers of wildly different size between runs. `LENGTH_TARGETS` in
`ui-prefs.ts` is read by BOTH the UI label and the model instruction, so they
cannot disagree.

| Choice | Short-answer question | Essay / paragraph question |
|---|---|---|
| **Short** | 15–40 words | 60–110 words |
| **Medium** (default) | 40–80 words | 120–220 words |
| **Long** | 80–140 words | 230–400 words |

Two scales because one scale made Short unusable on essays and Long absurd on a
single-line field. Bands are strictly increasing and non-overlapping — asserted
in `tests/compose-modes.test.mjs`.

Tones: `neutral` (default) / `formal` / `conversational`, defined in
`TONE_INSTRUCTIONS`. **Tone instructions are asserted by test to contain no
length words** (`word`, `sentence`, `paragraph`, `short`, `long`, …) so the two
axes cannot silently recouple.

**⚠️ GROUNDING INVARIANT — "a ceiling governed by evidence, not a quota to
fill".** This is not prompt phrasing to be tightened or trimmed. It is the rule
that stops the length control from becoming a fabrication control. A model told
"write 230–400 words" with a two-line seed will pad, and padding on an
application form IS invention — the precise failure §3 exists to prevent.

The Stage B instruction therefore states explicitly that the word target is a
ceiling subordinate to the evidence, that a shortfall must be recorded in
`gaps`, and that tone changes register only and never adds a claim.
**No future session may relax this to make the length control "work better".**
If drafts come back short, that is the system working: the seed was thin. The
answer is a better seed, never a louder word target.

### Segmented control semantics (do not replace with a `<select>`)

`buildSegmentedGroup()` emits `role="radiogroup"` containing real `<button>`
elements with `role="radio"` + `aria-checked` — not styled divs.

- **Roving tabindex**: exactly one focusable option per group, so each group is
  one tab stop.
- Arrow keys (both axes) move and select, wrapping; Home/End jump to the ends;
  Enter/Space select the focused option. This is the WAI-ARIA radio-group
  pattern and what a screen-reader user will expect after hearing "radio group,
  Length".
- `aria-label` carries the concrete range (`"Short, 15 to 40 words"`), so the
  target is available to screen readers and not only as a visual tooltip.
- Selection is **not colour-only** (WCAG 1.4.1): a `✓` is prepended via
  `::before` on `[aria-checked="true"]`.
- A `<select>` was rejected deliberately: these are 3-option, always-visible
  choices the user flips while comparing drafts, and burying them one click
  deep makes that comparison worse.

### The per-item settings fix (a real bug, found while building B)

`runCompose` previously did `composeSettingsFor(firstIndex)` and applied that
one result to the **entire batch**. Composing three questions at once silently
gave all three question 1's length and tone — so "settings persist per
question" was false in practice even though the map was already keyed by index.

Length and tone now ride on each `ComposeRequestItem`, and the directive is
emitted **per question** inside `questionsBlock` (`itemDirective()`), not once
per batch. `composeInstructions()` now takes no arguments and only carries the
batch-level rules. **Do not reintroduce a batch-level length/tone parameter.**

### Global defaults

Options → Compose defaults seeds each question's *initial* choice
(`easyfilla.composeDefaults`). It is a starting point, **not an override**:
changing it later does not rewrite questions the user has already tuned.

---

## 5. Other things worth not re-deriving

- **MV3 CSP**: `"script-src 'self' 'wasm-unsafe-eval'"` is required or
  `WebAssembly.instantiate` is blocked (this silently broke OCR for days).
  tesseract needs `workerBlobURL: false` — `blob:` workers are CSP-blocked — and
  it rejects with **bare strings**, so `instanceof Error` checks miss it.
- **`chrome.permissions.request()` must be the first statement in a gesture
  handler.** Any preceding `await` destroys the user gesture.
- **Traversal lives in the sidepanel**, not the content script: clicking "Next"
  can trigger a real navigation that destroys the content script.
- **`chrome.webNavigation` has no frame-removed event.** Frame removal is only
  detectable by reconciling against `getAllFrames`. Don't go looking for the
  listener that doesn't exist (§3c).
- **`window.frameElement` returns `null` cross-origin** in modern engines rather
  than throwing; older ones throw `SecurityError`. Both are handled, and neither
  is a usable frameId source — only the worker's `sender.frameId` is.
- **Chrome's Errors page never auto-clears.** A "persisting" error may be a stale
  build. Compare stack hashes before re-fixing something.
- **Stage A input comes from `rawUploads`, never `extractedDocuments`.**
  `extractedDocuments` is populated inside a `try`, so a file whose local
  extraction *threw* was silently absent — exactly the scanned PDFs Stage A
  exists for. Do not re-couple these.
- Sensitive Tier-0 values (ID, passport, DOB) are **never** sent to the API.
- Submit is **never** clicked, in any language.

---

## 6. Not built

**Done:** identity-key dedup + accessible-name priority (2b), multilingual +
`rel` traversal (2d), coverage report (2e), manual-only exclusion verified (2f),
**`all_frames` scanning + frameId routing (2a — §3c)**, **shared option
harvesting (2c — §4b)**, **request budget + quota defence (STAGE 3 — §4c)**,
**Files API (STAGE 4 — §4d)**, **permission hygiene (§4e)**.

Also done: release hardening (§4f — key audit, first-run, error surfaces,
console hygiene, MV3 lifecycle, dead code), `privacy-policy.md`,
`store-listing.md` (permission justifications written against the **built**
`dist/manifest.json`, listing copy, screenshot shot-list, and a claims audit),
and **compose UX: the input-quality note + length/tone controls (§4g)**.

⚠️ **The store listing's claims audit is load-bearing.** `store-listing.md` §8
records what the copy deliberately does NOT say, and why, cross-referenced to
§1b and §7 here. In particular: **Workday/Taleo/Greenhouse/SuccessFactors are
never claimed as working** (naming them appears only in the reviewer-facing
`all_frames` justification, as a fact about how those sites are built), and the
**Files API is not advertised at all** because no upload has ever been executed.
If a future session verifies either, update §1b/§7 FIRST and only then loosen
the listing.

**Two submission blockers remain, both outside the code:** the contact email in
`privacy-policy.md` §10 is still a placeholder, and the privacy policy must be
served from a public URL (a repo file does not satisfy CWS).

**Not done — in priority order:**

- **Provider abstraction + Anthropic, then the compose queue and variants.**
  **Fully specified in §6b — implement from there, do not re-derive.**
  Build order is **E → C → D → F**, and §6b.1 explains why C and D cannot come
  first (an earlier session's claim that they were provider-independent was
  wrong). §6b.2 carries the **outstanding byte-identical Gemini request-body
  acceptance gate**, which is the highest-value check in that whole task.
- **jsdom fill-path harness (STAGE 5). STILL BLOCKED — attempted and skipped
  again on 2026-07-29.** `tests/fixtures/` does not exist, so no DOM tests were
  written and **no fixtures were invented**. The fill path remains the only
  layer of this codebase with no test coverage at all. Blocked on real captured
  markup —
  `tests/fixtures/` does not exist. Needs the `outerHTML` of a Google Forms
  dropdown question **with its popup open** (so the detached `[role="option"]`
  nodes are included) and one radio group. Do not invent fixtures; guessed
  markup would validate the guess, not the code.

## 6b. SPECIFICATION — provider abstraction, compose queue, variants (NOT BUILT)

> ## ⚠️ NOTHING IN THIS SECTION HAS BEEN EXECUTED
>
> **No part of the compose, queue, variant, or provider work described below has
> been run against a live browser or a live API key.** Sections 6b.2–6b.5 are a
> DESIGN, not a report. Nothing here has been observed working; nothing here may
> be advertised, marked PASS, or promoted to §1 until a real run proves it.
>
> The compose *controls* (§4g) are built and type-check; the compose *pipeline*
> beyond them has never been exercised end to end either.

This section exists so the next session implements without re-deriving. Read
§1 (transport ground truth), §1b (unproven transport code) and §3 (provenance)
first — this specification sits on top of all three and overrides none of them.

### 6b.1 BUILD ORDER — E → C → D → F

**A previous session recorded that C and D were provider-independent and could
be built before E. That was wrong, and the correction matters:**

- **D1's pacing depends on a per-provider quantity.** *(Corrected: an earlier
  draft said D1's CONCURRENCY was RPM-derived. Concurrency is now settled at 1
  — see §3 and §6b.4. The dependency on E survives the correction, for a
  different reason.)* The compose queue must route through the provider
  interface rather than `gemini-client.ts`, and the spacing it respects comes
  from the selected model's per-minute limit. That limit is a **per-provider**
  property: Gemini exposes `assumedRpm` per model (`model-config.ts`), while
  Anthropic's semantics differ in kind — token buckets, `retry-after` and
  rate-limit response headers, and a credit balance rather than an RPD reset
  (§6b.2, E6). "The selected model's per-minute limit" is not a meaningful
  quantity until a provider interface defines what a model *is*.
- **D2 packs N variants into one structured response.** That is
  `response_format` on Gemini and **forced tool use** on Anthropic — two
  entirely different mechanisms. A variants schema written against Gemini's
  spelling would have to be rewritten the moment Anthropic lands.
- **C's cancellation** flows an `AbortSignal` into the request. The provider
  interface owns `signal` (§6b.2, E1), so C's Cancel affordance wires into E's
  surface, not into `gemini-client.ts` directly.

**Therefore: E first.** C and D are then built ON TOP of the provider
interface and must call it — never `gemini-client.ts` or `transport.ts`
directly. F (documents) last, because it describes what the others ended up
being.

### 6b.2 TASK E — provider abstraction (WRAP, DO NOT REWRITE)

**The freeze is relaxed only to WRAP.** The Gemini path must remain
behaviourally identical: same endpoint, same `Api-Revision: 2026-05-20`, same
`response_format` shape, same uppercase/lowercase schema casing split, same
`uri`/`file_data` variant. Gemini's implementation is a **MOVE** of existing
code behind the interface, not a reimplementation.

#### ⚠️ ACCEPTANCE GATE — OUTSTANDING, OWNED BY TASK E

> **Diff the Gemini request bodies before and after the refactor and confirm
> they are BYTE-IDENTICAL.** This check has **not** been performed. It could not
> be: tasks A and B never touch the transport, so there was nothing to diff, and
> the wrapper does not yet exist.
>
> **TASK E is not complete until this gate passes.** Suggested method: capture
> `buildWireRequest()` output for a fixed set of inputs (text-only, multimodal
> inline, `uri` variant, both transports, schema present and absent) to a golden
> file BEFORE introducing the interface, then assert equality after. Add it to
> `node tests/run.mjs` so it stays a gate rather than a one-off.
>
> This is the single highest-value check in the whole task. §1's breakage table
> is four sessions of evidence that the Gemini wire format silently regresses
> when touched; a wrapper is exactly the kind of change that looks safe.
>
> ### ✅ THE GATE IS NOW BUILT AND ARMED (2026-07-29)
>
> `tests/gemini-wire.test.mjs` + `tests/golden/gemini-wire.golden.json`, wired
> into `node tests/run.mjs`. **The golden file was captured BEFORE any
> refactor began** — that ordering is what makes it evidence rather than a
> rubber stamp, and it cannot be recreated after the fact.
>
> - **20 request shapes**: 2 transports × 10 cases, covering all three part
>   variants (text / inline base64 / Files-API `uri`), schema present and
>   absent, system instruction, thinking level, max tokens, relaxed safety, and
>   a mixed request containing all three variants at once. Headers for both
>   transports are pinned too, because `Api-Revision` is part of the contract.
> - **Baseline fingerprint (pre-refactor):**
>   `sha256 104f4ccb3012db3d1673dc924f56e98534b9033fe46e4b38b52ce2c7dcec89cd`,
>   21 872 bytes.
> - 13 SETTLED facts are additionally asserted **by name** (response_format
>   shape, both casing behaviours, `store:false`, the `uri`→`file_data` split,
>   Api-Revision present on Interactions and absent on generateContent), so a
>   regression names itself instead of only showing as an opaque diff.
> - Intentional regeneration: `UPDATE_GEMINI_GOLDEN=1 node tests/gemini-wire.test.mjs`
>   — **only with a freshly fetched doc URL justifying the change**, per §1.
>
> ### ✅ GATE DISCHARGED — E1 COMPLETE (2026-07-29)
>
> The Gemini wrap is done and **the gate passes unchanged**:
>
> ```
> === TASK E GATE: Gemini wire format is byte-identical ===
>   PASS ✅  all 20 request shapes match the golden file byte-for-byte
> ```
>
> Golden file **untouched** — `sha256 104f4ccb…dcec89cd`, 21 872 bytes, identical
> to the pre-refactor baseline. `UPDATE_GEMINI_GOLDEN` was never set.
> All 13 named SETTLED assertions pass. Suite: **269 assertions, 0 failures.**
>
> **Why it passed trivially, which is the point:** the wrap adds no wire-format
> logic. `transport.ts` is byte-for-byte unmodified, and `ProviderPart` was
> defined to mirror the shape `transport.ts` already consumes, so the
> translation cannot alter a request. That was the design goal, not luck.

#### E1 — the interface ✅ BUILT (2026-07-29)

`src/lib/ai/provider.ts` (interface + taxonomy + registry) and
`src/lib/ai/providers/gemini-provider.ts` (the Gemini adapter).

```ts
complete({ system, parts, schema, maxTokens, variants, signal })
  -> { text, structured, usage, finishReason, provider, model }
```

**Error taxonomy** (`ProviderErrorClass`), all eleven classes:
`network` · `timeout` · `auth` · **`browser-access-header-missing`** ·
`invalid-request` · `invalid-model` · `rate-limit-per-minute` (carries
`retryAfterMs`) · `quota-or-credit-exhausted` · `overloaded` ·
`safety-blocked` · `empty-response`.

`RETRYABLE_ERROR_CLASSES` lives in one place so two providers cannot disagree.
`quota-or-credit-exhausted` and `browser-access-header-missing` are both
NON-retryable — the first is the §4c retry storm, the second fails identically
until a header is added.

The Gemini classifier is **unchanged and still authoritative** (it holds the
re-verified per-day/per-minute fix from §4c). `CLASS_BY_KIND` in the adapter is
a translation of its verdicts, not a re-decision.

**The E3 boundary holds:** `transport.ts` now has exactly **one** importer,
`gemini-client.ts`, which IS the Gemini implementation. The provider adapter
imports `GeminiPart` from `gemini-client` rather than `transport` specifically
to keep that grep unambiguous.

**Deliberately NOT generalised** (per the E2 instruction): the daily counter,
Pacific-midnight reset, request spacing, 404 Interactions→generateContent
fallback, and Files API path all stay Gemini-internal. Anthropic has none of
that shape (§1b), so hoisting it now would be wrong in a specific way.

`perMinuteRequestLimit()` is on the interface and returns `null` when unknown.
§3: it drives **spacing**, never concurrency.

#### E2 — Anthropic: fetch the docs, do not write from memory

**§1's table is four sessions of memory-driven breakage.** Fetch current docs
and cite the URLs inline in the source file, as `files-api.ts` does.

Confirm from docs (do not assume): endpoint `POST /v1/messages`; headers
`x-api-key`, `anthropic-version`, `content-type`; structured output via
**forced tool use** (declare one tool whose `input_schema` is the Stage B
schema, set `tool_choice` to it, read the `tool_use` block's `input`) —
**and check whether a first-class structured-output feature now exists, and
prefer it if so**; multimodal image and PDF/document content blocks with their
supported mime types and size limits; and fetch the model list from the API
rather than hardcoding it.

> ### ⚠️ FIRST THING TO CHECK WHEN CLAUDE CALLS FAIL
>
> **Direct browser-origin calls to the Anthropic API are blocked by default.**
> There is an opt-in request header that permits it — believed to be
> `anthropic-dangerous-direct-browser-access`, **whose exact current name and
> required value MUST be verified from the docs before use.**
>
> Without it you get an **opaque CORS failure that presents as a generic
> network error**. Do not debug it as connectivity, DNS, or a bad key. Check
> this header first. The normalized `network` error for the Anthropic transport
> should say so in its message.

#### E3 — parity (non-negotiable)

Stage A must produce the **same dossier object shape** and Stage B the **same
answer objects** on both providers, including the `evidence` array with
`dossier_path`, `source_filename`, `snippet` and `implied_value`.

**The provenance state machine (§3) sits downstream and must not know which
provider ran.** Add tests asserting both providers' parsed outputs satisfy one
shared validator. A provider that cannot produce this shape is not integrated.

#### E3 — wiring: PARTIALLY DONE (2026-07-29)

**Done, gated, golden gate still byte-identical:**

- **Capability model** (`ProviderCapabilities` in `provider.ts`):
  `supportsFilesApi` · `maxInlineRequestBytes` · `maxPerFileBytes` ·
  `supportedFileMimeTypes` · `hasDailyQuota` ·
  `learnsLimitsFromResponseHeaders`. Both providers declare all six.
  **Call sites branch on capability, never on provider identity** — grep-clean
  outside `providers/`. The two providers genuinely differ on every flag, so
  identity-based branching would have been wrong, not merely ugly.
- **Files-API gating is capability-gated** (E3.6). Stage A asks
  `supportsFilesApi`, not "is this Gemini". A provider without one enforces its
  inline ceiling and fails with the offending files named largest-first.
- **Per-provider keys** (`storage/provider-keys.ts`), stored and validated
  independently, with `hasApiKey()` so neither string is ever materialised for
  a mere existence check. `MissingProviderKeyError` names WHICH key is missing.
- **Cache keys include provider AND model** (`dossierCacheKey`), and
  `dossierReuseVerdict()` returns a REASON so a switch can be explained rather
  than silently rebuilt or silently reused. A dossier cached before this
  existed is treated as unknown-provider and rebuilt, never assumed to match.
- **Anthropic is registered** in `active-provider.ts`, which is now the only
  module importing both implementations.
- **The 401 discriminator was tightened** (see the §1b correction).

#### E3b — the orchestration golden (2026-07-29) ✅ ARMED

`tests/orchestration-golden.test.mjs` + `tests/golden/orchestration.golden.json`
(**sha256 `ff447f61a1102837f14a1d21ec196ebb6fcbccbcdf6363c7db492e7306ab9ff2`,
29 309 bytes**). **Captured PRE-extraction** — it is evidence only because of
that ordering and cannot be recreated afterwards.

**What it pins that the transport golden CANNOT.** The transport golden fixes
what the transport emits *for given inputs*; it is blind to what Stage A/B/
compose *pass in*. Those system instructions carry §3 invariants, so silent
drift there is a provenance failure that no transport test can see. Eight §3
clauses are asserted **by name** (strict grounding, hard-fail on empty seed,
"NEVER pad with invention", the evidence-ceiling rule, "never pad to reach" a
word count, tone-changes-register-only, gaps-not-invention), so a dropped
clause identifies itself instead of appearing as one line in a large diff.

It also pins structural facts: that Stage A announces each filename
**immediately before its bytes** (source attribution depends on that order),
and that Stage B's schema still carries all four evidence fields.

Harness: stubs `chrome.storage` and `fetch`, then drives the REAL
`buildDossier` / `answerFromDossier` / `composeAnswers` against fixed
fixtures and records the request bodies. Seam-agnostic by construction — today
those bodies come from `callGemini`, after extraction from `complete()` → the
Gemini provider, and the golden is valid across that move.

> ##### ⚠️ IT ALREADY CAUGHT ONE — BEFORE ANY EXTRACTION CODE WAS WRITTEN
>
> All three stages send **`thinking_level: "medium"`**. `CompleteRequest` had
> no reasoning field, so moving them onto `complete()` would have **dropped
> `generation_config` from every real Gemini request** — invisible to the
> transport golden, which faithfully emits whatever it is handed.
>
> Fixed by adding provider-neutral `reasoningEffort` to `CompleteRequest`.
> Gemini maps it to `thinking_level` (same value set, a rename). **Anthropic
> deliberately IGNORES it** rather than guessing: §1b records three distinct
> thinking-related 400s whose correct shape is model-dependent. Implement it
> there only against a fetched `capabilities.thinking.types` check.
>
> **This is the concrete argument for capturing goldens before refactors, not
> after.** Captured afterwards, the missing field would have been baked into
> the baseline as "correct".

#### E3c — homing decisions for the coupled helpers (2026-07-29)

Recorded before the extraction so the split is deliberate rather than emergent.

| Helper | Home | Why |
|---|---|---|
| `logGeminiFailure`, `assertOkOrThrow` | **Gemini provider** | Transport concerns. They classify HTTP status and response shape — neither is meaningful to a provider with different status semantics (§1b). |
| Files-API path | **Gemini provider**, reached via `supportsFilesApi` | Already capability-gated (E3.6). Anthropic's own Files API is unimplemented, so the flag describes THIS CODE, not the vendor. |
| Safety-block retry | **Gemini provider** | Two Gemini endpoints with different capabilities — Interactions refuses custom safety settings, generateContent accepts them. Anthropic has no equivalent; a `refusal` stop_reason is terminal there. Pinned by `tests/safety-retry.test.mjs` BEFORE moving (neither golden covers it). |
| `normalizeDossier`, `resolveToOption` | **Orchestration** | Provider-agnostic. They shape the dossier and repair choice values, and both feed the provenance layer — §3 must not be able to tell which provider ran, so these cannot live in a provider. |
| **`extractOutputText`, `describeEmptyResponse`** | **Gemini provider** *(addition — not in the original list)* | Both parse GEMINI response shapes (`steps[]`/`candidates[]`, `promptFeedback.blockReason`). Anthropic's equivalents already live in its own provider (`extractAnthropicText`, `classifyAnthropicStop`). Leaving these in orchestration would mean the orchestrator parsing one vendor's response format — the exact coupling this task removes. `complete()` returns `{text, structured}`, so orchestration needs neither. |

**Empty-response semantics move with them.** Today the orchestrator decides
`blocked` (non-retryable) vs `empty` (retryable) by inspecting Gemini's payload.
After the move each provider makes that call in its own terms and returns the
shared `safety-blocked` / `empty-response` classes — the mapping already exists
on both sides (`CLASS_BY_KIND`, `classifyAnthropicStop`).

#### E3c — THE EXTRACTION IS DONE (2026-07-29)

**All three named functions moved onto `complete()`**, one at a time, with both
goldens re-run after each. Both remain byte-identical:

| Gate | Result |
|---|---|
| Transport golden | ✅ `sha256 104f4ccb…dcec89cd`, 20 shapes, unchanged |
| Orchestration golden | ✅ `sha256 ff447f61…06ab9ff2`, 29 309 bytes, unchanged |
| Safety-retry test | ✅ 20 assertions |
| Switchability proof | ✅ Stage A + Stage B through a mock, no key, no network |
| Suite | ✅ **465 assertions, 0 failures** (486 after E3d) |

Order was ascending coupling: `composeAnswers` → `answerFromDossier` →
`buildDossier`. The safety-block retry moved into the Gemini provider as
`readGeminiJsonWithSafetyRetry`, pinned first by `tests/safety-retry.test.mjs`.

**`reasoningEffort` and `onProgress` were added to `CompleteRequest`** — both
because the extraction needed them and would otherwise have dropped behaviour:
`thinking_level` on all three stages (caught by the orchestration golden) and
the safety-retry progress message.

##### Two things the switchability proof caught that nothing else would have

1. **The orchestrator gated on a GEMINI key.** `buildDossier`,
   `answerFromDossier` and `composeAnswers` each began with
   `loadGeminiApiKey()` → `MissingApiKeyError`, which would reject a run on
   ANY other provider before it reached `complete()`. Removed; the provider
   raises its own key error, and for Gemini that is still `MissingApiKeyError`
   from `readGeminiJson`, so the message the UI catches is unchanged. The Files
   API path genuinely needs a Gemini key, so that load moved INTO that branch.
2. **A test-harness trap worth knowing:** separate esbuild bundles each get
   their own copy of the provider registry Map. Registering a mock from one
   bundle while the orchestration resolves through another silently has no
   effect — the swap appears to work and the real provider still runs.
   `gemini-client.ts` re-exports `registerProvider`/`getProvider` so a test can
   register into the same module graph.

#### E3d.0 — residual Gemini coupling REMOVED (2026-07-29)

All four remaining Gemini-direct paths are resolved. Decisions recorded:

| Path | Decision | Why |
|---|---|---|
| `matchAnswersWithGemini` | **Moved onto `complete()`** | Generic model call with a Gemini-shaped name. Its prompt carries the FORM'S QUESTION TEXT. |
| `generateElicitationPrompts` | **Moved onto `complete()`** | Same — the prompt is built from question text. |
| `detectLanguageWithGemini` | **Moved onto `complete()`** | The sample labels ARE the form's own text. |
| `testGeminiConnection` | **Became `testProviderConnection`** (per-provider), old name kept as an alias | A connection test is legitimately provider-specific, but it must test the SELECTED provider. Sends only the word `"ping"` — never user content. |

> ##### ⚠️ THIS WAS A PRIVACY BUG, NOT A TIDINESS ONE
>
> Before this, a user on Anthropic hit one of two failures on these paths:
> either a **missing-Gemini-key error on a correctly configured run**, or **the
> form's own text silently sent to Google**. The second makes the privacy
> disclosure FALSE — it promises content goes to the provider the user selected.
>
> `tests/switchability.test.mjs` now asserts **ZERO direct Gemini traffic** on
> every one of these paths with a mock provider selected. `globalThis.fetch`
> throws, so any direct traffic fails loudly instead of passing unnoticed.

**The test caught the first failure mode immediately.** Three of these paths
still began with `loadGeminiApiKey()` — two throwing, one silently returning a
fallback. With no Gemini key they no-opped, so a user on another provider got
degraded behaviour with no error. Those gates are gone; the active provider
raises its own key error from `complete()`.

`verifyConfiguredModels` and `readGeminiJson` KEEP their Gemini key gates —
both are Gemini-specific by definition (a Gemini model list, and Gemini's own
transport).

#### E3d.1 — SETTINGS UI (2026-07-30)

`options.html` gained an **AI provider** section, and `options.ts` the logic:

| Requirement | Where |
|---|---|
| Provider selector | `#provider-select`, persists via `saveActiveProvider` |
| Separate key field per provider, stored/validated independently | `#anthropic-api-key-input` + its own save/clear/status, keyed through `provider-keys.ts` |
| Only the active provider's key is ever sent | proven by the E3d.0 zero-traffic test, not by inspection |
| Destination stated at the point of selection | `#provider-destination`, from `provider.dataDestination` |
| Misconfigured state names WHICH key is missing | `#provider-key-warning` + `MissingProviderKeyError(provider, displayName)` |
| Model list from the provider's live models, capability-filtered | `#provider-models-refresh` → `listModelsForProvider`, keeps only `supportsStructuredOutputs && supportsPdf` |
| Dossier-rebuild warning with its cost | `#provider-dossier-warning` via `dossierRetargetVerdict` |
| Per-provider connection test wired to the selector | `#provider-test-connection` → `testProviderConnection()` |

**Model listing moved ONTO the interface** as `listModels()` / `saveModel()`.
This was not cosmetic: `active-provider.ts` had two `if (provider === "anthropic")`
branches, the last provider-name branching outside `providers/`. It now delegates.

> ##### ⚠️ Gemini's model list carries NO capability flags
>
> Anthropic's `/v1/models` reports `structured_outputs.supported` and
> `pdf_input.supported` per model, so its `listModels()` **reads** them. Gemini's
> ListModels does not, so `geminiProvider.listModels()` returns `true` for both.
> That is an ASSUMPTION about the models this app offers, not a fact the API
> stated, and it is commented as such at the call site. A model that turns out
> not to support them fails on the `invalid-model` path (§4f/B3), not silently.

**The connection test button moved out of the Gemini key section.** It calls
`testProviderConnection()`, which tests the ACTIVE provider — so under a "Gemini
API Key" heading it would test Anthropic and report success, reading as evidence
about the wrong provider.

#### E3d.2 — PER-PROVIDER ACCOUNTING (2026-07-30)

`sidepanel.ts` `renderConnectionStatus()` now renders from CAPABILITIES:

- `Provider: <name>` is shown **at all times**.
- A daily counter appears **only** where `hasDailyQuota` is true.
- Where it is false, the per-minute limit is shown with its PROVENANCE stated:
  `learned from response headers` vs `our assumption, not stated by the API`,
  or `not yet learned from a response` when there is no number at all.

**Two §2 violations were found and fixed while wiring this:**

1. **`hasMonthlySpendCap` did not exist**, so the renderer printed "monthly
   spend cap applies" whenever `hasDailyQuota` was false — inferring one
   capability from the absence of another. "Has no daily quota" does not imply
   "has a monthly cap". It is now its own capability field, and
   `tests/switchability.test.mjs` asserts the two are independent
   (gemini: daily=true/monthly=false; anthropic: daily=false/monthly=true).
2. **The per-minute denominator was Gemini's assumption.** `windowLimit` is
   `currentRpm - 2`, and `setQueueRpm` is only ever called with the Gemini
   model's `assumedRpm`. Rendering `N/13 in the last minute` unqualified passed
   a Gemini guess off as the active provider's limit. It is now labelled
   **`(our pacing cap)`**.

> ##### ⚠️ A missing capability is indistinguishable from a false one
>
> An undeclared key reads as `undefined`, which is falsy, so a provider that
> FORGOT `hasDailyQuota` renders exactly like one that truthfully has none.
> `tests/switchability.test.mjs` asserts every provider declares all **7**
> capabilities and leaves none `undefined`, against the real implementations —
> **not** via `getProvider`, which by then holds the mock.

#### E3d.3 — SIZE-CEILING SURFACING (2026-07-30)

- **Before a run:** `setUploadSummary()` appends
  `~X MB of <Provider>'s <N> MB request limit (P%)`, measured on **encoded**
  bytes (base64 inflates 4/3; measuring raw lets a set through that 400s).
- **On failure:** the over-budget error names the provider and its number.

> These ceilings (18 MB Gemini, 32 MB Anthropic) are **transcribed from docs and
> still untested** (§1b/§7). Naming the provider and the number is what makes a
> wrong constant diagnosable instead of mysterious.

#### E3d — new module-level facts

- `dossierRetargetVerdict(cached, provider, model)` in `dossier.ts` answers the
  SETTINGS-PAGE question, which is **not** `dossierReuseVerdict`'s. That one
  needs the file-set hash; the settings page has none. Passing a placeholder
  hash made the key mismatch and fell through to *"the uploaded file set has
  changed"* — a claim about files the page cannot see, shown to a user who had
  changed nothing. Regression-tested in `tests/wiring.test.mjs`.

#### FINAL BUILD SESSION (2026-07-30) — 0a–0c, C, D1, D2, F

Suite: **616 assertions, 0 failures.** Both goldens byte-identical throughout.

##### 0a — E5 KEY SECURITY RE-AUDIT (the last open E-task) ✅ DONE

Re-run in B1's form, for **both** keys. Now enforced by
`tests/key-security.test.mjs` (13 assertions) rather than by a one-time grep,
because the original audit was true when written and then silently stopped being
true when a second key appeared.

| Boundary | Result |
|---|---|
| Any file under `src/content-scripts/` | **No reference to either key.** Structurally unreachable. |
| Any message type (`src/lib/messaging/`, `src/types/`) | **Neither key is a field on any message.** |
| `src/background/` (service worker) | **Never handles either key** — does not import the AI client. |
| Page/MAIN world | **No `world: "MAIN"` injection exists.** `executeScript` omits `world`, so it defaults to ISOLATED. |
| Console | **No log statement references a key or any slice of one.** Prefix redaction is treated as a leak, not a mitigation. |
| `chrome.storage.sync` | **Not used by any key module.** |

**Two real violations were found and fixed:**

1. **The first-run hint read the WRONG provider's key.** `sidepanel.ts` called
   `hasGeminiApiKey()` unconditionally, so a user with a valid Anthropic key and
   no Gemini key was told to "add your Gemini API key". It also read the state of
   a credential not in use. Now follows the active provider.
2. **The options page materialised the INACTIVE key into the DOM.** It called
   `loadGeminiApiKey()` on every open and assigned the string to the input's
   `value` — even with Anthropic selected. Two problems: it read a credential not
   in use, and it put the key into a DOM node where a screenshot, an
   accessibility-tree dump or a devtools snapshot would capture it (none of which
   respect `type="password"`). The Anthropic field never did this, so the two
   were **asymmetric**; both now show presence only.

Follow-on cleanups: both keys now write through the single audited
`provider-keys.ts`, and `gemini-api-key.ts` was reduced to `loadGeminiApiKey`
alone (its three other exports had zero call sites, and leaving them meant two
modules could write the same entry — so "who can write a key" had two answers).

> **On `hasApiKey()` not materialising the string:** its signature is
> `Promise<boolean>`, so no caller can receive the key. Precisely: the value does
> transit a local `result` object inside the function, because
> `chrome.storage.local` has no existence-check API — it cannot be otherwise. It
> is never returned, logged, or passed on.

##### 0b — PACING NOW COMES FROM THE ACTIVE PROVIDER ✅ DONE

Owner: **`src/lib/ai/pacing.ts`** (new). Tested in `tests/pacing.test.mjs` (22).

`setQueueRpm` was called from exactly ONE place — Gemini's `activeModel()` — with
the selected **Gemini** model's `assumedRpm`. So a user on Anthropic was paced by
a Gemini constant, and `noteAnthropicRateHeaders` (which reads
`anthropic-ratelimit-requests-limit`) fed nothing: the learned value existed and
was never applied. E3d.2 labelled the denominator "(our pacing cap)", which made
the DISPLAY honest and left the BEHAVIOUR wrong.

`decidePacing()` branches on the CAPABILITY `learnsLimitsFromResponseHeaders`,
never on identity, and returns one of three bases:

| Basis | When | Rendered as |
|---|---|---|
| `learned-from-response` | a real response header supplied it | "50/min (learned from response headers)" |
| `provider-assumption` | provider states a figure we assume (Gemini) | "15/min (our assumption, not stated by the API)" |
| `unlearned-fallback` | nothing known yet | "pacing conservatively at 5/min until a response states the real limit" |

`UNLEARNED_FALLBACK_RPM = 5` is **our** conservative choice, not a claim about
any provider's limit. A test asserts it equals no Gemini `assumedRpm`.

- Applied at all three orchestration entry points, so a provider switch re-paces
  without reopening Settings.
- **The sidepanel renders the SAME decision that paces the queue**, so the number
  on screen cannot drift from the number in force.
- **§3: SPACING ONLY.** A test asserts the decision object exposes no
  concurrency / parallel / in-flight field.

##### 0c — ASSUMED vs REPORTED CAPABILITIES ✅ DONE

`ProviderModelOption.capabilitySource: "reported" | "assumed"`. Anthropic reads
`structured_outputs.supported` / `pdf_input.supported` per model (§1b) →
`reported`. Gemini's ListModels carries no flags → `assumed`, declared once as
`GEMINI_CAPABILITY_SOURCE` so `listModels()` and the error path cannot disagree.

Before this the distinction existed **only in a comment**: the data was
identical, so the UI could not warn and a failure could not name the cause.

1. **In the data** — the field above.
2. **In the selector** — assumed models are labelled "— capabilities assumed",
   and the status line warns that the filter rests on an assumption.
3. **In the failure** — `diagnoseAssumedCapability()` turns a bare model
   rejection into one naming the likely cause: *"…may simply not support
   structured output … EasyFilla ASSUMED this model could do that — the
   assumption may be wrong for this model rather than your settings being wrong.
   Try another model."* It is **withheld** when it would mislead: never for a
   `reported` capability, never when the request exercised no assumed capability,
   and never for auth / rate-limit / network / timeout / safety failures. A
   diagnosis attached to every failure is noise that trains users to ignore it.

##### TASK C + D1 — COMPOSE INDICATOR AND QUEUE ✅ DONE

Owner: **`src/lib/ai/compose-queue.ts`** (new, DOM-free and provider-free).
Tested in `tests/compose-queue.test.mjs` (55 assertions).

> ###### ⚠️ THE QUEUE IS NOT IN THE SERVICE WORKER, AND MUST NOT BE MOVED THERE
>
> §6b.4 specified "lives in the service worker". It does not. Composing needs a
> provider key, and §4f/B1 + E5 require the worker never handle either key — an
> audited, **tested** boundary. Moving compose into the worker means moving key
> access into the worker and deleting that guarantee. It also agrees with B5,
> which keeps answers in sidepanel memory deliberately so answers derived from ID
> documents are never written to disk; a worker-owned queue would have to persist
> job state to survive MV3 termination. The queue lives in the extension page
> that already legitimately holds both the key and the answers.

- **Keys are `${runId}:${questionIndex}`.** `runId` is minted per report
  generation (new `ApprovedReport.runId`) — it did not exist before, which is
  exactly the hazard §6b.4 names.
- **Concurrency 1**, enforced by a `draining` flag; a test asserts the observed
  peak never exceeds 1. No concurrency knob exists to be raised, asserted
  against the source.
- **Key-routed delivery.** After `run()` resolves, the job is re-read BY KEY; if
  it was cancelled or its run superseded, the result is **dropped**. Tests cover
  the late-result-after-cancel and result-after-regeneration cases.
- **Cancellation.** Queued → removed, `spentRequest: false`, nothing restored
  because nothing was overwritten. Running → `AbortController.abort()`, the draft
  captured **at job start** is restored, state is `cancelled` not `failed`, no
  retry consumed, and the next job starts. The signal is threaded through
  `composeAnswers` to `complete()` — without that, "cancel" would only stop us
  listening while still spending the quota.
- **Admission refuses a duplicate** for a question already queued or running, so
  a double-click cannot spend two requests.
- **`queued` and `running` are visually distinct.** `running` → spinner +
  "Composing…", elapsed seconds after ≥3s. `queued` → **static bar** +
  "Queued (2nd)…". A test asserts a queued label never contains "Composing".
  `aria-busy` is true only while running — a queued job is waiting, not working.
  `prefers-reduced-motion` swaps the spinner for a solid dot (not merely
  `animation: none`, which would leave a broken-circle glyph looking like a
  rendering fault).
- Accessibility: `#compose-live-region` is a polite live region announcing start
  and finish, separate from the status line so an announcement never overwrites
  an unread error.

> **Why the per-row button and "Compose all" take different paths:** routing the
> batch button through a per-question queue would turn ONE request covering N
> questions into N requests. §2/§6b.4 are explicit that throughput comes from
> BATCHING and §4c's binding constraint is the daily request ceiling, so that
> "improvement" would multiply the user's cost by N to gain nothing. The per-row
> button composes one question (already one request) and gets full per-question
> state; the batch button keeps its single request and the global status line.

##### TASK D2 — MULTI-VARIANT DRAFTS ✅ DONE

Tested in `tests/variants.test.mjs` (23 assertions).

- **N variants in ONE request.** A test asserts exactly one request for three
  drafts. `ComposeResult.variants: string[]`; `draft` is always the first
  variant, so every existing caller is unaffected.
- **⚠️ THE SCHEMA IS CHOSEN CONDITIONALLY, AND THIS IS LOAD-BEARING.**
  `COMPOSE_SCHEMA_WITH_VARIANTS` is sent **only** when some item requests more
  than one draft. Adding `drafts` to `COMPOSE_SCHEMA` unconditionally would change
  the wire for every compose and **break the orchestration golden** — which exists
  because the request contract has been altered by accident before (§1). Keeping
  the single-draft wire byte-identical is why that golden still passes.
- **PROVENANCE INVARIANT (§3, §6b.5), enforced structurally:** when the compose
  is invalid (`notFound`, empty draft, or a leaked instruction) `variants` is
  **emptied**. A test feeds three fluent drafts alongside `notFound: true` and
  asserts all three are discarded — three fabrications are not a choice. The
  variant count never influences whether a result is usable.
- **One evidence set.** The variant schema carries `drafts` as plain strings with
  **no per-draft evidence fields** — a test asserts this. Per-variant evidence
  would let a picked variant carry a different claim about the documents than the
  one that was verified. The picker therefore never touches `report.provenance`,
  and says so: *"Same sources as before — only the wording changed."*
- The leak guard applies per variant. Note its patterns target AI
  meta-commentary ("as an AI", "I cannot", "please provide") — **echoed directive
  brackets like `[Target: 120–220 words]` are NOT detected.** An early version of
  the test wrongly assumed they were; the guard was right and the test was wrong.
  Recorded as a known gap, not patched under time pressure (§3 warns against
  casual heuristics here — see the deleted first-person regex).
- Length and tone per §4g still apply, and the word target remains a **ceiling
  governed by evidence**.

##### TASK F — DOCUMENTS ✅ DONE

**`privacy-policy.md` was materially FALSE and is now correct.** It stated
flatly "The documents you upload are sent to Google" — untrue the moment provider
switching started working. It now names both possible recipients, states that the
destination depends on the user's selection, and describes each provider's
handling **separately**.

> ###### ⚠️ THE PROVIDERS ARE NOT SYMMETRIC. Terms verified 2026-07-30.
>
> - **Google Gemini, unpaid tier:** "Google uses the content you submit … to
>   provide, improve, and develop Google products and services", and **"human
>   reviewers may read, annotate, and process your API input and output"**
>   (disconnected from account/key/project first). Paid tier: not used for
>   improvement. <https://ai.google.dev/gemini-api/terms>
> - **Anthropic API:** **"Anthropic may not train models on Customer Content from
>   Services."** Inputs and outputs deleted within **30 days**; up to **2 years**
>   if a usage-policy classification triggers, and classification scores up to
>   **7 years**. No free tier exists for the API.
>   <https://www.anthropic.com/legal/commercial-terms>
>
> So the free-tier "content is used for product improvement and human review"
> warning applies to **Google only**. Flattening these into one paragraph would
> have been the dishonest version. Re-verify before each release.

- **`manifest.json`: `https://api.anthropic.com/*` was MISSING** from
  `host_permissions`. Selecting Anthropic would have depended on that vendor's
  CORS behaviour rather than a declared origin. Added, rebuilt, and justified in
  the listing.
- **`store-listing.md`:** new host justification, the `storage` justification
  covers two keys, the PII disclosure names "the provider the user selected", and
  the options-surface note records that the worker never handles a key.
- **Listing copy mentions provider CHOICE but does NOT advertise Anthropic.**
  Two new claims-audit rows: Anthropic support is absent from the feature list,
  the short description and "How it works", appearing only in the privacy
  disclosure and LIMITATIONS where a user needs to know a second destination
  exists. LIMITATIONS states plainly that it has never been tested against the
  live API. The Files API remains unadvertised.

##### PART 5 — FILL-PATH DOM TESTS ⛔ SKIPPED, NOT ATTEMPTED

`tests/fixtures/` **does not exist.** Neither `gforms-radiogroup.html` nor
`gforms-dropdown-open.json` is present anywhere in the repository (checked by
name and by repo-wide search). Per the instruction, skipped entirely rather than
synthesised: a reconstructed fixture would test our idea of Google's markup, and
a green result would be evidence of nothing.

**The detached-popup path — the document-wide `[role="option"]` query the whole
test exists to prove — remains UNVERIFIED.** This is the highest-value item a
future session can close, and it needs a real capture taken with the listbox
OPEN (`popupRoot` non-null, `optionCount` > 0).

#### E4–E8 — status after E3d

- **E4 Settings — ✅ DONE** in E3d.1. See that section for the requirement→code
  table.
- **E5 Key security — ✅ DONE (2026-07-30).** The B1 audit was re-run against
  **both** keys and is now guarded by `tests/key-security.test.mjs` (13
  assertions) rather than by a one-time grep. **Two real violations were found
  and fixed** — the first-run hint read the wrong provider's key, and the options
  page materialised the inactive provider's key into the DOM. Full detail in the
  FINAL BUILD SESSION section above.

  > The lesson worth keeping: this task sat at "the mechanism is in place, the
  > audit has not been re-run" for a whole session. `hasApiKey()` was correct the
  > entire time, and both violations were elsewhere — in code that predated the
  > second key and was never revisited. A structural guarantee does not survive
  > the arrival of a second instance on its own.
- **E6 Accounting — ✅ DONE** in E3d.2, including two §2 violations found while
  wiring it (a capability inferred from another's absence, and Gemini's assumed
  RPM rendered as the active provider's limit). Both fixed and tested.
- **E7 Cache keys — ✅ DONE** in E3.5 (`dossierCacheKey`,
  `dossierReuseVerdict`) and extended in E3d.1 (`dossierRetargetVerdict` for the
  settings page, which has no file-set hash).
- **E8 Files API — ✅ DONE as specified**: capability-gated on
  `supportsFilesApi`, never on provider identity. Anthropic enforces its own
  ceiling with a **named-files** error, and `toAnthropicBlocks` **refuses** a
  Gemini file URI rather than forwarding it (tested in `tests/wiring.test.mjs`).
  Anthropic's own Files API remains unimplemented — the flag describes THIS
  CODE, not the vendor.

### 6b.3 TASK C — in-button composing indicator (spec)

Today a compose gives no feedback while it runs.

**Per-question state machine.** One question composing must never disable or
freeze the rest of the panel — this is the requirement that shapes everything
else, and the current code cannot satisfy it because status is global
(`setRefinementStatus`) and there is no per-row state.

```ts
type ComposeJobState = "idle" | "queued" | "running" | "done" | "cancelled" | "failed";

interface ComposeJobView {
  key: string;                 // see 8.4 — stable per question, survives re-render
  state: ComposeJobState;
  startedAt: number | null;
  previousDraft: string | null; // captured at start, for restore-on-cancel
  error?: NormalizedProviderError;
}
```

Requirements:

- **Spinner rendered INSIDE the triggering button**, label switching to
  `"Composing…"`. That button disabled; **everything else stays usable.**
- **`queued` and `running` must be visually distinct.** With concurrency
  settled at 1 (§3, §6b.4), *queued* is the ordinary state whenever a user
  composes a second question — not an edge case. A queued button showing
  "Composing…" with a spinner would be a lie, and a user watching two spinners
  where only one request exists will read the queue as broken when the second
  takes twice as long. Suggested: `"Composing…"` + spinner for `running`;
  `"Queued (2nd)…"` + a static indicator for `queued`, with its position.
  Cancelling a queued job is free — it never spends a request — and the UI
  should make that obvious, since it is the cheapest correction available.
- **Cancel affordance** wired to the existing `AbortController`. A cancelled
  compose **must not consume a retry**, **must not corrupt the answer state**,
  and **must restore `previousDraft` if one existed**. Capture the previous
  draft at job start, not at cancel time.
- **Elapsed seconds shown after ~3s**, so a slow call does not look hung.
- **Accessibility**: `aria-busy` on the button while in flight, plus a **polite
  `aria-live` region** announcing start and finish. The spinner must respect
  `prefers-reduced-motion` and fall back to a **non-animated** indicator (the
  existing `@media (prefers-reduced-motion: reduce)` blocks in `sidepanel.css`
  are the pattern).
- **On failure** the button returns to its resting state and the **existing
  classified error surfaces** (§4f/B3 — never a silent revert, never a generic
  message).

The per-row DOM handles must be held in a registry keyed by question so an
out-of-order completion updates only its own row (§6b.4).

### 6b.4 TASK D1 — compose queue (spec)

> #### ⚠️ SETTLED: CONCURRENCY STAYS AT 1
>
> **The queue does not execute in parallel. Do not add a concurrency > 1 path,
> guarded or otherwise.** See the settled decision in §3 for the full reasoning.
>
> An earlier draft of this specification proposed deriving a concurrency limit
> from the model's RPM. **That was rejected.** The queue's job is *admission*,
> not *parallelism*.

**Lives in the service worker**, keyed by question id.

```ts
Map<string, QueuedComposeJob>   // key: `${runId}:${questionIndex}`
```

**Why `runId` and not the bare index**: reports are regenerated, and a bare
index would let a stale job's result land on a freshly-scanned question with the
same position. `runId` is minted per report generation.

#### What the queue IS responsible for

1. **Admission** — accepting compose jobs from any number of questions and
   holding them until the single execution slot is free.
2. **Ordering** — a defined, inspectable order of execution (FIFO on
   enqueue). Not an implicit race.
3. **Per-question state** — each job carries its own
   `ComposeJobState` (§6b.3). Several jobs are legitimately *queued* at once;
   exactly one is ever *running*.
4. **Out-of-order-safe result routing** — results are routed by
   `${runId}:${questionIndex}` on arrival. **Never by arrival order, never by a
   captured index in a closure.** Even with concurrency 1 this matters: a
   cancelled-then-restarted job, or a result arriving after a report
   regeneration, must not land on the wrong question.
5. **Individual cancellation** — one `AbortController` per job. Cancelling a
   *queued* job removes it without ever spending a request; cancelling the
   *running* job aborts it and lets the next job start. Neither disturbs any
   other job.
6. **Queue depth in the UI** — e.g. `"1 composing, 2 queued"`. Note the first
   number is always 0 or 1 by design.

#### What the queue is NOT responsible for

- **Parallel execution.** Throughput comes from **batching**, not concurrency:
  Stage B already sends 12 questions per request (§2), and D2 returns N variants
  from ONE request (§6b.5). Those are the levers.
- **Deciding the request pace.** The existing rolling 60s window and the
  per-minute spacing in `request-queue.ts` (§4c) remain the only pacing
  mechanism, unchanged.

#### Interaction with the existing gate

`request-queue.ts` is already the single global concurrency-1 chokepoint, and
**it stays exactly as it is.** The compose queue sits *above* it as an
admission layer that adds per-question identity, cancellation and visibility —
things the global gate has no concept of. It must not bypass or duplicate the
gate, and every compose request still passes through it so the daily counter
(§4c) increments at one place.

Under TASK E the compose queue calls the **provider interface**, never
`gemini-client.ts` directly.

### 6b.5 TASK D2 — multiple drafts per seed (spec)

Let the user request **N variants (2 or 3)** for one question, shown side by
side with a pick control.

- **Generated in ONE request returning an array** — not N requests. This costs
  **one unit of budget, not three**. `ComposeRequestItem.variants` already
  exists (§4g) and is already threaded into the per-question directive; the
  response schema is what still needs extending.
- The **chosen variant becomes the answer; the rest are discarded.**
- **All variants inherit the SAME evidence and provenance.**

> **⚠️ PROVENANCE INVARIANT.** Variants are alternative PROSE over ONE evidence
> set. Picking a variant must not change the evidence, and **an
> evidence-empty compose is still `needs_user_input` no matter how many variants
> came back**. Three fluent drafts of an ungrounded answer are three fabrications,
> not a choice. §3 decides state structurally from evidence and must not learn
> that variants exist.

On Gemini this is a `response_format` schema change; on Anthropic it is the
forced-tool `input_schema`. Hence D2 after E (§6b.1).

---

## 7. Verification status — read this honestly

**Nothing in sections 2–4 has been verified against a live browser or a live API
key.** It type-checks and builds; that is all. The only executed tests are
`node tests/run.mjs` — **826 assertions** across evidence agreement, field
identity and accessible-name priority, frame merge/ordering/dedup/lifecycle
(§3c), host-permission matching (§4e), the label-ambiguity refusal (FIX 1),
harvest budget accounting (§4b), quota accounting and the Pacific rollover
(§4c), Files-API cache expiry (§4d), generation-counter persistence across a
worker restart (§4f/B5), and the compose length/tone mapping (§4g) — which cover *none* of the transport, Stage A/B
request/response, or fill paths end to end.

Specifically unverified: that Stage A's request shape is accepted; that
`Api-Revision` is a real header; that schema casing is right on either path; that
Google's option nodes match `SELECTORS.listboxOption` when portalled; that the
timing defaults are adequate; and every acceptance case in sections 3 and 4.

**There is no acceptance table in this repo.** A past session's brief referred
to one ("criterion 6, 59-field form, no duplicates, marked PASS"); it does not
exist in any file here. The underlying claim is now recorded honestly in §3b as
**UNVERIFIED** — the dedup rule is tested only on hand-written key strings, not
on the form. If an acceptance table is reconstructed later, carry that label
over rather than re-marking it PASS.

### STAGE 2a specifically — what was and was NOT executed

**Executed:** `npx tsc --noEmit` (clean), `npm run build` (clean; the built
`dist/manifest.json` was read back to confirm crxjs passes `all_frames` and
`match_origin_as_fallback` through), and `node tests/run.mjs` — 47 new
assertions in `tests/frames.test.mjs` over the merge, cross-frame ordering
(including the redirect and ambiguous-src failure modes), cross-frame dedup,
inaccessible classification, and registry lifecycle (added / navigated /
removed / tab closed). Two real bugs were found by those tests and fixed: the
nav-frame preference counted manual-only fields as "owning the form", and the
host-permission wildcard match (`https://*/*`) mis-parsed and falsely reported
`no-host-access`.

**NOT executed — no browser was run.** All of the following are reasoned-about
only: that the FRAME_HELLO round trip completes in a real cross-origin frame;
that `executeScript({allFrames:true})` reaches a Workday-class portal's
application frame; that `match_about_blank` actually covers
`about:blank`/`srcdoc` frames here; that `window.frameElement` returns the index
expected on same-origin children; that the two-step reveal makes
visibility-dependent widgets fill; that the 2500 ms per-frame scan timeout is
adequate on a slow portal; and that the rect-based in-frame ordering matches
what a user sees. `tests/fixtures/` still does not exist — **no DOM fixtures
were invented** (§6, STAGE 5).

### STAGE 2c / 3 / 4 / permissions — what was and was NOT executed

**Executed:** `npx tsc --noEmit`, `npm run build`, and `node tests/run.mjs`
(225 assertions, 0 failures) after each of the four tasks. The built
`dist/manifest.json` was read back to confirm the final permission set. Four
real defects were found BY these tests and fixed:
1. the placeholder-option regex missed `"Select…"` and `"Select an option"`;
2. the daily-vs-per-minute classifier treated every `free_tier` 429 as daily,
   stopping runs that would have cleared in 60 s (§4c);
3. `no-host-access` matching ignored URL paths, so an ungranted
   `docs.google.com/picker` frame was misreported as `no-content-script` (§4e);
4. (earlier) the nav-frame preference counted manual-only fields as owning the
   form, and the `https://*/*` wildcard mis-parsed.

**NOT executed — reasoned about only:**
- **§4b harvesting:** the entire DOM half. Whether opening a real portal widget
  renders `[role="option"]` within 1200 ms, whether Escape + body-pointerdown
  closes every widget family, and whether scroll/focus restoration is actually
  invisible to the user. Only the budget arithmetic and placeholder text
  classification are tested. **No DOM fixtures were invented.**
- **§4c quota:** no live 429 was observed this session. The metric strings the
  classifier is tested against are the documented/reported names, not captured
  responses. `extractObservedLimit` is tested against a hand-built QuotaFailure
  shape — if Google nests the value differently, learning silently no-ops (the
  ledger stays "unknown", which is the safe failure).
- **§4d Files API:** **no upload was ever performed.** The two-request resumable
  protocol, the `x-goog-upload-url` response header being readable from an
  extension page, PROCESSING→ACTIVE polling, and the `{type, uri, mime_type}`
  content block are all transcribed from docs fetched 2026-07-28, not observed.
  The header-readability assumption is the most likely thing to be wrong; if it
  is, `uploadFile` fails with an explicit message saying exactly that rather
  than a generic error.
- **§4e permissions:** the install prompt was not seen, and no runtime
  `chrome.permissions.request()` was exercised in a browser.

### Compose UX (§4g) — what was and was NOT executed

**Executed:** `npx tsc --noEmit`, `npm run build`, and `node tests/run.mjs`
(**255 assertions, 0 failures**) after TASK A and again after TASK B. 22 new
assertions in `tests/compose-modes.test.mjs` cover the word-target table
(monotonic, non-overlapping, two scales), the independence of the length and
tone axes (all 9 combinations expressible, including the short-formal case the
old control could not reach), and that tone instructions contain no length
words. One real bug was found while building: `runCompose` applied the first
question's length/tone to the entire batch (§4g).

**NOT executed — no browser was run.** Everything visual and interactive is
reasoned about only:
- that the splash note appears, is legible, and genuinely does not delay the
  intro on a real cold start;
- that the radiogroups' roving tabindex, arrow-key traversal and `✓` marker
  behave as intended, and that a screen reader announces
  `"Short, 15 to 40 words"` as designed — **no assistive technology was used**;
- that `prefers-reduced-motion` produces the intended non-animated fallbacks;
- that the Options compose-defaults selects render and persist.

**The compose PIPELINE has never been exercised end to end either.** The
length/tone directive now reaches the Stage B prompt, but no compose request
carrying it has ever been sent, so it is unknown whether the model honours the
word ranges or the evidence-ceiling rule in practice. **Treat §4g's word targets
as a specification the model has never been observed obeying.**

### §6b (provider abstraction, compose queue, variants) — NOT BUILT AT ALL

No code exists. Nothing in §6b has been executed, and its own header says so.
It is a design to implement from, not a report of anything.

### Release hardening (§4f) — what was and was NOT executed

**Executed:** `npx tsc --noEmit`, `npm run build`, `node tests/run.mjs`
(**233 assertions, 0 failures**) after each sub-task; `dist/manifest.json` read
back and every declared permission cross-checked against actual API usage. The
B1 audit was performed by grep across every trust boundary (content scripts,
message types, service worker, MAIN world, console) — all clean. Two real
defects were found and fixed: the **full-document-text console leak** (B4) and
**`setChunkSpacingMs` never being called**, which left STAGE 3's request spacing
inert (B6).

**NOT executed — no browser was run:**
- The first-run sequence (B2) was verified by reading every guard, not by
  installing the extension cold and clicking through it. The wording is
  untested against a real user.
- Error surfaces (B3) were audited by inspecting each throw/catch. **No error
  was actually triggered** — in particular the 400/404 remedy text branches on
  Google's message wording, which was matched against documented phrasings, not
  captured responses.
- MV3 termination (B5) was **never actually induced**. The persistence path is
  unit-tested (`exportGenerations`/`importGenerations`, including the
  never-lower-a-live-counter rule), but no worker was killed and restarted to
  confirm `chrome.storage.session` behaves as assumed across that boundary.
- The Options UI additions (debug toggle, daily budget) were never rendered.

---

## 7a. THE FIRST LIVE-LOAD FAILURE (2026-07-30) — and the guard added for it

Chrome refused to load the extension:

> `The path component for scripts with 'match_origin_as_fallback' must be '*'.`

**Cause.** `match_origin_as_fallback: true` was added in STAGE 2a to reach
`about:blank`/`srcdoc` frames. The narrow `https://docs.google.com/forms/*`
pattern predates it. Each was correct alone; Chrome rejects the combination,
because an opaque-origin frame has no path and so a path-restricted pattern
could never match one. **They had never been loaded together, and nine sessions
of green tests never looked at the manifest.**

### The fix: `match_about_blank`, NOT a split, and NOT a broadening

Documented rule (fetched 2026-07-30):
*"Chrome requires any content scripts specified with 'match_origin_as_fallback'
set to true to also specify a path of *."* **No such requirement exists for
`match_about_blank`.**

Splitting the entry was considered first and does not work. A second entry
carrying the flag needs a path of exactly `/*`, so its only candidates are:

| Candidate | Why it is unacceptable |
|---|---|
| `https://docs.google.com/*` | Injects into Docs, Sheets, Slides and Drive — the breadth §4e/TASK D exists to avoid. |
| `https://*/*` | Worse. Declarative `content_scripts.matches` count toward the INSTALL-TIME prompt, so this reads "Read and change all your data on all websites" at install, destroying the decision to keep those origins OPTIONAL. |

**The host was never the problem — the path was.** So no second entry can exist
without a broadening, and the correct move is the narrower, older flag:
`match_about_blank: true` covers `about:blank`/`srcdoc` — exactly what STAGE 2a
wanted — with no path restriction, so `/forms/*` stays narrow.

> ⚠️ **What is given up:** `match_origin_as_fallback` also covers `data:`,
> `blob:` and `filesystem:` frames. Nothing in this codebase needs those — the
> recorded purpose was `about:blank`/`srcdoc`, and Google Forms does not render
> into a `data:` frame. If one is ever needed, get it from the RUNTIME path
> (`executeScript({allFrames:true})`, already gated on a user gesture and scoped
> to one tab), which is strictly narrower than any declarative pattern.

> ⚠️ **Still unverified:** that `match_about_blank` actually reaches the frames
> in question. It replaces an unverified flag with a differently-unverified one.
> The manifest now LOADS, which is strictly better than before, but frame
> coverage remains item 4/19 on the checklist below.

### The guard: `tests/manifest.test.mjs` (36 assertions)

Validates **`dist/manifest.json`**, not the source — crxjs rewrites `js` paths,
swaps the service worker for a loader, and **adds a `web_accessible_resources`
entry that does not appear in the source**. Chrome loads the built file, so the
built file is what must be valid. The source is checked too, so a bad edit fails
before a build. It rebuilds automatically when `dist/` is missing or stale.

Asserted: the `match_origin_as_fallback` path rule (on both files); full match-
pattern syntax for `host_permissions`, `optional_host_permissions`,
`content_scripts.matches` and `web_accessible_resources.matches`; both API
origins present; **permission-hygiene regression guards** (the Forms script must
not widen to `docs.google.com/*`; no content script may declare an all-sites
pattern; all-sites stays optional); every referenced file exists in `dist/`;
every resource glob matches an emitted file; and Chrome load rules
(manifest_version, version format, name/description limits, CSP keeps
`wasm-unsafe-eval` and has no bare `unsafe-eval`, no inert content script, valid
`run_at`, real permission names, no duplicates, no host both required and
optional).

> **The rule is proved non-vacuous.** The real manifest no longer carries the
> flag, so the path assertion would pass even if the rule were broken. Synthetic
> fixtures reproduce the exact shape Chrome rejected and assert it is caught.

> **It found a second defect on its first run:** `description` was **140
> characters**, over Chrome's documented 132 limit. Shortened to 119.

**Add to this file on every future live-load failure.** That is the point of it.

---

## 7c. FIRST LIVE FILL RUN (2026-07-30) — the dropdown commit failure

The fill report named two failures, correctly and specifically:

```
failed — "Current Academic Year or Employment Tenure":
         clicked "4+ Years" but the control still shows "Choose"
failed — "PrimarField of Studyor Department":
         clicked "ECE" but the control still shows "Choose"
```

That message chain proves a lot worked: the listbox opened, options rendered,
strict text matching found the option, a click was dispatched, and the verifier
re-queried the DOM and refused to claim success. **The report was right. The
fill was wrong.**

### Root cause, confirmed by reading the code

`shared/options.ts` finds options with `document.querySelectorAll('[role="option"]')`.
That document-wide scan is **deliberate and correct for FINDING** options — Google
Forms renders them into a detached popup outside the question card, so a
card-scoped query finds nothing (§4), and this scan is what fixed the earlier
"(No options detected)" bug.

**But finding is not owning.** A document-wide scan says nothing about which
trigger an option belongs to. This form had TWO dropdowns, so the right option
TEXT could be matched inside the WRONG widget's popup: a real option really gets
clicked, it really selects something, and the control being watched never
changes. That is the observed symptom exactly.

### The fix — `src/content-scripts/shared/listbox-ownership.ts` (new)

Ownership is resolved from the trigger EXPLICITLY, then the option query is
scoped to the owner. Resolution order, most to least trustworthy:

| Order | Signal | Notes |
|---|---|---|
| 1 | `aria-controls` | the trigger states which popup it controls |
| 2 | `aria-owns` | same relationship, older spelling |
| 3 | `aria-expanded="true"` | only when EXACTLY ONE listbox is open |
| 4 | `aria-activedescendant` | the listbox containing the named option |
| 5 | the trigger itself holds `[role=option]` children | Google's trigger carries `role="listbox"` |

- **Two open listboxes → REFUSES to resolve.** Guessing between two open popups
  is the bug. A dangling IDREF is likewise reported, not silently ignored.
- **The assertion that would have caught this live:** a matched option must be a
  descendant of the resolved owner. If it is not, the fill FAILS with
  *"found, but in a listbox this question does not own"* rather than clicking
  another question's option — which would select a wrong answer elsewhere AND
  leave this one blank.
- **The document-wide scan survives as a fallback only**, and `console.warn`s
  when it fires. Removing it would trade this bug for the old one; leaving it as
  the silent default is how this hid for nine sessions.

### Three other defects fixed in the same path

1. **The event sequence was incomplete (1c).** `robustClick` omitted `composed`,
   `button`, `buttons` and coordinates. Google's jsaction handlers are delegated
   listeners, and **many such widgets commit on `mousedown`, not `click`** — an
   event reporting no held button (`buttons: 0`, the default) can be filtered as
   synthetic. Now sends `pointerdown → mousedown → pointerup → mouseup → click`
   with `bubbles`, `composed`, `button: 0`, `buttons: 1→0` and centre
   coordinates. On failure it retries on the deepest text-bearing descendant and
   then the nearest `[data-value]/[jsaction]` ancestor, logging which target won.
2. **Verification was single-signal (1e).** It read only the trigger's rendered
   text — the WEAKEST signal, and the one most affected by Google's async
   re-render. Worse, `dropdownDisplayedValue` looked for
   `[role="option"][aria-selected]` INSIDE the card, but the options live in the
   detached popup, so that lookup always found nothing and silently degraded to
   the trigger text. Now polls FOUR independent signals — trigger text,
   `aria-activedescendant`, the option's own `aria-selected` (read outside the
   card), and any `entry.*` hidden input — and reports which one confirmed.
3. **The failure message under-reported.** It said only `clicked "X" but…`, which
   read as though the keyboard fallback never ran. It DID run. The message now
   lists every path attempted and the ownership verdict.

### The diagnostic block (1a)

`DropdownDiagnostics` emits one tagged block per dropdown attempt, always on for
dropdowns: trigger outerHTML, all four aria-* values, the ownership verdict, the
owning listbox, **owned option count vs document-wide count (flagged on
mismatch)**, the clicked node with 3 levels of ancestors, whether it was owned,
the event sequence, and post-click state for all four signals.

> **B4 scope note:** dropdown option labels are the FORM's own published choices
> ("4+ Years", "ECE"), not content extracted from the user's documents, and the
> existing failure messages already named them. Document text and API keys remain
> absolutely unlogged. Nothing here reads a text-field value.

### ⛔ Fixtures were absent AGAIN — 1f skipped

`tests/fixtures/` does not exist. `tests/dropdown-ownership.test.mjs` (51
assertions) therefore uses a hand-built DOM stub implementing exactly the methods
the resolver touches, and proves the **decision logic**: given a two-dropdown
layout, which listbox is treated as the owner and whether a wrong-widget option
is refused. It **cannot** prove a real browser commits the selection.

---

## 7d. ORANGE THEME (PART 2) — every ratio computed, two real bugs found

`src/theme.css` is now the single source of colour; `sidepanel.css` and
`options.css` contain **zero** hex literals and import it.
`tests/theme-contrast.test.mjs` (76 assertions) computes WCAG ratios and fails
under 4.5:1. Every shipped text-on-fill pair:

| Pair | Light | Dark | prefers-contrast: more |
|---|---|---|---|
| primary button label | **5.23** | 5.23 | 7.63 |
| primary button, hover | 7.63 | 7.63 | 9.33 |
| secondary button / link | 5.23 | 7.81 | 9.33 |
| secondary on surface | 4.83 | 7.11 | 8.62 |
| body text | 15.80 | 13.70 | 15.80 |
| subtle text | 7.70 | 7.39 | 12.02 |
| brand badge | 6.23 | 9.30 | 7.63 |
| answered | 6.49 | 7.52 | 6.49 |
| needs input | 7.15 | 10.34 | 9.38 |
| draft/manual | 7.57 | 10.97 | 7.57 |
| failed | 5.30 | 11.16 | 8.19 |
| skipped | 8.40 | 9.85 | 8.40 |
| splash notice | 15.80 | 13.70 | 15.80 |

Bright `#ff7a00` is **2.61:1** on white — accents, borders and focus rings only,
never text and never a fill carrying white text. Asserted, not just documented.

> ### ⚠️ TWO REAL BUGS THE CONTRAST TEST FOUND
>
> 1. **The splash notice was invisible in light mode.** It shipped `#e8eaf2`
>    (near-white) with a comment claiming *"≈ 14.5:1 on the #10131c splash"*. The
>    splash background is `#ffffff` in light mode, so the real ratio was
>    **1.20:1**. The 14.5:1 figure was true only against a dark background that
>    no longer existed. Now 15.80:1 light / 13.70:1 dark.
> 2. **Brand-as-TEXT needed its own token.** A fill's ratio is independent of the
>    page behind it, so `#b84a00` works in both schemes — but as TEXT on a dark
>    background it is only **3.16:1**. Secondary buttons and links would have
>    failed in dark mode. `--brand-text` now flips per scheme (`#ff9a3c` dark);
>    `--brand-deep` never does.

**The amber warning state had to go.** The old "needs input" pill was `#92400e`
on `#fef3c7` — dark ORANGE on pale amber, indistinguishable from an orange brand.
Semantic hues are now spread away from it: answered green (119° from brand),
needs-input blue (158°), draft violet (121°), skipped slate (169°).

> **Failed stays RED**, and red is inherently only 24° from orange. A blanket
> hue-distance rule would have forced failure to stop being red to pass, so the
> 40° floor applies to the four states that CAN move, and failure is covered by a
> stricter rule instead: it must be red AND must not rely on colour at all. The
> fill report's failed rows carry the word "failed" plus a border and a wash — the
> word is what carries it, since red-vs-orange is unreliable under protanopia.

---

## 7e. SPLASH NOTICE (PART 3) — staggered reveal, one-line hook

Copy chosen: **"Great files make great answers."** Recorded against the
alternatives in `ui-prefs.ts`: *"Your files in. Your answers out."* describes the
mechanism but drops the quality dependency, which is the entire point of the
note; *"As good as what you feed it."* carries it but leads with a limitation on
first launch. The chosen line carries the same expectation in a positive frame.

**The guidance did not disappear** — it moved to the two permanent inline notes
(105 and 127 chars), which §4g keeps non-dismissible precisely because a user who
dismissed the splash weeks ago still needs the advice at the point of action. The
splash gets the hook; the inline copy keeps the substance.

- **Per-WORD stagger, not a typewriter.** A typewriter withholds meaning until the
  sentence completes, wasting most of a 3.8s window. Whole words are legible from
  the first frame.
- **It cannot delay the splash.** Every word is in the DOM immediately; only CSS
  opacity animates, via a per-word `animation-delay`. No timer, no await between
  words. `SPLASH_MIN_MS`/`SPLASH_MAX_MS` are untouched, and `dismissSplash`
  awaits nothing — asserted.
- **A skip lands the full line at once** via `onSplashSkipped`, fired BEFORE the
  fade so the text is on screen during it, and immediately for a late subscriber.
- **prefers-reduced-motion:** no stagger, full opacity.
- **Still announced:** `role="note"` kept, no blanket `aria-hidden` on the splash
  (it stays on the decorative logo and bars only), and the split line is exposed
  as ONE `aria-label` so a screen reader does not announce six fragments.

---

## 7c. LIVE RUN #2 (2026-07-31) — THE DROPDOWN NEVER OPENED

Live instrumentation (from the §7a diagnostic block, which is the only reason
this was diagnosable at all):

> `"Amharic" was clicked and no commit signal changed. Tried: the option node`
> `[pointerdown → mousedown → pointerup → mouseup → click]; its deepest`
> `text-bearing descendant [same]; keyboard: focus listbox → ArrowDown ×1 →`
> `Enter. Ownership: OWNED via self. The control still shows "Choose".`

### ⚠️ THE FACT THAT WAS WRONG IN THIS FILE FOR NINE SESSIONS

§4 said: *"Its `[role="option"]` children **do not exist** until it is clicked
open."* **THAT IS FALSE.** Google Forms keeps `[role="option"]` nodes in the DOM
**at all times, inside the listbox, even while it is CLOSED.**

That single wrong belief produced the bug: the readiness poll waited for options
to APPEAR, so it succeeded on the first tick — before the widget had opened — and
every strategy afterwards fired at inert, non-interactive nodes. The ownership
fix from §7a resolved correctly (`OWNED via self`) and could not help, because
the problem was never *which* options; it was that nothing was open.

> **THE RULE, NOW SETTLED: OPENNESS IS `aria-expanded="true"`. IT IS NEVER THE
> PRESENCE OF OPTIONS.** Presence proves the markup exists; only `aria-expanded`
> proves the widget is interactive. Do not re-derive this.

### What changed (PART 1)

Owner: **`src/content-scripts/shared/listbox-selection.ts`** (new, pure) plus
`filler.ts`. 46 assertions in `tests/listbox-open.test.mjs`.

- **Explicit open step.** Pointer sequence on the listbox, then poll
  `aria-expanded` up to `LISTBOX_OPEN_TIMEOUT_MS` (2000 ms). One retry.
- **"Could not open the dropdown" is a DISTINCT failure** from "clicked but did
  not commit", and states that nothing was clicked so no wrong answer was
  selected. Conflating those two is what hid this for an entire session.
- **Matching is `data-value` FIRST**, then exact text, case-insensitive,
  whitespace-normalized. Never fuzzy. The placeholder (empty `data-value`, or
  "Choose") is excluded from matching AND from counting — counting it offsets
  every keyboard index by one.
- **Corrected keyboard path.** The old code arrowed on a CLOSED listbox, where
  the first press is consumed opening it — the live run sent ArrowDown ×1 and
  landed nowhere. Now: ensure open, then move RELATIVE to the currently
  highlighted row (`keyboardPlanFor`), using ArrowUp when the target is above.
- **Failure closes with Escape and restores focus**, so a failed attempt leaves
  the page as it was found.
- **`aria-expanded` is logged BEFORE and AFTER the open step.** ⚠️ **That pair is
  the proof.** `false → true` means the fix worked; `false → false` means the
  open click is the problem, not the option click.
- Two regressions I introduced mid-fix and then restored: the virtualized-list
  scroller (200+ entry country lists) and the document-wide fallback for
  portalled popups.

### PART 2 — file uploads are `manual_only`, permanently

Google Forms file questions open a cross-origin Drive picker and attach from the
user's **Drive**. Our documents live in extension storage. There is no
`<input type="file">` to populate and no way to inject a local file into a picker
we do not control. **This is a hard limit, not unfinished work — do not attempt
automation, and do not leave it as pending.**

- `manualOnly = true` is now set at SCAN time in BOTH adapters, so every request
  filter (they all test `manualOnly`) excludes it structurally, rather than by a
  per-call-site type check that a future path could forget.
- The richer `ready_to_attach` / `needs_file` states are DELIBERATELY kept for
  display. Collapsing them into `manual_only` would have deleted the useful
  compromise below, which the same brief asked for.
- The fill report now says why in plain language, and **names the matched
  document** — "attach your Jane_Doe_Resume_Updated.pdf", or "no matching
  document uploaded, so there is nothing to suggest". The match already existed;
  it was simply never surfaced in the report the user actually reads.

### PART 3 — date fields are fillable

Owner: **`src/lib/text/date-format.ts`** (new, pure). Previously skipped with
"date fields can't be auto-filled" while the dossier held a date of birth the
whole time.

> ⚠️ **A WRONG DATE OF BIRTH IS WORSE THAN A BLANK ONE.** "03/04/2001" is 3 April
> in most of the world and 4 March in the US. When both components are ≤ 12 and
> the form states no order, the fill **REFUSES** and says why. It never picks a
> probably-right reading. This is the §3 fabrication rule arriving through a date
> parser instead of a language model.

Accepted without ambiguity: ISO year-first, any month named in words, and numeric
forms where one component is > 12 (the reading is forced). Both DOM shapes are
handled — native `input[type="date"]` and Google Forms' split day/month/year —
and both verify by RE-QUERYING the live DOM.

### PART 4 — diagnosis: the tip was DISMISSED, not missing

Reported as "no catchy phrase appears during the logo animation". Diagnosed in
the required order before changing anything:

| Hypothesis | Verdict |
|---|---|
| **4a — dismissal flag** | ✅ **THE CAUSE.** `easyfilla.inputQualityNoteDismissed` persists forever and had **no reset UI**. A tip dismissed in any earlier session is indistinguishable from a feature that was never built. |
| 4b — reveal outlives the splash | ❌ Ruled out by arithmetic: 5 words × 170 ms stagger + 700 ms start + 420 ms duration ≈ **1800 ms**; the splash lives ≥ 3800 ms. |
| 4c — did PART 3 ship? | ❌ Ruled out: `splash__note-word` ×3 and the hook string are both present in `dist/`. |

The orange theme was verified in the BUILT CSS as well: `#b84a00`, `#8f3900`,
`#ff7a00`, `font-weight:700`, and zero `#1a73e8`. If a screenshot shows no
orange, it is a stale load, not missing code.

Fix: `resetInputNote()` plus a Settings control that also reports the current
state. The first-run default is now explicit — only the literal `true` hides the
tip, so an absent or malformed value always shows it.

> **The general lesson, worth more than the fix:** a control that can be
> dismissed permanently with no way back turns a working feature into an
> unfalsifiable bug report. Any future "don't show again" needs a reset beside it.

---

## 7b. THE VERIFICATION CHECKLIST — everything unverifiable without a live browser, key or upload

**This is the list. It is ordered by consequence, not by effort.** Nothing below
has been observed; everything below is implemented, type-checked, and covered by
tests that assert what our own code *produces* — which is not the same as a
server accepting it, or a browser behaving as assumed.

### A. Highest consequence — a wrong assumption here breaks the product silently

1. **Anthropic has NEVER been executed.** Not one request has reached
   `api.anthropic.com` from this build. Everything in §1b for Anthropic is
   doc-transcription: `output_config.format`, the TEXT-block-carrying-JSON
   response shape, the 32 MB cap, the schema subset the adapter enforces, and the
   `anthropic-dangerous-direct-browser-access` header. **Send one request and
   read one response** — that single act converts most of §1b into §1.
2. **The 401 browser-access trap.** The classifier special-cases a 401 whose
   message names the header or pairs a CORS token with a must-set token. The
   discriminator was tightened against 6 decoy messages, but **the real 401 body
   has never been seen.** If its wording differs, a valid key is reported as
   invalid — the exact false accusation the class exists to prevent.
3. **`api.anthropic.com` host permission.** Added to the manifest this session.
   Whether the request *also* needs the browser-access header to satisfy CORS
   from an extension page is untested; both are now in place, so a failure here
   should be diagnosable rather than mysterious.
4. **⚠️ UPDATED BY THE LIVE RUN — see §7c.** The document-wide option scan was
   confirmed as the cause of two dropdown commit failures and is fixed
   (ownership-scoped resolution). **The fix itself is unconfirmed: it needs a
   live run.** Fixtures are STILL absent, so the DOM half remains untestable.
   Original note: **The detached-popup fill path (Part 5, SKIPPED — no fixtures).** The
   document-wide `[role="option"]` query is the fix for the bug that left two
   Google Forms dropdowns on "Choose". It is asserted nowhere. **Capture
   `tests/fixtures/gforms-dropdown-open.json` with the listbox OPEN** (keys:
   `card`, `popupRoot`, `optionCount`) plus `gforms-radiogroup.html`, then write
   the eight tests specified in §6b. Do not synthesise the markup.
5. **Stage A's request shape.** Whether Gemini accepts the multimodal Interactions
   body at all. The transport golden pins what we send; it cannot pin what is
   accepted.

### B. Provider-switching claims now made to the user in writing

6. **That selecting Anthropic actually produces a report.** Switching is wired
   end to end and proven not to leak to Gemini (`tests/switchability.test.mjs`),
   but the run has never completed on Anthropic.
7. **The learned rate limit.** `anthropic-ratelimit-requests-limit` is parsed and
   now drives pacing (0b), but **no real header has ever been read.** Until one
   is, every Anthropic run paces at the conservative 5/min fallback.
8. **The size ceilings.** 18 MB (Gemini) and 32 MB (Anthropic) are transcribed
   from docs and never tested against a rejection. The over-budget error names the
   provider and the number precisely so a wrong constant is diagnosable.
9. **Gemini's assumed capability flags (0c).** Whether any offered Gemini model
   actually lacks structured output or PDF input — and therefore whether
   `diagnoseAssumedCapability()` ever fires — is unknown.
10. **The per-provider connection test** has never been run against either API.

### C. The Files API — implemented, never executed (§1b)

11. **No upload has ever been performed.** In particular: whether the upload URL
    really arrives in the `x-goog-upload-url` RESPONSE HEADER, which §1b flags as
    the single most likely thing to be wrong. Also unverified: `waitForActive()`
    polling, the 48-hour TTL, and every pre-upload size limit.

### D. UI built this session, never rendered

12. **The compose queue and indicator (C/D1).** The state machine has 55
    assertions, but no button has been clicked. Unrendered: the spinner, the
    static queued indicator, the elapsed-seconds timer after 3s, the cancel
    affordance, `aria-busy`, the polite live region, and the
    `prefers-reduced-motion` fallback.
13. **The variant picker (D2).** 23 assertions cover the packing and the
    provenance invariant; the side-by-side cards have never been displayed, and
    **no model has ever actually returned a `drafts` array.**
14. **The settings UI (E3d.1).** Provider selector, per-provider key fields, the
    live model list, the dossier-rebuild warning — none rendered.
15. **Per-provider accounting (E3d.2)** and the size-ceiling line in the upload
    summary (E3d.3) — never displayed.

### E. Pre-existing, still open

16. **MV3 termination (B5)** was never induced.
17. **The first-run sequence (B2)** was verified by reading guards, not by
    installing cold.
18. **Error surfaces (B3):** no error was ever actually triggered.
19. **`executeScript({allFrames:true})` reaching a real portal's application
    frame** (Workday/Taleo/Greenhouse/SuccessFactors) — never executed. This is
    why the listing does not claim those sites work.
20. **Every acceptance case in sections 3 and 4.**

> ### One thing to hold onto
>
> Six of the defects fixed across these sessions were found by a test that
> asserted a *structural* property rather than an output: the orchestration golden
> caught a dropped `generation_config`; the switchability proof caught key gates
> that would reject a valid run; the capability-completeness check caught a
> capability inferred from another's absence; the E5 grep caught a key written
> into the DOM. **None of them would have been caught by testing a happy path.**
> When adding to the list above, prefer the assertion that makes a wrong
> assumption *loud*.
