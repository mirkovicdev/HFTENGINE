/** BOOK: price ladder (DOM). Local view of the order book with our resting orders and, for each of
 * them, the exchange-side queue estimate split into ahead | ours | behind.
 *
 * mode "levels": one row per populated level (plus levels holding our orders) — dense.
 * mode "ticks":  one row per tick around the touch, empty ticks shown empty — classic DOM.
 */
import { CW, esc, sp } from "../dom";
import { lotDigits, num, tickDigits } from "../fmt";
import { ST, type Session } from "../session";
import { Panel, type RenderCtx } from "./base";

const OURS_W = 7;
const QTY_W = 9;
const PX_W = 10;

export type LadderMode = "levels" | "ticks";

export class BookPanel extends Panel {
  private readonly pxd: number;
  private readonly qd: number;
  mode: LadderMode = "levels";

  constructor(s: Session) {
    super("book", 1, "BOOK", s);
    this.pxd = tickDigits(s.tickSize);
    this.qd = lotDigits(s.lotSize);
    this.body.classList.add("ladder");
    const m = new URLSearchParams(location.search).get("ladder");
    if (m === "ticks" || m === "levels") this.mode = m;
  }

  render(c: RenderCtx): void {
    const s = this.s;
    const f = c.f;
    const tradeN = s.tradesUpTo(c.t);
    // recent trades (last 250 ms) flash their price cell; our fills (last 600 ms) flash yellow
    const hits = new Map<number, number>();
    for (let i = tradeN - 1; i >= 0 && s.trLocalT[i] > c.t - 150e6; i--) hits.set(s.trTick[i], s.trSide[i]);
    const evN = s.eventsUpTo(c.t);
    const fills = new Set<number>();
    for (let i = evN - 1; i >= 0 && s.eT[i] > c.t - 600e6; i--) if (s.eKind[i] === 3) fills.add(s.eExecTick[i]);
    const rows = this.rows;
    const key = `${f}|${rows}|${this.cols}|${this.mode}|${[...hits.keys()].join(",")}|${[...fills].join(",")}`;
    if (!this.changed(key)) return;
    // centre the 46-column ladder in the panel
    const padCols = Math.max(0, Math.floor((this.cols - (OURS_W + 1 + QTY_W + 1 + PX_W + 1 + QTY_W + 1 + OURS_W)) / 2));
    this.body.style.paddingLeft = `${(padCols + 1) * CW}px`;

    const bb = s.bestBidTick[f];
    const ba = s.bestAskTick[f];
    const { bids, asks } = s.bookAt(f);
    const [o0, o1] = s.orderRange(f);
    const ours = new Map<number, { qty: number; leaves: number; front: number; level: number; status: number; req: number; side: number }>();
    for (let i = o0; i < o1; i++) {
      ours.set(s.oTick[i], {
        qty: s.oQty[i],
        leaves: s.oLeaves[i],
        front: s.oFront[i],
        level: s.oLevel[i],
        status: s.oStatus[i],
        req: s.oReq[i],
        side: s.oSide[i],
      });
    }

    const nAsk = Math.floor((rows - 1) / 2);
    const nBid = rows - 1 - nAsk;

    // rows to show per side
    let askTicks: number[];
    let bidTicks: number[];
    if (this.mode === "ticks") {
      askTicks = [];
      bidTicks = [];
      if (ba) for (let i = 0; i < nAsk; i++) askTicks.push(ba + i);
      if (bb) for (let i = 0; i < nBid; i++) bidTicks.push(bb - i);
    } else {
      const aset = new Set<number>(asks.keys());
      const bset = new Set<number>(bids.keys());
      for (const [t, o] of ours) {
        if (o.side === -1) aset.add(t);
        else bset.add(t);
      }
      askTicks = [...aset].filter((t) => !ba || t >= ba).sort((a, b) => a - b).slice(0, nAsk);
      bidTicks = [...bset].filter((t) => !bb || t <= bb).sort((a, b) => b - a).slice(0, nBid);
    }

    // scale bars to the largest visible level (sqrt so small levels stay visible)
    let maxQ = 0;
    for (const t of askTicks) maxQ = Math.max(maxQ, asks.get(t) ?? 0);
    for (const t of bidTicks) maxQ = Math.max(maxQ, bids.get(t) ?? 0);
    if (maxQ <= 0) maxQ = 1;
    const barW = (OURS_W + 1 + QTY_W) * CW;
    const widthOf = (q: number) => Math.round(Math.sqrt(Math.min(1, q / maxQ)) * barW);
    const leftBarRight = (OURS_W + 1 + QTY_W) * CW;
    const rightBarLeft = (OURS_W + 1 + QTY_W + 1 + PX_W + 1) * CW;
    const spreadTicks = bb && ba ? ba - bb : NaN;
    const mid = bb && ba ? ((bb + ba) / 2) * s.tickSize : NaN;

    const out: string[] = [];
    const row = (tick: number, side: 1 | -1, isBest: boolean) => {
      const q = side === -1 ? asks.get(tick) ?? 0 : bids.get(tick) ?? 0;
      const o = ours.get(tick);
      const hit = hits.get(tick);
      const w = widthOf(q);
      let bars = "";
      if (o && o.side === side && o.status === ST.NEW && Number.isFinite(o.front)) {
        // split the level bar: ahead (exchange estimate) | ours | behind
        const front = Math.max(0, o.front);
        const mine = Math.max(0, o.leaves);
        const behind = Math.max(0, q - front - mine);
        const tot = Math.max(q, front + mine + behind, 1e-12);
        const wTot = Math.max(widthOf(tot), 3 * CW);
        const wA = Math.round((front / tot) * wTot);
        const wM = Math.max(3, Math.round((mine / tot) * wTot));
        const wB = Math.max(0, wTot - wA - wM);
        if (side === 1) {
          bars += `<i class="bar ahead" style="left:${leftBarRight - wA}px;width:${wA}px"></i>`;
          bars += `<i class="bar ours" style="left:${leftBarRight - wA - wM}px;width:${wM}px"></i>`;
          bars += `<i class="bar bid" style="left:${leftBarRight - wA - wM - wB}px;width:${wB}px"></i>`;
        } else {
          bars += `<i class="bar ahead" style="left:${rightBarLeft}px;width:${wA}px"></i>`;
          bars += `<i class="bar ours" style="left:${rightBarLeft + wA}px;width:${wM}px"></i>`;
          bars += `<i class="bar ask" style="left:${rightBarLeft + wA + wM}px;width:${wB}px"></i>`;
        }
      } else if (q > 0) {
        if (side === 1) bars += `<i class="bar bid" style="left:${leftBarRight - w}px;width:${w}px"></i>`;
        else bars += `<i class="bar ask" style="left:${rightBarLeft}px;width:${w}px"></i>`;
      }
      const pxs = (tick * s.tickSize).toFixed(this.pxd);
      const qs = q > 0 ? q.toFixed(this.qd) : "";
      let oursTxt = " ".repeat(OURS_W);
      let oursCls = "ours";
      if (o) {
        const pending = o.status === ST.NONE;
        const cxl = o.req === 4;
        const glyph = pending ? "»" : cxl ? "«" : " ";
        oursTxt = (glyph + o.leaves.toFixed(this.qd)).padStart(OURS_W);
        oursCls = pending || cxl ? "d" : "ours";
      }
      const pxCls = o ? "ours" : isBest ? "w" : side === 1 ? "bid" : "ask";
      const pxHtml = fills.has(tick)
        ? `<span class="fill-flash">${esc(pxs.padStart(PX_W))}</span>`
        : hit !== undefined
          ? `<span class="hit">${esc(pxs.padStart(PX_W))}</span>`
          : sp(pxCls, pxs.padStart(PX_W));
      // quantity text sits on top of the bar; on a split (queue) bar use white for contrast
      const qtyCls = o && o.side === side && o.status === ST.NEW ? "w" : side === 1 ? "bid" : "ask";
      let txt: string;
      if (side === 1) {
        txt = sp(oursCls, oursTxt) + " " + sp(qtyCls, qs.padStart(QTY_W)) + " " + pxHtml;
      } else {
        txt = " ".repeat(OURS_W + 1 + QTY_W + 1) + pxHtml + " " + sp(qtyCls, qs.padEnd(QTY_W)) + " " + sp(oursCls, oursTxt.trimStart().padEnd(OURS_W));
      }
      out.push(`<div class="row${isBest ? " best" : ""}">${bars}<div class="txt">${txt}</div></div>`);
    };

    for (let i = askTicks.length - 1; i >= 0; i--) row(askTicks[i], -1, askTicks[i] === ba);
    for (let i = askTicks.length; i < nAsk; i++) out.unshift(`<div class="row"></div>`);
    const spreadTxt = Number.isFinite(spreadTicks)
      ? `${" ".repeat(OURS_W + 1)}${("spread " + spreadTicks + (spreadTicks === 1 ? " tick" : " ticks")).padStart(QTY_W + 1 + 3)}${("mid " + mid.toFixed(this.pxd + 1)).padStart(PX_W + 6)}`
      : "  no book";
    out.push(`<div class="row spread">${esc(spreadTxt)}</div>`);
    for (let i = 0; i < bidTicks.length; i++) row(bidTicks[i], 1, bidTicks[i] === bb);
    this.body.innerHTML = out.join("");

    const bq = bids.get(bb) ?? 0;
    const aq = asks.get(ba) ?? 0;
    this.setTitle(`${num(bq, this.qd)} x ${num(aq, this.qd)} @ ${(bb * s.tickSize).toFixed(this.pxd)}/${(ba * s.tickSize).toFixed(this.pxd)}`);
  }
}
