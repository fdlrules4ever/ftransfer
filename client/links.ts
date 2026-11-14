import { $, api, ApiError, errorMessage, formatDateTime, h, icon, plural, timeUntil } from "./common.js";
import { decryptSecret, deriveFromEasyCode, isSecretKey, normalizeEasyCode } from "./crypto.js";
import { linkRow } from "./linkview.js";
import { decodeLinks, parseLink, type Link } from "./urls.js";

interface Encrypted {
  id: string;
  iv: string;
  ciphertext: string;
  expiresAt: number;
}

type View = "loading" | "missing" | "links" | "deleted";

const views: Record<View, HTMLElement> = {
  loading: $("view-loading"),
  missing: $("view-missing"),
  links: $("view-links"),
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

// /l/{id}#{key}: the key is in the fragment, which the browser never sends to the server.
// An easy link is /l#{code}: the ID and key are both derived from the code, in this browser.
const easy = location.pathname === "/l";
let key = location.hash.slice(1);
let apiUrl = `/api/links/${encodeURIComponent(location.pathname.slice("/l/".length))}`;
let links: Link[] = [];

async function init(): Promise<void> {
  if (easy) {
    const code = normalizeEasyCode(key);
    if (!code) {
      showMissing("This code is incomplete", "The code after the # should be 16 letters and digits. Check it with the sender.");
      return;
    }
    const derived = await deriveFromEasyCode(code);
    key = derived.key;
    apiUrl = `/api/links/${encodeURIComponent(derived.id)}`;
  }
  if (!isSecretKey(key)) {
    showMissing(
      "This link is incomplete",
      "The part after the # is missing or cut off, and it's needed to decrypt the links. Ask the sender for the complete link.",
    );
    return;
  }
  let data: Encrypted;
  try {
    // Nothing gets used up, so the links are fetched and decrypted straight away.
    data = await api<Encrypted>(apiUrl);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      showMissing(undefined, easy ? "Check the code for typos. Otherwise they were deleted or have expired: ask the sender to share them again." : undefined);
    }
    else $("loading-text").textContent = errorMessage(err);
    return;
  }

  let texts: string[] | null;
  try {
    texts = decodeLinks(await decryptSecret({ key, iv: data.iv, ciphertext: data.ciphertext }));
  } catch (err) {
    showMissing("Couldn't decrypt these links", `${errorMessage(err)} Ask the sender for the complete link.`);
    return;
  }
  if (!texts) {
    showMissing("Couldn't read these links", "The shared data isn't in the expected format. Ask the sender to share them again.");
    return;
  }

  // Checked again here: the server only stores ciphertext, so nothing has vetted these links yet.
  const parsed = texts.map(parseLink);
  links = parsed.filter((p): p is Link => p.ok);
  $("links-title").textContent = plural(links.length, "link");
  $("links-meta").textContent = `Available until ${formatDateTime(data.expiresAt)} (${timeUntil(data.expiresAt)}).`;
  $("links-list").replaceChildren(...parsed.map((p) => linkRow(p, "recipient", p.ok ? [copyButton(p.href)] : [])));
  resetCopyAll();
  $("copy-all").hidden = links.length < 2;
  show("links");
}

// ---------------------------------------------------------------------------
// Copy

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Older browsers, or no clipboard permission: copy through a temporary field.
    const field = h("textarea", { class: "sr-only", "aria-hidden": "true" });
    field.value = text;
    document.body.append(field);
    field.select();
    document.execCommand("copy");
    field.remove();
  }
}

function copyButton(href: string): HTMLButtonElement {
  const reset = () => button.replaceChildren(icon("copy", 18));
  const button = h("button", { class: "btn ghost icon-btn", type: "button", "aria-label": "Copy link", title: "Copy link" });
  reset();
  button.addEventListener("click", async () => {
    await copyText(href);
    button.replaceChildren(icon("check", 18));
    setTimeout(reset, 2000);
  });
  return button;
}

const copyAll = $<HTMLButtonElement>("copy-all");
function resetCopyAll(): void {
  copyAll.replaceChildren(icon("copy", 18), "Copy all links");
}

copyAll.addEventListener("click", async () => {
  await copyText(links.map((l) => l.href).join("\n"));
  copyAll.replaceChildren(icon("check", 18), "Copied");
  setTimeout(resetCopyAll, 2000);
});

// ---------------------------------------------------------------------------
// Delete

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
    show("deleted");
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) show("deleted");
    else showError($("delete-error"), `Couldn't delete: ${errorMessage(err)}`);
  } finally {
    button.disabled = false;
  }
});

// Correcting a typo in the code only changes the #, which doesn't reload the page by itself.
window.addEventListener("hashchange", () => location.reload());

void init();
