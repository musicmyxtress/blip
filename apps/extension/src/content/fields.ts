// Form mirror: read the fields in one outline region (or the whole page) so the desk can show them
// as real Windows controls, and change one field at a time on the user's command.
//
// Rules this module keeps:
// - Password, card, security-code, one-time-code and SSN fields are listed (so the user knows they
//   exist) but never read and never written. The user types those on the page.
// - Nothing here submits. Text is set with input/change events and no Enter key, and every write
//   runs only while Blip's persistent submit guard is installed.
// - Ids are minted per outline and re-checked live before each write.
import { fillSelect, fillText, setChecked, settle } from "./fill.js";
import { focusWithEvents } from "./focus.js";
import { labelCandidatesOf } from "./labels.js";
import { CONTROL_SELECTOR, formButtons, regionScopeElements, textOf } from "./outline.js";
import { safeValueOf } from "./sensitive.js";
import { withSubmitEventsBlocked } from "./submit-guard.js";
import { isVisible } from "./visibility.js";

export type FieldKind = "text" | "textarea" | "select" | "checkbox" | "radio" | "combobox" | "other";
export type FieldOption = { label: string; selected: boolean };
export type FieldInfo = {
  id: string;
  kind: FieldKind;
  inputType: string;
  label: string;
  value: string | null;
  sensitive: boolean;
  required: boolean;
  disabled: boolean;
  readOnly: boolean;
  checked?: boolean;
  invalid: string;
  hint: string;
  options?: FieldOption[];
  maxLength?: number;
};

type FieldEntry = {
  element: Element;
  kind: FieldKind;
  /** Radio groups: each choice, in page order. */
  members?: Element[];
  /** Comboboxes: the option elements from the last field-options call. */
  shown?: Element[];
};

const FIELD_SELECTOR = [
  "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image])",
  "select", "textarea",
  "[role=combobox]", "[role=checkbox]", "[role=switch]", "[role=radio]",
  "button[aria-haspopup=listbox]",
].join(",");
const TEXT_TYPES = new Set([
  "", "text", "email", "tel", "url", "search", "number", "date", "datetime-local", "time", "month", "week", "password",
]);
const MAX_FIELDS = 150;
const MAX_OPTIONS = 300;

let nextFieldNumber = 0;
/** Fields Blip has changed: Chrome only flags :user-invalid after a real edit, so check these ourselves. */
const touched = new WeakSet<Element>();
const fieldsByDocument = new WeakMap<Document, Map<string, FieldEntry>>();

/** Forget every field id for this document; called when a new outline is built. */
export function resetFields(document: Document): void {
  fieldsByDocument.delete(document);
}

// ------------------------------------------------------------------------------------- reading

function byIds(element: Element, attribute: string): Element[] {
  const ids = (element.getAttribute(attribute) ?? "").trim().split(/\s+/).filter(Boolean);
  return ids.map((id) => element.ownerDocument.getElementById(id)).filter((found): found is HTMLElement => found !== null);
}

function idText(element: Element, attribute: string): string {
  return byIds(element, attribute).map((found) => textOf(found, 300)).filter(Boolean).join(" ").slice(0, 300);
}

function inputType(element: Element): string {
  return element.localName === "input" ? (element as HTMLInputElement).type.toLowerCase() : "";
}

/** Native checkboxes and radios are often hidden behind a styled label; the label then stands in. */
function fieldVisible(element: Element): boolean {
  if (isVisible(element)) return true;
  if (element.localName !== "input") return false;
  const type = inputType(element);
  if (type !== "checkbox" && type !== "radio") return false;
  const labels = (element as HTMLInputElement).labels;
  return labels !== null && [...labels].some((label) => isVisible(label));
}

function kindOf(element: Element): FieldKind | null {
  const role = element.getAttribute("role")?.trim().toLowerCase() ?? "";
  if (element.localName === "select") return "select";
  if (element.localName === "textarea") return "textarea";
  if (element.localName === "input") {
    const type = inputType(element);
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "file" || type === "range" || type === "color") return "other";
    const autocomplete = element.getAttribute("aria-autocomplete")?.toLowerCase() ?? "";
    if (role === "combobox" || element.hasAttribute("list") || autocomplete === "list" || autocomplete === "both" ||
        element.closest("[role=combobox]") !== null) return "combobox";
    return TEXT_TYPES.has(type) ? "text" : "other";
  }
  if (role === "checkbox" || role === "switch") return "checkbox";
  if (role === "radio") return "radio";
  if (role === "combobox" || element.getAttribute("aria-haspopup") === "listbox") {
    // An ARIA 1.1 combobox wraps its own text box: the text box is the field, not the wrapper.
    if (element.querySelector("input:not([type=hidden])") !== null) return null;
    return "combobox";
  }
  return null;
}

function labelOf(element: Element): string {
  const candidate = labelCandidatesOf(element)[0]?.text ?? "";
  if (candidate) return candidate;
  if (element.localName !== "input" && element.localName !== "select" && element.localName !== "textarea") {
    return textOf(element, 200);
  }
  return "";
}

function radioLabel(member: Element): string {
  if (member.localName === "input") {
    const labels = (member as HTMLInputElement).labels;
    const text = labels && labels.length > 0 ? textOf(labels[0]!, 200) : "";
    return text || member.getAttribute("aria-label")?.trim() || (member as HTMLInputElement).value || "Choice";
  }
  return member.getAttribute("aria-label")?.trim() || textOf(member, 200) || "Choice";
}

function radioChecked(member: Element): boolean {
  return member.localName === "input" ? (member as HTMLInputElement).checked : member.getAttribute("aria-checked") === "true";
}

/** The group's name: a radiogroup's label or the fieldset legend, else the first choice's own label. */
function radioGroupLabel(first: Element): string {
  const group = first.closest("[role=radiogroup]");
  if (group) {
    const named = group.getAttribute("aria-label")?.trim() || idText(group, "aria-labelledby");
    if (named) return named;
  }
  const legend = first.closest("fieldset")?.querySelector(":scope > legend");
  if (legend) return textOf(legend, 200);
  const name = first.getAttribute("name") ?? "";
  return name ? name.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim() : radioLabel(first);
}

function radioMembers(first: Element, scope: Element[]): Element[] {
  if (first.localName === "input") {
    const name = first.getAttribute("name");
    if (!name) return [first];
    const owner = (first as HTMLInputElement).form ?? first.ownerDocument;
    return [...owner.querySelectorAll(`input[type=radio]`)]
      .filter((member) => member.getAttribute("name") === name && fieldVisible(member));
  }
  const group = first.closest("[role=radiogroup]");
  if (!group) return [first];
  return [...group.querySelectorAll("[role=radio]")].filter((member) => scope.includes(member) || isVisible(member));
}

function comboValue(element: Element): string {
  if (element.localName === "input") return (element as HTMLInputElement).value;
  return textOf(element, 300);
}

function isRequired(element: Element): boolean {
  return (element as HTMLInputElement).required === true || element.getAttribute("aria-required") === "true";
}

function isDisabledField(element: Element): boolean {
  if ((element as HTMLInputElement).disabled === true) return true;
  return element.closest("[aria-disabled=true]") !== null;
}

function isReadOnly(element: Element): boolean {
  return (element as HTMLInputElement).readOnly === true || element.getAttribute("aria-readonly") === "true";
}

/** The page's own error text, when it marks the field invalid (ARIA, or the browser after the user edited it). */
function invalidText(element: Element): string {
  const ariaInvalid = (element.getAttribute("aria-invalid") ?? "").toLowerCase();
  let userInvalid = false;
  try { userInvalid = element.matches(":user-invalid"); } catch { /* older browsers */ }
  const validity = (element as HTMLInputElement).validity;
  if (touched.has(element) && validity && !validity.valid && !validity.valueMissing) userInvalid = true;
  if ((ariaInvalid === "" || ariaInvalid === "false") && !userInvalid) return "";
  const message = idText(element, "aria-errormessage") || idText(element, "aria-describedby") ||
    ((element as HTMLInputElement).validationMessage ?? "");
  return (message || "marked as not valid").slice(0, 300);
}

function describe(id: string, entry: FieldEntry): FieldInfo {
  const element = entry.element;
  const safe = safeValueOf(element);
  const sensitive = safe.sensitive !== "none";
  const invalid = invalidText(element);
  const hint = invalid ? "" : idText(element, "aria-describedby");
  const base = {
    id,
    kind: entry.kind,
    inputType: inputType(element) || element.getAttribute("role") || element.localName,
    label: labelOf(element) || "Unlabelled field",
    sensitive,
    required: isRequired(element),
    disabled: isDisabledField(element),
    readOnly: isReadOnly(element),
    invalid,
    hint,
  };
  switch (entry.kind) {
    case "select": {
      const select = element as HTMLSelectElement;
      const options = [...select.options].slice(0, MAX_OPTIONS).map((option) => ({ label: (option.label || option.text).trim().slice(0, 200), selected: option.selected }));
      return { ...base, value: [...select.selectedOptions].map((option) => (option.label || option.text).trim()).join(", "), options };
    }
    case "checkbox": {
      const checked = element.localName === "input" ? (element as HTMLInputElement).checked : element.getAttribute("aria-checked") === "true";
      return { ...base, value: null, checked };
    }
    case "radio": {
      const members = entry.members ?? [element];
      const options = members.map((member) => ({ label: radioLabel(member), selected: radioChecked(member) }));
      const chosen = options.find((option) => option.selected)?.label ?? "";
      return { ...base, label: radioGroupLabel(members[0]!), value: chosen, options };
    }
    case "combobox":
      return { ...base, value: sensitive ? null : comboValue(element).slice(0, 10_000) };
    case "other":
      return { ...base, value: null, hint: inputType(element) === "file" ? "File upload. Do this one on the page." : base.hint };
    default: {
      const maxLength = (element as HTMLInputElement).maxLength;
      return { ...base, value: safe.value === null ? null : safe.value.slice(0, 10_000), ...(maxLength > 0 ? { maxLength } : {}) };
    }
  }
}

export type FieldsResult = {
  id: string | null;
  fields: FieldInfo[];
  controls: ReturnType<typeof formButtons>;
  truncated: boolean;
};

/** Lists the fields in a region (or the whole page when regionId is null), plus their forms' buttons. */
export function regionFields(document: Document, regionId: string | null): FieldsResult | null {
  const scope = regionId === null
    ? [...document.querySelectorAll(FIELD_SELECTOR)]
    : regionScopeElements(document, regionId, FIELD_SELECTOR);
  if (scope === null) return null;
  let map = fieldsByDocument.get(document);
  if (!map) { map = new Map(); fieldsByDocument.set(document, map); }
  if (map.size > 2000) map.clear();

  const fields: FieldInfo[] = [];
  const grouped = new Set<Element>();
  const forms = new Set<HTMLFormElement>();
  let truncated = false;
  for (const element of scope) {
    if (grouped.has(element) || !fieldVisible(element)) continue;
    const kind = kindOf(element);
    if (kind === null) continue;
    if (fields.length >= MAX_FIELDS) { truncated = true; break; }
    const entry: FieldEntry = { element, kind };
    if (kind === "radio") {
      entry.members = radioMembers(element, scope);
      for (const member of entry.members) grouped.add(member);
    }
    nextFieldNumber += 1;
    const id = `f${nextFieldNumber}`;
    map.set(id, entry);
    fields.push(describe(id, entry));
    const form = (element as HTMLInputElement).form ?? element.closest("form");
    if (form) forms.add(form);
  }

  // Buttons: those in the region, or for the whole page, those in the fields' forms.
  const buttonScope = regionId === null
    ? [...forms].flatMap((form) => [...form.querySelectorAll(CONTROL_SELECTOR), ...[...form.elements].filter((el) => el.matches(CONTROL_SELECTOR))])
    : (regionScopeElements(document, regionId, CONTROL_SELECTOR) ?? []);
  const unique = [...new Set(buttonScope)];
  return { id: regionId, fields, controls: formButtons(document, unique, 50), truncated };
}

// ------------------------------------------------------------------------------------- combobox options

function visibleOptions(container: Element): Element[] {
  const options = container.matches("[role=option]") ? [container] : [...container.querySelectorAll("[role=option]")];
  return options.filter((option) => isVisible(option) && option.getAttribute("aria-disabled") !== "true");
}

/** Where a combobox's choices live: its aria-controls/owns list, its datalist, or the nearest open listbox. */
function findShownOptions(element: Element): Element[] {
  const sources = [element, element.closest("[role=combobox]")].filter((found): found is Element => found !== null);
  for (const source of sources) {
    for (const attribute of ["aria-controls", "aria-owns"]) {
      for (const list of byIds(source, attribute)) {
        const options = visibleOptions(list);
        if (options.length > 0) return options;
      }
    }
  }
  const listboxes = [...element.ownerDocument.querySelectorAll("[role=listbox]")].filter((list) => isVisible(list) && visibleOptions(list).length > 0);
  if (listboxes.length === 0) return [];
  // Several open lists: take the one nearest the field on screen.
  const anchor = element.getBoundingClientRect();
  const distance = (list: Element): number => {
    const rect = list.getBoundingClientRect();
    return Math.abs(rect.top - anchor.bottom) + Math.abs(rect.left - anchor.left);
  };
  listboxes.sort((a, b) => distance(a) - distance(b));
  return visibleOptions(listboxes[0]!);
}

function optionLabel(option: Element): string {
  return (option.getAttribute("aria-label")?.trim() || textOf(option, 200) || (option as HTMLOptionElement).value || "Choice").slice(0, 200);
}

/** Press like a hand would: many custom widgets listen for pointer or mouse down, not click. */
function press(element: Element): void {
  const view = element.ownerDocument.defaultView;
  const rect = element.getBoundingClientRect();
  const at = { bubbles: true, cancelable: true, composed: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0 };
  const PointerCtor = view?.PointerEvent ?? (globalThis as { PointerEvent?: typeof PointerEvent }).PointerEvent;
  if (PointerCtor) element.dispatchEvent(new PointerCtor("pointerdown", { ...at, pointerType: "mouse", isPrimary: true }));
  element.dispatchEvent(new MouseEvent("mousedown", at));
  if (PointerCtor) element.dispatchEvent(new PointerCtor("pointerup", { ...at, pointerType: "mouse", isPrimary: true }));
  element.dispatchEvent(new MouseEvent("mouseup", at));
  element.dispatchEvent(new MouseEvent("click", at));
}

/**
 * Type into a combobox the way a keyboard does, one character at a time (key down, text changes,
 * key up), without leaving the box, so widgets that filter on keys and widgets that filter on
 * input both see a normal person typing.
 */
function typeWithoutBlur(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
  const setValue = (value: string): void => { if (setter) setter.call(input, value); else input.value = value; };
  const key = (type: string, name: string): void => {
    input.dispatchEvent(new KeyboardEvent(type, { key: name, bubbles: true, cancelable: true, composed: true }));
  };
  focusWithEvents(input);
  if (input.value !== "") {
    setValue("");
    input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "deleteContentBackward" }));
  }
  let typed = "";
  for (const character of Array.from(text).slice(0, 60)) {
    typed += character;
    key("keydown", character);
    setValue(typed);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: character }));
    key("keyup", character);
  }
  if (text === "") {
    // An empty box often opens its list on Down Arrow.
    key("keydown", "ArrowDown");
    key("keyup", "ArrowDown");
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type FieldFailure = { ok: false; code: "not-found" | "stale-capture" | "invalid-target" | "unauthorized"; message: string };

function liveEntry(document: Document, fieldId: string): FieldEntry | FieldFailure {
  const entry = fieldsByDocument.get(document)?.get(fieldId);
  if (!entry) return { ok: false, code: "not-found", message: "That field is no longer listed. Open the form again." };
  if (!entry.element.isConnected) return { ok: false, code: "stale-capture", message: "That field is no longer on the page." };
  if (safeValueOf(entry.element).sensitive !== "none") {
    return { ok: false, code: "invalid-target", message: "Blip never handles passwords, card numbers or codes. Type this one on the page yourself." };
  }
  if (isDisabledField(entry.element)) return { ok: false, code: "invalid-target", message: "That field is turned off on the page right now." };
  return entry;
}

/** Opens a combobox (typing the filter first if it takes text) and lists what it offers. */
export async function fieldOptions(document: Document, fieldId: string, filter: string): Promise<{ ok: true; options: FieldOption[]; truncated: boolean } | FieldFailure> {
  const entry = liveEntry(document, fieldId);
  if ("ok" in entry) return entry;
  if (entry.kind !== "combobox") return { ok: false, code: "invalid-target", message: "That field has no list of choices to open." };
  const element = entry.element;
  return withSubmitEventsBlocked(document, async () => {
    const input = element.localName === "input" ? element as HTMLInputElement : null;
    // A plain datalist: its options are right there.
    if (input?.list) {
      const wanted = filter.trim().toLowerCase();
      const options = [...input.list.querySelectorAll("option")]
        .filter((option) => !wanted || (option.value + " " + option.label).toLowerCase().includes(wanted));
      entry.shown = options;
      return { ok: true as const, options: options.slice(0, MAX_OPTIONS).map((option) => ({ label: (option.label || option.value).slice(0, 200), selected: false })), truncated: options.length > MAX_OPTIONS };
    }
    element.scrollIntoView?.({ block: "nearest" });
    if (input) typeWithoutBlur(input, filter);
    else if (element.getAttribute("aria-expanded") !== "true") press(element);
    // Lists often load from the network: keep looking for up to about two seconds.
    let options: Element[] = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      await wait(attempt === 0 ? 150 : 200);
      options = findShownOptions(element);
      if (options.length > 0) break;
    }
    entry.shown = options;
    return {
      ok: true as const,
      options: options.slice(0, MAX_OPTIONS).map((option) => ({ label: optionLabel(option), selected: option.getAttribute("aria-selected") === "true" })),
      truncated: options.length > MAX_OPTIONS,
    };
  });
}

// ------------------------------------------------------------------------------------- writing

export type SetFieldRequest = { value?: string; checked?: boolean; option?: number };

/** Changes one field and reads it back from the page. */
export async function setField(document: Document, fieldId: string, request: SetFieldRequest): Promise<{ ok: true; field: FieldInfo; detail: string } | FieldFailure> {
  const entry = liveEntry(document, fieldId);
  if ("ok" in entry) return entry;
  const element = entry.element;
  if (isReadOnly(element)) return { ok: false, code: "invalid-target", message: "That field can't be changed." };
  const bad = (message: string): FieldFailure => ({ ok: false, code: "invalid-target", message });

  return withSubmitEventsBlocked(document, async () => {
    let detail = "";
    switch (entry.kind) {
      case "text":
      case "textarea": {
        if (request.value === undefined) return bad("Type the text for this field.");
        const outcome = await fillText(element as HTMLInputElement | HTMLTextAreaElement, request.value);
        if (!outcome.ok) return bad(`Couldn't change that field: ${outcome.detail}.`);
        detail = outcome.detail ? `Cut off: ${outcome.detail}.` : "";
        break;
      }
      case "select": {
        const select = element as HTMLSelectElement;
        const option = request.option === undefined ? undefined : select.options[request.option];
        if (!option) return bad("That choice is no longer in the list.");
        const outcome = await fillSelect(select, option.value);
        if (!outcome.ok) return bad(`Couldn't choose that: ${outcome.detail}.`);
        break;
      }
      case "checkbox": {
        if (request.checked === undefined) return bad("Say whether to check or uncheck it.");
        if (element.localName === "input") {
          const outcome = await setChecked(element as HTMLInputElement, request.checked);
          if (!outcome.ok) return bad(`Couldn't change that: ${outcome.detail}.`);
        } else if ((element.getAttribute("aria-checked") === "true") !== request.checked) {
          press(element);
          await settle(document.defaultView);
        }
        break;
      }
      case "radio": {
        const member = request.option === undefined ? undefined : entry.members?.[request.option];
        if (!member || !member.isConnected) return bad("That choice is no longer on the page.");
        if (!radioChecked(member)) {
          if (member.localName === "input") (member as HTMLInputElement).click(); else press(member);
          await settle(document.defaultView);
        }
        break;
      }
      case "combobox": {
        if (request.option !== undefined) {
          const option = entry.shown?.[request.option];
          if (!option || !option.isConnected) return bad("That choice went away. Open the list again.");
          if (option.localName === "option") {
            // Datalist: the choice is just text for the box.
            const outcome = await fillText(element as HTMLInputElement, (option as HTMLOptionElement).value);
            if (!outcome.ok) return bad(`Couldn't choose that: ${outcome.detail}.`);
          } else {
            press(option);
            await settle(document.defaultView);
          }
          entry.shown = undefined;
        } else if (request.value !== undefined && element.localName === "input") {
          const outcome = await fillText(element as HTMLInputElement, request.value);
          if (!outcome.ok) return bad(`Couldn't change that field: ${outcome.detail}.`);
        } else {
          return bad("Open the list and pick a choice.");
        }
        break;
      }
      case "other":
        return bad("Blip can't fill this kind of field yet. Do this one on the page.");
    }
    touched.add(element);
    // Give the page a moment to validate and re-render before reading the field back.
    await wait(200);
    if (!element.isConnected) return { ok: false as const, code: "stale-capture" as const, message: "The page replaced that field after the change. Open the form again." };
    return { ok: true as const, field: describe(fieldId, entry), detail };
  });
}
