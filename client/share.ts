import { $, api, ApiError, errorMessage, fileBadge, formatBytes, formatDate, h, icon, plural, timeUntil } from "./common.js";

interface Transfer {
  id: string;
  createdAt: number;
  expiresAt: number;
  totalBytes: number;
  files: { index: number; name: string; size: number }[];
}

type View = "loading" | "missing" | "transfer" | "deleted";

const views: Record<View, HTMLElement> = {
  loading: $("view-loading"),
  missing: $("view-missing"),
  transfer: $("view-transfer"),
  deleted: $("view-deleted"),
};

function show(view: View): void {
  for (const [name, el] of Object.entries(views)) el.hidden = name !== view;
}

const id = location.pathname.slice(1);
const fileUrl = (index: number) => `/api/transfers/${encodeURIComponent(id)}/files/${index}`;

async function init(): Promise<void> {
  let transfer: Transfer;
  try {
    transfer = await api<Transfer>(`/api/transfers/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      show("missing");
    } else {
      $("loading-text").textContent = errorMessage(err);
    }
    return;
  }
  render(transfer);
  show("transfer");
}

function render(t: Transfer): void {
  const single = t.files.length === 1;
  $("t-title").textContent = single ? t.files[0]!.name : plural(t.files.length, "file");
  const expiry = $("t-expiry");
  expiry.textContent = `Available until ${formatDate(t.expiresAt)} (${timeUntil(t.expiresAt)})`;
  $("t-size").textContent = single ? formatBytes(t.totalBytes) : `${formatBytes(t.totalBytes)} in total`;

  $("t-files").replaceChildren(
    ...t.files.map((f) =>
      h(
        "li",
        { class: "file" },
        h("span", { class: "badge", "aria-hidden": "true" }, fileBadge(f.name)),
        h("div", { class: "file-main" }, h("div", { class: "file-name", title: f.name }, f.name), h("div", { class: "file-meta" }, formatBytes(f.size))),
        h("a", { class: "btn sm", href: fileUrl(f.index), download: "", "aria-label": `Download ${f.name}` }, icon("download", 18), h("span", { class: "hide-narrow" }, "Download")),
      ),
    ),
  );

  const all = $<HTMLButtonElement>("download-all");
  all.replaceChildren(icon("download", 20), single ? `Download (${formatBytes(t.totalBytes)})` : `Download all (${formatBytes(t.totalBytes)})`);
  all.onclick = () => void downloadAll(t);
  $("multi-hint").hidden = single;
}

/** Starts each download in turn; browsers may ask once to allow multiple downloads. */
async function downloadAll(t: Transfer): Promise<void> {
  const button = $<HTMLButtonElement>("download-all");
  button.disabled = true;
  try {
    for (const [i, f] of t.files.entries()) {
      const a = h("a", { href: fileUrl(f.index), download: "" });
      document.body.append(a);
      a.click();
      a.remove();
      if (i < t.files.length - 1) await new Promise((r) => setTimeout(r, 800));
    }
  } finally {
    setTimeout(() => (button.disabled = false), 1500);
  }
}

// ---------------------------------------------------------------------------
// Delete

const dialog = $<HTMLDialogElement>("confirm-delete");

$("delete-btn").addEventListener("click", () => {
  $("delete-error").hidden = true;
  dialog.showModal();
});

// The form uses method="dialog", so any button closes the dialog; only "confirm" deletes.
// (Handled on submit rather than the dialog's close event, which some browsers defer.)
dialog.querySelector("form")!.addEventListener("submit", async (e) => {
  if ((e.submitter as HTMLButtonElement | null)?.value !== "confirm") return;
  const button = $<HTMLButtonElement>("delete-btn");
  button.disabled = true;
  try {
    await api(`/api/transfers/${encodeURIComponent(id)}`, { method: "DELETE" });
    show("deleted");
  } catch (err) {
    const el = $("delete-error");
    el.textContent = `Couldn't delete: ${errorMessage(err)}`;
    el.hidden = false;
  } finally {
    button.disabled = false;
  }
});

void init();
