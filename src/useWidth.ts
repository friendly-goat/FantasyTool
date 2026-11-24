import { type RefObject, useEffect, useState } from "react";

/**
 * An element's width in pixels, followed as it changes. Charts draw at their real width with it,
 * so their labels stay readable on a phone instead of shrinking with the picture.
 */
export function useWidth(ref: RefObject<HTMLElement | null>, start = 640): number {
  const [width, setWidth] = useState(start);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(Math.max(280, Math.round(element.getBoundingClientRect().width)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
