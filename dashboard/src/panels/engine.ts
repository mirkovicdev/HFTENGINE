/** ENGINE: what is being replayed — data files, models, strategy parameters, run statistics, and
 * replay progress. Every value comes from the recording's metadata. */
import { bar, sp } from "../dom";
import { bytes, clock, lj, thousands } from "../fmt";
import type { Session } from "../session";
import { Panel, type RenderCtx } from "./base";

export class EnginePanel extends Panel {
  constructor(s: Session) {
    super("engine", 8, "ENGINE", s);
  }

  render(c: RenderCtx): void {
    const s = this.s;
    const f = c.f;
    const key = `${f}|${this.rows}|${this.cols}|${c.playing}|${c.speed}`;
    if (!this.changed(key)) return;
    const m = s.meta;
    const cols = this.cols;
    const L = (k: string, v: string) => sp("d", lj(k, 10)) + v;
    const lines: string[] = [];
    lines.push(L("ENGINE", sp("w", `${m.engine.name} ${m.engine.crate_version}`) + sp("d", ` rust crate │ ${m.engine.rustc}`)));
    lines.push(L("MARKET", sp("w", `${m.symbol}`) + sp("d", ` ${m.exchange} │ tick ${m.tick_size} lot ${m.lot_size}`)));
    for (const d of m.data_files ?? []) {
      lines.push(L("DATA", sp("c", d.name) + sp("d", ` ${bytes(d.bytes)} │ ${thousands(d.rows)} rows`)));
      lines.push(L("", sp("d", `${d.first_local_iso.slice(0, 19).replace("T", " ")} → ${d.last_local_iso.slice(11, 19)} UTC │ ${thousands(d.trade_rows)} trades`)));
    }
    lines.push(L("SNAPSHOT", sp("", m.initial_snapshot ?? "reconstructed from feed")));
    const lat = m.models.latency;
    const latSrc = Array.isArray(lat.source) ? lat.source.join(", ") : lat.source ?? `${lat.entry_us / 1000}/${lat.response_us / 1000} ms`;
    lines.push(L("LATENCY", sp("w", lat.kind) + sp("d", ` ← ${latSrc}`)));
    const ol = s.collector?.order_latency;
    if (ol) {
      lines.push(
        L(
          "",
          sp("d", `order latency = feed latency × ${ol.mul_entry} (entry) / × ${ol.mul_resp} (response), interpolated │ p50 entry ${ol.entry_ms_p50.toFixed(0)}ms resp ${ol.resp_ms_p50.toFixed(0)}ms`),
        ),
      );
    }
    const q = m.models.queue;
    lines.push(L("QUEUE", sp("w", q.kind + (q.n !== undefined ? ` n=${q.n}` : "")) + sp("d", ` │ ${m.models.exchange}`)));
    lines.push(L("FEES", sp("", `${m.models.fee.kind} maker ${(m.models.fee.maker * 100).toFixed(4)}% taker ${(m.models.fee.taker * 100).toFixed(2)}%`)));
    const st = m.strategy;
    lines.push(
      L(
        "STRATEGY",
        sp("d", "hftbacktest tutorial ") +
          sp("w", st.kind === "queue" ? "Queue-Based Market Making in Large Tick Size Assets" : "High-Frequency Grid Trading"),
      ),
    );
    lines.push(
      L(
        "",
        sp("d", `${st.grid_num} levels/side × ${st.order_qty} │ half spread ${Number(st.half_spread_ticks).toFixed(2)}t │ grid ${st.grid_interval_ticks}t │ skew ${Number(st.skew_ticks).toFixed(3)}t │ ${st.time_in_force} ${st.order_type} │ ${st.decision_interval_ms}ms`),
      ),
    );
    lines.push(L("", sp("d", `fair price: ${st.fair_price ?? "mid"} │ max position ${st.max_position}`)));
    const r = m.run;
    lines.push(
      L(
        "RUN",
        sp("w", `${thousands(r.events_total)} events`) +
          sp("d", ` in ${(r.wall_ms / 1000).toFixed(1)}s wall → `) +
          sp("c", `${thousands(Math.round(r.events_per_wall_sec))}/s`) +
          sp("d", ` │ ${thousands(r.submits)} orders, ${thousands(r.cancels)} cancels, ${thousands(r.fills)} fills`),
      ),
    );
    const done = s.eventsLocal[f] + s.eventsExch[f];
    const frac = r.events_total ? done / r.events_total : 0;
    lines.push(
      L(
        "REPLAY",
        sp("w", clock(s.t0, c.t, true) + " UTC") +
          sp("d", ` │ frame ${f + 1}/${s.nFrames} │ ${c.playing ? "►" : "‖"} x${c.speed}`),
      ),
    );
    lines.push(L("", sp("d", `${thousands(done)} / ${thousands(r.events_total)} events `) + sp("c", bar(frac, Math.max(8, cols - 12 - 30))) + sp("d", ` ${(frac * 100).toFixed(1)}%`)));
    lines.push(L("", sp("d", `engine wall clock at this frame ${(s.wallMs[f] / 1000).toFixed(2)}s │ sim/wall ${((s.frameT[f] / 1e9) / Math.max(0.001, s.wallMs[f] / 1000)).toFixed(0)}x`)));
    this.body.innerHTML = lines.slice(0, this.rows).join("\n");
    this.setTitle(`${m.engine.runner}`);
  }
}
