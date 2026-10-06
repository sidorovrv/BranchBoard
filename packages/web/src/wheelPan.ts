const SCROLLABLE_OVERFLOW = /auto|scroll/;

const canScrollAlong = (element: Element, axis: "x" | "y", delta: number): boolean => {
  if (delta === 0) return false;
  const style = getComputedStyle(element);
  const isY = axis === "y";
  if (!SCROLLABLE_OVERFLOW.test(isY ? style.overflowY : style.overflowX)) return false;
  const position = isY ? element.scrollTop : element.scrollLeft;
  const maximum = isY ? element.scrollHeight - element.clientHeight : element.scrollWidth - element.clientWidth;
  return delta < 0 ? position > 0 : position < maximum - 1;
};

export const hasScrollableAncestor = (start: Element, boundary: Element, deltaX: number, deltaY: number): boolean => {
  for (let element: Element | null = start; element && element !== boundary; element = element.parentElement) {
    if (canScrollAlong(element, "y", deltaY) || canScrollAlong(element, "x", deltaX)) return true;
  }
  return false;
};

const LINE_HEIGHT_PX = 20;

export const wheelPixels = (event: WheelEvent): { x: number; y: number } => {
  const scale = event.deltaMode === 1 ? LINE_HEIGHT_PX : 1;
  return { x: event.deltaX * scale, y: event.deltaY * scale };
};
