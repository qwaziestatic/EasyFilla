# EasyFilla — Chrome Web Store submission

Everything below is written against the **built** `dist/manifest.json`
(re-read on 2026-07-30 after the Anthropic origin was added), not the source
manifest. Every declared entry is covered.

> **Reviewer-facing accuracy note.** The copy in this file deliberately avoids
> claiming end-to-end results that have not been observed in a browser. See
> "Claims audit" at the end, and `HANDOFF.md` §1b and §7.

---

## 1. Single-purpose statement

> **EasyFilla has one purpose: to help a person complete a web form using
> documents they already have.**
>
> It reads the fields of the form in the tab the user opens it on, matches
> those fields against documents the user uploads, presents every proposed
> answer for review, and — only after the user approves them — types the
> approved answers into the form's fields. It never submits the form.
>
> Every permission below exists to serve that one purpose. The extension has no
> secondary function: no analytics, no advertising, no content injection, no
> data collection of any kind, and no server operated by the developer.

---

## 2. Permission justifications

### `activeTab`

EasyFilla operates on the single tab the user explicitly invoked it on, by
clicking the toolbar icon to open the side panel. `activeTab` grants temporary
access to exactly that tab at exactly that moment, which is the narrowest way
to read a form the user is pointing at. It grants nothing to background tabs,
nothing to other windows, and nothing before the user acts.

### `scripting`

The form scanner runs as a content script in the page containing the form.
Declarative registration only reaches pages loaded *after* installation, so
tabs the user already had open would silently do nothing. `scripting` lets the
extension inject the scanner into the current tab when the user asks it to
scan, so the feature works immediately instead of requiring the user to reload
every tab. Injection targets only the active tab, and only on user action.

### `storage`

Everything EasyFilla saves is saved locally on the user's own device, and
nothing is transmitted anywhere except to the AI provider the user selected,
using that user's own API key for it: **one API key per provider, stored and
validated separately**, which of the two providers is selected, the structured
"dossier" of facts extracted from their documents, their editable profile, their
reusable answers to standard compliance questions, a per-day count of API
requests used (so the extension can warn before exceeding a quota), the selected
model, and a verbose-logging preference. `chrome.storage.sync` is deliberately
**not** used, because syncing would replicate an API key and identity data to
every device on the user's Chrome account.

Keys are stored under separate storage entries so that clearing one does not
affect the other, and so that only the selected provider's key is ever read for a
request.

### `sidePanel`

The entire user interface is a side panel: uploads, review of proposed answers,
and the fill report. Without this permission the extension has no UI.

### `webNavigation`

**Used solely to enumerate the frame tree of the tab being filled.**

Application forms are frequently rendered inside embedded frames. To report a
form completely, EasyFilla needs to know *which frames exist*. It calls
`chrome.webNavigation.getAllFrames()` on the active tab and reconciles that
list against the frames that actually responded to it. A frame that exists in
the tree but never reported is then named to the user as inaccessible, with the
specific reason — sandboxed without scripting, failed to load, or host access
not yet granted — instead of being silently dropped, which would make a partial
scan look like a complete one.

It is also used to detect when a frame navigates or is removed, so that answers
prepared against one page are never typed into a different page that has loaded
since.

**No browsing history is read, stored, or transmitted.** The extension does not
use `webNavigation` to observe navigation on tabs it is not working on, and
retains only integer counters keyed by frame ID, cleared when the browser
closes.

---

## 3. Host permission justifications

### `https://docs.google.com/forms/*` — required, static

Google Forms is the one site with a purpose-built adapter, because its controls
are custom widgets rather than standard HTML inputs (its dropdown options do not
exist in the page until the control is opened, and then render in a detached
container). This is the narrowest pattern that covers Google Forms: it does not
grant access to Google Docs, Sheets, Slides, or Drive.

### `https://generativelanguage.googleapis.com/*` — required, static

The Google Gemini API endpoint, and the default provider. EasyFilla sends the
user's documents and the form's questions here, authenticated with **the user's
own API key**, which the user supplies. This host cannot be made optional:
requests occur during report generation and connection testing, at which point
there is no user gesture available to satisfy `chrome.permissions.request()`.

### `https://api.anthropic.com/*` — required, static

The Anthropic Claude API endpoint, which the user may select instead of Gemini in
Settings. Same role and same justification as the Gemini host: the user's
documents and the form's questions are sent here, authenticated with **the
user's own Anthropic API key**, and the requests occur outside any user gesture
so the host cannot be made optional.

**Only the selected provider's host is ever contacted, and only that provider's
key is ever sent.** Both origins are declared because the user chooses between
them at runtime; declaring only one would mean the other silently failed, or
worked only by depending on that vendor's CORS behaviour, which is not something
an extension should rely on. Requests to this origin also carry the
`anthropic-dangerous-direct-browser-access` header, which Anthropic requires for
browser-originated calls.

### `https://*/*` and `http://*/*` — OPTIONAL, requested at runtime

**These are not granted at install and do not appear in the install prompt.**

They exist so the user can point EasyFilla at whatever application form they
are actually filling in — which cannot be enumerated in advance. Access is
requested **per origin**, from the click handler of an explicit "Grant
EasyFilla access to *[origin]*" button, naming the specific origin. Until the
user clicks it, the extension has no access to that site and reports the form
as unreadable rather than reading it.

### The Drive-picker origin — why it is requested at runtime

Google Forms renders its file-upload control as a Google Drive picker in a
child frame served from a path **outside** `/forms/*` (`docs.google.com/picker`).

Chrome host permissions are **path-sensitive**: `https://docs.google.com/forms/*`
matches the form page but does **not** match `/picker`. The extension therefore
cannot read that frame under its static grant. Rather than widen the static
permission to `https://docs.google.com/*` — which would grant standing access to
Docs, Sheets, Slides and Drive and materially worsen the install prompt — the
picker origin is obtained through the **optional** runtime grant above, on the
same per-origin button, only for users who actually need to attach a file to a
Google Form.

When it is not granted, the picker frame is reported to the user as
inaccessible with a "grant access" reason. It is never silently skipped.

---

## 4. Manifest features requiring explanation

### `content_scripts` → `"all_frames": true` — why this is necessary

**Without it, the extension sees nothing at all on a large class of real
application sites.**

Enterprise recruitment and application platforms (the Workday / Taleo /
Greenhouse / SuccessFactors class of product) do not render their form in the
top-level page. The page the user navigates to is a host shell, and the actual
application form is rendered inside one or more embedded child frames, usually
on a different origin. A content script restricted to the top frame finds a
page with no fields on it and correctly reports zero questions — which is
useless to the user and indistinguishable from a bug.

`all_frames` allows the scanner to run in each frame of the tab so the fields
inside the embedded form can be read at all. The scan is still confined to the
tab the user invoked EasyFilla on, and still requires a host permission for each
frame's origin.

### `content_scripts` → `"match_about_blank": true`

Some embedded form widgets are rendered into frames with no ordinary origin of
their own (`about:blank`, or `srcdoc` frames created by the parent page). This
flag allows the scanner to run in those frames under the origin of the page that
created them, so fields inside them are not invisible. It does not extend the
extension's reach to any additional site.

This was previously `match_origin_as_fallback`, which Chrome **refuses to load**
alongside a path-restricted pattern: it requires a path of exactly `*`, and the
Google Forms pattern is deliberately narrowed to `/forms/*`. The only way to keep
that flag would have been to widen the pattern to `https://docs.google.com/*`,
which would inject into Docs, Sheets, Slides and Drive. `match_about_blank`
covers the frames actually needed and carries no path restriction, so the narrow
pattern is preserved.

### `content_security_policy` → `wasm-unsafe-eval`

EasyFilla runs optical character recognition locally, in the extension's own
pages, to read text from image-based documents without sending them anywhere.
The OCR engine is WebAssembly, and Chrome blocks `WebAssembly.instantiate` under
the default MV3 policy. This directive applies **only to the extension's own
pages** and does not relax the policy of any website. No remote code is loaded
or executed; the WebAssembly module is bundled in the package.

### `web_accessible_resources`

The built package contains two entries.

1. **`assets/*.js`, matched to `<all_urls>`.** The content script is bundled as
   an ES module and loaded via a small loader, so its module chunks must be
   fetchable from the page context it runs in. Because the user may grant access
   to any site at runtime (see optional host permissions), the resource match
   must cover the sites where the script may legitimately run.
2. **A specific chunk list matched to `https://docs.google.com/*`,** generated
   by the build tool for the declaratively-registered Google Forms content
   script.

These expose **only EasyFilla's own bundled JavaScript modules**. They contain
no user data, no API key, and no user-specific content — the API key and all
document data live in extension storage and in extension pages, and are never
placed in a web-accessible resource. `use_dynamic_url` is `false` because the
files are static build artifacts with no per-user content to protect.

### `options_ui` / `background.service_worker` / `action` / `icons`

Standard extension surfaces: the settings page (AI provider selection, one API
key per provider, model, profile, daily budget, diagnostics toggle), the event
handler that owns frame bookkeeping, and the toolbar entry point that opens the
side panel. No justification beyond their ordinary purpose.

Note for review: the service worker deliberately does NOT import the AI client
and never handles either API key. Keys are read only in extension pages
(side panel, options). This is an audited boundary with an automated test.

---

## 5. Data-use disclosures (Chrome Web Store form)

Answer these as follows; each is accurate against the code.

| Question | Answer |
|---|---|
| Does this item collect personally identifiable information? | **Yes** — but only to transmit it to the AI provider the user selected (Google Gemini or Anthropic Claude), authenticated with that user's own API key for that provider. Not collected by the developer. |
| Does it collect health information? | No |
| Does it collect financial/payment information? | No. Payment-card fields are explicitly excluded from all processing. |
| Does it collect authentication information? | No. Password fields are explicitly excluded from all processing. |
| Does it collect personal communications? | No |
| Does it collect location? | No |
| Does it collect web history? | No |
| Does it collect user activity? | No |
| Does it collect website content? | **Yes** — the field labels and options of the form the user asks it to read. |
| Is data sold to third parties? | **No** |
| Is data used or transferred for purposes unrelated to the single purpose? | **No** |
| Is data used or transferred to determine creditworthiness / for lending? | **No** |

**Required certifications:** all three (no sale, no unrelated use, no
creditworthiness use) can be truthfully certified.

**Privacy policy URL:** ⚠️ *Must be a public URL — see the blockers list in the
final report. A file in the repository is not sufficient.*

---

# 6. Listing copy

## Short description (Chrome Web Store limit: 132 characters)

```
Answer long application forms from your own documents. Every answer is yours to review, and nothing is ever submitted for you.
```

**126 characters.** Within the limit.

---

## Long description

**Long application forms are the same twenty questions, retyped.**

Your name, your address, your degree, your dates of employment, the same
paragraph about why you want the role — spread across six pages of a portal
that logs you out if you pause. You already have all of it, in a CV and a
transcript and a scan of your ID. EasyFilla's job is to get it out of those
documents and into the form, without you retyping it and without inventing
anything you didn't say.

### How it works

1. **Scan.** Open the form, open EasyFilla's side panel, and press Scan. It
   reads every field on every step — including fields rendered inside embedded
   frames, which is how many application portals are built — and tells you what
   it found, what it couldn't read, and why.

2. **Upload.** Add the documents the answers should come from: CV, transcript,
   certificates, ID. They stay on your device until you ask for answers.

3. **Export (optional).** Export the whole form to a PDF before answering
   anything. Useful for seeing a six-page portal as one document, or for
   drafting offline.

4. **Generate.** EasyFilla builds a structured summary of your documents, then
   answers the form's questions from it. **Every answer is traced back to the
   file it came from.** Questions your documents don't answer are left blank
   and labelled — they are not filled with a plausible guess. Where two
   documents disagree, both are shown and neither is chosen for you.

5. **Review.** Nothing reaches the form until you have seen it. Edit anything,
   accept anything, reject anything.

6. **Fill.** Approved answers are typed into the form's fields. **EasyFilla
   then stops.** You read the form and press its own Submit button yourself.

### What it will not do

- It will not submit a form. Ever, in any language, on any page.
- It will not answer a question your documents don't answer. Blank and honest
  beats filled and wrong on an application that matters.
- It will not touch password, payment-card, login or CAPTCHA fields. Those are
  excluded from reading, from filling, and from anything sent to the AI.
- It will not send your documents to the developer, because there is no
  developer server to send them to.

### Who it's for

People filling in long, repetitive, high-stakes forms from documents they
already have: job applications on enterprise portals, university and
scholarship applications, visa and immigration paperwork, grant and funding
applications, and professional registrations.

It is aimed at someone who wants the typing removed but wants to check the
result — not at someone who wants a form filled while they look away.

---

## LIMITATIONS — please read before installing

**This section is deliberately not buried. Install with these in mind.**

- **You supply your own API key.** EasyFilla has no key of its own and no
  subscription. You paste your key into Settings. Requests are made with your
  key, counted against your quota, and — on a paid tier — billed to you.

- **⚠️ Your documents are sent to an AI provider, and you choose which one.**
  They have to be sent: a language model reads them. This includes ID photos,
  CVs and academic records, as raw file bytes. EasyFilla defaults to **Google
  Gemini**; **Anthropic Claude** can be selected in Settings instead. Only the
  provider you select receives anything.

- **⚠️ File-upload questions cannot be automated — this is permanent.** Google
  Forms attachments open a Google Drive picker and attach from *your Drive*.
  EasyFilla holds your documents locally, and a browser extension cannot put a
  local file into that picker. EasyFilla detects these questions, marks them
  manual, and tells you which of your uploaded documents most likely belongs
  there — but you attach it yourself. This is a hard limit of the platform, in
  the same category as forms drawn on a canvas or delivered as a flat PDF.

- **⚠️ The Anthropic option has not been tested against the live API.** It is
  fully built and selectable, and its requests are written to Anthropic's
  published specification — but no real request has yet been sent to
  `api.anthropic.com` from this build. **Treat Gemini as the supported path and
  Anthropic as unproven** until this line says otherwise. If you try it and it
  fails, that is a bug worth reporting, not something you configured wrongly.

- **⚠️ The two providers' terms are NOT equivalent — this matters most on a free
  Gemini key.** At the time of writing, Google's API terms allow content
  submitted on the *unpaid* tier to be used to improve their products and to be
  **read by human reviewers**. Anthropic's commercial terms state it may not
  train models on content sent through the API. **If you are uploading identity
  documents on a free-tier Gemini key, read Google's current terms first** — a
  paid key or the other provider are both ways to avoid that. The privacy policy
  sets out both providers' published terms side by side and does not soften
  either.

- **Every answer requires your review before submission.** EasyFilla produces a
  draft, not a finished application. Answers can be wrong, incomplete, or
  matched to the wrong field. Read the whole form before you submit it.

- **EasyFilla never submits anything.** Filling and submitting are separate, and
  it only does the first. You press Submit.

- **Forms drawn to a canvas, or embedded as a PDF, cannot be read.** There is no
  DOM to inspect in either case, so no fields can be detected. EasyFilla will
  say so plainly rather than reporting an empty form. This is a hard limit, not
  a bug, and it will not be worked around.

- **Some frames cannot be read.** A frame sandboxed without scripting, or one
  whose origin you have not granted access to, cannot be scanned. EasyFilla
  names each such frame and why, rather than quietly reporting fewer fields.

- **Free-tier daily quotas are small and change without notice.** Google does
  not publish the per-model daily limit, so EasyFilla shows your usage without
  inventing a limit, warns before starting work it cannot finish, and offers to
  answer as many questions as your remaining budget allows.

- **This is an early release.** It has been built carefully and its logic is
  covered by an automated test suite, but it has not yet been validated
  end-to-end against every portal in the wild. Treat its output as a draft
  prepared by a careful assistant who has never seen your form before —
  because that is exactly what it is.

---

# 7. Screenshot shot-list (C4)

Chrome Web Store screenshots are **1280×800**. Five is the maximum shown in the
carousel; the order below is the order a reviewer and a new user should see.
**No images are generated here — this is the capture list.**

Use a **realistic but fictional** applicant throughout (invented name, invented
ID numbers). Do **not** screenshot real identity documents: these images are
public on the store listing permanently.

| # | Screen to capture | Caption (one line) |
|---|---|---|
| 1 | A multi-step application form open in the tab, side panel open on the right, scan complete — the question list populated and the coverage line visible ("N questions found … frames scanned"). | "Reads every field on every step — and tells you what it couldn't read." |
| 2 | The upload area with 3–4 documents listed (CV, transcript, ID) and their extraction status shown. | "Add the documents your answers should come from. They stay on your device until you ask." |
| 3 | The review panel, scrolled so **three different answer states are visible at once**: one answered-from-documents with its source filename, one `needs_user_input` left blank, and one `conflicting_sources` showing both candidate files. | "Every answer is traced to the file it came from — and anything your documents don't say is left blank, not guessed." |
| 4 | The fill report after a run, showing a mix of filled and failed rows, with a failure's reason text visible and the "Show me on the form" link. | "A partial fill is reported field by field, with the reason — never silently." |
| 5 | The Settings page showing the API-key field (masked), the model selector, and the daily request budget section. | "Your own Gemini API key, your own quota — with a usage counter and a warning before a run that can't finish." |

**Optional 6th (if a slot is free):** the pre-flight budget prompt offering
"answer the first N questions now" — caption: *"Warns before spending requests
it can't complete, instead of failing halfway."*

### Capture notes

- Redact or use fictional data in **every** field visible in every shot — the
  side panel shows extracted personal data by design.
- The API key field is `type="password"`, so it renders masked; confirm no key
  is visible in any browser devtools panel if devtools is in frame.
- Shot 3 is the most important one in the set: the three-state review is the
  single thing that distinguishes this from a form-filler that guesses.

---

# 8. Claims audit — what this listing deliberately does NOT say

Cross-checked against `HANDOFF.md` §1b (implemented but never executed) and §7
(verification status). **Nothing above advertises an unverified capability.**

| Not claimed | Why |
|---|---|
| That it works on Workday, Taleo, Greenhouse or SuccessFactors | §7: reaching a portal's application frame with `executeScript({allFrames:true})` has **never been executed in a browser**. Those products are named **only** in the reviewer-facing permission justification (§4), where the claim is about *how those sites are built* — the reason `all_frames` is needed — not about verified success. User-facing copy says only "embedded frames, which is how many application portals are built". |
| Large-file / phone-photo upload support (Files API) | §1b: **no upload has ever been performed.** The entire Files API path is implemented but unexecuted, so it is not advertised at all. |
| **That Anthropic Claude works** | §1b: **no live request has ever been made to `api.anthropic.com`.** The provider is fully implemented, wired, and selectable, and its request shapes are asserted against the published docs — but a shape a doc describes is not a shape the API has accepted. Anthropic therefore appears **only** in the privacy disclosure and LIMITATIONS, where the user needs to know a second destination exists and what its terms say. It is deliberately **absent from the feature list**, the short description, and "How it works". Do not promote it until a real request/response has been seen. |
| That switching provider preserves your existing dossier | It does not, by design: a dossier built by one provider is rebuilt rather than reused, because reusing it would attribute one provider's reading of your documents to the other. The UI says this and states the cost before you switch. |
| Any specific number of supported sites, forms, or fields | Never measured. |
| Any accuracy, success-rate or time-saving figure | Never measured. No benchmark exists. |
| That the AI's answers are correct | The copy states the opposite: review is required, answers can be wrong. |
| That data is encrypted at rest | It is not. The privacy policy says so explicitly. |
| OCR as a headline feature | Runs locally for diagnostics; not load-bearing for answers, and not verified end-to-end. |

**"Early release" wording is doing real work in the LIMITATIONS section** and
should not be removed: no part of this build has been validated against a live
browser or a live API key (§7). If a future session verifies portions of it,
tighten that sentence rather than deleting it.
