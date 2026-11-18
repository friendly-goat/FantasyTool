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
