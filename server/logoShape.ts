// Makes NBA logos look the same size next to each other.
//
// The NBA's logo files leave very different amounts of empty space around the
// drawing (in Nov 2026 the drawn part filled from about 60% to 94% of the
// frame), and the drawings themselves range from wide wordmarks to tall
// crests. Shown in the same box, some looked small and others ran to the edge.
//
// So each logo is measured once, when it is downloaded: the box around what is
// drawn (paths, polygons, rects, circles, ellipses and lines, leaving out clip
// paths and masks). Its frame (viewBox) is then replaced by a square around
// that drawing, sized so every logo covers about the same area
// (AREA_FILL of a square box for a square logo) without running past
// EDGE_FILL of the box in either direction. A file the code cannot measure
// safely (transforms, nothing found) is served as it came.

/** Share of the box's side a square logo fills: the same area for every logo. */
export const AREA_FILL = 0.86;
/** The most of the box's width or height any logo fills, so none touches its neighbors. */
export const EDGE_FILL = 0.9;

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const empty = (): Box => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
const add = (box: Box, x: number, y: number) => {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  box.minX = Math.min(box.minX, x);
  box.minY = Math.min(box.minY, y);
  box.maxX = Math.max(box.maxX, x);
  box.maxY = Math.max(box.maxY, y);
};
const isEmpty = (box: Box) => !(box.maxX >= box.minX && box.maxY >= box.minY);

/** Roots in [0, 1] of a t² + b t + c. */
function unitRoots(a: number, b: number, c: number): number[] {
  const roots: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) roots.push(-c / b);
  } else {
    const d = b * b - 4 * a * c;
    if (d >= 0) {
      const s = Math.sqrt(d);
      roots.push((-b + s) / (2 * a), (-b - s) / (2 * a));
    }
  }
  return roots.filter((t) => t > 0 && t < 1);
}

function addCubic(box: Box, x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) {
  add(box, x0, y0);
  add(box, x3, y3);
  const at = (p0: number, p1: number, p2: number, p3: number, t: number) => {
    const u = 1 - t;
    return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
  };
  // Where the derivative of each coordinate is zero.
  const extremes = (p0: number, p1: number, p2: number, p3: number) =>
    unitRoots(3 * (-p0 + 3 * p1 - 3 * p2 + p3), 6 * (p0 - 2 * p1 + p2), 3 * (p1 - p0));
  for (const t of [...extremes(x0, x1, x2, x3), ...extremes(y0, y1, y2, y3)]) add(box, at(x0, x1, x2, x3, t), at(y0, y1, y2, y3, t));
}

function addQuadratic(box: Box, x0: number, y0: number, x1: number, y1: number, x2: number, y2: number) {
  // A quadratic is a cubic with control points two thirds of the way to its own.
  addCubic(box, x0, y0, x0 + (2 / 3) * (x1 - x0), y0 + (2 / 3) * (y1 - y0), x2 + (2 / 3) * (x1 - x2), y2 + (2 / 3) * (y1 - y2), x2, y2);
}

/** An elliptical arc from (x0, y0) to (x, y), in SVG's endpoint form. */
function addArc(box: Box, x0: number, y0: number, rxIn: number, ryIn: number, rotation: number, large: boolean, sweep: boolean, x: number, y: number) {
  add(box, x0, y0);
  add(box, x, y);
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0 || (x0 === x && y0 === y)) return;
  const phi = (rotation * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  // Centre form, as in the SVG specification (appendix B.2.4).
  const dx = (x0 - x) / 2;
  const dy = (y0 - y) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  const scale = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (scale > 1) {
    rx *= Math.sqrt(scale);
    ry *= Math.sqrt(scale);
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const factor = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (factor * rx * y1p) / ry;
  const cyp = (-factor * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x0 + x) / 2;
  const cy = sin * cxp + cos * cyp + (y0 + y) / 2;
  const angle = (ux: number, uy: number) => Math.atan2(uy, ux);
  const start = angle((x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angle((-x1p - cxp) / rx, (-y1p - cyp) / ry) - start;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  const point = (theta: number) => [
    cx + rx * Math.cos(theta) * cos - ry * Math.sin(theta) * sin,
    cy + rx * Math.cos(theta) * sin + ry * Math.sin(theta) * cos,
  ];
  // The angles where x or y is at its most, then those that fall on the arc.
  const tx = Math.atan2(-ry * sin, rx * cos);
  const ty = Math.atan2(ry * cos, rx * sin);
  for (const base of [tx, ty]) {
    for (let k = -4; k <= 4; k++) {
      const theta = base + k * Math.PI;
      const along = delta > 0 ? theta - start : start - theta;
      if (along > 0 && along < Math.abs(delta)) {
        const [px, py] = point(theta);
        add(box, px!, py!);
      }
    }
  }
}

const NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

/** The box around a path's `d`, with every SVG path command, absolute or relative. */
export function pathBox(d: string, box: Box = empty()): Box {
  const commands = d.match(/[MmLlHhVvCcSsQqTtAaZz][^MmLlHhVvCcSsQqTtAaZz]*/g) ?? [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  // The last control point, for S and T.
  let cx = 0;
  let cy = 0;
  let last = "";
  for (const command of commands) {
    const type = command[0]!;
    const upper = type.toUpperCase();
    const relative = type !== upper;
    const body = command.slice(1);
    // Arc flags may be written without separators ("a1 1 0 011 1").
    const values =
      upper === "A" ? arcNumbers(body) : (body.match(NUMBER) ?? []).map(Number);
    const take = (n: number) => values.splice(0, n);
    const ox = () => (relative ? x : 0);
    const oy = () => (relative ? y : 0);
    if (upper === "Z") {
      x = startX;
      y = startY;
      last = "Z";
      continue;
    }
    let first = true;
    do {
      switch (upper) {
        case "M": {
          const [px, py] = take(2);
          x = px! + ox();
          y = py! + oy();
          if (first) {
            startX = x;
            startY = y;
          }
          add(box, x, y);
          break;
        }
        case "L": {
          const [px, py] = take(2);
          x = px! + ox();
          y = py! + oy();
          add(box, x, y);
          break;
        }
        case "H": {
          x = take(1)[0]! + ox();
          add(box, x, y);
          break;
        }
        case "V": {
          y = take(1)[0]! + oy();
          add(box, x, y);
          break;
        }
        case "C": {
          const [a, b, c, e, f, g] = take(6);
          const x1 = a! + ox(), y1 = b! + oy(), x2 = c! + ox(), y2 = e! + oy(), nx = f! + ox(), ny = g! + oy();
          addCubic(box, x, y, x1, y1, x2, y2, nx, ny);
          cx = x2;
          cy = y2;
          x = nx;
          y = ny;
          break;
        }
        case "S": {
          const [c, e, f, g] = take(4);
          const smooth = last === "C" || last === "S";
          const x1 = smooth ? 2 * x - cx : x;
          const y1 = smooth ? 2 * y - cy : y;
          const x2 = c! + ox(), y2 = e! + oy(), nx = f! + ox(), ny = g! + oy();
          addCubic(box, x, y, x1, y1, x2, y2, nx, ny);
          cx = x2;
          cy = y2;
          x = nx;
          y = ny;
          break;
        }
        case "Q": {
          const [a, b, f, g] = take(4);
          const x1 = a! + ox(), y1 = b! + oy(), nx = f! + ox(), ny = g! + oy();
          addQuadratic(box, x, y, x1, y1, nx, ny);
          cx = x1;
          cy = y1;
          x = nx;
          y = ny;
          break;
        }
        case "T": {
          const [f, g] = take(2);
          const smooth = last === "Q" || last === "T";
          const x1 = smooth ? 2 * x - cx : x;
          const y1 = smooth ? 2 * y - cy : y;
          const nx = f! + ox(), ny = g! + oy();
          addQuadratic(box, x, y, x1, y1, nx, ny);
          cx = x1;
          cy = y1;
          x = nx;
          y = ny;
          break;
        }
        case "A": {
          const [rx, ry, rotation, large, sweep, f, g] = take(7);
          const nx = f! + ox(), ny = g! + oy();
          addArc(box, x, y, rx!, ry!, rotation!, large !== 0, sweep !== 0, nx, ny);
          x = nx;
          y = ny;
          break;
        }
      }
      // Extra pairs after a move are lines.
      last = upper === "M" ? "L" : upper;
      first = false;
    } while (values.length > 0 && !Number.isNaN(values[0]!));
    if (upper === "M") last = "M";
  }
  return box;
}

/** An arc's numbers, where the two flags may run together with what follows ("011 1"). */
function arcNumbers(body: string): number[] {
  const out: number[] = [];
  let rest = body;
  while (true) {
    for (let i = 0; i < 7; i++) {
      rest = rest.replace(/^[\s,]+/, "");
      if (rest === "") return out;
      if (i === 3 || i === 4) {
        const flag = rest[0]!;
        if (flag !== "0" && flag !== "1") return out;
        out.push(Number(flag));
        rest = rest.slice(1);
      } else {
        const match = rest.match(/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/);
        if (!match) return out;
        out.push(Number(match[0]));
        rest = rest.slice(match[0].length);
      }
    }
  }
}

const attribute = (tag: string, name: string): string | null => {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`));
  return match ? match[2]! : null;
};
const numberAttribute = (tag: string, name: string, fallback = 0) => {
  const value = attribute(tag, name);
  const parsed = value === null ? NaN : parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** The box around everything drawn in an SVG file, or null if it cannot be measured safely. */
export function contentBox(svg: string): Box | null {
  // Transforms would move shapes; these files have none, so a file with one is left as it is.
  if (/\stransform\s*=/.test(svg)) return null;
  const drawn = svg
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<clipPath[\s\S]*?<\/clipPath>/gi, "")
    .replace(/<mask[\s\S]*?<\/mask>/gi, "");
  const box = empty();
  for (const match of drawn.matchAll(/<(path|polygon|polyline|rect|circle|ellipse|line)\b[^>]*>/gi)) {
    const tag = match[0];
    switch (match[1]!.toLowerCase()) {
      case "path": {
        const d = attribute(tag, "d");
        if (d) pathBox(d, box);
        break;
      }
      case "polygon":
      case "polyline": {
        const points = (attribute(tag, "points")?.match(NUMBER) ?? []).map(Number);
        for (let i = 0; i + 1 < points.length; i += 2) add(box, points[i]!, points[i + 1]!);
        break;
      }
      case "rect": {
        const x = numberAttribute(tag, "x");
        const y = numberAttribute(tag, "y");
        add(box, x, y);
        add(box, x + numberAttribute(tag, "width"), y + numberAttribute(tag, "height"));
        break;
      }
      case "circle":
      case "ellipse": {
        const cx = numberAttribute(tag, "cx");
        const cy = numberAttribute(tag, "cy");
        const r = numberAttribute(tag, "r");
        const rx = numberAttribute(tag, "rx", r);
        const ry = numberAttribute(tag, "ry", r);
        add(box, cx - rx, cy - ry);
        add(box, cx + rx, cy + ry);
        break;
      }
      case "line":
        add(box, numberAttribute(tag, "x1"), numberAttribute(tag, "y1"));
        add(box, numberAttribute(tag, "x2"), numberAttribute(tag, "y2"));
        break;
    }
  }
  return isEmpty(box) ? null : box;
}

/** The square frame for a drawing: the same area for every logo, never past EDGE_FILL of the box. */
export function squareFrame(box: Box): { x: number; y: number; side: number } {
  const width = box.maxX - box.minX;
  const height = box.maxY - box.minY;
  const side = Math.max(Math.max(width, height) / EDGE_FILL, Math.sqrt(width * height) / AREA_FILL);
  return { x: (box.minX + box.maxX) / 2 - side / 2, y: (box.minY + box.maxY) / 2 - side / 2, side };
}

/** The logo with its frame replaced by the square around its drawing; as it came if it cannot be measured. */
export function normalizeLogo(svg: string): string {
  const box = contentBox(svg);
  if (!box) return svg;
  const { x, y, side } = squareFrame(box);
  if (!(side > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return svg;
  const round = (value: number) => Number(value.toFixed(2));
  const viewBox = `${round(x)} ${round(y)} ${round(side)} ${round(side)}`;
  return svg.replace(/<svg\b[^>]*>/i, (tag) => {
    const cleaned = tag
      .replace(/\s(viewBox|width|height|preserveAspectRatio)\s*=\s*(["'])[\s\S]*?\2/gi, "")
      .replace(/\s*(\/?)>$/, "");
    return `${cleaned} viewBox="${viewBox}">`;
  });
}
