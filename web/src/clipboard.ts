/**
 * Copy text. `navigator.clipboard` exists only on a secure page (https or
 * localhost): on Umbrel's http://umbrel.local it is undefined, and a plain
 * `navigator.clipboard.writeText(…)` threw, so a Copy button did nothing. The
 * old way works there. Resolves to whether the text was copied: a Copy button
 * says "copied" only then, or someone pastes what was on the clipboard before.
 */
export const COPY_FAILED = "This browser wouldn't copy it: select the text and copy it by hand.";

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Refused (no permission): the old way may still work.
  }
  if (typeof document === "undefined") return false;
  const box = document.createElement("textarea");
  box.value = text;
  box.setAttribute("readonly", "");
  box.style.position = "fixed";
  box.style.opacity = "0";
  const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.appendChild(box);
  box.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  box.remove();
  before?.focus();
  return copied;
}
