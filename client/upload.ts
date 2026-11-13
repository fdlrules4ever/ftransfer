import {
  $,
  api,
  ApiError,
  errorMessage,
  fileBadge,
  formatBytes,
  formatDate,
  formatDuration,
  h,
  icon,
  plural,
} from "./common.js";

// ---------------------------------------------------------------------------
// Types shared with the API

interface Limits {
  chunkSize: number;
  maxTotalBytes: number;
  maxFiles: number;
  expiryDays: number[];
  defaultExpiryDays: number;
}

interface Session {
  authenticated: boolean;
  configured: boolean;
  limits?: Limits;
  usage?: { usedBytes: number; freeBytes: number };
}

interface CreatedFile {
  index: number;
  name: string;
  size: number;
  multipart: boolean;
  parts: number;
}

interface Created {
  id: string;
  chunkSize: number;
  files: CreatedFile[];
}

interface Finalized {
  id: string;
  expiresAt: number;
  totalBytes: number;
  files: { index: number; name: string; size: number }[];
}

// ---------------------------------------------------------------------------
// Views

type View = "loading" | "login" | "compose" | "upload" | "done";

const views: Record<View, HTMLElement> = {
  loading: $("view-loading"),
  login: $("view-login"),
  compose: $("view-compose"),
  upload: $("view-upload"),
  done: $("view-done"),
};

function show(view: View): void {
  for (const [name, el] of Object.entries(views)) el.hidden = name !== view;
  $("signout").hidden = !(view === "compose" || view === "done");
}

function showError(el: HTMLElement, message: string | null): void {
  el.textContent = message ?? "";
  el.hidden = message === null;
}

let session: Session = { authenticated: false, configured: true };
let selected: File[] = [];
let uploading = false;

async function init(): Promise<void> {
  try {
    session = await api<Session>("/api/session");
  } catch (err) {
    show("loading");
    $("loading-text").textContent = errorMessage(err);
    return;
  }
  if (!session.authenticated) {
    $("not-configured").hidden = session.configured;
    show("login");
    $<HTMLInputElement>("password").focus();
    return;
  }
  setupCompose();
  show("compose");
}

// ---------------------------------------------------------------------------
// Login

$<HTMLFormElement>("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("password");
  const button = $<HTMLButtonElement>("login-btn");
  const errorEl = $("login-error");
  showError(errorEl, null);
  button.disabled = true;
  try {
    await api("/api/login", { method: "POST", body: JSON.stringify({ password: input.value }) });
    input.value = "";
    await init();
  } catch (err) {
    showError(errorEl, errorMessage(err));
    input.select();
  } finally {
    button.disabled = false;
  }
});

$("signout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" }).catch(() => undefined);
  selected = [];
  await init();
});

// ---------------------------------------------------------------------------
// Compose: pick files and options

const dropzone = $("dropzone");
const fileInput = $<HTMLInputElement>("file-input");
const expirySelect = $<HTMLSelectElement>("expiry");

function setupCompose(): void {
  const limits = session.limits!;
  const current = Number(expirySelect.value) || limits.defaultExpiryDays;
  expirySelect.replaceChildren(
    ...limits.expiryDays.map((d) => {
      const opt = h("option", { value: String(d) }, d === 1 ? "1 day" : `${d} days`);
      opt.selected = d === (limits.expiryDays.includes(current) ? current : limits.defaultExpiryDays);
      return opt;
    }),
  );
  renderSelected();
}

function totalSelected(): number {
  return selected.reduce((sum, f) => sum + f.size, 0);
}

function renderSelected(): void {
  const limits = session.limits!;
  const free = session.usage?.freeBytes ?? limits.maxTotalBytes;
  const total = totalSelected();
  const list = $("file-list");

  list.replaceChildren(
    ...selected.map((file, i) => {
      const remove = h("button", { class: "btn ghost icon-btn", type: "button", "aria-label": `Remove ${file.name}` }, icon("x", 18));
      remove.addEventListener("click", () => {
        selected.splice(i, 1);
        renderSelected();
      });
      return h(
        "li",
        { class: "file" },
        h("span", { class: "badge", "aria-hidden": "true" }, fileBadge(file.name)),
        h("div", { class: "file-main" }, h("div", { class: "file-name", title: file.name }, file.name), h("div", { class: "file-meta" }, formatBytes(file.size))),
        remove,
      );
    }),
  );

  const hasFiles = selected.length > 0;
  dropzone.classList.toggle("compact", hasFiles);
  $("dz-title").textContent = hasFiles ? "Add more files" : "Drop files here";
  $("space-hint").textContent = `Up to ${formatBytes(free)} available`;
  $("summary").textContent = hasFiles ? `${plural(selected.length, "file")} · ${formatBytes(total)}` : "";

  let problem: string | null = null;
  if (selected.length > limits.maxFiles) problem = `You can send at most ${limits.maxFiles} files at once.`;
  else if (total > free) problem = `That's ${formatBytes(total)}, but only ${formatBytes(free)} is free right now.`;
  showError($("compose-error"), problem);
  $<HTMLButtonElement>("share-btn").disabled = !hasFiles || problem !== null;
}

function addFiles(files: Iterable<File>): void {
  const seen = new Set(selected.map((f) => `${f.name}|${f.size}|${f.lastModified}`));
  for (const file of files) {
    const key = `${file.name}|${file.size}|${file.lastModified}`;
    if (!seen.has(key)) {
      seen.add(key);
      selected.push(file);
    }
  }
  renderSelected();
}

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener("change", () => {
  if (fileInput.files) addFiles(fileInput.files);
  fileInput.value = "";
});

// Accept drops anywhere on the page while composing.
let dragDepth = 0;
const canDrop = () => !views.compose.hidden;
window.addEventListener("dragenter", (e) => {
  if (!canDrop() || !e.dataTransfer?.types.includes("Files")) return;
  e.preventDefault();
  dragDepth++;
  dropzone.classList.add("dragging");
});
window.addEventListener("dragover", (e) => {
  if (!canDrop()) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
});
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    dropzone.classList.remove("dragging");
  }
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropzone.classList.remove("dragging");
  if (!canDrop() || !e.dataTransfer) return;

  const files: File[] = [];
  let folders = 0;
  const items = Array.from(e.dataTransfer.items ?? []);
  if (items.length > 0) {
    for (const item of items) {
      if (item.kind !== "file") continue;
      if (item.webkitGetAsEntry?.()?.isDirectory) {
        folders++;
        continue;
      }
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  } else {
    files.push(...Array.from(e.dataTransfer.files));
  }
  addFiles(files);
  if (folders > 0) {
    showError($("compose-error"), `${plural(folders, "folder")} skipped: zip folders first, then add the zip file.`);
  }
});

$("share-btn").addEventListener("click", () => void startUpload());

// ---------------------------------------------------------------------------
// Upload engine: parallel, chunked, with retries

const PARALLEL_REQUESTS = 4;
const MAX_ATTEMPTS = 5;

class RequestFailed extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Job {
  stopped: boolean;
  cancelled: boolean;
  xhrs: Set<XMLHttpRequest>;
}

/** Limits concurrent requests; a finished task hands its slot straight to the next one in line. */
class Pool {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private readonly size: number) {}

  async run<T>(job: Job, task: () => Promise<T>): Promise<T> {
    if (this.active < this.size) this.active++;
    else await new Promise<void>((resolve) => this.queue.push(resolve));
    try {
      if (job.stopped) throw new RequestFailed(-1, "Stopped");
      return await task();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryable(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

/** Retries network errors and server hiccups with exponential backoff. */
async function withRetry<T>(job: Job, attemptFn: () => Promise<T>, onRetry?: () => void): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await attemptFn();
    } catch (err) {
      const status = err instanceof RequestFailed || err instanceof ApiError ? err.status : -1;
      if (job.stopped || !isRetryable(status) || attempt >= MAX_ATTEMPTS) throw err;
      onRetry?.();
      await sleep(Math.min(1000 * 2 ** (attempt - 1), 15_000));
      if (job.stopped) throw err;
    }
  }
}

/** XHR instead of fetch, because only XHR reports upload progress. */
function sendBlob(job: Job, url: string, body: Blob, onProgress: (loaded: number) => void): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    job.xhrs.add(xhr);
    xhr.open("PUT", url);
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => onProgress(Math.min(e.loaded, body.size));
    xhr.onload = () => {
      job.xhrs.delete(xhr);
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
      else reject(new RequestFailed(xhr.status, xhr.response?.error ?? `Upload failed (${xhr.status}).`));
    };
    xhr.onerror = () => {
      job.xhrs.delete(xhr);
      reject(new RequestFailed(0, "Network error while uploading."));
    };
    xhr.onabort = () => {
      job.xhrs.delete(xhr);
      reject(new RequestFailed(-1, "Upload cancelled."));
    };
    xhr.send(body);
  });
}

class Progress {
  private readonly loaded: number[][];
  private readonly samples: { t: number; bytes: number }[] = [];
  private frame = 0;
  readonly total: number;

  constructor(
    private readonly files: CreatedFile[],
    private readonly onRender: (p: Progress) => void,
  ) {
    this.loaded = files.map((f) => new Array<number>(f.parts).fill(0));
    this.total = files.reduce((sum, f) => sum + f.size, 0);
  }

  set(file: number, part: number, bytes: number): void {
    this.loaded[file]![part] = bytes;
    if (!this.frame) {
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.onRender(this);
      });
    }
  }

  fileLoaded(file: number): number {
    return this.loaded[file]!.reduce((a, b) => a + b, 0);
  }

  sent(): number {
    return this.files.reduce((sum, f) => sum + this.fileLoaded(f.index), 0);
  }

  /** Bytes per second over the last ~5 seconds. */
  speed(): number {
    const now = performance.now();
    this.samples.push({ t: now, bytes: this.sent() });
    while (this.samples.length > 2 && now - this.samples[0]!.t > 5000) this.samples.shift();
    const first = this.samples[0]!;
    const dt = (now - first.t) / 1000;
    return dt > 0.5 ? (this.sent() - first.bytes) / dt : 0;
  }
}

let currentJob: Job | null = null;

function stopJob(job: Job): void {
  job.stopped = true;
  for (const xhr of job.xhrs) xhr.abort();
  job.xhrs.clear();
}

function buildProgressRows(files: File[]): { bars: HTMLElement[]; metas: HTMLElement[]; status: HTMLElement[] } {
  const bars: HTMLElement[] = [];
  const metas: HTMLElement[] = [];
  const status: HTMLElement[] = [];
  $("progress-list").replaceChildren(
    ...files.map((file) => {
      const fill = h("span");
      const bar = h("div", { class: "bar", role: "progressbar", "aria-label": file.name, "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": "0" }, fill);
      const meta = h("div", { class: "file-meta" }, `Waiting · ${formatBytes(file.size)}`);
      const stat = h("span", { class: "file-status" });
      bars.push(bar);
      metas.push(meta);
      status.push(stat);
      return h(
        "li",
        { class: "file" },
        h("span", { class: "badge", "aria-hidden": "true" }, fileBadge(file.name)),
        h("div", { class: "file-main" }, h("div", { class: "file-name", title: file.name }, file.name), bar, meta),
        stat,
      );
    }),
  );
  return { bars, metas, status };
}

function setBar(bar: HTMLElement, fraction: number): void {
  const pct = Math.round(fraction * 1000) / 10;
  (bar.firstElementChild as HTMLElement).style.width = `${pct}%`;
  bar.setAttribute("aria-valuenow", String(Math.round(pct)));
}

async function startUpload(): Promise<void> {
  const files = selected.slice();
  const expiryDays = Number(expirySelect.value);
  const job: Job = { stopped: false, cancelled: false, xhrs: new Set() };
  currentJob = job;
  uploading = true;

  showError($("upload-error"), null);
  $("upload-failed-actions").hidden = true;
  $("cancel-btn").hidden = false;
  $("upload-title").textContent = `Uploading ${plural(files.length, "file")}`;
  show("upload");

  const rows = buildProgressRows(files);
  const done = new Set<number>();
  let lastText = 0;
  setBar($("overall-bar"), 0);
  $("overall-percent").textContent = "0%";
  $("overall-detail").textContent = "Starting…";

  const render = (p: Progress) => {
    for (let i = 0; i < files.length; i++) {
      if (done.has(i)) continue;
      const loaded = p.fileLoaded(i);
      const size = files[i]!.size;
      setBar(rows.bars[i]!, size === 0 ? 0 : loaded / size);
      if (loaded > 0) rows.metas[i]!.textContent = `${formatBytes(loaded)} of ${formatBytes(size)}`;
    }
    const sent = p.sent();
    const fraction = p.total === 0 ? 1 : sent / p.total;
    setBar($("overall-bar"), fraction);
    $("overall-percent").textContent = `${Math.floor(fraction * 100)}%`;
    const now = performance.now();
    if (now - lastText > 400) {
      lastText = now;
      const speed = p.speed();
      const eta = speed > 0 ? formatDuration((p.total - sent) / speed) : "";
      $("overall-detail").textContent = [`${formatBytes(sent)} of ${formatBytes(p.total)}`, speed > 0 ? `${formatBytes(speed)}/s` : "", eta]
        .filter(Boolean)
        .join(" · ");
    }
  };

  const markDone = (i: number) => {
    done.add(i);
    setBar(rows.bars[i]!, 1);
    rows.bars[i]!.classList.add("done");
    rows.metas[i]!.textContent = formatBytes(files[i]!.size);
    rows.status[i]!.replaceChildren(icon("check", 20));
    rows.status[i]!.classList.add("done");
  };

  let created: Created | null = null;
  try {
    created = await withRetry(job, () =>
      api<Created>("/api/transfers", {
        method: "POST",
        body: JSON.stringify({ expiryDays, files: files.map((f) => ({ name: f.name, size: f.size, type: f.type })) }),
      }),
    );
    const transfer = created;
    const progress = new Progress(transfer.files, render);
    const pool = new Pool(PARALLEL_REQUESTS);

    await Promise.all(
      transfer.files.map(async (cf) => {
        const file = files[cf.index]!;
        const base = `/api/transfers/${transfer.id}/files/${cf.index}`;

        if (!cf.multipart) {
          await pool.run(job, () =>
            withRetry(
              job,
              () => sendBlob(job, base, file, (n) => progress.set(cf.index, 0, n)),
              () => progress.set(cf.index, 0, 0),
            ),
          );
          progress.set(cf.index, 0, file.size);
        } else {
          const { uploadId } = await withRetry(job, () => api<{ uploadId: string }>(`${base}/multipart`, { method: "POST" }));
          const etags: string[] = [];
          await Promise.all(
            Array.from({ length: cf.parts }, (_, p) =>
              pool.run(job, async () => {
                const start = p * transfer.chunkSize;
                const blob = file.slice(start, Math.min(start + transfer.chunkSize, file.size));
                const url = `${base}/parts/${p + 1}?uploadId=${encodeURIComponent(uploadId)}`;
                const res = (await withRetry(
                  job,
                  () => sendBlob(job, url, blob, (n) => progress.set(cf.index, p, n)),
                  () => progress.set(cf.index, p, 0),
                )) as { etag: string };
                progress.set(cf.index, p, blob.size);
                etags[p] = res.etag;
              }),
            ),
          );
          await withRetry(job, () =>
            api(`${base}/complete`, {
              method: "POST",
              body: JSON.stringify({ uploadId, parts: etags.map((etag, p) => ({ partNumber: p + 1, etag })) }),
            }),
          );
        }
        markDone(cf.index);
      }),
    );

    $("overall-detail").textContent = "Finishing…";
    const result = await withRetry(job, () => api<Finalized>(`/api/transfers/${transfer.id}/finalize`, { method: "POST" }));
    uploading = false;
    showDone(result);
  } catch (err) {
    stopJob(job);
    uploading = false;
    if (created) discardTransfer(created.id);
    if (job.cancelled) {
      show("compose");
      return;
    }
    showError($("upload-error"), `Upload failed: ${errorMessage(err)} Nothing was shared.`);
    $("upload-title").textContent = "Upload failed";
    $("cancel-btn").hidden = true;
    $("upload-failed-actions").hidden = false;
  } finally {
    if (currentJob === job) currentJob = null;
  }
}

/** Best-effort cleanup of a cancelled/failed transfer; the hourly cleanup catches anything left. */
function discardTransfer(id: string): void {
  void fetch(`/api/transfers/${id}`, { method: "DELETE", keepalive: true, credentials: "same-origin" }).catch(() => undefined);
}

$("cancel-btn").addEventListener("click", () => {
  if (!currentJob) return;
  currentJob.cancelled = true;
  stopJob(currentJob);
});
$("retry-btn").addEventListener("click", () => void startUpload());
$("back-btn").addEventListener("click", () => {
  void refreshUsage();
  show("compose");
});

window.addEventListener("beforeunload", (e) => {
  if (uploading) e.preventDefault();
});

// ---------------------------------------------------------------------------
// Done

function showDone(result: Finalized): void {
  const url = `${location.origin}/${result.id}`;
  const input = $<HTMLInputElement>("share-url");
  input.value = url;
  $<HTMLAnchorElement>("open-link").href = url;
  $("done-meta").textContent = `${plural(result.files.length, "file")} · ${formatBytes(result.totalBytes)} · deleted automatically on ${formatDate(result.expiresAt)}`;
  resetCopyButton();
  show("done");
  input.focus();
  input.select();
}

const copyBtn = $<HTMLButtonElement>("copy-btn");
function resetCopyButton(): void {
  copyBtn.replaceChildren(icon("copy", 18), "Copy link");
}

copyBtn.addEventListener("click", async () => {
  const input = $<HTMLInputElement>("share-url");
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    input.select();
    document.execCommand("copy");
  }
  copyBtn.replaceChildren(icon("check", 18), "Copied");
  setTimeout(resetCopyButton, 2000);
});

$("share-url").addEventListener("focus", (e) => (e.target as HTMLInputElement).select());

$("new-btn").addEventListener("click", async () => {
  selected = [];
  await refreshUsage();
  show("compose");
});

async function refreshUsage(): Promise<void> {
  try {
    session = await api<Session>("/api/session");
  } catch {
    // keep the old numbers; the server re-checks space anyway
  }
  if (session.authenticated) renderSelected();
  else await init();
}

void init();
