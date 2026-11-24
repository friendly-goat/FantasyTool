import { type RefObject, useEffect, useRef } from "react";

// Phone controls for the bottom sheets (player and team cards, the More sheet),
// the way iPhone sheets behave: pull the sheet down from its top to close it,
// and the phone's back gesture (or the browser's Back) closes the sheet on top
// instead of leaving the app.

/** Phone layout, where the cards open as bottom sheets (styles.css). */
const PHONE = "(max-width: 720px)";
/** Movement before a touch counts as a pull (or as something else, such as a sideways swipe). */
const SLOP = 8;
/** A pull this far down closes the sheet, whatever its speed (or a quarter of its height, if less). */
const CLOSE_DISTANCE = 140;
/** A flick this fast (pixels a millisecond) closes it once it has moved a little. */
const CLOSE_SPEED = 0.55;
const CLOSE_FLICK_DISTANCE = 36;

/** Where a pull's decision stands, worked out from where it is and how fast it moves. */
export function pullCloses(distance: number, speed: number, height: number): boolean {
  if (distance <= 0) return false;
  if (distance >= Math.min(CLOSE_DISTANCE, height / 4)) return true;
  return speed >= CLOSE_SPEED && distance >= CLOSE_FLICK_DISTANCE;
}

/**
 * Pull-down to close for a sheet. A downward pull counts when it starts with the sheet scrolled
 * to its top (or on its grabber); the sheet follows the finger and the page behind brightens. Let
 * go far or fast enough and the sheet slides away and closes; otherwise it springs back. Sideways
 * swipes (the chart carousel, wide tables) and ordinary scrolling are left alone. Phones only.
 */
export function useSheetPull(ref: RefObject<HTMLDialogElement | null>): void {
  useEffect(() => {
    const sheet = ref.current;
    if (!sheet) return;
    let start: { x: number; y: number } | null = null;
    let pulling = false;
    let distance = 0;
    let samples: { y: number; t: number }[] = [];

    const reset = () => {
      sheet.style.removeProperty("transform");
      sheet.style.removeProperty("transition");
      sheet.style.removeProperty("--sheet-dim");
      sheet.classList.remove("pulling", "settling");
    };
    const settle = (to: string, then: () => void, timing: string) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        sheet.removeEventListener("transitionend", onEnd);
        then();
      };
      const onEnd = (event: TransitionEvent) => {
        if (event.target === sheet && event.propertyName === "transform") finish();
      };
      sheet.addEventListener("transitionend", onEnd);
      window.setTimeout(finish, 400);
      sheet.style.transition = `transform ${timing}`;
      sheet.style.transform = to;
    };

    const onStart = (event: TouchEvent) => {
      start = null;
      pulling = false;
      if (event.touches.length !== 1 || !sheet.open || sheet.classList.contains("closing")) return;
      if (!window.matchMedia(PHONE).matches) return;
      const target = event.target as Element | null;
      const onHandle = Boolean(target?.closest(".sheet-grabber, .panel-close"));
      if (!onHandle && sheet.scrollTop > 0) return;
      // A dropdown or text field keeps its own touch.
      if (target?.closest("select, input, textarea")) return;
      const touch = event.touches[0]!;
      start = { x: touch.clientX, y: touch.clientY };
      samples = [{ y: touch.clientY, t: event.timeStamp }];
    };

    const onMove = (event: TouchEvent) => {
      if (!start) return;
      const touch = event.touches[0]!;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (!pulling) {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        // Sideways, or up (scrolling the sheet): not a pull.
        if (Math.abs(dx) > Math.abs(dy) || dy < 0 || sheet.scrollTop > 0) {
          start = null;
          return;
        }
        pulling = true;
        sheet.classList.add("pulling");
        sheet.style.transition = "none";
      }
      event.preventDefault();
      distance = Math.max(0, dy - SLOP);
      sheet.style.transform = `translateY(${distance}px)`;
      sheet.style.setProperty("--sheet-dim", String(Math.max(0, 1 - distance / Math.max(1, sheet.offsetHeight))));
      samples.push({ y: touch.clientY, t: event.timeStamp });
      if (samples.length > 6) samples.shift();
    };

    const onEnd = () => {
      if (!start || !pulling) {
        start = null;
        return;
      }
      start = null;
      pulling = false;
      sheet.classList.replace("pulling", "settling");
      const first = samples[0]!;
      const last = samples.at(-1)!;
      const speed = last.t > first.t ? (last.y - first.y) / (last.t - first.t) : 0;
      if (pullCloses(distance, speed, sheet.offsetHeight)) {
        sheet.style.setProperty("--sheet-dim", "0");
        settle(`translateY(${sheet.offsetHeight + 24}px)`, () => {
          sheet.close();
          reset();
        }, "0.2s cubic-bezier(0.3, 0, 0.8, 0.15)");
      } else {
        sheet.style.setProperty("--sheet-dim", "1");
        settle("translateY(0)", reset, "0.28s cubic-bezier(0.2, 0.8, 0.2, 1)");
      }
      distance = 0;
    };

    sheet.addEventListener("touchstart", onStart, { passive: true });
    sheet.addEventListener("touchmove", onMove, { passive: false });
    sheet.addEventListener("touchend", onEnd);
    sheet.addEventListener("touchcancel", onEnd);
    return () => {
      sheet.removeEventListener("touchstart", onStart);
      sheet.removeEventListener("touchmove", onMove);
      sheet.removeEventListener("touchend", onEnd);
      sheet.removeEventListener("touchcancel", onEnd);
      reset();
    };
  }, [ref]);
}

let nextMarker = 0;
/** A sheet that just closed, whose history entry is about to be stepped back over. */
let releasing: { marker: string; timer: number } | null = null;

/**
 * Back closes the sheet: while `open`, the sheet adds a history entry, and going back (the phone's
 * back gesture, the browser's Back) calls `close` instead of leaving the page. A sheet closed any
 * other way steps back over its entry, so history stays as it was. A sheet that closes and another
 * that opens in the same moment share one entry (this also covers React's development double run).
 */
export function useBackToClose(open: boolean, close: () => void): void {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open) return;
    let marker: string;
    const top = (window.history.state as { sheet?: string } | null)?.sheet;
    if (releasing && top === releasing.marker) {
      window.clearTimeout(releasing.timer);
      marker = releasing.marker;
      releasing = null;
    } else {
      marker = `sheet-${++nextMarker}`;
      window.history.pushState({ ...((window.history.state as object | null) ?? {}), sheet: marker }, "");
    }
    let popped = false;
    const onPop = () => {
      if ((window.history.state as { sheet?: string } | null)?.sheet === marker) return;
      popped = true;
      latest.current();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (popped || (window.history.state as { sheet?: string } | null)?.sheet !== marker) return;
      const timer = window.setTimeout(() => {
        if (releasing?.marker !== marker) return;
        releasing = null;
        if ((window.history.state as { sheet?: string } | null)?.sheet === marker) window.history.back();
      }, 0);
      releasing = { marker, timer };
    };
  }, [open]);
}
