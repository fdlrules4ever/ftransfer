import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeLinks, encodeLinks, parseLink, parseLinks, splitLinks, type Link, type Parsed } from "../client/urls.ts";

function ok(p: Parsed): Link {
  assert.ok(p.ok, `expected a link, got: ${p.ok ? "" : p.reason}`);
  return p;
}

test("only whitespace separates links: spaces, tabs, new lines and Unicode spaces", () => {
  assert.deepEqual(splitLinks("  https://a.com\thttps://b.com\r\nhttps://c.com https://d.com　x  "), [
    "https://a.com",
    "https://b.com",
    "https://c.com",
    "https://d.com",
    "x",
  ]);
  // Commas and semicolons are part of the link: they're valid in URLs.
  assert.deepEqual(splitLinks("https://a.com,https://b.com"), ["https://a.com,https://b.com"]);
  assert.deepEqual(splitLinks(" \n\t"), []);
});

test("http and https links are kept exactly as pasted, trailing characters included", () => {
  for (const text of [
    "https://en.wikipedia.org/wiki/Apple_Inc.",
    "https://en.wikipedia.org/wiki/Mercury_(planet)",
    "https://www.google.com/maps/@52.3676,4.9041,15z",
    "https://example.com/a;jsessionid=123?ids=1,2#top",
    "HTTP://EXAMPLE.COM/Path",
  ]) {
    const link = ok(parseLink(text));
    assert.equal(link.text, text);
    assert.deepEqual(link.warnings, []);
  }
  const wiki = ok(parseLink("https://en.wikipedia.org/wiki/Apple_Inc."));
  assert.equal(wiki.href, "https://en.wikipedia.org/wiki/Apple_Inc.");
  assert.equal(wiki.host, "en.wikipedia.org");
  assert.equal(ok(parseLink("HTTP://EXAMPLE.COM/Path")).href, "http://example.com/Path");
});

test("links without http(s):// get https://, but only when they look like a web address", () => {
  assert.equal(ok(parseLink("example.com")).href, "https://example.com/");
  assert.equal(ok(parseLink("www.example.co.uk/a?b=c")).href, "https://www.example.co.uk/a?b=c");
  assert.equal(ok(parseLink("example.com:8080/x")).host, "example.com:8080");
  assert.equal(ok(parseLink("192.168.1.10:8080/admin")).host, "192.168.1.10:8080");
  for (const text of ["hello", "and/or", "e.g.", "v1.2", "localhost:3000", "-", "..."]) {
    assert.equal(parseLink(text).ok, false, text);
  }
});

test("other schemes and email addresses are refused", () => {
  for (const text of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "mailto:someone@example.com",
    "ftp://example.com/file",
    "tel:+31201234567",
    "someone@example.com",
  ]) {
    assert.equal(parseLink(text).ok, false, text);
  }
});

test("lookalike domains are flagged and shown in their real xn-- form", () => {
  const cyrillicA = ok(parseLink("https://аpple.com/login")); // Cyrillic а + Latin
  assert.equal(cyrillicA.host, "xn--pple-43d.com");
  assert.deepEqual(cyrillicA.warnings, ["unusual-characters"]);

  const allCyrillic = ok(parseLink("https://аррӏе.com"));
  assert.equal(allCyrillic.host, "xn--80ak6aa92e.com");
  assert.ok(allCyrillic.warnings.includes("unusual-characters"));

  // A fraction slash looks like "/", but it's part of the domain: this really goes to evil.com.
  const slash = ok(parseLink("https://google.com⁄login.evil.com"));
  assert.ok(slash.host.endsWith(".evil.com"));
  assert.ok(slash.warnings.includes("unusual-characters"));

  // Bare too.
  assert.ok(ok(parseLink("аpple.com")).warnings.includes("unusual-characters"));
  // Real international domains are flagged as well; that's the trade-off.
  assert.ok(ok(parseLink("https://münchen.de")).warnings.includes("unusual-characters"));
});

test("full-width letters are normalised to the real domain without a warning", () => {
  const link = ok(parseLink("https://ｇｏｏｇｌｅ.com"));
  assert.equal(link.host, "google.com");
  assert.deepEqual(link.warnings, []);
});

test("a login part before @ is flagged and the real domain is shown", () => {
  const link = ok(parseLink("https://google.com@evil.com/login"));
  assert.equal(link.host, "evil.com");
  assert.deepEqual(link.warnings, ["login-part"]);
  assert.ok(ok(parseLink("https://user:pass@example.com")).warnings.includes("login-part"));
});

test("hidden characters are flagged; the href shows them %-encoded", () => {
  const rtl = ok(parseLink("https://example.com/files/‮gpj.exe"));
  assert.deepEqual(rtl.warnings, ["hidden-characters"]);
  assert.equal(rtl.href, "https://example.com/files/%E2%80%AEgpj.exe");

  const zws = ok(parseLink("https://goo​gle.com"));
  assert.equal(zws.host, "google.com"); // the browser drops it, so this one is harmless
  assert.ok(zws.warnings.includes("hidden-characters"));

  assert.equal(parseLink("https://goo‍gle.com").ok, false); // zero-width joiner: rejected by the URL parser
  assert.equal(parseLink("https://example.com/\u0007").ok, false); // control character
});

test("a trailing comma or semicolon is kept but flagged", () => {
  const comma = ok(parseLink("https://a.com,"));
  assert.equal(comma.text, "https://a.com,");
  assert.deepEqual(comma.warnings, ["trailing-separator"]);
  assert.deepEqual(ok(parseLink("https://a.com/x;")).warnings, ["trailing-separator"]);
  assert.deepEqual(ok(parseLink("https://a.com/x.")).warnings, []);
});

test("non-ASCII paths are fine: no warning, %-encoded href", () => {
  const link = ok(parseLink("https://de.wikipedia.org/wiki/Straße"));
  assert.deepEqual(link.warnings, []);
  assert.equal(link.href, "https://de.wikipedia.org/wiki/Stra%C3%9Fe");
});

test("parseLinks keeps the order, marks non-links and skips duplicates", () => {
  const result = parseLinks("https://a.com  nope\nexample.com https://a.com/ https://b.com");
  assert.deepEqual(
    result.map((p) => (p.ok ? p.href : `✘ ${p.text}`)),
    ["https://a.com/", "✘ nope", "https://example.com/", "✘ https://a.com/", "https://b.com/"],
  );
});

test("the encrypted payload round-trips and rejects anything else", () => {
  const texts = ["https://a.com", "https://аpple.com", 'https://x.com/"q"\\'];
  assert.deepEqual(decodeLinks(encodeLinks(texts)), texts);
  for (const bad of ["", "null", "[]", '{"v":2,"links":[]}', '{"v":1}', '{"v":1,"links":[1]}', '{"v":1,"links":"x"}']) {
    assert.equal(decodeLinks(bad), null, bad);
  }
});
