# EasyFilla — Privacy Policy

**Last updated: 2026-07-30**

EasyFilla is a browser extension that reads a web form, matches it against
documents you upload, and helps you fill it in. This policy describes exactly
what happens to your data. It is written to be checkable against the source
code, not to reassure you.

---

## 1. The most important thing on this page

**The documents you upload are sent to an AI provider — and YOU choose which
one.**

EasyFilla cannot answer a form from your documents without a language model
reading them. There are two possible recipients, and **the destination depends
entirely on the provider you select in Settings**:

| If you select… | Your documents are transmitted to… |
|---|---|
| **Google Gemini** (the default) | `generativelanguage.googleapis.com` — Google |
| **Anthropic Claude** | `api.anthropic.com` — Anthropic |

Only the provider you have selected ever receives your content. The other
provider receives nothing, and its API key is not read or sent. The active
provider is shown in the side panel at all times, and named again at the moment
you choose it, so the destination is never a surprise.

Those documents routinely include the most sensitive records people own:

- **identity documents and ID photos** — passports, national ID cards,
  residence permits, driving licences, and photographs of them
- **résumés and CVs** — including full employment history and contact details
- **academic records** — transcripts, degree certificates, enrolment letters
- employment records — references, payslips, contracts
- anything else you choose to upload

**All of it is transmitted, in full, to whichever provider you selected**, for
processing. This includes the raw image or PDF bytes — not just text extracted
from them — because the model reads scans and photographs directly.

### It is sent with YOUR key, under YOUR account

EasyFilla has no API key of its own and no shared account. You supply your own
key for the provider you choose, and **every request is made with it**. Keys are
stored separately per provider, and only the selected provider's key is ever
transmitted. That means:

- the requests are attributed to **your** account with that provider;
- they count against **your** quota, and on a paid tier, **your** bill;
- **that provider's handling of your content is governed by your relationship
  with them**, not by any agreement between you and the developer of this
  extension. The developer is not a party to it and cannot see, retain, or
  restrict what is sent.

If you are not comfortable sending a document to either company, **do not upload
it to EasyFilla.** There is no setting that makes this local. The extension is
not useful without it, and pretending otherwise would be the dishonest version
of this page.

### ⚠️ THE TWO PROVIDERS DO NOT TREAT YOUR DATA THE SAME WAY

This is the single most consequential decision in using this extension, and the
two options are genuinely different. Do not assume they are equivalent.

#### Google Gemini — the free tier trains on your content

Terms: <https://ai.google.dev/gemini-api/terms> · <https://policies.google.com/privacy>

At the time of writing, on the **unpaid (free) tier**, Google's API terms state
that "Google uses the content you submit to the Services and any generated
responses to provide, improve, and develop Google products and services", and
that **"human reviewers may read, annotate, and process your API input and
output"** — Google states it disconnects this data from your Google Account, API
key and Cloud project before reviewers see it.

On the **paid tier**, Google states it "doesn't use your prompts … or responses
to improve our products", and logs prompts and responses only for a limited
period to detect and prevent violations.

> **If you use a free-tier Gemini key, assume a human being may read your
> passport scan.** That is not a worst-case reading of the terms; it is what they
> say. If that is not acceptable to you, use a paid key or select Anthropic.

#### Anthropic Claude — the API terms say it may not train on your content

Terms: <https://www.anthropic.com/legal/commercial-terms> ·
<https://privacy.claude.com>

At the time of writing, Anthropic's commercial terms state that **"Anthropic may
not train models on Customer Content from Services"** — which covers the inputs
and outputs sent through the API. Anthropic's privacy documentation states that
API inputs and outputs are deleted from its backend **within 30 days** of
receipt or generation, with exceptions: where a request triggers a usage-policy
classification, inputs and outputs may be retained for **up to 2 years**, and
trust-and-safety classification scores for **up to 7 years**. Organisations can
separately negotiate zero-data-retention terms.

Note that the Anthropic API has no free tier equivalent to Google's — API usage
is billed — so the "free tier trains on your content" concern above does not
have an Anthropic counterpart.

> ⚠️ **These summaries were read from each provider's published terms on
> 2026-07-30 and are not legal advice.** Terms change, and yours may differ by
> account, region or plan. **Read the current terms of the provider you select
> before uploading identity documents.** The choice is yours to make, not ours.

---

## 2. Who receives your data

| Recipient | What they receive | When |
|---|---|---|
| **The AI provider YOU selected** — Google (Gemini API) *or* Anthropic (Claude API), never both | Uploaded document bytes; the questions found on the form; the answers derived from your documents | Only when you press *Generate AI-answered report* or *Compose*. Never during a scan. |
| **The provider you did NOT select** | **Nothing.** Its key is not read and no request is made to it. | Never |
| **The website you are filling in** | The answers you approve, typed into its form fields | Only when you press *Fill*, and only for answers you approved |
| **Anyone else** | Nothing | — |

**No feature routes your content to a fixed provider regardless of your
selection.** Every path that sends document or form text — building the document
dossier, answering questions, composing drafts, detecting the form's language,
generating follow-up prompts, and the connection test — goes to the provider you
selected. This is enforced by an automated test that runs each of those paths
with a stand-in provider selected and fails if any direct call to Google is
attempted.

Two provider-specific details, for completeness:

- **Large-upload handling is Gemini-only.** When your files exceed the
  single-request size limit, EasyFilla can upload them to Google's Files API and
  reference them by URI. There is no equivalent path for Anthropic — instead the
  run is refused with the oversized files named, so nothing is ever uploaded to a
  provider you did not select.
- **The Gemini model list and Gemini's own transport** naturally read the Gemini
  key. They are only reached when Gemini is the selected provider.

**There is no EasyFilla server.** We operate no backend, collect no analytics,
run no telemetry, and have no account system. We never receive your documents,
your answers, your API key, or any record that you used the extension. There is
nowhere for us to send your data even if we wanted to.

Requests go directly from your browser to the provider you selected, using your
key. Nothing is proxied through us.

---

## 3. What is stored, and where

Everything is stored **locally on your device**, using `chrome.storage.local`
(persists until deleted) or `chrome.storage.session` (cleared when the browser
closes). Nothing is stored in the cloud, and **nothing uses Chrome Sync** — that
would replicate your data to every device on your Google account.

| Stored item | Key | Contains | Lifetime |
|---|---|---|---|
| Gemini API key | `geminiApiKey` | Your key, **in plain text** | Until you clear it |
| Anthropic API key | `easyfilla.anthropicApiKey` | Your key, **in plain text**. Stored and validated separately; only sent when Anthropic is the selected provider | Until you clear it |
| Selected provider | `easyfilla.activeProvider` | `gemini` or `anthropic` — which provider receives your documents | Until changed |
| Document dossier | `easyfilla.dossier` | Structured facts extracted from your documents — **names, dates of birth, ID numbers, addresses** | Until documents change or you clear it |
| Profile | `easyfilla.profile` | Contact/identity facts, including ones you type manually | Until you clear it |
| Uploaded-file references | `easyfilla.fileUploads.v1` | Google file URIs for large uploads (no file contents) | 48 h max, matching Google's retention |
| Declaration defaults | `easyfilla.declarationDefaults` | Your usual yes/no answers to standard compliance questions | Until you clear it |
| Daily request ledger | `easyfilla.quotaLedger.v1` | Count of API requests made today | Rolls over daily |
| Model settings | `easyfilla.modelId`, `easyfilla.ingestModelId`, `easyfilla.modelList` | Which model you selected | Until changed |
| Debug flag | `easyfilla.debugLogging` | On/off | Until changed |
| OCR cache | `easyfilla.ocr.*` | Text recovered from documents locally | Until cleared |
| Frame counters | `easyfilla.frameGenerations.v1` | Integers used to avoid filling a page that navigated | Browser session only |

**Your uploaded files themselves are held in memory only** for the duration of a
session and are not written to storage.

### What someone with access to your computer could read

Anyone who can read your Chrome profile directory — another user of the same
account, malware running as you, or anyone with your unlocked device — can read
**all of the above in plain text**, including:

- **your Gemini API key**, which they could use to spend against your Google
  account's quota or billing
- **the dossier and profile**, which may contain your **passport number,
  national ID number, date of birth, and home address**

Chrome does not encrypt extension storage. EasyFilla does not add its own
encryption, because the key would have to be stored next to the data it
protects, which provides no real defence. **Treat your browser profile as
sensitive**, use full-disk encryption, and clear EasyFilla's stored data
(Options → Clear) when you are finished with a device you do not control.

---

## 4. What EasyFilla deliberately does NOT do

These are enforced in code, not merely promised:

- **Sensitive local values are never sent to the API.** Values the local
  extractor identifies as ID numbers, passport numbers or dates of birth are
  used to fill fields directly and are excluded from every model request.
- **Password, payment-card, login and CAPTCHA fields are never read, never
  auto-filled, and never sent to the model.** They are marked "manual only" and
  a runtime assertion aborts the request if one ever reaches the model boundary.
- **The API key never leaves the extension's own pages.** It is never given to a
  content script, never injected into a web page, and never included in any
  message. It travels only in the `x-goog-api-key` request header, direct to
  Google.
- **Your documents and answers are never written to the browser console**, at
  any logging level — so a console log copied into a bug report cannot leak them.
- **Nothing is ever submitted.** EasyFilla fills fields and stops. It will not
  click a submit button in any language, on any page. You review and submit.
- **No document text is sent to any site you are filling in** — only the specific
  answers you approved for specific fields.

---

## 5. Permissions, and why each is needed

| Permission | Why |
|---|---|
| `storage` | Save your key, profile and settings locally |
| `sidePanel` | The interface is a side panel |
| `scripting`, `activeTab` | Read the form on the tab you invoked it on |
| `webNavigation` | Find forms inside embedded frames, and detect when a page navigates so answers are not typed into the wrong page. **Used for frame bookkeeping only — no browsing history is read or stored.** |
| `https://docs.google.com/forms/*` | Google Forms support |
| `https://generativelanguage.googleapis.com/*` | Send requests to Gemini with your key |
| Other sites (optional) | **Requested only when you press "Grant access", per site.** Not granted at install. |

EasyFilla has no access to any site until you explicitly grant it, except Google
Forms and the Gemini API endpoint.

---

## 6. Retention — how long things last, and where

### On your device

Everything in the table above persists **until you delete it**, with two
exceptions: the frame counters are cleared when the browser closes, and the
uploaded-file references self-expire after 48 hours. Uninstalling the extension
causes Chrome to delete all of it. Nothing expires on a timer otherwise —
your dossier and profile stay until you clear them.

### On your selected provider's servers

**EasyFilla has no control over, and no visibility into, retention on either
provider's side.** What follows is what each provider publishes; §1 has the
sources and the important asymmetry.

#### If you selected Google Gemini

Two different paths, depending on document size:

1. **Inline (the normal path).** Documents under the inline size budget are
   sent as bytes inside the request itself. They are not stored by EasyFilla
   anywhere on Google's side. **How long Google retains request content is
   determined by Google's own policies and by which API tier your key is on** —
   see §1 and Google's terms.

2. **Files API (large documents).** When a document set exceeds the inline
   budget, the files are uploaded to Google's Files API first and referenced by
   URI. **Google stores those uploaded files for up to 48 hours**, after which
   they are deleted automatically by Google. EasyFilla caches only the returned
   URI locally (never the file), and expires that cache an hour early so it
   never points at a lapsed file. Per Google's documentation the storage limit
   is 20 GB per project, 2 GB per file (50 MB for PDFs).
   <https://ai.google.dev/gemini-api/docs/files>

**EasyFilla does not delete files from Google on your behalf.** If you want an
uploaded file removed before the 48-hour expiry, delete it through the Gemini
API or AI Studio using your own key.

#### If you selected Anthropic Claude

There is **one path only**: documents are sent as bytes inside the request
itself. EasyFilla does not use any Anthropic file-upload endpoint, so nothing is
stored server-side by EasyFilla on your behalf. When your files exceed the
single-request limit, the run is **refused with the oversized files named** —
EasyFilla will not fall back to uploading them anywhere.

Anthropic's published retention for API traffic (see §1) is deletion from its
backend **within 30 days**, with longer retention where a usage-policy
classification is triggered.

### Nowhere else

There is no third path. Nothing is retained by the developer, because nothing
is ever sent to the developer — see §2.

---

## 7. Deleting your data

- **API keys** — Options → Clear, per provider. Each key is stored separately, so clearing one does not affect the other.
- **Profile** — Options → edit or delete individual facts
- **Dossier and caches** — Side panel → Rebuild/clear dossier
- **Everything** — remove the extension; Chrome deletes all its local storage

Data already sent to a provider is subject to THAT provider's retention and deletion
policies, not ours — see §1 and §6. Switching providers does not withdraw
anything already sent to the previous one.

---

## 8. Children

EasyFilla is not directed at children and should not be used by anyone under 16.

## 9. Changes

Material changes to this policy will be reflected in the "Last updated" date and
in the extension's release notes.

## 10. Contact

<!-- TODO before store submission: replace with a real, monitored contact.
     Chrome Web Store requires a working contact address for the developer. -->
**[CONTACT EMAIL — REQUIRED BEFORE SUBMISSION]**
