/** Formatting helpers. All session times are nanoseconds relative to meta.t0_ns. */

export function pad(n: number, w: number, ch = "0"): string {
  let s = String(n);
  while (s.length < w) s = ch + s;
  return s;
}

/** Right-align a string in a field of width w (monospace tables). */
export function rj(s: string, w: number): string {
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

/** Left-align a string in a field of width w, truncating if needed. */
export function lj(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
}

/** Wall-clock "HH:MM:SS.mmm" (UTC) for a relative time, given the absolute t0 in ns (BigInt). */
export function clock(t0ns: bigint, relNs: number, withMicros = false): string {
  const abs = t0ns + BigInt(Math.floor(relNs));
  const ms = Number(abs / 1000000n);
  const d = new Date(ms);
  const base = `${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}.${pad(d.getUTCMilliseconds(), 3)}`;
  if (!withMicros) return base;
  const micros = Number((abs / 1000n) % 1000n);
  return base + pad(micros, 3);
}

export function dateOf(t0ns: bigint): string {
  const d = new Date(Number(t0ns / 1000000n));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}`;
}

/** "m:ss.t" elapsed from relative ns. */
export function elapsed(relNs: number): string {
  const s = Math.max(0, relNs) / 1e9;
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${pad(Math.floor(r), 2)}.${Math.floor((r % 1) * 10)}`;
}

/** Duration in ns -> compact human string with units chosen by magnitude. */
export function dur(ns: number): string {
  if (!Number.isFinite(ns)) return "-";
  const a = Math.abs(ns);
  if (a < 1e3) return `${ns.toFixed(0)}ns`;
  if (a < 1e6) return `${(ns / 1e3).toFixed(0)}us`;
  if (a < 1e9) return `${(ns / 1e6).toFixed(1)}ms`;
  if (a < 60e9) return `${(ns / 1e9).toFixed(2)}s`;
  const s = ns / 1e9;
  return `${Math.floor(s / 60)}m${pad(Math.floor(s % 60), 2)}s`;
}

export function ms(ns: number, digits = 1): string {
  if (!Number.isFinite(ns)) return "-";
  return (ns / 1e6).toFixed(digits);
}

export function num(v: number, digits: number): string {
  if (!Number.isFinite(v)) return "-";
  return v.toFixed(digits);
}

export function px(tick: number, tickSize: number, digits: number): string {
  return (tick * tickSize).toFixed(digits);
}

export function thousands(n: number): string {
  const s = Math.trunc(Math.abs(n)).toString();
  return (n < 0 ? "-" : "") + s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function percentile(sorted: Float64Array | number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const i = Math.min(n - 1, Math.max(0, Math.round((p / 100) * (n - 1))));
  return sorted[i];
}

/** Decimal digits needed to print prices for a tick size (0.1 -> 1, 0.001 -> 3). */
export function tickDigits(tickSize: number): number {
  let d = 0;
  let t = tickSize;
  while (d < 8 && Math.abs(Math.round(t) - t) > 1e-9) {
    t *= 10;
    d++;
  }
  return d;
}

/** Decimal digits for quantities from a lot size. */
export function lotDigits(lotSize: number): number {
  return tickDigits(lotSize);
}
