// Page outline: a cheap, whole-page map of the regions a sighted person takes in at a glance.
//
// Unlike captureVisibleContent (first 20 blocks in document order), the outline covers the whole
// document. Each region carries layout evidence (position, size, heading size) and noise signals
// (ad frames, sponsored labels, cookie banners, link farms) so the server and model can decide
// what matters for the user's goal, then read only those regions in full with readRegion().
// Read-only: nothing here changes the page.
import { classifyAction, classifyBrowserLink } from "@blip/policy/classify";
import { isVisible } from "./visibility.js";

export type OutlineRegionKind =
  | "main" | "navigation" | "banner" | "contentinfo" | "complementary" | "search" | "form"
  | "dialog" | "alert" | "section" | "iframe" | "overlay" | "list";

export type OutlineNoiseSignal =
  | "ad-frame" | "ad-marker" | "sponsored" | "cookie-banner" | "fixed-overlay" | "link-farm" | "offscreen"
  | "pagination" | "link-row";

export type OutlineRegion = {
  id: string;
  kind: OutlineRegionKind;
  /** Accessible label, heading text, or a short derived name. */
  label: string;
  /** Heading level 1-6 for heading sections; 0 otherwise. */
  level: number;
  /** Id of the enclosing region, or null for top-level regions. */
  parentId: string | null;
  /** Page coordinates (CSS pixels, scroll-independent) and size. */
  rect: { x: number; y: number; w: number; h: number };
  /** Fraction of the initial viewport this region covers (0-1). */
  viewportShare: number;
  /** Rendered font size of the region's heading in CSS pixels; 0 when there is none. */
  headingPx: number;
  textChars: number;
  links: number;
  buttons: number;
  fields: number;
  images: number;
  noise: OutlineNoiseSignal[];
  /** First characters of the region's visible text. */
  preview: string;
  /** For "list" regions: one entry per repeated card or row, in visual order. */
  items?: OutlineListItem[];
};

export type OutlineListItem = {
  id: string;
  /** The item's name: its heading, else its first link, else its first line of text. */
  label: string;
  preview: string;
};

export type PageSteps = {
  next: RegionControlsResult["controls"][number] | null;
  previous: RegionControlsResult["controls"][number] | null;
  more: RegionControlsResult["controls"][number] | null;
};

export type PageOutline = {
  title: string;
  /** Next/previous page links and a "load more" button, found by rel= attributes and common labels. */
  steps: PageSteps;
  viewport: { w: number; h: number; scrollY: number };
  pageHeight: number;
  regions: OutlineRegion[];
  truncated: boolean;
};

const MAX_REGIONS = 300;
const PREVIEW_CHARS = 200;
const MAX_READ_CHARS = 20_000;
const MAX_LIST_ITEMS = 100;
const MIN_LIST_ITEMS = 5;

const LANDMARK_SELECTOR = [
  "main", "[role=main]", "nav", "[role=navigation]", "header", "[role=banner]", "footer", "[role=contentinfo]",
  "aside", "[role=complementary]", "[role=search]", "search", "form", "[role=form]", "dialog", "[role=dialog]",
  "[role=alertdialog]", "[role=alert]", "[role=region][aria-label]", "[role=region][aria-labelledby]",
  "section[aria-label]", "section[aria-labelledby]", "iframe",
].join(",");

const HEADING_SELECTOR = "h1,h2,h3,h4,[role=heading]";

/** Known advertising and tracking hosts, matched against iframe src hosts. */
const AD_HOST = /(^|\.)(doubleclick\.net|googlesyndication\.com|googleadservices\.com|adservice\.google\.[a-z.]+|googletagservices\.com|amazon-adsystem\.com|adnxs\.com|taboola\.com|outbrain\.com|criteo\.(com|net)|pubmatic\.com|rubiconproject\.com|moatads\.com|adform\.net|openx\.net|casalemedia\.com|smartadserver\.com|teads\.tv|media\.net|yieldmo\.com|sharethrough\.com|33across\.com|indexww\.com|lijit\.com|carbonads\.(net|com)|buysellads\.com)$/i;
/** Ad container naming conventions in id/class attributes. Word-bounded so "header" or "add" never match. */
const AD_NAME = /(^|[\s_-])(ad|ads|advert|adverts|advertisement|adslot|ad-slot|adunit|ad-unit|ad-container|adwrapper|dfp|gpt-ad|banner-ad|sponsor|sponsored|promoted)([\s_-]|\d|$)/i;
const SPONSORED_TEXT = /^\s*(advertisement|sponsored|promoted|ad|ads|paid partnership|sponsored content)\s*$/i;
const PAGE_LINK = /^\s*(\d{1,5}|next|previous|prev|first|last|older|newer|«|»|‹|›|…|\.\.\.)\s*$/i;
const COOKIE_TEXT = /\b(cookie|cookies|consent|gdpr)\b/i;

let nextRegionNumber = 0;
const regionsByDocument = new WeakMap<Document, Map<string, Element>>();

function textOf(element: Element, max: number): string {
  const raw = (element as HTMLElement).innerText ?? element.textContent ?? "";
  return raw.replace(/\s+/g, " ").trim().slice(0, max);
}

function fullTextLength(element: Element): number {
  const raw = (element as HTMLElement).innerText ?? element.textContent ?? "";
  return raw.replace(/\s+/g, " ").trim().length;
}

function labelOf(element: Element, document: Document): string {
  const aria = element.getAttribute("aria-label")?.trim();
  if (aria) return aria.slice(0, 120);
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").replace(/\s+/g, " ").trim();
    if (text) return text.slice(0, 120);
  }
  if (element.localName === "iframe") {
    const title = element.getAttribute("title")?.trim();
    if (title) return title.slice(0, 120);
  }
  const heading = element.querySelector(HEADING_SELECTOR);
  if (heading) {
    const text = textOf(heading, 120);
    if (text) return text;
  }
  return "";
}

function kindOf(element: Element): OutlineRegionKind | null {
  const role = element.getAttribute("role")?.toLowerCase();
  const tag = element.localName;
  if (role === "main" || tag === "main") return "main";
  if (role === "navigation" || tag === "nav") return "navigation";
  if (role === "search" || tag === "search") return "search";
  if (role === "dialog" || role === "alertdialog" || tag === "dialog") return "dialog";
  if (role === "alert") return "alert";
  if (role === "form" || tag === "form") return "form";
  if (tag === "iframe") return "iframe";
  if (role === "complementary" || tag === "aside") return "complementary";
  // header/footer are landmarks only when not inside article/section/main (HTML-AAM).
  if (role === "banner" || (tag === "header" && !element.parentElement?.closest("article,section,main,aside,nav"))) return "banner";
  if (role === "contentinfo" || (tag === "footer" && !element.parentElement?.closest("article,section,main,aside,nav"))) return "contentinfo";
  if (role === "region" || tag === "section") return "section";
  return null;
}

function headingLevel(element: Element): number {
  const match = /^h([1-6])$/.exec(element.localName);
  if (match) return Number(match[1]);
  const aria = Number(element.getAttribute("aria-level"));
  return Number.isInteger(aria) && aria >= 1 && aria <= 6 ? aria : 2;
}

function iframeHost(element: Element, document: Document): string {
  const src = element.getAttribute("src");
  if (!src) return "";
  try { return new URL(src, document.baseURI).hostname; } catch { return ""; }
}

function noiseSignals(element: Element, kind: OutlineRegionKind, rect: DOMRect, view: Window, document: Document, counts: { links: number; textChars: number; linkChars: number }): OutlineNoiseSignal[] {
  const signals: OutlineNoiseSignal[] = [];
  if (kind === "iframe") {
    const host = iframeHost(element, document);
    if (host && AD_HOST.test(host)) signals.push("ad-frame");
  }
  const names = `${element.id} ${typeof (element as HTMLElement).className === "string" ? (element as HTMLElement).className : ""}`;
  if (AD_NAME.test(names) || element.hasAttribute("data-ad-slot") || element.hasAttribute("data-google-query-id")) signals.push("ad-marker");
  const ariaLabel = element.getAttribute("aria-label") ?? "";
  const firstLine = textOf(element, 40);
  if (SPONSORED_TEXT.test(ariaLabel) || SPONSORED_TEXT.test(firstLine.split(/[.\n]/)[0] ?? "")) signals.push("sponsored");
  const style = view.getComputedStyle(element);
  const fixed = style.position === "fixed" || style.position === "sticky";
  if (fixed && kind !== "banner" && kind !== "navigation") signals.push("fixed-overlay");
  if (fixed && COOKIE_TEXT.test(textOf(element, 600))) signals.push("cookie-banner");
  if (counts.links >= 8 && counts.textChars > 0 && counts.linkChars / counts.textChars > 0.8) signals.push("link-farm");
  if (rect.width === 0 || rect.height === 0) signals.push("offscreen");
  return signals;
}

function countsFor(element: Element): { links: number; buttons: number; fields: number; images: number; linkChars: number } {
  const links = element.querySelectorAll("a[href]");
  let linkChars = 0;
  for (const link of links) linkChars += textOf(link, 400).length;
  return {
    links: links.length,
    buttons: element.querySelectorAll("button,[role=button],input[type=submit],input[type=button],input[type=reset]").length,
    fields: element.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]),select,textarea,[role=combobox],[role=textbox],[role=listbox],[role=checkbox],[role=radio],[role=switch],[role=spinbutton],[role=slider]").length,
    images: element.querySelectorAll("img,svg[role=img],[role=img]").length,
    linkChars,
  };
}

/** Name a list from its own label, else the closest visible heading before it. */
function listLabel(container: Element, document: Document): string {
  const own = container.getAttribute("aria-label")?.trim();
  if (own) return own.slice(0, 120);
  const labelledBy = container.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").replace(/\s+/g, " ").trim();
    if (text) return text.slice(0, 120);
  }
  let before: Element | null = null;
  for (const heading of document.querySelectorAll(HEADING_SELECTOR)) {
    if (heading.compareDocumentPosition(container) & 4 /* FOLLOWING */) {
      if (!heading.contains(container) && isVisible(heading)) before = heading;
    } else break;
  }
  if (before === null) return "";
  // Only when the list lives inside the heading's own section (not a footer far below it).
  const root = before.closest("main,[role=main]") ?? document.body ?? before;
  return sectionContainer(before, root).contains(container) ? textOf(before, 120) : "";
}

function itemLabel(card: Element): string {
  const heading = card.querySelector("h1,h2,h3,h4,h5,h6,[role=heading]");
  const fromHeading = heading ? textOf(heading, 120) : "";
  if (fromHeading) return fromHeading;
  const link = card.localName === "a" ? card : card.querySelector("a[href]");
  const fromLink = link ? textOf(link, 120) : "";
  if (fromLink) return fromLink;
  return (textOf(card, 120).split(/(?<=[.!?])\s/)[0] ?? "").slice(0, 120);
}

/**
 * The container a heading's section belongs to: climb from the heading until an ancestor holds
 * meaningfully more text than the heading itself (the column, card, or article it introduces).
 */
function sectionContainer(heading: Element, root: Element): Element {
  const own = textOf(heading, 400).length;
  let current: Element = heading;
  while (current.parentElement && current.parentElement !== root) {
    current = current.parentElement;
    if (fullTextLength(current) > own + 200) return current;
  }
  return root;
}

function nextId(): string {
  nextRegionNumber += 1;
  return `r${nextRegionNumber}`;
}

/**
 * Build the outline. Landmarks and iframes become regions; inside each main-like container, every
 * h1-h4 starts a heading section that runs until the next heading of the same or higher level.
 */
export function buildOutline(document: Document): PageOutline {
  const view = document.defaultView!;
  const viewportW = view.innerWidth || 1;
  const viewportH = view.innerHeight || 1;
  const scrollX = view.scrollX;
  const scrollY = view.scrollY;
  const map = new Map<string, Element>();
  regionsByDocument.set(document, map);
  sectionEnds.clear();
  sectionColumns.clear();
  controlsByDocument.delete(document);
  const regions: OutlineRegion[] = [];
  const idByElement = new Map<Element, string>();
  let truncated = false;

  function add(element: Element, kind: OutlineRegionKind, label: string, level: number, headingEl: Element | null, rectOverride?: DOMRect): string | null {
    if (regions.length >= MAX_REGIONS) { truncated = true; return null; }
    const rect = rectOverride ?? element.getBoundingClientRect();
    const textChars = fullTextLength(element);
    const counts = countsFor(element);
    const id = nextId();
    map.set(id, element);
    idByElement.set(element, id);
    const visibleTop = Math.max(rect.top, 0);
    const visibleBottom = Math.min(rect.bottom, viewportH);
    const visibleLeft = Math.max(rect.left, 0);
    const visibleRight = Math.min(rect.right, viewportW);
    const share = visibleBottom > visibleTop && visibleRight > visibleLeft
      ? ((visibleBottom - visibleTop) * (visibleRight - visibleLeft)) / (viewportW * viewportH) : 0;
    let parent: Element | null = element.parentElement;
    let parentId: string | null = null;
    while (parent && parentId === null) { parentId = idByElement.get(parent) ?? null; parent = parent.parentElement; }
    regions.push({
      id, kind, label, level, parentId,
      rect: { x: Math.round(rect.left + scrollX), y: Math.round(rect.top + scrollY), w: Math.round(rect.width), h: Math.round(rect.height) },
      viewportShare: Math.round(share * 1000) / 1000,
      headingPx: headingEl ? Math.round(parseFloat(view.getComputedStyle(headingEl).fontSize) || 0) : 0,
      textChars,
      links: counts.links, buttons: counts.buttons, fields: counts.fields, images: counts.images,
      noise: noiseSignals(element, kind, rect, view, document, { links: counts.links, textChars, linkChars: counts.linkChars }),
      preview: textOf(element, PREVIEW_CHARS),
    });
    return id;
  }

  // Landmarks and iframes, in document order so parents precede children.
  for (const element of document.body?.querySelectorAll(LANDMARK_SELECTOR) ?? []) {
    const kind = kindOf(element);
    if (kind === null) continue;
    if (kind !== "iframe" && !isVisible(element)) continue;
    add(element, kind, labelOf(element, document), 0, element.querySelector(HEADING_SELECTOR));
  }

  // Heading sections inside main content (or the whole body when the page has no main landmark).
  const containers = [...document.querySelectorAll("main,[role=main]")].filter((element) => isVisible(element));
  const roots = containers.length > 0 ? containers : document.body ? [document.body] : [];
  for (const root of roots) {
    const headings = [...root.querySelectorAll(HEADING_SELECTOR)].filter((heading) => isVisible(heading) && textOf(heading, 2) !== "");
    headings.forEach((heading, index) => {
      const level = headingLevel(heading);
      let end: Element | null = null;
      for (const later of headings.slice(index + 1)) {
        if (headingLevel(later) <= level) { end = later; break; }
      }
      // A section is a DOM range, not an element: measure it from heading to the next peer heading.
      const range = document.createRange();
      range.setStartBefore(heading);
      const column = sectionContainer(heading, root);
      if (end && column.contains(end)) range.setEndBefore(end);
      else range.setEndAfter(column.lastChild ?? heading);
      const rect = clampRect(range.getBoundingClientRect(), view);
      const fragmentHolder = document.createElement("div");
      fragmentHolder.appendChild(range.cloneContents());
      const id = add(heading, "section", textOf(heading, 120), level, heading, rect);
      if (id === null) return;
      const region = regions[regions.length - 1]!;
      // Counts and text describe the whole section range, not just the heading element.
      const counts = countsFor(fragmentHolder);
      const text = (fragmentHolder.textContent ?? "").replace(/\s+/g, " ").trim();
      region.textChars = text.length;
      region.links = counts.links; region.buttons = counts.buttons; region.fields = counts.fields; region.images = counts.images;
      region.preview = text.slice(0, PREVIEW_CHARS);
      region.noise = region.noise.filter((signal) => signal !== "fixed-overlay" && signal !== "cookie-banner");
      if (counts.links >= 8 && text.length > 0 && counts.linkChars / text.length > 0.8 && !region.noise.includes("link-farm")) region.noise.push("link-farm");
      sectionEnds.set(id, end && column.contains(end) ? end : null);
      sectionColumns.set(id, column);
    });
  }

  // Repeated cards or rows (search results, product grids, feeds, tables of apps): a container
  // whose children mostly share one tag+class signature and mostly contain a link.
  const listed = new Set<Element>();
  for (const container of document.body?.querySelectorAll("*") ?? []) {
    if (regions.length >= MAX_REGIONS) { truncated = true; break; }
    const tag = container.localName;
    if (tag === "select" || tag === "datalist" || tag === "svg" || tag === "head") continue;
    const children = [...container.children];
    if (children.length < MIN_LIST_ITEMS) continue;
    const bySignature = new Map<string, Element[]>();
    for (const child of children) {
      const signature = `${child.localName}.${[...child.classList].sort().join(".")}`;
      const group = bySignature.get(signature);
      if (group) group.push(child); else bySignature.set(signature, [child]);
    }
    let cards: Element[] = [];
    for (const group of bySignature.values()) if (group.length > cards.length) cards = group;
    if (cards.length < MIN_LIST_ITEMS) continue;
    const linked = cards.filter((card) => card.querySelector("a[href]") !== null || card.localName === "a").length;
    if (linked / cards.length < 0.6) continue;
    if (!isVisible(container)) continue;
    let ancestor = container.parentElement;
    let nested = false;
    while (ancestor) { if (listed.has(ancestor)) { nested = true; break; } ancestor = ancestor.parentElement; }
    if (nested) continue;
    const visibleCards = cards.filter((card) => isVisible(card) && textOf(card, 3).length >= 3);
    if (visibleCards.length < MIN_LIST_ITEMS) continue;
    listed.add(container);
    const id = add(container, "list", listLabel(container, document), 0, null);
    if (id === null) break;
    const region = regions[regions.length - 1]!;
    region.items = visibleCards.slice(0, MAX_LIST_ITEMS).map((card, index) => {
      const itemId = `${id}.${index + 1}`;
      map.set(itemId, card);
      return { id: itemId, label: itemLabel(card), preview: textOf(card, PREVIEW_CHARS) };
    });
    if (visibleCards.length > MAX_LIST_ITEMS) truncated = true;
    region.noise = region.noise.filter((signal) => signal !== "link-farm");
    const items = region.items;
    const pageLike = items.filter((item) => PAGE_LINK.test(item.label)).length;
    if (pageLike / items.length >= 0.7) {
      region.noise.push("pagination");
      region.label = "Page numbers";
    } else if (items.every((item) => item.label.length < 40 && item.preview === item.label)) {
      // Every item is just a short link with nothing else: a menu, footer, or tag row.
      region.noise.push("link-row");
    }
    if (region.label === "") {
      const pageHeight = document.documentElement.scrollHeight || 1;
      region.label = region.noise.includes("link-row")
        ? (region.rect.y > pageHeight * 0.8 ? "Footer links" : "Links")
        : "List";
    }
  }

  // A heading inside a list's card (each search result's title) is already one of that list's items:
  // drop its separate heading section so results aren't listed twice.
  const inCard = (region: OutlineRegion): boolean => {
    if (region.kind === "list" || region.kind === "iframe" || region.kind === "dialog" || region.kind === "alert") return false;
    const heading = map.get(region.id);
    if (!heading) return false;
    for (const container of listed) if (container.contains(heading) && container !== heading) return true;
    return false;
  };
  const kept = regions.filter((region) => !inCard(region));
  if (kept.length !== regions.length) {
    const dropped = new Set(regions.filter((region) => !kept.includes(region)).map((region) => region.id));
    for (const id of dropped) { map.delete(id); sectionEnds.delete(id); sectionColumns.delete(id); }
    regions.length = 0;
    regions.push(...kept);
  }

  return {
    title: document.title.slice(0, 200),
    steps: findPageSteps(document, new Set([...listed].filter((container) => {
      const region = regions.find((candidate) => map.get(candidate.id) === container);
      return region !== undefined && !region.noise.includes("pagination") && !region.noise.includes("link-row");
    }))),
    viewport: { w: Math.round(viewportW), h: Math.round(viewportH), scrollY: Math.round(scrollY) },
    pageHeight: Math.round(document.documentElement.scrollHeight),
    regions,
    truncated,
  };
}

/** For heading sections: the heading that ends the section (null = runs to the end of its column). */
const sectionEnds = new Map<string, Element | null>();
const sectionColumns = new Map<string, Element>();

/** Ranges that span hidden or absolutely positioned nodes can report huge widths; keep them on the page. */
function clampRect(rect: DOMRect, view: Window): DOMRect {
  const pageWidth = view.document.documentElement.scrollWidth || view.innerWidth;
  const left = Math.max(rect.left, -view.scrollX);
  const right = Math.min(rect.right, pageWidth - view.scrollX);
  return new DOMRect(left, rect.top, Math.max(0, right - left), rect.height);
}

/**
 * Text of a live DOM range: elements wholly inside the range contribute their layout-aware innerText
 * (which keeps block breaks and skips hidden text); partly covered elements are walked into.
 */
function liveRangeText(range: Range): string {
  const parts: string[] = [];
  const document = range.startContainer.ownerDocument ?? (range.startContainer as Document);
  const probe = document.createRange();
  const walk = (node: Node): void => {
    if (parts.length > 5000 || !range.intersectsNode(node)) return;
    if (node.nodeType === 3) {
      let value = node.nodeValue ?? "";
      if (node === range.endContainer) value = value.slice(0, range.endOffset);
      if (node === range.startContainer) value = value.slice(range.startOffset);
      if (value.trim()) parts.push(value);
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (element.localName === "script" || element.localName === "style" || element.localName === "noscript") return;
    probe.selectNode(element);
    const contained = range.compareBoundaryPoints(Range.START_TO_START, probe) <= 0 &&
      range.compareBoundaryPoints(Range.END_TO_END, probe) >= 0;
    if (contained) {
      const inner = (element as HTMLElement).innerText ?? element.textContent ?? "";
      if (inner.trim()) parts.push(inner);
      return;
    }
    for (const child of element.childNodes) walk(child);
  };
  walk(range.commonAncestorContainer);
  return parts.join("\n");
}

export type RegionReadResult = { id: string; label: string; text: string; truncated: boolean } | null;

/** Read the full visible text of one region from the latest outline of this document. */
export function readRegion(document: Document, regionId: string): RegionReadResult {
  const element = regionsByDocument.get(document)?.get(regionId);
  if (!element || !element.isConnected) return null;
  let text: string;
  if (sectionEnds.has(regionId)) {
    const range = document.createRange();
    range.setStartBefore(element);
    const end = sectionEnds.get(regionId);
    const column = sectionColumns.get(regionId) ?? element.closest("main,[role=main]") ?? document.body;
    if (end && end.isConnected) range.setEndBefore(end); else range.setEndAfter(column.lastChild ?? element);
    text = liveRangeText(range).replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  } else {
    text = ((element as HTMLElement).innerText ?? element.textContent ?? "").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  }
  const truncated = text.length > MAX_READ_CHARS;
  return { id: regionId, label: labelOf(element, document) || textOf(element, 120), text: text.slice(0, MAX_READ_CHARS), truncated };
}

// ---------------------------------------------------------------------------------------------
// Controls: the links and buttons inside one region, and acting on the user's choice.
//
// Links are never clicked. Activation re-validates the live anchor and returns its address; the
// extension background then navigates the tab there, so no page script runs. target=_blank is
// ignored on purpose (the desk always opens in the same tab). Downloads are refused.
// Buttons are classified with Blip's own policy: click-safe runs directly, pay/delete/send are
// refused, anything else needs the user's explicit yes. Blip's submit guard still blocks a form
// submission that a button click would trigger.

type ControlAccess = "direct" | "confirm" | "blocked";
type ControlEntry = { element: Element; kind: "link" | "button"; label: string; href: string | null; pageLink?: boolean };

const CONTROL_SELECTOR = "a[href],button,[role=button],[role=link],input[type=submit],input[type=button],input[type=reset],input[type=image],summary";
const MAX_CONTROLS = 200;
let nextControlNumber = 0;
const controlsByDocument = new WeakMap<Document, Map<string, ControlEntry>>();

function controlLabel(element: Element): string {
  const aria = element.getAttribute("aria-label")?.trim();
  if (aria) return aria.slice(0, 120);
  const text = textOf(element, 120);
  if (text) return text;
  const title = element.getAttribute("title")?.trim();
  if (title) return title.slice(0, 120);
  if (element.localName === "input") {
    const value = (element as HTMLInputElement).value?.trim() || element.getAttribute("alt")?.trim();
    if (value) return value.slice(0, 120);
  }
  const alt = element.querySelector("img[alt]")?.getAttribute("alt")?.trim();
  return alt ? alt.slice(0, 120) : "";
}

/** Links with a real web address are links; "#" and javascript: anchors behave like buttons. */
function controlKind(element: Element): { kind: "link" | "button"; href: string | null } {
  if (element.localName === "a" && element.hasAttribute("href")) {
    const raw = (element.getAttribute("href") ?? "").trim();
    const href = (element as HTMLAnchorElement).href;
    if (raw !== "" && !raw.startsWith("#") && /^https?:/i.test(href)) return { kind: "link", href };
  }
  return { kind: "button", href: null };
}

function hostOf(href: string | null): string | null {
  if (href === null) return null;
  try { return new URL(href).host.toLowerCase() || null; } catch { return null; }
}

function rateControl(element: Element, entry: { kind: "link" | "button"; label: string; href: string | null }, pageUrl: string): { access: ControlAccess; note: string } {
  if (entry.kind === "link") {
    if (element.hasAttribute("download")) return { access: "blocked", note: "download link" };
    const safety = classifyBrowserLink({ tag: "a", href: entry.href ?? "", target: "", origin: pageUrl, text: entry.label });
    if (safety === "same-origin-safe-get") return { access: "direct", note: "" };
    if (safety === "unsupported") return { access: "blocked", note: "this link can't be checked safely" };
    let pageHost = "";
    try { pageHost = new URL(pageUrl).host; } catch { /* keep empty */ }
    const host = hostOf(entry.href);
    return { access: "confirm", note: host && host !== pageHost ? `goes to ${host}` : "may change something" };
  }
  const tag = element.localName;
  const inForm = element.closest("form") !== null;
  const typeAttribute = element.getAttribute("type");
  // A <button> with no type only submits inside a form; elsewhere it is an ordinary button.
  const buttonType = tag === "button" ? (typeAttribute ?? (inForm ? "submit" : "button")) : undefined;
  const classified = classifyAction({
    tag: tag === "a" || tag === "summary" ? "button" : tag,
    role: element.getAttribute("role") ?? undefined,
    text: entry.label,
    buttonType: tag === "button" ? buttonType : tag === "a" || tag === "summary" || element.getAttribute("role") === "button" ? "button" : undefined,
    inputType: tag === "input" ? (element as HTMLInputElement).type : undefined,
    inForm,
  });
  if (classified.kind === "click-safe") return { access: "direct", note: "" };
  if (classified.kind === "pay") return { access: "blocked", note: "pays money; do this on the page for now" };
  if (classified.kind === "delete") return { access: "blocked", note: "deletes something; do this on the page for now" };
  if (classified.kind === "send") return { access: "blocked", note: "sends something; do this on the page for now" };
  return { access: "confirm", note: inForm ? "may submit a form" : "may change something" };
}

/** Elements belonging to a region: its element subtree, or for heading sections the heading's range. */
function regionScopeControls(document: Document, regionId: string): Element[] | null {
  const element = regionsByDocument.get(document)?.get(regionId);
  if (!element || !element.isConnected) return null;
  if (sectionEnds.has(regionId)) {
    const column = sectionColumns.get(regionId) ?? element.closest("main,[role=main]") ?? document.body;
    const range = document.createRange();
    range.setStartBefore(element);
    const end = sectionEnds.get(regionId);
    if (end && end.isConnected) range.setEndBefore(end); else range.setEndAfter(column.lastChild ?? element);
    return [...column.querySelectorAll(CONTROL_SELECTOR)].filter((candidate) => range.intersectsNode(candidate));
  }
  const inside = [...element.querySelectorAll(CONTROL_SELECTOR)];
  return element.matches(CONTROL_SELECTOR) ? [element, ...inside] : inside;
}

export type RegionControlsResult = {
  id: string;
  controls: Array<{ id: string; kind: "link" | "button"; label: string; host: string | null; access: ControlAccess; note: string }>;
  truncated: boolean;
};

export function regionControls(document: Document, regionId: string): RegionControlsResult | null {
  const elements = regionScopeControls(document, regionId);
  if (elements === null) return null;
  const pageUrl = document.location?.href ?? "";
  let map = controlsByDocument.get(document);
  if (!map) { map = new Map<string, ControlEntry>(); controlsByDocument.set(document, map); }
  if (map.size > 2000) map.clear();
  const controls: RegionControlsResult["controls"] = [];
  const seenLinks = new Map<string, number>();
  let truncated = false;
  for (const element of elements) {
    if (!isVisible(element) || element.closest("[aria-hidden=true],[hidden],[inert]")) continue;
    // Skip a control nested inside another control already listed (a button inside a link card).
    if (element.parentElement?.closest(CONTROL_SELECTOR) && elements.includes(element.parentElement.closest(CONTROL_SELECTOR)!)) continue;
    const { kind, href } = controlKind(element);
    const label = controlLabel(element);
    if (kind === "link" && href !== null) {
      // Cards often link the image and the title to the same place: keep one, preferring a label.
      const existing = seenLinks.get(href);
      if (existing !== undefined) {
        if (controls[existing]!.label === "" && label !== "") controls[existing]!.label = label;
        continue;
      }
    }
    if (label === "" && kind === "button") continue;
    if (controls.length >= MAX_CONTROLS) { truncated = true; break; }
    nextControlNumber += 1;
    const id = `c${nextControlNumber}`;
    const rating = rateControl(element, { kind, label, href }, pageUrl);
    map.set(id, { element, kind, label, href });
    if (kind === "link" && href !== null) seenLinks.set(href, controls.length);
    controls.push({ id, kind, label: label || (hostOf(href) ?? "Unlabelled link"), host: kind === "link" ? hostOf(href) : null, ...rating });
  }
  return { id: regionId, controls, truncated };
}

export type ActivateOutcome =
  | { ok: true; result: { kind: "link"; href: string; access: "direct" | "confirm" } | { kind: "button" } }
  | { ok: false; code: "not-found" | "stale-capture" | "unauthorized" | "invalid-target"; message: string };

export function activateControl(document: Document, controlId: string, confirmed: boolean): ActivateOutcome {
  const entry = controlsByDocument.get(document)?.get(controlId);
  if (!entry) return { ok: false, code: "not-found", message: "That link or button is no longer listed; open the part again." };
  const element = entry.element;
  if (!element.isConnected || !isVisible(element)) return { ok: false, code: "stale-capture", message: "That link or button is no longer on the page." };
  // Re-check live: the label and address must still be what the user chose.
  const live = controlKind(element);
  if (live.kind !== entry.kind || live.href !== entry.href || controlLabel(element) !== entry.label) {
    return { ok: false, code: "stale-capture", message: "That link or button changed after it was listed." };
  }
  const rating = ratePageControl(element, entry, document, entry.pageLink === true);
  if (rating.access === "blocked") return { ok: false, code: "invalid-target", message: `Not allowed: ${rating.note}.` };
  if (rating.access === "confirm" && !confirmed) return { ok: false, code: "unauthorized", message: `This needs your yes first: ${rating.note}.` };
  if (entry.kind === "link") return { ok: true, result: { kind: "link", href: entry.href!, access: rating.access } };
  (element as HTMLElement).click();
  return { ok: true, result: { kind: "button" } };
}

// ---------------------------------------------------------------------------------------------
// Page steps: how a sighted reader gets more results. Prefer explicit rel=next/prev, then common
// labels ("Next", "›", "Load more"). Each step is minted as a control so the desk can activate it
// through the normal checked path.

const NEXT_LABEL = /^\s*(?:(?:next(?: page)?|older(?: posts)?|more results)\s*[›»→>]?|[›»→>])\s*$/i;
const PREVIOUS_LABEL = /^\s*(?:[‹«←<]?\s*(?:prev(?:ious)?(?: page)?|newer(?: posts)?)|[‹«←<])\s*$/i;
const MORE_LABEL = /^\s*(?:(?:load|show|see|view) more(?: results| items| posts| repositories)?|more results|show all results)\s*[.…]*\s*$/i;

function mintStep(document: Document, element: Element | null, pageLink = false): RegionControlsResult["controls"][number] | null {
  if (!element || !isVisible(element)) return null;
  const { kind, href } = controlKind(element);
  const label = controlLabel(element) || (element.getAttribute("rel") ?? "").trim();
  if (!label) return null;
  let map = controlsByDocument.get(document);
  if (!map) { map = new Map(); controlsByDocument.set(document, map); }
  nextControlNumber += 1;
  const id = `c${nextControlNumber}`;
  map.set(id, { element, kind, label, href, pageLink });
  const rating = ratePageControl(element, { kind, label, href }, document, pageLink);
  return { id, kind, label, host: kind === "link" ? hostOf(href) : null, ...rating };
}

/** rateControl, plus: a same-site next/previous page link outside any form opens directly. */
function ratePageControl(element: Element, entry: { kind: "link" | "button"; label: string; href: string | null }, document: Document, pageLink: boolean): { access: ControlAccess; note: string } {
  let rating = rateControl(element, entry, document.location?.href ?? "");
  const { kind, href } = entry;
  // Blip's policy distrusts "Next" because of multi-step forms. A same-site next/previous page
  // link outside any form is followed by navigating to its address, which cannot submit anything.
  if (pageLink && kind === "link" && rating.access === "confirm" && element.closest("form") === null) {
    try {
      if (new URL(href!).origin === new URL(document.location.href).origin) rating = { access: "direct", note: "" };
    } catch { /* keep the stricter rating */ }
  }
  return rating;
}

/** Steps are page-level: controls inside a result card (an image carousel's arrows) never count. */
function findPageSteps(document: Document, cards: Set<Element>): PageSteps {
  const inCard = (element: Element): boolean => {
    for (const container of cards) if (container.contains(element)) return true;
    return false;
  };
  const visibleOf = (selector: string): Element | null =>
    [...document.querySelectorAll(selector)].find((element) => isVisible(element) && !inCard(element)) ?? null;
  const byLabel = (pattern: RegExp, selector: string): Element | null =>
    [...document.querySelectorAll(selector)].find((element) => {
      const label = (element.getAttribute("aria-label") ?? "").trim() || textOf(element, 40);
      return pattern.test(label) && isVisible(element) && !inCard(element);
    }) ?? null;
  return {
    // Pagination is links; carousels use buttons. Only "load more" may be a button.
    next: mintStep(document, visibleOf("a[rel~=next][href]") ?? byLabel(NEXT_LABEL, "a[href]"), true),
    previous: mintStep(document, visibleOf("a[rel~=prev][href]") ?? byLabel(PREVIOUS_LABEL, "a[href]"), true),
    more: mintStep(document, byLabel(MORE_LABEL, "button,[role=button],a[href]")),
  };
}
