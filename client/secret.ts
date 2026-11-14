import { $, api, ApiError, errorMessage, formatDateTime, icon, maskToggle, timeUntil } from "./common.js";
import { decryptSecret, deriveFromEasyCode, isSecretKey, normalizeEasyCode } from "./crypto.js";

interface SecretInfo {
  id: string;
  expiresAt: number;
  oneTime: boolean;
}

interface Revealed extends SecretInfo {
  iv: string;
  ciphertext: string;
}

type View = "loading" | "missing" | "ready" | "secret" | "deleted";

const views: Record<View, HTMLElement> = {
  loading: $("view-loading"),
  missing: $("view-missing"),
  ready: $("view-ready"),
  secret: $("view-secret"),
  deleted: $("view-deleted"),
};

function show(view: View): void {
  for (const [name, el] of Object.entries(views)) el.hidden = name !== view;
}

function showError(el: HTMLElement, message: string | null): void {
  el.textContent = message ?? "";
  el.hidden = message === null;
}

function showMissing(title?: string, text?: string): void {
  if (title) $("missing-title").textContent = title;
  if (text) $("missing-text").textContent = text;
  show("missing");
}

// /s/{id}#{key}: the key is in the fragment, which the browser never sends to the server.
// An easy link is /s#{code}: the ID and key are both derived from the code, in this browser.
const easy = location.pathname === "/s";
let key = location.hash.slice(1);
let apiUrl = `/api/secrets/${encodeURIComponent(location.pathname.slice("/s/".length))}`;

const MISSING_EASY = "Check the code for typos. Otherwise it was already viewed, was deleted, or has expired: ask the sender to share it again.";

async function init(): Promise<void> {
  if (easy) {
    const code = normalizeEasyCode(key);
    if (!code) {
      showMissing("This code is incomplete", "The code after the # should be 16 letters and digits. Check it with the sender.");
      return;
    }
    const derived = await deriveFromEasyCode(code);
    key = derived.key;
    apiUrl = `/api/secrets/${encodeURIComponent(derived.id)}`;
  }
  if (!isSecretKey(key)) {
    // Don't contact the server: revealing without a usable key would only use up a one-time secret.
    showMissing(
      "This link is incomplete",
      "The part after the # is missing or cut off, and it's needed to decrypt the secret. Ask the sender for the complete link.",
    );
    return;
  }
  let info: SecretInfo;
  try {
    info = await api<SecretInfo>(apiUrl);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) showMissing(undefined, easy ? MISSING_EASY : undefined);
    else $("loading-text").textContent = errorMessage(err);
    return;
  }
  $("ready-meta").textContent = info.oneTime
    ? "You can view it once: it's deleted as soon as you reveal it, so have somewhere ready to put it."
    : `Available until ${formatDateTime(info.expiresAt)} (${timeUntil(info.expiresAt)}).`;
  show("ready");
  $("reveal-btn").focus();
}

// ---------------------------------------------------------------------------
// Reveal

const revealBtn = $<HTMLButtonElement>("reveal-btn");
const output = $<HTMLTextAreaElement>("secret-output");
const setMasked = maskToggle($<HTMLButtonElement>("secret-toggle"), output);
let revealed = "";

revealBtn.addEventListener("click", async () => {
  revealBtn.disabled = true;
  revealBtn.textContent = "Decrypting…";
  showError($("reveal-error"), null);
  try {
    // POST, so it only ever happens on this click, never on a link preview or prefetch.
    const data = await api<Revealed>(`${apiUrl}/reveal`, { method: "POST" });
    let text: string;
    try {
      text = await decryptSecret({ key, iv: data.iv, ciphertext: data.ciphertext });
    } catch (err) {
      showMissing(
        "Couldn't decrypt this secret",
        data.oneTime
          ? `${errorMessage(err)} It has been deleted from the server, so ask the sender to share it again.`
          : `${errorMessage(err)} Ask the sender for the complete link.`,
      );
      return;
    }
    showSecret(text, data);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) showMissing();
    else showError($("reveal-error"), errorMessage(err));
  } finally {
    revealBtn.disabled = false;
    revealBtn.textContent = "Reveal secret";
  }
});

function showSecret(text: string, info: SecretInfo): void {
  revealed = text;
  output.value = text;
  setMasked(true);
  resetCopyButton();
  $("secret-note").textContent = info.oneTime
    ? "This secret has now been deleted from the server. Copy it before you leave this page: the link won't work again."
    : `Available until ${formatDateTime(info.expiresAt)} (${timeUntil(info.expiresAt)}). Anyone with the link can view it until then.`;
  $("secret-delete-zone").hidden = info.oneTime;
  show("secret");
  // Fit the field to its content (it has to be visible to measure).
  output.style.height = "auto";
  output.style.height = `${Math.min(output.scrollHeight + 2, 360)}px`;
  $("copy-secret").focus();
}

// ---------------------------------------------------------------------------
// Copy

const copyBtn = $<HTMLButtonElement>("copy-secret");
function resetCopyButton(): void {
  copyBtn.replaceChildren(icon("copy", 18), "Copy secret");
}

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(revealed);
  } catch {
    output.select();
    document.execCommand("copy");
    output.setSelectionRange(0, 0);
  }
  copyBtn.replaceChildren(icon("check", 18), "Copied");
  setTimeout(resetCopyButton, 2000);
});

// ---------------------------------------------------------------------------
// Delete (only offered for secrets that aren't one-time)

const dialog = $<HTMLDialogElement>("confirm-delete");

$("delete-btn").addEventListener("click", () => {
  showError($("delete-error"), null);
  dialog.showModal();
});

// The form uses method="dialog", so any button closes the dialog; only "confirm" deletes.
dialog.querySelector("form")!.addEventListener("submit", async (e) => {
  if ((e.submitter as HTMLButtonElement | null)?.value !== "confirm") return;
  const button = $<HTMLButtonElement>("delete-btn");
  button.disabled = true;
  try {
    await api(apiUrl, { method: "DELETE" });
    revealed = "";
    output.value = "";
    show("deleted");
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      revealed = "";
      output.value = "";
      show("deleted");
    } else {
      showError($("delete-error"), `Couldn't delete: ${errorMessage(err)}`);
    }
  } finally {
    button.disabled = false;
  }
});

// Correcting a typo in the code only changes the #, which doesn't reload the page by itself.
window.addEventListener("hashchange", () => location.reload());

void init();
