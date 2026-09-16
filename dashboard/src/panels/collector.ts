/** COLLECTOR: the raw websocket recording behind the session — file facts, message rate per stream,
 * and the raw lines that arrived at the moment being replayed (sampled). */
import { CH, CW, cssVar, el, fitCanvas, sp } from "../dom";
import { bytes, clock, lj, rj, thousands } from "../fmt";
import type { Session } from "../session";
import { Panel, type RenderCtx } from "./base";

const STREAM_COLORS: Record<string, string> = {
  "depth@0ms": "--cyan",
  trade: "--yellow",
  bookTicker: "--green",
  "depth snapshot (REST)": "--magenta",
};
const STREAM_LABEL: Record<string, string> = {
  "depth@0ms": "depth",
  trade: "trade",
  bookTicker: "bookTicker",
  "depth snapshot (REST)": "snapshot",
};
const STREAM_CLS: Record<string, string> = {
  "depth@0ms": "c",
  trade: "y",
  bookTicker: "g",
  "depth snapshot (REST)": "m",
};

export class CollectorPanel extends Panel {
  private readonly head: HTMLElement;
  private readonly rate: HTMLCanvasElement;
  private readonly tail: HTMLElement;

  constructor(s: Session) {
    super("collector", 9, "COLLECTOR", s);
    this.head = el("div", "", this.body);
    this.rate = el("canvas", "", this.body);
    this.tail = el("div", "", this.body);
  }

  render(c: RenderCtx): void {
    const s = this.s;
    const col = s.collector;
    const key = `${Math.floor(c.t / 1e8)}|${this.rows}|${this.cols}`;
    if (!this.changed(key)) return;
    if (!col) {
      this.head.innerHTML = sp("d", "no collector facts for this session");
      this.setTitle("");
      return;
    }
    const cols = this.cols;
    const W = cols * CW;
    const rows = this.rows;
    const t0 = s.t0;
    const nowAbs = t0 + BigInt(Math.floor(c.t));
    const nowSec = Number(nowAbs / 1000000000n);

    const streams = Object.keys(col.streams).sort();
    const h: string[] = [];
    h.push(sp("d", lj("RAW", 6)) + sp("c", col.source_file ?? col.file) + sp("d", ` ${bytes(col.source_bytes ?? col.bytes)} gz │ ${thousands(col.lines)} messages`));
    h.push(sp("d", lj("", 6)) + streams.map((k) => sp(STREAM_CLS[k] ?? "", STREAM_LABEL[k] ?? k) + sp("d", ` ${thousands(col.streams[k])}  `)).join(""));
    if (col.npz) {
      h.push(sp("d", lj("NPZ", 6)) + sp("", `${col.npz.file} ${bytes(col.npz.bytes)} │ ${thousands(col.npz.rows)} events`) + sp("d", ` │ feed latency p50 ${col.npz.feed_latency_ms_p50.toFixed(1)}ms p99 ${col.npz.feed_latency_ms_p99.toFixed(1)}ms`));
    }
    // current rates
    const idx = nowSec - col.rate_t0_s;
    const cur = streams
      .filter((k) => k !== "depth snapshot (REST)")
      .map((k) => `${STREAM_LABEL[k] ?? k} ${rj(String(idx >= 0 && idx < (col.rate[k]?.length ?? 0) ? col.rate[k][idx] : 0), 4)}/s`)
      .join("  ");
    h.push(sp("d", lj("RATE", 6)) + sp("w", cur));
    this.head.innerHTML = h.join("\n");

    // rate chart: last 120 s, stacked per stream
    const chartRows = Math.max(3, Math.min(5, Math.floor(rows / 4)));
    const ctx = fitCanvas(this.rate, W, chartRows * CH);
    const H = this.rate.height;
    ctx.fillStyle = cssVar("--blue-dark");
    ctx.fillRect(0, 0, W, H);
    const span = Math.min(120, W);
    let vmax = 1;
    for (let i = 0; i < span; i++) {
      const j = idx - span + 1 + i;
      let tot = 0;
      for (const k of streams) tot += col.rate[k]?.[j] ?? 0;
      vmax = Math.max(vmax, tot);
    }
    const px = Math.max(1, Math.floor(W / span));
    for (let i = 0; i < span; i++) {
      const j = idx - span + 1 + i;
      if (j < 0) continue;
      let yBase = H;
      for (const k of streams) {
        const v = col.rate[k]?.[j] ?? 0;
        if (!v) continue;
        const hh = Math.max(1, Math.round((v / vmax) * (H - 2)));
        ctx.fillStyle = cssVar(STREAM_COLORS[k] ?? "--gray");
        ctx.fillRect(i * px, yBase - hh, px, hh);
        yBase -= hh;
      }
    }
    ctx.fillStyle = cssVar("--gray");
    ctx.font = "8px EGA8";
    ctx.textBaseline = "top";
    ctx.fillText(`${vmax} msg/s`, 2, 2);
    ctx.fillText("-120s", 2, H - 9);

    // raw tail: sampled lines received up to now
    const tailRows = rows - 4 - chartRows;
    const lines: string[] = [];
    const samples = col.sample;
    // binary search by t (absolute ns as number is fine for ordering)
    let lo = 0;
    let hi = samples.length;
    const nowNum = Number(nowAbs);
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (samples[mid].t <= nowNum) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo - 1; i >= 0 && lines.length < tailRows; i--) {
      const smp = samples[i];
      const rel = smp.t - Number(t0);
      const kind = STREAM_LABEL[smp.k] ?? smp.k;
      const c2 = STREAM_CLS[smp.k] ?? "";
      const prefix = `${clock(t0, rel, true)} ${lj(kind, 10)} `;
      const room = Math.max(8, cols - prefix.length - 1);
      lines.unshift(sp("d", clock(t0, rel, true) + " ") + sp(c2, lj(kind, 10)) + " " + sp("", smp.s.slice(0, room)));
    }
    this.tail.innerHTML = lines.join("\n");
    this.setTitle(`1 of ${col.sample_every} messages shown │ ${col.snapshots} REST snapshot${col.snapshots === 1 ? "" : "s"}`);
  }
}
