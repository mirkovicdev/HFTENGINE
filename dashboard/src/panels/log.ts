/** LOG: order lifecycle as the local side saw it — submissions, acceptances (with entry latency
 * and queue ahead), fills, cancels, post-only rejections. Newest at the bottom. */
import { sp } from "../dom";
import { clock, dur, lj, lotDigits, ms, tickDigits } from "../fmt";
import { EV, type Session } from "../session";
import { Panel, type RenderCtx } from "./base";

export class LogPanel extends Panel {
  private readonly pxd: number;
  private readonly qd: number;

  constructor(s: Session) {
    super("log", 7, "ORDER LOG", s);
    this.pxd = tickDigits(s.tickSize);
    this.qd = lotDigits(s.lotSize);
  }

  render(c: RenderCtx): void {
    const s = this.s;
    const evN = s.eventsUpTo(c.t);
    const key = `${evN}|${this.rows}|${this.cols}`;
    if (!this.changed(key)) return;
    const rows = this.rows;
    const out: string[] = [];
    for (let i = Math.max(0, evN - rows); i < evN; i++) {
      const k = s.eKind[i];
      const side = s.eSide[i] === 1 ? "BUY " : "SELL";
      const sideCls = s.eSide[i] === 1 ? "bid" : "ask";
      const px = (s.eTick[i] * s.tickSize).toFixed(this.pxd);
      const qty = s.eQty[i].toFixed(this.qd);
      const t = clock(s.t0, s.eT[i], true);
      const li = s.lifeIndexOfEvent[i];
      const life = li >= 0 ? s.lives[li] : null;
      let body = "";
      let kcls = "";
      switch (k) {
        case EV.SUBMIT:
          kcls = "w";
          body = sp(sideCls, side) + ` ${qty} @ ${px}` + sp("d", ` post-only limit → exchange`);
          break;
        case EV.ACK: {
          kcls = "g";
          const entry = s.eExchT[i] - s.eReqT[i];
          const resp = s.eT[i] - s.eExchT[i];
          const front = Math.max(0, s.eFront[i]);
          const level = s.eLevel[i];
          body =
            sp(sideCls, side) +
            ` @ ${px}` +
            sp("d", ` entry ${ms(entry, 1)}ms resp ${ms(resp, 1)}ms │ queue ahead `) +
            sp("c", Number.isFinite(front) ? front.toFixed(this.qd) : "?") +
            sp("d", Number.isFinite(level) ? ` of ${level.toFixed(this.qd)}` : "");
          break;
        }
        case EV.FILL: {
          kcls = "y";
          const rested = life && Number.isFinite(life.exchAckT) ? s.eExchT[i] - life.exchAckT : NaN;
          body =
            sp(sideCls, side) +
            ` ${qty} @ ${(s.eExecTick[i] * s.tickSize).toFixed(this.pxd)}` +
            sp("d", ` rested ${dur(rested)} │ traded at level ${Number.isFinite(s.eTradedAtLevel[i]) ? s.eTradedAtLevel[i].toFixed(this.qd) : "-"}`);
          break;
        }
        case EV.CANCEL_SENT:
          kcls = "d";
          body = sp(sideCls, side) + ` @ ${px}` + sp("d", " cancel → exchange");
          break;
        case EV.CANCELED: {
          kcls = "d";
          const rtt = s.eT[i] - s.eReqT[i];
          body = sp(sideCls, side) + ` @ ${px}` + sp("d", ` canceled, round trip ${ms(rtt, 1)}ms`);
          break;
        }
        case EV.EXPIRED: {
          kcls = "r";
          const entry = s.eExchT[i] - s.eReqT[i];
          body = sp(sideCls, side) + ` @ ${px}` + sp("d", ` rejected: post-only would cross after ${ms(entry, 1)}ms`);
          break;
        }
        case EV.CANCEL_REJECTED:
          kcls = "m";
          body = sp(sideCls, side) + ` @ ${px}` + sp("d", " cancel rejected (already gone)");
          break;
      }
      const name = k === EV.SUBMIT ? "NEW" : k === EV.ACK ? "ACK" : k === EV.FILL ? "FILL" : k === EV.CANCEL_SENT ? "CXL" : k === EV.CANCELED ? "CXLD" : k === EV.EXPIRED ? "REJ" : "CREJ";
      out.push(sp("d", t) + " " + sp(kcls, lj(name, 5)) + body);
    }
    this.body.innerHTML = out.join("\n");
    this.setTitle(`${evN} events`);
  }
}
