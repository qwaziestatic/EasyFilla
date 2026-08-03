import { initDebugLogging, setDebugLogging } from "../lib/debug";
import { loadLedger, setDailyLimit } from "../lib/ai/quota-store";
import { describeUsage, describeReset } from "../lib/ai/request-budget";
import {
  loadComposeDefaults,
  saveComposeDefaults,
  lengthTargetFor,
  type ComposeLengthChoice,
  type ComposeToneChoice,
} from "../lib/ui-prefs";
import { testProviderConnection } from "../lib/ai/gemini-client";
import { getProvider, type ProviderId } from "../lib/ai/provider";
import { listModelsForProvider, saveModelForProvider } from "../lib/ai/active-provider";
import { loadCachedDossier, dossierRetargetVerdict } from "../lib/ai/dossier";
import {
  hasApiKey,
  saveApiKey,
  clearApiKey,
  loadActiveProvider,
  saveActiveProvider,
} from "../lib/storage/provider-keys";
import { MODEL_OPTIONS, loadSelectedModel, saveSelectedModel } from "../lib/ai/model-config";
import { resetInputNote, isInputNoteDismissed } from "../lib/ui-prefs";
import { loadProfile, updateProfileFacts } from "../lib/profile/storage";
import type { ProfileFact, ProfileFieldKind } from "../lib/profile/types";

const apiKeyInput = document.getElementById("gemini-api-key-input") as HTMLInputElement;
const saveButton = document.getElementById("save-api-key-button") as HTMLButtonElement;
const clearButton = document.getElementById("clear-api-key-button") as HTMLButtonElement;
const testConnectionButton = document.getElementById("provider-test-connection") as HTMLButtonElement;
const statusText = document.getElementById("api-key-status") as HTMLParagraphElement;
const connectionTestStatus = document.getElementById("connection-test-status") as HTMLParagraphElement;
const profileList = document.getElementById("profile-list") as HTMLDivElement;
const profileAddButton = document.getElementById("profile-add-button") as HTMLButtonElement;
const profileSaveButton = document.getElementById("profile-save-button") as HTMLButtonElement;
const profileStatus = document.getElementById("profile-status") as HTMLParagraphElement;

function setStatus(message: string): void {
  statusText.textContent = message;
}

// ── E5: PRESENCE ONLY. The key is never read back into the DOM. ────────────
// This used to call loadGeminiApiKey() and assign the string to the input's
// value on every open. Two problems, both found by the E5 re-audit:
//   1. It read the INACTIVE provider's key. With Anthropic selected, opening
//      Settings still materialised the Gemini key — a read of a credential not
//      in use, for no purpose beyond repainting a masked field.
//   2. It put the key into a DOM node, widening the surface for it to be
//      captured by a screenshot, an accessibility tree dump or a devtools
//      snapshot, none of which respect `type="password"`.
// The Anthropic field never did this, so the two were asymmetric; both now use
// the safer pattern. A user replacing a key types the new one, which is the
// only operation the field is actually for.
async function loadExistingKey(): Promise<void> {
  setStatus(
    (await hasApiKey("gemini"))
      ? "A Gemini API key is saved on this device. Type a new one to replace it."
      : "No Gemini API key saved yet.",
  );
}

void loadExistingKey();

saveButton.addEventListener("click", () => {
  void (async () => {
    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
      setStatus("Enter a Gemini API key first.");
      return;
    }
    await saveApiKey("gemini", apiKey);
    setStatus("API key saved.");
  })();
});

clearButton.addEventListener("click", () => {
  void (async () => {
    await clearApiKey("gemini");
    apiKeyInput.value = "";
    setStatus("API key removed from this device.");
  })();
});

// FIX 6: model selector — persisted and applied to every call path; the
// request queue re-paces itself from the selected model's assumed RPM.
const modelSelect = document.getElementById("model-select") as HTMLSelectElement;

async function initModelSelect(): Promise<void> {
  const selected = await loadSelectedModel();
  modelSelect.innerHTML = "";
  MODEL_OPTIONS.forEach((option) => {
    const el = document.createElement("option");
    el.value = option.id;
    el.textContent = option.label;
    el.selected = option.id === selected.id;
    modelSelect.append(el);
  });
}

modelSelect.addEventListener("change", () => {
  void (async () => {
    await saveSelectedModel(modelSelect.value);
    setStatus(`Model set to ${modelSelect.value}. It applies to the next run, and re-paces the request queue.`);
  })();
});

void initModelSelect();

// FIX 4.1: one minimal request, reporting exactly what's wrong.
// E3d.1: PER PROVIDER. It tests the provider chosen in the selector, using that
// provider's own key, and the result names which provider answered — so a pass
// can never be read as evidence about the other one.
testConnectionButton.addEventListener("click", () => {
  void (async () => {
    testConnectionButton.disabled = true;
    const selected = getProvider(providerSelect.value as ProviderId);
    connectionTestStatus.textContent = `Testing ${selected.displayName}…`;
    const result = await testProviderConnection();
    connectionTestStatus.textContent = `${result.ok ? "✓" : "✗"} ${result.message}`;
    testConnectionButton.disabled = false;
  })();
});

// ── Editable profile reviewer (Problem 1.2) ──────────────────────────────

const FIELD_KINDS: ProfileFieldKind[] = [
  "email",
  "phone",
  "name",
  "address",
  "dob",
  "id",
  "url",
  "language",
  "education",
  "job_title",
  "employer",
  "nationality",
  "other",
];

let workingFacts: ProfileFact[] = [];
let nextManualId = 0;

function renderProfile(): void {
  profileList.innerHTML = "";
  if (workingFacts.length === 0) {
    const empty = document.createElement("p");
    empty.className = "options__hint";
    empty.textContent = "No facts yet. Upload documents in the side panel, or add facts manually below.";
    profileList.append(empty);
    return;
  }

  workingFacts.forEach((fact) => {
    const row = document.createElement("div");
    row.className = "profile-row";

    const kind = document.createElement("select");
    kind.className = "text-input profile-row__kind";
    FIELD_KINDS.forEach((k) => {
      const option = document.createElement("option");
      option.value = k;
      option.textContent = k;
      option.selected = k === fact.field;
      kind.append(option);
    });
    kind.addEventListener("change", () => {
      fact.field = kind.value as ProfileFieldKind;
    });

    const value = document.createElement("input");
    value.type = "text";
    value.className = "text-input profile-row__value";
    value.value = fact.value;
    value.addEventListener("input", () => {
      fact.value = value.value;
      fact.source = "manual"; // an edit makes it a permanent manual fact
    });

    const source = document.createElement("span");
    source.className = "profile-row__source";
    source.textContent = fact.source;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn btn--secondary btn--tiny";
    remove.textContent = "Delete";
    remove.addEventListener("click", () => {
      workingFacts = workingFacts.filter((f) => f.id !== fact.id);
      renderProfile();
    });

    row.append(kind, value, source, remove);
    profileList.append(row);
  });
}

async function loadProfileEditor(): Promise<void> {
  const profile = await loadProfile();
  workingFacts = profile ? profile.facts.map((f) => ({ ...f })) : [];
  renderProfile();
}

profileAddButton.addEventListener("click", () => {
  nextManualId += 1;
  workingFacts.push({
    id: `manual-${Date.now()}-${nextManualId}`,
    field: "other",
    label: "Custom",
    value: "",
    source: "manual",
    confidence: "high",
  });
  renderProfile();
});

profileSaveButton.addEventListener("click", () => {
  void (async () => {
    const cleaned = workingFacts.filter((f) => f.value.trim().length > 0);
    cleaned.forEach((f) => {
      f.value = f.value.trim();
      if (!f.label || f.label === "Custom") {
        f.label = f.field.charAt(0).toUpperCase() + f.field.slice(1);
      }
    });
    await updateProfileFacts(cleaned);
    workingFacts = cleaned.map((f) => ({ ...f }));
    renderProfile();
    profileStatus.textContent = `Saved ${cleaned.length} fact(s). These are used for contact/identity fields, permanently.`;
  })();
});

void loadProfileEditor();

// ── Reusable declaration defaults (Tier 1) ───────────────────────────────
import {
  DECLARATION_LABELS,
  loadDeclarationDefaults,
  saveDeclarationDefaults,
  type DeclarationDefaults,
  type DeclarationKind,
} from "../lib/profile/declarations";

const declarationsList = document.getElementById("declarations-list") as HTMLDivElement;
const declarationsSaveButton = document.getElementById("declarations-save-button") as HTMLButtonElement;
const declarationsStatus = document.getElementById("declarations-status") as HTMLParagraphElement;

const declarationSelects = new Map<DeclarationKind, HTMLSelectElement>();

async function renderDeclarations(): Promise<void> {
  const defaults = await loadDeclarationDefaults();
  declarationsList.innerHTML = "";
  (Object.keys(DECLARATION_LABELS) as DeclarationKind[]).forEach((kind) => {
    const row = document.createElement("div");
    row.className = "declarations-row";

    const label = document.createElement("span");
    label.className = "declarations-row__label";
    label.textContent = DECLARATION_LABELS[kind];

    const select = document.createElement("select");
    select.className = "text-input declarations-row__select";
    const choices: [string, string][] = [
      ["", "— no default —"],
      ["No", "No"],
      ["Yes", "Yes"],
    ];
    for (const [value, text] of choices) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      option.selected = (defaults[kind] ?? "") === value;
      select.append(option);
    }
    declarationSelects.set(kind, select);

    row.append(label, select);
    declarationsList.append(row);
  });
}

declarationsSaveButton.addEventListener("click", () => {
  void (async () => {
    const defaults: DeclarationDefaults = {};
    declarationSelects.forEach((select, kind) => {
      if (select.value) {
        defaults[kind] = select.value;
      }
    });
    await saveDeclarationDefaults(defaults);
    declarationsStatus.textContent = "Saved. These pre-fill every form as a draft you can review.";
  })();
});

void renderDeclarations();

// ── TASK B: global compose defaults ──────────────────────────────────────
// These SEED each question's initial choice. They are not an override: once a
// question has its own length/tone, changing the default here leaves it alone.
const composeLengthSelect = document.getElementById("compose-default-length") as HTMLSelectElement;
const composeToneSelect = document.getElementById("compose-default-tone") as HTMLSelectElement;
const composeDefaultsStatus = document.getElementById("compose-defaults-status") as HTMLParagraphElement;

function describeLengthTargets(choice: ComposeLengthChoice): string {
  const shortTarget = lengthTargetFor(choice, false);
  const essayTarget = lengthTargetFor(choice, true);
  return (
    `${shortTarget.minWords}–${shortTarget.maxWords} words on a short question, ` +
    `${essayTarget.minWords}–${essayTarget.maxWords} on an essay.`
  );
}

void (async () => {
  const defaults = await loadComposeDefaults();
  composeLengthSelect.value = defaults.length;
  composeToneSelect.value = defaults.tone;
  composeDefaultsStatus.textContent = describeLengthTargets(defaults.length);
})();

const persistComposeDefaults = (): void => {
  void (async () => {
    const next = {
      length: composeLengthSelect.value as ComposeLengthChoice,
      tone: composeToneSelect.value as ComposeToneChoice,
    };
    await saveComposeDefaults(next);
    composeDefaultsStatus.textContent = `Saved. ${describeLengthTargets(next.length)}`;
  })();
};

composeLengthSelect.addEventListener("change", persistComposeDefaults);
composeToneSelect.addEventListener("change", persistComposeDefaults);

// ── STAGE 3 / B6: daily request budget ───────────────────────────────────
// The pre-flight message already tells the user "set it in Options if you know
// it" — so Options has to actually offer it. Blank means unknown, which is the
// honest default: Google does not publish the free-tier RPD per model.
const dailyLimitInput = document.getElementById("daily-limit-input") as HTMLInputElement;
const dailyLimitSave = document.getElementById("daily-limit-save-button") as HTMLButtonElement;
const dailyLimitStatus = document.getElementById("daily-limit-status") as HTMLParagraphElement;

void (async () => {
  const ledger = await loadLedger();
  if (ledger.limit !== null) {
    dailyLimitInput.value = String(ledger.limit);
  }
  dailyLimitStatus.textContent = `${describeUsage(ledger)}. Resets at ${describeReset()} (00:00 Pacific).`;
})();

dailyLimitSave.addEventListener("click", () => {
  void (async () => {
    const raw = dailyLimitInput.value.trim();
    const parsed = raw === "" ? null : Number.parseInt(raw, 10);
    if (parsed !== null && (!Number.isFinite(parsed) || parsed <= 0)) {
      dailyLimitStatus.textContent = "Enter a whole number greater than zero, or leave it blank for unknown.";
      return;
    }
    const ledger = await setDailyLimit(parsed);
    dailyLimitStatus.textContent =
      parsed === null
        ? `Budget cleared — EasyFilla will report usage without a limit until it learns one from a quota error. ${describeUsage(ledger)}.`
        : `Budget set. ${describeUsage(ledger)}. Resets at ${describeReset()} (00:00 Pacific).`;
  })();
});

// ── B4: verbose logging toggle ───────────────────────────────────────────
// Default OFF. The summary blocks stay on regardless; this only controls the
// per-field/per-frame chatter. Neither level ever prints the API key or any
// document content — that is enforced at the call sites, not here.
const debugToggle = document.getElementById("debug-logging-toggle") as HTMLInputElement;
const debugStatus = document.getElementById("debug-logging-status") as HTMLParagraphElement;

void (async () => {
  debugToggle.checked = await initDebugLogging();
})();

debugToggle.addEventListener("change", () => {
  void (async () => {
    await setDebugLogging(debugToggle.checked);
    debugStatus.textContent = debugToggle.checked
      ? "Verbose logging ON. Reload the form tab and the side panel to apply it there."
      : "Verbose logging off. Run summaries are still printed.";
  })();
});

// ═══════════════════════════════════════════════════════════════════════
// E3d.1 — PROVIDER SELECTION
//
// The provider choice decides WHERE THE USER'S DOCUMENTS GO. That makes it
// privacy-relevant, so it is never silent: the destination is stated at the
// point of selection, the missing-key state names which key is missing, and
// switching with a dossier present says what will be rebuilt and what it costs.
// ═══════════════════════════════════════════════════════════════════════

const providerSelect = document.getElementById("provider-select") as HTMLSelectElement;
const providerDestination = document.getElementById("provider-destination") as HTMLParagraphElement;
const providerKeyWarning = document.getElementById("provider-key-warning") as HTMLParagraphElement;
const providerDossierWarning = document.getElementById("provider-dossier-warning") as HTMLParagraphElement;
const providerModelSelect = document.getElementById("provider-model-select") as HTMLSelectElement;
const providerModelStatus = document.getElementById("provider-model-status") as HTMLParagraphElement;
const providerModelsRefresh = document.getElementById("provider-models-refresh") as HTMLButtonElement;

const anthropicKeyInput = document.getElementById("anthropic-api-key-input") as HTMLInputElement;
const anthropicSaveButton = document.getElementById("save-anthropic-key-button") as HTMLButtonElement;
const anthropicClearButton = document.getElementById("clear-anthropic-key-button") as HTMLButtonElement;
const anthropicKeyStatus = document.getElementById("anthropic-key-status") as HTMLParagraphElement;

async function renderProviderState(): Promise<void> {
  const selected = providerSelect.value as ProviderId;
  const provider = getProvider(selected);

  // ── Where the documents go. Stated plainly, every time. ──
  providerDestination.textContent =
    `Your uploaded documents will be transmitted to ${provider.dataDestination}, ` +
    `using your own ${provider.displayName} API key. ` +
    (provider.capabilities.hasDailyQuota
      ? "This provider enforces a daily request quota."
      : "This provider has no daily request quota; it uses per-minute limits and a monthly spend cap.");

  // ── The misconfigured state, named. Never a generic AI error. ──
  const keyPresent = await hasApiKey(selected);
  providerKeyWarning.hidden = keyPresent;
  if (!keyPresent) {
    providerKeyWarning.textContent =
      `No ${provider.displayName} API key is saved, so runs will fail until you add one. ` +
      `Paste it into the "${provider.displayName}" key field below — a key for the other provider will not be used.`;
  }

  // ── Switching with a dossier present: say what it costs. ──
  const cached = await loadCachedDossier();
  const model = providerModelSelect.value || (await provider.activeModel());
  // Provider/model only — this page cannot see the uploaded files, so it must
  // not make claims about them (see `dossierRetargetVerdict`).
  const verdict = dossierRetargetVerdict(cached, selected, model);
  providerDossierWarning.hidden = !verdict.rebuild;
  if (verdict.rebuild && cached) {
    providerDossierWarning.textContent =
      `Your existing document dossier (${cached.fileCount} file(s), built by ${cached.provider ?? "an unknown provider"}) ` +
      `cannot be reused: ${verdict.reason} It will be rebuilt automatically on your next report, which costs ONE ` +
      `extra ${provider.displayName} request before any question is answered. Your uploaded files, your saved ` +
      "answers and your profile are NOT discarded.";
  }
}

providerSelect.addEventListener("change", () => {
  void (async () => {
    const selected = providerSelect.value as ProviderId;
    await saveActiveProvider(selected);
    providerModelSelect.innerHTML = "";
    providerModelStatus.textContent = 'Press "Load models from the API" to list models available to your key.';
    await renderProviderState();
  })();
});

// ── Model list: fetched live, filtered by the capabilities the app REQUIRES ──
// Stage A needs PDF input (scanned documents are the whole point, §2) and both
// stages need structured output (§3 derives provenance from the schema). A model
// lacking either cannot run this app, so it is excluded rather than offered and
// allowed to fail at request time.
providerModelsRefresh.addEventListener("click", () => {
  void (async () => {
    const selected = providerSelect.value as ProviderId;
    const provider = getProvider(selected);
    providerModelsRefresh.disabled = true;
    providerModelStatus.textContent = "Loading…";
    try {
      const models = await listModelsForProvider(selected);
      const usable = models.filter((m) => m.supportsStructuredOutputs && m.supportsPdf);
      providerModelSelect.innerHTML = "";
      usable.forEach((model) => {
        const option = document.createElement("option");
        option.value = model.id;
        // 0c — an ASSUMED capability is labelled in the list. The user is
        // choosing under uncertainty and the UI should say so; silently
        // presenting a guess as a filtered fact is what made a later
        // "not supported" error look like the user's mistake.
        option.textContent =
          model.capabilitySource === "assumed" ? `${model.displayName} — capabilities assumed` : model.displayName;
        providerModelSelect.append(option);
      });
      const assumedCount = usable.filter((m) => m.capabilitySource === "assumed").length;
      const excluded = models.length - usable.length;
      providerModelStatus.textContent =
        usable.length === 0
          ? `No model available to this key supports both structured output and PDF input, which EasyFilla requires. ` +
            `(${models.length} model(s) returned.)`
          : (assumedCount === usable.length
              ? `⚠️ ${provider.displayName} does not report per-model capabilities, so this list is filtered on an ` +
                "ASSUMPTION that these models support structured output and PDF input. If a model rejects a run, " +
                "the error will say so — try another rather than changing your other settings. "
              : "") +
            `${usable.length} usable model(s)` +
            (excluded > 0
              ? ` · ${excluded} hidden because they lack structured output or PDF input, which EasyFilla requires.`
              : "");
      await renderProviderState();
    } catch (error) {
      providerModelStatus.textContent =
        error instanceof Error ? error.message : `Couldn't list ${provider.displayName} models.`;
    } finally {
      providerModelsRefresh.disabled = false;
    }
  })();
});

providerModelSelect.addEventListener("change", () => {
  void (async () => {
    await saveModelForProvider(providerSelect.value as ProviderId, providerModelSelect.value);
    await renderProviderState();
  })();
});

// ── The Anthropic key field, independent of Gemini's ──
anthropicSaveButton.addEventListener("click", () => {
  void (async () => {
    const key = anthropicKeyInput.value.trim();
    if (!key) {
      anthropicKeyStatus.textContent = "Enter an Anthropic API key first.";
      return;
    }
    await saveApiKey("anthropic", key);
    anthropicKeyStatus.textContent = "Anthropic API key saved.";
    await renderProviderState();
  })();
});

anthropicClearButton.addEventListener("click", () => {
  void (async () => {
    await clearApiKey("anthropic");
    anthropicKeyInput.value = "";
    anthropicKeyStatus.textContent = "Anthropic API key removed from this device.";
    await renderProviderState();
  })();
});

void (async () => {
  providerSelect.value = await loadActiveProvider();
  if (await hasApiKey("anthropic")) {
    anthropicKeyStatus.textContent = "An Anthropic API key is saved on this device.";
  } else {
    anthropicKeyStatus.textContent = "No Anthropic API key saved yet.";
  }
  providerModelStatus.textContent = 'Press "Load models from the API" to list models available to your key.';
  await renderProviderState();
})();

// ── Intro tip: make a permanently-dismissed splash note recoverable ───────
// A tip that can be dismissed forever, with no way back, is indistinguishable
// from a tip that was never built — which is exactly how a live run reported it
// as missing when it was present and working.
{
  const resetButton = document.getElementById("reset-intro-tip-button") as HTMLButtonElement | null;
  const tipStatus = document.getElementById("intro-tip-status") as HTMLParagraphElement | null;

  const renderTipState = async (): Promise<void> => {
    if (!tipStatus) return;
    tipStatus.textContent = (await isInputNoteDismissed())
      ? "Currently hidden — you dismissed it. Press the button to show it again."
      : "Currently shown on startup.";
  };

  resetButton?.addEventListener("click", () => {
    void (async () => {
      await resetInputNote();
      if (tipStatus) {
        tipStatus.textContent = "Done — it will appear the next time you open the side panel.";
      }
    })();
  });

  void renderTipState();
}
