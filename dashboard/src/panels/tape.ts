/** TAPE: market trades from the recorded feed, newest first, with our fills interleaved. */
import { sp } from "../dom";
import { clock, lj, lotDigits, rj, tickDigits } from "../fmt";
import { EV, type Session } from "../session";
import { Panel, type RenderCtx } from "./base";

export class TapePanel extends Panel {
  private readonly pxd: number;
  private readonly qd: number;

  constructor(s: Session) {
    super("tape", 6, "TRADES", s);
    this.pxd = tickDigits(s.tickSize);
    this.qd = lotDigits(s.lotSize);
  }

  render(c: RenderCtx): void {
    const s = this.s;
    const n = s.tradesUpTo(c.t);
    const evN = s.eventsUpTo(c.t);
    const key = `${n}|${evN}|${this.rows}|${this.cols}`;
    if (!this.changed(key)) return;
    const rows = this.rows;
    type Row = { t: number; html: string };
    const list: Row[] = [];
    const wide = this.cols >= 44;
    for (let i = n - 1; i >= 0 && list.length < rows; i--) {
      const side = s.trSide[i];
      const cls = side === 1 ? "bid" : "ask";
      const t = s.trLocalT[i];
      const tag = side === 1 ? "BUY " : "SELL";
      const line =
        sp("d", clock(s.t0, s.trExchT[i])) +
        " " +
        sp(cls, rj((s.trTick[i] * s.tickSize).toFixed(this.pxd), 9)) +
        " " +
        sp("w", rj(s.trQty[i].toFixed(this.qd), 8)) +
        " " +
        sp(cls, tag) +
        (wide ? sp("d", `  rx +${((s.trLocalT[i] - s.trExchT[i]) / 1e6).toFixed(1)}ms`) : "");
      list.push({ t, html: line });
    }
    const tMin = list.length ? list[list.length - 1].t : -Infinity;
    for (let i = evN - 1; i >= 0; i--) {
      if (s.eKind[i] !== EV.FILL) continue;
      const t = s.eT[i];
      if (t < tMin) break;
      const side = s.eSide[i];
      const line = `<span class="sel">${lj(
        `${clock(s.t0, Number.isFinite(s.eExchT[i]) ? s.eExchT[i] : t)} ${rj((s.eExecTick[i] * s.tickSize).toFixed(this.pxd), 9)} ${rj(
          s.eQty[i].toFixed(this.qd),
          8,
        )} OUR ${side === 1 ? "BUY " : "SELL"} FILLED`,
        Math.max(1, this.cols - 1),
      )}</span>`;
      list.push({ t, html: line });
    }
    list.sort((a, b) => b.t - a.t);
    this.body.innerHTML = list
      .slice(0, rows)
      .map((r) => r.html)
      .join("\n");
    // 1-minute trade rate
    const f0 = s.tradesUpTo(c.t - 60e9);
    this.setTitle(`${n} trades │ ${((n - f0) / 60).toFixed(1)}/s`);
  }
}
