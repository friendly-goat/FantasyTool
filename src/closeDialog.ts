/**
 * Closes a dialog after its closing animation, when it has one: on a phone
 * the bottom sheets (player details, More) slide back down the way they came
 * up. Where no closing animation applies (wider screens, reduced motion) it
 * closes at once.
 */
export function closeDialog(dialog: HTMLDialogElement | null): void {
  if (!dialog?.open || dialog.classList.contains("closing")) return;
  dialog.classList.add("closing");
  const animated = getComputedStyle(dialog).animationName.split(",").some((name) => name.trim() === "sheet-down");
  let timer = 0;
  const finish = () => {
    window.clearTimeout(timer);
    dialog.removeEventListener("animationend", onEnd);
    dialog.classList.remove("closing");
    dialog.close();
  };
  const onEnd = (event: AnimationEvent) => {
    if (event.target === dialog && event.animationName === "sheet-down") finish();
  };
  if (!animated) {
    finish();
    return;
  }
  dialog.addEventListener("animationend", onEnd);
  timer = window.setTimeout(finish, 500); // in case the animation never reports its end
}

/** The button or link last pressed, so a sheet can hand focus back to it when it closes. */
let lastPressed: HTMLElement | null = null;
/** Whether the keyboard was used last (rather than a finger or mouse), so focus should stay visible. */
let usingKeyboard = false;
if (typeof document !== "undefined") {
  document.addEventListener(
    "pointerdown",
    (event) => {
      usingKeyboard = false;
      lastPressed = (event.target as Element | null)?.closest<HTMLElement>("button, a[href], summary, [tabindex]") ?? null;
    },
    true,
  );
  document.addEventListener("keydown", () => (usingKeyboard = true), true);
}

/**
 * Opens a dialog (a card or sheet) so that closing it leaves the page exactly where it was.
 *
 * A dialog hands focus back, when it closes, to whatever had focus when it opened, and the browser
 * scrolls that into view. An iPhone does not focus a tapped button, so that was often a dropdown or
 * a box tapped earlier, somewhere else on the page (on Trades, the builder near the bottom), and
 * closing a player card jumped there. So the button that opened the dialog takes focus first
 * (without scrolling), and the page's scroll position is put back when the dialog closes, and
 * again after Back steps over the dialog's history entry. Opened by a tap, the button then lets go of
 * focus, so it shows no focus box (Safari draws one on focus handed back); opened from the keyboard
 * it keeps focus, so keyboard users carry on from it.
 */
export function openDialog(dialog: HTMLDialogElement | null): void {
  if (!dialog || dialog.open) return;
  const top = window.scrollY;
  const focused = document.activeElement;
  const opener = lastPressed?.isConnected && !dialog.contains(lastPressed) ? lastPressed : null;
  if (opener && focused !== opener) opener.focus({ preventScroll: true });
  else if (!opener && focused instanceof HTMLElement && focused.matches("input, select, textarea")) focused.blur();
  const restore = () => {
    if (Math.abs(window.scrollY - top) > 1) window.scrollTo({ top, behavior: "instant" });
  };
  dialog.addEventListener(
    "close",
    () => {
      restore();
      requestAnimationFrame(restore);
      const back = document.activeElement;
      if (!usingKeyboard && back instanceof HTMLElement && back === opener) back.blur();
      window.addEventListener("popstate", restore);
      window.setTimeout(() => window.removeEventListener("popstate", restore), 1000);
    },
    { once: true },
  );
  dialog.showModal();
}
