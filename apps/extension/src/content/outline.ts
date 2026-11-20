// Page outline: a cheap, whole-page map of the regions a sighted person takes in at a glance.
//
// Unlike captureVisibleContent (first 20 blocks in document order), the outline covers the whole
// document. Each region carries layout evidence (position, size, heading size) and noise signals
// (ad frames, sponsored labels, cookie banners, link farms) so the server and model can decide
// what matters for the user's goal, then read only those regions in full with readRegion().
// Read-only: nothing here changes the page.
import { isVisible } from "./visibility";

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

export type PageOutline = {
  title: string;
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
  return before ? textOf(before, 120) : "";
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
    const items = region.items;
    const pageLike = items.filter((item) => PAGE_LINK.test(item.label)).length;
    if (pageLike / items.length >= 0.7) {
      region.noise.push("pagination");
      region.label = "Page numbers";
    } else if (items.every((item) => item.label.length < 40 && item.preview === item.label)) {
      // Every item is just a short link with nothing else: a menu, footer, or tag row.
      region.noise.push("link-row");
    }
    if (region.label === "") region.label = `${visibleCards.length} items`;
  }

  return {
    title: document.title.slice(0, 200),
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
    const holder = document.createElement("div");
    holder.appendChild(range.cloneContents());
    // innerText needs layout; cloned nodes have none, so join block-level text with line breaks.
    holder.querySelectorAll("p,li,h1,h2,h3,h4,h5,h6,tr,dt,dd,div,br").forEach((node) => node.append("\n"));
    text = (holder.textContent ?? "").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  } else {
    text = ((element as HTMLElement).innerText ?? element.textContent ?? "").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  }
  const truncated = text.length > MAX_READ_CHARS;
  return { id: regionId, label: labelOf(element, document) || textOf(element, 120), text: text.slice(0, MAX_READ_CHARS), truncated };
}
