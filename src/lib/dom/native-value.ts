// React/Angular/Vue track form values via a patched value setter on the
// element instance — assigning `.value` directly gets silently reverted by
// the framework's next render. Calling the NATIVE prototype setter and then
// dispatching real input/change events makes the framework observe the
// change the same way it would a genuine keystroke. This is the only
// mechanism used for text-like fills anywhere in the extension.
export function setNativeValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;

  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

// Some validation logic only runs on blur — fire it so the page's state
// settles the way it would after real user interaction.
export function dispatchBlur(element: HTMLElement): void {
  element.dispatchEvent(new FocusEvent("blur", { bubbles: false }));
  element.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
}
