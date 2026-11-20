// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fieldOptions, regionFields, setField } from "../src/content/fields.js";
import { activateControl } from "../src/content/outline.js";
import { installPersistentSubmitGuard } from "../src/content/submit-guard.js";

beforeAll(() => {
  installPersistentSubmitGuard(document);
  // jsdom has no layout: give every element a box, and treat `hidden` as not rendered.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const shown = this.closest("[hidden]") === null;
    const size = shown ? 20 : 0;
    return { x: 10, y: 10, left: 10, top: 10, width: size, height: size, right: 10 + size, bottom: 10 + size, toJSON: () => ({}) } as DOMRect;
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  delete (window.navigator as { userActivation?: unknown }).userActivation;
});

function fieldsOnPage() {
  const result = regionFields(document, null);
  if (result === null) throw new Error("no fields result");
  return result;
}

describe("form mirror fields", () => {
  it("lists text, select, checkbox and radio groups with labels and values", () => {
    document.body.innerHTML = `
      <form>
        <label for="title">Gig title</label><input id="title" value="I will mix your song" required maxlength="80">
        <label for="cat">Category</label>
        <select id="cat"><option>Music</option><option selected>Mixing</option></select>
        <label><input type="checkbox" id="terms"> I agree</label>
        <fieldset><legend>Delivery</legend>
          <label><input type="radio" name="days" value="3"> 3 days</label>
          <label><input type="radio" name="days" value="7" checked> 7 days</label>
        </fieldset>
        <button type="submit">Save</button>
      </form>`;
    const { fields, controls } = fieldsOnPage();
    expect(fields.map((field) => [field.kind, field.label])).toEqual([
      ["text", "Gig title"],
      ["select", "Category"],
      ["checkbox", "I agree"],
      ["radio", "Delivery"],
    ]);
    expect(fields[0]).toMatchObject({ value: "I will mix your song", required: true, maxLength: 80 });
    expect(fields[1]).toMatchObject({ value: "Mixing", options: [{ label: "Music", selected: false }, { label: "Mixing", selected: true }] });
    expect(fields[2]).toMatchObject({ checked: false });
    expect(fields[3]).toMatchObject({ value: "7 days", options: [{ label: "3 days", selected: false }, { label: "7 days", selected: true }] });
    expect(controls.map((control) => control.label)).toEqual(["Save"]);
    expect(controls[0]!.access).toBe("confirm");
  });

  it("lists password fields without their value and refuses to write them", async () => {
    document.body.innerHTML = `<label for="pw">Password</label><input id="pw" type="password" value="hunter2">`;
    const [field] = fieldsOnPage().fields;
    expect(field).toMatchObject({ sensitive: true, value: null });
    const outcome = await setField(document, field!.id, { value: "anything" });
    expect(outcome.ok).toBe(false);
    expect((document.getElementById("pw") as HTMLInputElement).value).toBe("hunter2");
  });

  it("sets text, select, checkbox and radio values and reads them back", async () => {
    document.body.innerHTML = `
      <label for="name">Name</label><input id="name">
      <label for="size">Size</label><select id="size"><option>Small</option><option>Large</option></select>
      <label><input type="checkbox" id="news"> Newsletter</label>
      <fieldset><legend>Plan</legend>
        <label><input type="radio" name="plan" value="a"> Basic</label>
        <label><input type="radio" name="plan" value="b"> Pro</label>
      </fieldset>`;
    const [name, size, news, plan] = fieldsOnPage().fields;
    const changed = vi.fn();
    document.getElementById("name")!.addEventListener("input", changed);

    const typed = await setField(document, name!.id, { value: "Blake" });
    expect(typed).toMatchObject({ ok: true, field: { value: "Blake" } });
    expect(changed).toHaveBeenCalled();
    expect(await setField(document, size!.id, { option: 1 })).toMatchObject({ ok: true, field: { value: "Large" } });
    expect(await setField(document, news!.id, { checked: true })).toMatchObject({ ok: true, field: { checked: true } });
    expect(await setField(document, plan!.id, { option: 1 })).toMatchObject({ ok: true, field: { value: "Pro" } });
  });

  it("cuts text to the field's maximum length and says so", async () => {
    document.body.innerHTML = `<label for="t">Title</label><input id="t" maxlength="5">`;
    const [field] = fieldsOnPage().fields;
    const outcome = await setField(document, field!.id, { value: "Too long a title" });
    expect(outcome).toMatchObject({ ok: true, field: { value: "Too l" } });
    expect(outcome.ok && outcome.detail).toContain("5");
  });

  it("reports the page's own error message for an invalid field", () => {
    document.body.innerHTML = `
      <label for="e">Email</label><input id="e" aria-invalid="true" aria-errormessage="err">
      <span id="err">Enter a valid email address</span>`;
    expect(fieldsOnPage().fields[0]!.invalid).toBe("Enter a valid email address");
  });

  it("opens a custom combobox, lists its options, and picks one by pressing it", async () => {
    document.body.innerHTML = `
      <label id="lang-label">Language</label>
      <div role="combobox" aria-labelledby="lang-label" aria-controls="lang-list" aria-expanded="false" tabindex="0">Choose</div>
      <ul id="lang-list" role="listbox" hidden></ul>`;
    const box = document.querySelector("[role=combobox]")!;
    const list = document.getElementById("lang-list")!;
    // A typical custom widget: opens on mousedown, picks on mousedown of an option.
    box.addEventListener("mousedown", () => {
      list.hidden = false;
      box.setAttribute("aria-expanded", "true");
      list.innerHTML = `<li role="option">English</li><li role="option">Spanish</li>`;
      for (const option of list.querySelectorAll("li")) {
        option.addEventListener("mousedown", () => { box.textContent = option.textContent; list.hidden = true; });
      }
    });

    const [field] = fieldsOnPage().fields;
    expect(field).toMatchObject({ kind: "combobox", label: "Language", value: "Choose" });
    const opened = await fieldOptions(document, field!.id, "");
    expect(opened).toMatchObject({ ok: true, options: [{ label: "English" }, { label: "Spanish" }] });
    expect(await setField(document, field!.id, { option: 1 })).toMatchObject({ ok: true, field: { value: "Spanish" } });
  });

  it("never submits a form while filling it", async () => {
    document.body.innerHTML = `<form><label for="q">Search</label><input id="q"></form>`;
    const submitted = vi.fn((event: Event) => event.preventDefault());
    document.querySelector("form")!.addEventListener("submit", submitted);
    const [field] = fieldsOnPage().fields;
    await setField(document, field!.id, { value: "free synth" });
    expect(submitted).not.toHaveBeenCalled();
  });
});

describe("submitting", () => {
  it("lets a confirmed press of a submit button through the guard exactly once", () => {
    document.body.innerHTML = `<form><label for="q">Name</label><input id="q"><button type="submit">Save changes</button></form>`;
    const submitted = vi.fn((event: Event) => event.preventDefault());
    document.querySelector("form")!.addEventListener("submit", submitted);
    const { controls } = fieldsOnPage();
    expect(activateControl(document, controls[0]!.id, false).ok).toBe(false);
    expect(submitted).not.toHaveBeenCalled();
    expect(activateControl(document, controls[0]!.id, true).ok).toBe(true);
    expect(submitted).toHaveBeenCalledTimes(1);
    // The allowance is used up: the page can't submit again on its own.
    document.querySelector("form")!.requestSubmit();
    expect(submitted).toHaveBeenCalledTimes(1);
  });

  it("lets the user's own submission through while Chrome reports a real click or key press", () => {
    document.body.innerHTML = `<form><button type="submit">Go</button></form>`;
    const submitted = vi.fn((event: Event) => event.preventDefault());
    const form = document.querySelector("form")!;
    form.addEventListener("submit", submitted);
    form.requestSubmit();
    expect(submitted).not.toHaveBeenCalled();
    Object.defineProperty(window.navigator, "userActivation", { value: { isActive: true }, configurable: true });
    form.requestSubmit();
    expect(submitted).toHaveBeenCalledTimes(1);
  });
});

describe("validity after Blip's own change", () => {
  it("reports the browser's message for a value that breaks the field's rules", async () => {
    document.body.innerHTML = `<label for="m">Email</label><input id="m" type="email">`;
    const [field] = regionFields(document, null)!.fields;
    expect(field!.invalid).toBe("");
    const outcome = await setField(document, field!.id, { value: "not-an-email" });
    expect(outcome.ok && outcome.field.invalid).not.toBe("");
  });
});

describe("date fields", () => {
  it("calls a page's pop-up-calendar text box a date and passes on its format", () => {
    document.body.innerHTML = `
      <label for="d">Date picker</label><input id="d" name="my-date" placeholder="mm/dd/yyyy">
      <label for="n">Nickname</label><input id="n" name="nick">`;
    const [date, nick] = regionFields(document, null)!.fields;
    expect(date).toMatchObject({ inputType: "text-date", dateFormat: "MM/DD/YYYY", dateFormatSource: "page" });
    expect(nick!.inputType).toBe("text");
  });
});

describe("date detection", () => {
  it("doesn't mistake words that merely contain 'date' for dates", () => {
    document.body.innerHTML = `
      <label for="c">Candidate name</label><input id="c">
      <label for="u">Update note</label><input id="u">
      <label for="s">Start</label><input id="s" name="startdate">`;
    expect(regionFields(document, null)!.fields.map((f) => f.inputType)).toEqual(["text", "text", "text-date"]);
  });
});

describe("date formats", () => {
  function formatFor(html: string, lang = "") {
    document.documentElement.setAttribute("lang", lang);
    document.body.innerHTML = html;
    const [field] = regionFields(document, null)!.fields;
    return [field!.dateFormat, field!.dateFormatSource];
  }

  it("prefers the page's own hint, then a date already there, then the page's language", () => {
    expect(formatFor(`<label for="d">Date</label><input id="d" placeholder="DD.MM.YYYY">`)).toEqual(["DD.MM.YYYY", "page"]);
    expect(formatFor(`<label for="d">Date</label><input id="d" data-date-format="yyyy-mm-dd">`)).toEqual(["YYYY-MM-DD", "page"]);
    expect(formatFor(`<label for="d">Date</label><input id="d" value="19/11/2026">`)).toEqual(["DD/MM/YYYY", "value"]);
    expect(formatFor(`<label for="d">Date</label><input id="d" value="11-19-26">`)).toEqual(["MM-DD-YY", "value"]);
    expect(formatFor(`<label for="d">Date</label><input id="d">`, "en-GB")).toEqual(["DD/MM/YYYY", "language"]);
    expect(formatFor(`<label for="d">Date</label><input id="d">`, "en-US")).toEqual(["MM/DD/YYYY", "language"]);
    document.documentElement.removeAttribute("lang");
  });
});
