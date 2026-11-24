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

/** Whether the keyboard was used last (rather than a finger or mouse), so focus should come back. */
let usingKeyboard = false;
if (typeof document !== "undefined") {
  document.addEventListener("pointerdown", () => (usingKeyboard = false), true);
  document.addEventListener("keydown", () => (usingKeyboard = true), true);
}

/**
 * Opens a dialog (a card or sheet) so that closing it leaves the page exactly where it was.
 *
 * A dialog hands focus back, when it closes, to whatever had focus when it opened: the browser
 * scrolls that into view and Safari draws a focus box on it. An iPhone does not focus a tapped
 * button, so that was often a dropdown or box tapped earlier somewhere else on the page (on Trades,
 * the builder near the bottom), and closing a player card jumped there; handing focus to the tapped
 * name instead showed a box around it. So a dialog opened by a tap or click lets go of focus first:
 * nothing gets it back on close, so nothing scrolls into view and no box is drawn, not even for a
 * frame. Opened from the keyboard, the button that opened it keeps focus and gets it back, so
 * keyboard users carry on from it. The page's scroll position is also put back when the dialog
 * closes, and again after Back steps over the dialog's history entry.
 */
export function openDialog(dialog: HTMLDialogElement | null): void {
  if (!dialog || dialog.open) return;
  const top = window.scrollY;
  const focused = document.activeElement;
  if (!usingKeyboard && focused instanceof HTMLElement && focused !== document.body) focused.blur();
  const restore = () => {
    if (Math.abs(window.scrollY - top) > 1) window.scrollTo({ top, behavior: "instant" });
  };
  dialog.addEventListener(
    "close",
    () => {
      restore();
      requestAnimationFrame(restore);
      window.addEventListener("popstate", restore);
      window.setTimeout(() => window.removeEventListener("popstate", restore), 1000);
    },
    { once: true },
  );
  dialog.showModal();
}
