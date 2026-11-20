const SUBMIT_METHOD_GUARD_SENTINEL = "blip-submit-method-guard-v1";
const SUBMIT_METHOD_GUARD_PROPERTY = "__blipSubmitMethodGuardInstalled";

type SubmitMethodGuardGlobal = typeof globalThis & {
  __blipSubmitMethodGuardInstalled?: unknown;
};

/** Install the immutable page-world wrapper as soon as this document-start entry runs. */
export function installSubmitMethodGuard(target: Window & typeof globalThis): void {
  const formConstructor = target.HTMLFormElement;
  if (typeof formConstructor !== "function") return;

  const scope = target as SubmitMethodGuardGlobal;
  const current = Object.getOwnPropertyDescriptor(formConstructor.prototype, "submit");
  if (scope[SUBMIT_METHOD_GUARD_PROPERTY] === SUBMIT_METHOD_GUARD_SENTINEL &&
      current?.configurable === false && current.writable === false && typeof current.value === "function") {
    return;
  }

  const browserSubmit = typeof current?.value === "function" ? current.value as (this: HTMLFormElement) => void : null;
  Object.defineProperty(formConstructor.prototype, "submit", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: function submit(this: HTMLFormElement): void {
      // Pages call form.submit() from their own click handlers. Allow it only right after a real
      // click or key press by the user (Chrome's transient activation), which Blip's synthetic
      // events can never produce. Otherwise it stays a no-op.
      const activation = (target.navigator as Navigator & { userActivation?: { isActive?: boolean } }).userActivation;
      if (browserSubmit !== null && activation?.isActive === true) browserSubmit.call(this);
    },
  });
  Object.defineProperty(scope, SUBMIT_METHOD_GUARD_PROPERTY, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: SUBMIT_METHOD_GUARD_SENTINEL,
  });
}

if (typeof window !== "undefined" && typeof window.HTMLFormElement === "function") {
  installSubmitMethodGuard(window);
}
