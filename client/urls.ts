// Parses pasted links for the Links tab and flags addresses that may not go where they seem to.
//
// Used on both ends. The sender sees exactly what will be shared, and the recipient's browser checks
// every link again before showing it: the server only stores ciphertext, so it can't check anything.
// Links are kept exactly as pasted (nothing is trimmed or rewritten); the browser's own URL parser
// decides where a link really goes, and that's what both sides show.
//
// No imports and no DOM, so the unit tests can load this file directly in Node.

export type LinkWarning = "unusual-characters" | "hidden-characters" | "login-part" | "trailing-separator";

export interface Link {
  ok: true;
  /** Exactly as pasted. This is what gets shared. */
  text: string;
  /** What the browser opens: parsed and normalised, always plain ASCII (xn-- domains, %-encoded path). */
  href: string;
  /** Domain (and port) the link really goes to. */
  host: string;
  warnings: LinkWarning[];
}

export interface NotALink {
  ok: false;
  text: string;
  reason: string;
}

export type Parsed = Link | NotALink;

/** A scheme such as "mailto:" or "javascript:", but not a host with a port ("localhost:3000"). */
const SCHEME = /^([a-z][a-z0-9+.-]*):(?!\d+(?:[/?#]|$))/i;
const HTTP = /^https?:/i;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** Invisible characters, and characters that change the reading direction of the text around them. */
const HIDDEN = /[­͏؜ᅟᅠ᠎​-‏‪-‮⁠-⁤⁦-⁩ㅤﾠ]/;
/** Something like example.com or www.example.co.uk, for links pasted without http(s)://. */
const BARE_HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})\.?$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export function splitLinks(input: string): string[] {
  return input.split(/\s+/).filter((s) => s !== "");
}

export function parseLink(text: string): Parsed {
  const fail = (reason: string): NotALink => ({ ok: false, text, reason });
  if (CONTROL.test(text)) return fail("It contains control characters.");

  const bare = !HTTP.test(text);
  if (bare) {
    const scheme = SCHEME.exec(text)?.[1];
    // "example.com:8080" also looks like a scheme; a real scheme has no dot in it.
    if (scheme !== undefined && !scheme.includes(".")) return fail(`Only http and https links are allowed, not “${scheme}:”.`);
    if (/^[^/?#]*@/.test(text)) return fail("It looks like an email address.");
  }

  let url: URL;
  try {
    url = new URL(bare ? `https://${text}` : text);
  } catch {
    return fail("It isn't a valid web address.");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "") {
    return fail("It isn't a valid web address.");
  }
  if (bare && !BARE_HOST.test(url.hostname) && !IPV4.test(url.hostname)) return fail("It isn't a web address.");

  const warnings: LinkWarning[] = [];
  // The browser turns a domain with non-ASCII characters into xn-- form, lookalikes included.
  if (url.hostname.split(".").some((label) => label.startsWith("xn--"))) warnings.push("unusual-characters");
  if (HIDDEN.test(text)) warnings.push("hidden-characters");
  if (url.username !== "" || url.password !== "") warnings.push("login-part");
  if (/[,;]$/.test(text)) warnings.push("trailing-separator");

  return { ok: true, text, href: url.href, host: url.host, warnings };
}

/** Splits on whitespace and parses each piece. A link that's already in the list (same href) is skipped. */
export function parseLinks(input: string): Parsed[] {
  const seen = new Set<string>();
  return splitLinks(input).map((text): Parsed => {
    const parsed = parseLink(text);
    if (!parsed.ok) return parsed;
    if (seen.has(parsed.href)) return { ok: false, text, reason: "It's already in the list." };
    seen.add(parsed.href);
    return parsed;
  });
}

/** Whether to show the link as it was pasted next to where it really goes. */
export function showsPastedText(link: Link): boolean {
  return link.warnings.includes("unusual-characters") || link.warnings.includes("hidden-characters");
}

export function warningMessage(warning: LinkWarning, link: Link, audience: "sender" | "recipient"): string {
  switch (warning) {
    case "unusual-characters":
      return audience === "sender"
        ? `The address uses unusual characters, which can imitate normal letters. It goes to ${link.host}. Check that this is the site you mean.`
        : `The address uses unusual characters, which can imitate normal letters. It goes to ${link.host}, which may not be the site it looks like.`;
    case "hidden-characters":
      return "It contains hidden characters (invisible, or ones that change the reading direction), so it may not read the way it really is.";
    case "login-part":
      return `The part before “@” is a login name, not the website. This link goes to ${link.host}.`;
    case "trailing-separator": {
      const last = link.text.slice(-1);
      return audience === "sender"
        ? `It ends with “${last}”. If that was meant to separate links, remove it: only spaces and new lines do.`
        : `It ends with “${last}”. If the link doesn't work, try it without.`;
    }
  }
}

// ---------------------------------------------------------------------------
// What gets encrypted: the text of each link, exactly as the sender saw it in the list.

export function encodeLinks(texts: readonly string[]): string {
  return JSON.stringify({ v: 1, links: texts });
}

export function decodeLinks(json: string): string[] | null {
  try {
    const data: unknown = JSON.parse(json);
    if (typeof data !== "object" || data === null || !("v" in data) || data.v !== 1 || !("links" in data)) return null;
    const links = data.links;
    return Array.isArray(links) && links.every((s) => typeof s === "string") ? links : null;
  } catch {
    return null;
  }
}
