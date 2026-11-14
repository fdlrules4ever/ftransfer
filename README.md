# FTransfer

A small, private alternative to WeTransfer that you host yourself, entirely on Cloudflare's free tier.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/fdlrules4ever/ftransfer)

In the examples below, `transfer.example.com` stands for wherever you host it.

- **Files**: sign in with a shared passphrase, drop files (multiple, any size up to the storage cap), pick when they should be deleted, press **Share**, copy the link.
- **transfer.example.com/{share-id}**: anyone with the link can download the files (one by one or all at once) or delete them.
- Files are deleted automatically after 7 days by default (1, 3, 7, 14 or 30 days can be chosen).
- **Links** (second tab): paste one or more links, separated by spaces or new lines. They're encrypted in your browser, and you get a link like **transfer.example.com/l/{id}#{key}** to a page where the recipient can click them (they open in a new tab). Links expire after 1, 7 (default) or 30 days. For a link that's really secret, use a secret instead.
- **Secrets** (third tab): paste a password, API key or note. It's encrypted in your browser, and you get a link like **transfer.example.com/s/{id}#{key}**. Secrets expire after 1 hour, 1 day (default) or 7 days and can optionally be deleted after the first view.

- **Easy-to-type link** (a checkbox on each tab): for when a link has to be typed over, from a screen or a phone call. You get a 16-character code instead of the long link, written like a card number: **transfer.example.com/k7m2-qpx9-vtd4-8hrw** for files, **transfer.example.com/s#k7m2-qpx9-vtd4-8hrw** for secrets and **/l#…** for links. Case, dashes and spaces don't matter.
- Every link is also shown as a **QR code** when it's ready, so it can be opened on a phone without typing at all.

No accounts, no tracking, no email. Nobody gets rights to your files.

## How it works

```
Browser ──► Worker (transfer.example.com) ──► R2 bucket "ftransfer" (private)
              │  serves the pages + JSON API
              │  checks the passphrase cookie on uploads
              └─ cron, every hour: deletes expired transfers, secrets and links
```

| Piece | Cloudflare product | Free tier |
|---|---|---|
| Pages + API | Workers with Static Assets | 100k requests/day |
| File storage | R2 (private bucket, no public URL) | 10 GB stored, egress always free |
| Cleanup | Cron Trigger (hourly) | included |
| Login throttling | Rate Limiting binding (5 tries/min/IP) | included |

**Uploads** are split into 32 MiB parts and sent 4 at a time (R2 multipart upload), so file size isn't limited by the Worker's 100 MB request limit, failed parts are retried automatically, and progress bars stay smooth.

**Privacy.** The R2 bucket has no public access. Files can only be fetched through the Worker, and only with the share ID: 128 random bits, effectively impossible to guess. Other measures:
- Pages send `Referrer-Policy: no-referrer` so the link doesn't leak to other sites.
- Pages are marked `noindex`.
- Downloads are always sent as attachments with a sandbox CSP, so an uploaded HTML file can never run on this site.

**Secrets are end-to-end encrypted.** The browser encrypts the text with AES-256-GCM (Web Crypto, no libraries) using a new random key for each secret. The key goes in the link after the `#`, which browsers never send to the server. R2, the Worker and Cloudflare only ever see ciphertext. The recipient's page decrypts it locally. More details:
- The secret is only fetched when the recipient clicks **Reveal secret**, through a POST request. That means link previews in Slack, Teams or WhatsApp (and browser prefetching) can't use up a one-time secret.
- A one-time secret is claimed with a conditional R2 write on the object's etag, then deleted before the response is sent. If two people open the link at the same moment, only one of them gets the secret.
- Text in the secret field is masked (shown as dots, or blurred in browsers that can't mask a textarea) until you press the eye button. This guards against someone looking over your shoulder, not against software running on your device.

**Links are end-to-end encrypted too**, the same way as secrets. Shared links (Google Drive, Figma, signed download URLs) often grant access on their own, so the server never sees them. Links are never one-time, so the recipient's page fetches and decrypts them straight away. Both sides show where every link really goes:
- Only `http` and `https` links are accepted. Links without `https://` get it added when they look like a web address (`example.com/page`). Anything else (`javascript:`, `mailto:`, plain words, email addresses) is listed as skipped, never shared silently.
- Links are shared exactly as pasted: nothing is trimmed, because characters like a closing `.` or `)` can belong to the link. A link ending in `,` or `;` gets a warning, since only spaces and new lines separate links.
- Each link shows its domain as the browser parses it, then the full address. A domain with non-ASCII characters is shown in its real `xn--` form with a warning, so lookalikes (a Cyrillic `а` in `аpple.com`) stand out. Real international domains like `münchen.de` get the warning too.
- A login part before `@` (`google.com@evil.com` goes to evil.com) and hidden characters (zero-width or text-direction marks) are flagged as well.
- The recipient's browser checks every link again before showing it, because the server only stores ciphertext and can't check anything. Links are added as DOM properties (never as HTML) and open with `rel="noopener noreferrer"`.

**Easy-to-type links.** The code uses Crockford's base32 alphabet: digits and lowercase letters without i, l, o and u, so no two characters look alike. It's read forgivingly: uppercase, dashes and spaces are ignored, and O, I and L are read as 0, 1 and 1. A typed variant of a file code redirects to its canonical form.
- The code holds 80 random bits instead of the 128 (ID) and 256 (key) bits of a normal link. That's still far too many to guess through the website.
- For secrets and links the code is all there is: the browser derives both the storage ID and the AES key from it with PBKDF2 (SHA-256, 600,000 rounds), and only sends the ID. The server never sees the code or the key, so they stay end-to-end encrypted.
- The trade-off: someone who has the stored ciphertext (Cloudflare, or whoever runs the Worker) could try every code offline. Thanks to the slow derivation that takes about 2^99 hash operations, which is out of reach in practice but less of a margin than a normal link. For the most sensitive secrets, use a normal link.
- QR codes are drawn in the browser by a small built-in encoder (`client/qr.ts`), so the link never goes to a third-party service.

**Upload access.** Uploading (and creating secrets and links) needs a shared passphrase (a Worker secret). Signing in sets a signed, HttpOnly, `__Host-` cookie that lasts 30 days. Changing the passphrase signs out every device. State-changing requests from other origins are rejected.

**Storage cap.** New transfers are refused when all active transfers together would exceed `MAX_TOTAL_BYTES` (9.5 GB), which keeps R2 within the free 10 GB.

**Expiry.** Expiry is enforced at three levels:
1. Every request checks the expiry date.
2. The hourly cron deletes expired transfers, secrets and links, and uploads abandoned for more than 24 hours.
3. R2 lifecycle rules delete files and links older than 32 days and secrets older than 8 days as a safety net.

## Project layout

```
src/           Worker (TypeScript)
  index.ts       routing, security headers, cron handler
  transfers.ts   API: login, upload (single + multipart), finalize, download, delete
  secrets.ts     API: create, reveal and delete encrypted secrets
  links.ts       API: create, read and delete encrypted lists of links
  storage.ts     R2 layout, manifests, secrets, links, usage, cleanup
  auth.ts        passphrase check + signed session cookie
  util.ts        ids, file names, ranges, small helpers
client/        Browser code (TypeScript, compiled to public/js by `tsc`, no framework)
  crypto.ts      AES-GCM encryption for secrets and links (also used by the tests)
  urls.ts        parses pasted links and flags misleading ones (also used by the tests)
  linkview.ts    one row in a list of links, for the sender and the recipient
public/        HTML, CSS, icons (served as static assets)
test/          Unit tests (Node's built-in test runner)
scripts/       smoke.ts: end-to-end test against a running server
```

Dependencies: only `wrangler` and `typescript` (dev).

## Local development

Requires Node 22+ and pnpm.

```bash
pnpm install --ignore-scripts
```

```bash
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` to set a local passphrase (12+ characters) and session secret (32+ characters). Then:

```bash
pnpm dev
```

Open http://localhost:8787. Local R2 storage lives in `.wrangler/state` (gitignored).

```bash
pnpm test
```

```bash
pnpm smoke
```

`pnpm smoke` runs the end-to-end test against `pnpm dev` (set `BASE_URL` to test another URL). `pnpm typecheck` type-checks the Worker and the client.

The cron doesn't run automatically in dev. Trigger it with:

```bash
curl "http://localhost:8787/cdn-cgi/local/scheduled"
```

> **Note:** in a synced folder (OneDrive, Dropbox), Wrangler's file watcher sometimes misses changes. If an edit doesn't show up, stop and restart `pnpm dev`.

## Deploy your own

You need a Cloudflare account (the free plan is enough) with R2 enabled. Afterwards the app runs at `https://ftransfer.<your-subdomain>.workers.dev`; you can add your own domain later.

### With the Deploy to Cloudflare button

1. Click the button at the top. Cloudflare copies this repository to your GitHub or GitLab account, creates the R2 bucket, and deploys every push to your copy automatically (Workers Builds).
2. When it asks for `UPLOAD_PASSWORD` and `SESSION_SECRET`, enter your own values (see step 5 below). Values starting with `change-me` are refused, and the upload page stays locked until both are set properly.
3. Open the `workers.dev` address it shows, sign in, and send yourself a file.
4. Recommended: add the safety-net lifecycle rules (step 3 below) and, if you like, [your own domain](#your-own-domain).

### By hand with Wrangler

Clone the repository and install the dependencies first (see [Local development](#local-development)).

**1. Log in.**

```bash
pnpm exec wrangler login
```

**2. Create the private bucket.**

```bash
pnpm exec wrangler r2 bucket create ftransfer
```

**3. Add the safety-net lifecycle rules.** These delete leftover files and links after 32 days and leftover secrets after 8 days, and abort stale multipart uploads after 1 day. The hourly cron already deletes everything on time; these rules only catch what it might miss. If your bucket has another name, use that instead of `ftransfer`.

```bash
pnpm exec wrangler r2 bucket lifecycle add ftransfer expire-files files/ --expire-days 32 --force
```

```bash
pnpm exec wrangler r2 bucket lifecycle add ftransfer expire-manifests manifests/ --expire-days 32 --force
```

```bash
pnpm exec wrangler r2 bucket lifecycle add ftransfer abort-uploads files/ --abort-multipart-days 1 --force
```

```bash
pnpm exec wrangler r2 bucket lifecycle add ftransfer expire-secrets secrets/ --expire-days 8 --force
```

```bash
pnpm exec wrangler r2 bucket lifecycle add ftransfer expire-links links/ --expire-days 32 --force
```

If the bucket already exists from an earlier version, run only the commands for rules it doesn't have yet (`pnpm exec wrangler r2 bucket lifecycle list ftransfer` shows them).

**4. Deploy.** This builds the client and deploys the Worker to its `workers.dev` address.

```bash
pnpm run deploy
```

**5. Set the secrets.** Wrangler prompts for each value, so it never lands in your shell history. Until both are set, the upload page says it isn't configured. Nothing is exposed in the meantime.

- **UPLOAD_PASSWORD**: a passphrase you can share with people you trust. Use 4–5 random words; at least 12 characters.
- **SESSION_SECRET**: a random string of at least 32 characters, for example from `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.

```bash
pnpm exec wrangler secret put UPLOAD_PASSWORD
```

```bash
pnpm exec wrangler secret put SESSION_SECRET
```

**6. Test it.** Open your Worker's address, sign in, send yourself a file, and open the link in a private window. Optionally run the end-to-end test against it. It creates a small transfer (~67 MB) and a few test secrets and link shares, and deletes them again. The command uses Git Bash syntax:

```bash
BASE_URL=https://transfer.example.com UPLOAD_PASSWORD='your passphrase' pnpm smoke
```

After that, `pnpm run deploy` is all you need for updates.

### Your own domain

The domain has to be a zone in the same Cloudflare account. Deploying with `--domain` attaches it as a custom domain and creates its DNS record and certificate. It fails if a DNS record with that name already exists: remove that record first.

```bash
pnpm exec wrangler deploy --domain transfer.example.com
```

Pass `--domain` on every deploy. With Workers Builds (the Deploy button), set the deploy command in your Worker's settings, under **Build**, to `npx wrangler deploy --domain transfer.example.com`. Alternatively, add the domain to `routes` in `wrangler.jsonc` in your own copy (the comment there shows how). To stop serving the `workers.dev` address once your domain works, set `"workers_dev": false`.

## Configuration

Set in `wrangler.jsonc` → `vars` and redeploy:

| Variable | Default | Meaning |
|---|---|---|
| `MAX_TOTAL_BYTES` | `9500000000` | Cap on all active transfers together (decimal bytes) |
| `MAX_FILES` | `200` | Files per transfer |
| `EXPIRY_DAYS` | `1,3,7,14,30` | Options in the "Delete after" dropdown |
| `DEFAULT_EXPIRY_DAYS` | `7` | Preselected option |
| `SECRET_EXPIRY_HOURS` | `1,24,168` | Options for secrets, in hours. Values above 168 (7 days) are ignored, so the 8-day lifecycle rule always covers them |
| `DEFAULT_SECRET_EXPIRY_HOURS` | `24` | Preselected option for secrets |
| `LINK_EXPIRY_DAYS` | `1,7,30` | Options for links, in days. Values above 30 are ignored, so the 32-day lifecycle rule always covers them |
| `DEFAULT_LINK_EXPIRY_DAYS` | `7` | Preselected option for links |

If you add file options above 30 days, raise the 32-day lifecycle rules too. Secrets are limited to 10,000 characters. A link share holds at most 50 links and 20,000 characters.

**Signing everyone out:** change `UPLOAD_PASSWORD` (or `SESSION_SECRET`) with `wrangler secret put`. All existing sessions become invalid immediately.

**Logs:** Workers Logs is enabled. Look in the dashboard under Workers → ftransfer → Logs. Share IDs aren't logged on purpose.

## Known limitations and trade-offs

These were deliberate choices or shortcuts for a personal tool. Revisit them if usage grows.

- **Anyone with the link can delete** (product decision). A forwarded link also lets the new holder delete the files, the links, or a secret that isn't one-time.
- **The link is the key.** Anyone who gets it can download until it expires or is deleted. There's no per-recipient password. For secrets and links, the link literally holds the decryption key, so send the whole link through a channel you trust.
- **Lookalike detection is deliberately simple.** Any non-ASCII domain gets a warning; there's no full Unicode confusables check (that needs a large data table or a dependency). Real international domains are flagged too, and a lookalike made only of ASCII (`rnicrosoft.com`) isn't caught.
- **Files are not end-to-end encrypted** (secrets are). R2 encrypts at rest, but Cloudflare (and anyone with access to the account) could technically read files. Client-side encryption for files could be added later.
- **The length of a secret is visible to the server.** The ciphertext is about as long as the text, so the server can tell a short password from a long note, but not what it says.
- **No virus or malware scanning** of uploaded files.
- **The storage cap check isn't atomic.** Two uploads started at the same moment could together exceed the cap slightly. This is irrelevant for one or two users.
- **Login throttling is approximate.** Cloudflare counts per data-center location. The real protection is a long passphrase.
- **Free-plan CPU limit (10 ms per request).** Upload parts are streamed straight into R2, which uses very little CPU. This was verified locally, not yet in production. If uploads fail with errors 1102 or 503 in production, check Workers Logs. The fix is Workers Paid ($5/month) or switching to presigned direct-to-R2 uploads.
- **"Download all" starts separate downloads** rather than one ZIP, because zipping inside a Worker would hit the CPU limit. Browsers may ask once to allow multiple downloads.
- **Folders can't be dropped.** Zip them first; the UI says so.
- **Keep the tab open** while uploading. Leaving the page asks for confirmation. An interrupted upload has to be restarted; it is cleaned up automatically.

## License

[MIT](LICENSE)
