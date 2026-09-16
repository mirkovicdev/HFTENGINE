/** Tiny DOM/text helpers for text-mode rendering. */

export const CW = 9; // character cell width in CSS px (VGA 9x16)
export const CH = 16;

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Coloured span; text is escaped. */
export function sp(cls: string, s: string): string {
  return `<span class="${cls}">${esc(s)}</span>`;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

const cache = new Map<string, string>();
export function cssVar(name: string): string {
  let v = cache.get(name);
  if (v === undefined) {
    v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    cache.set(name, v);
  }
  return v;
}

/** Text-mode progress bar of width w (0..1). */
export function bar(frac: number, w: number, full = "▓", empty = "░"): string {
  const n = Math.round(Math.max(0, Math.min(1, frac)) * w);
  return full.repeat(n) + empty.repeat(w - n);
}

/** Size a canvas to its CSS box (1 canvas px per CSS px; zoom scales it crisply). */
export function fitCanvas(c: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D {
  const W = Math.max(1, Math.floor(w));
  const H = Math.max(1, Math.floor(h));
  if (c.width !== W || c.height !== H) {
    c.width = W;
    c.height = H;
    c.style.width = `${W}px`;
    c.style.height = `${H}px`;
  }
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  return ctx;
}
