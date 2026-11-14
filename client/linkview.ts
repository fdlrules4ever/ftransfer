// One row in a list of links, shared by the Links tab (sender) and the links page (recipient).
// Always shows the real destination: the domain as the browser sees it, then the full address.

import { h, icon } from "./common.js";
import { showsPastedText, warningMessage, type Parsed } from "./urls.js";

export type Audience = "sender" | "recipient";

/**
 * On the recipient's side, the domain and address are one link that opens in a new tab, and
 * `actions` (e.g. a copy button) go at the end of the row.
 */
export function linkRow(parsed: Parsed, audience: Audience, actions: Node[] = []): HTMLLIElement {
  if (!parsed.ok) {
    const reason = audience === "sender" ? `Won't be shared. ${parsed.reason}` : `Can't be opened. ${parsed.reason}`;
    return h(
      "li",
      { class: "link-row rejected" },
      h("span", { class: "link-icon", "aria-hidden": "true" }, icon("x", 18)),
      h("div", { class: "link-main" }, h("bdi", { class: "link-href" }, parsed.text), h("div", { class: "link-reason" }, reason)),
    );
  }

  const warned = parsed.warnings.length > 0;
  const target: (Node | string)[] = [
    h("div", { class: "link-host" }, parsed.host),
    h("div", { class: "link-href", title: parsed.href }, parsed.href),
  ];
  const main = h(
    "div",
    { class: "link-main" },
    audience === "recipient"
      ? // Built as a DOM property, never as HTML; the href is the browser's own parse of the link.
        Object.assign(h("a", { class: "link-open", target: "_blank", rel: "noopener noreferrer" }, ...target), { href: parsed.href })
      : h("div", {}, ...target),
  );
  if (showsPastedText(parsed)) {
    main.append(h("div", { class: "link-looks" }, audience === "sender" ? "Pasted as " : "Sent as ", h("bdi", {}, parsed.text)));
  }
  if (warned) {
    main.append(h("ul", { class: "link-warnings" }, ...parsed.warnings.map((w) => h("li", {}, warningMessage(w, parsed, audience)))));
  }
  return h(
    "li",
    { class: warned ? "link-row warn" : "link-row" },
    h("span", { class: "link-icon", "aria-hidden": "true" }, icon(warned ? "warning" : "link", 18)),
    main,
    ...actions,
  );
}
