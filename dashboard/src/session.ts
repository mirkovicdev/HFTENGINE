/** Session model: typed-array views over a recording plus derived indices.
 *
 * All times are nanoseconds relative to meta.t0_ns (a BigInt absolute epoch).
 */
import type { Hbr } from "./hbr";

export const EV = {
  SUBMIT: 1,
  ACK: 2,
  FILL: 3,
  CANCEL_SENT: 4,
  CANCELED: 5,
  EXPIRED: 6,
  CANCEL_REJECTED: 7,
} as const;

export const EV_NAME: Record<number, string> = {
  1: "SUBMIT",
  2: "ACK",
  3: "FILL",
  4: "CANCEL",
  5: "CANCELED",
  6: "EXPIRED",
  7: "CXL REJ",
};

/** Order status codes as recorded (hftbacktest Status enum). */
export const ST = { NONE: 0, NEW: 1, EXPIRED: 2, FILLED: 3, CANCELED: 4, PARTIAL: 5, REJECTED: 6, REPLACED: 7 } as const;

export interface OrderLife {
  id: number;
  side: number; // 1 buy, -1 sell
  tick: number;
  qty: number;
  submitT: number;
  ackT: number; // local receipt of the acceptance, NaN if never acked
  exchAckT: number; // exchange processing time of the acceptance
  frontAtAck: number; // queue ahead when accepted (exchange estimate)
  levelAtAck: number; // level quantity when accepted
  fillT: number; // local receipt of the fill
  exchFillT: number; // exchange time of the fill
  execTick: number;
  fillQty: number;
  tradedAtLevel: number; // market qty traded at the level while resting
  frontAtFill: number;
  cancelSentT: number;
  canceledT: number;
  expiredT: number;
  exchExpiredT: number;
  touchT: number; // first opposite-side market trade at our price after exchAckT (exchange time)
  endT: number; // local time at which the order stopped being live
  outcome: "live" | "filled" | "canceled" | "expired";
}

export interface CollectorFacts {
  file: string;
  bytes: number;
  lines: number;
  first_ns: string;
  last_ns: string;
  streams: Record<string, number>;
  snapshots: number;
  rate_t0_s: number;
  rate: Record<string, number[]>;
  sample: { t: number; k: string; s: string; len: number }[];
  sample_every: number;
  source_file?: string;
  source_bytes?: number;
  npz?: Record<string, any>;
  order_latency?: Record<string, any>;
  truncated_stream_recovered?: boolean;
}

function arr<T extends keyof ArrayTypes>(h: Hbr, name: string): ArrayTypes[T] {
  const a = h.arrays.get(name);
  if (!a) throw new Error(`recording is missing array ${name}`);
  return a.data as ArrayTypes[T];
}

interface ArrayTypes {
  f64: Float64Array;
  f32: Float32Array;
  i32: Int32Array;
  u32: Uint32Array;
  i8: Int8Array;
  u8: Uint8Array;
}

export class Session {
  readonly meta: Record<string, any>;
  readonly t0: bigint;
  readonly tickSize: number;
  readonly lotSize: number;
  readonly frameNs: number;
  readonly levels: number;
  readonly nFrames: number;
  readonly endT: number;

  // frames
  readonly frameT: Float64Array;
  readonly bestBidTick: Int32Array;
  readonly bestAskTick: Int32Array;
  readonly bidTick: Int32Array;
  readonly bidQty: Float32Array;
  readonly askTick: Int32Array;
  readonly askQty: Float32Array;
  readonly position: Float32Array;
  readonly numTrades: Int32Array;
  readonly volume: Float32Array;
  readonly feedLast: Float32Array;
  readonly feedMin: Float32Array;
  readonly feedMax: Float32Array;
  readonly feedMean: Float32Array;
  readonly feedBatches: Uint32Array;
  readonly eventsLocal: Float64Array;
  readonly eventsExch: Float64Array;
  readonly wallMs: Float32Array;
  readonly orderStart: Uint32Array;
  // per-frame orders
  readonly oId: Float64Array;
  readonly oSide: Int8Array;
  readonly oTick: Int32Array;
  readonly oQty: Float32Array;
  readonly oLeaves: Float32Array;
  readonly oStatus: Uint8Array;
  readonly oReq: Uint8Array;
  readonly oFront: Float32Array;
  readonly oLevel: Float32Array;
  readonly oSubmitT: Float64Array;
  readonly oAckT: Float64Array;
  readonly oTradesAtLevel: Uint32Array;
  // market trades
  readonly trExchT: Float64Array;
  readonly trLocalT: Float64Array;
  readonly trTick: Int32Array;
  readonly trQty: Float32Array;
  readonly trSide: Int8Array;
  // order events
  readonly eT: Float64Array;
  readonly eKind: Uint8Array;
  readonly eId: Float64Array;
  readonly eSide: Int8Array;
  readonly eTick: Int32Array;
  readonly eQty: Float32Array;
  readonly eReqT: Float64Array;
  readonly eExchT: Float64Array;
  readonly eFront: Float32Array;
  readonly eLevel: Float32Array;
  readonly eExecTick: Int32Array;
  readonly eTradedAtLevel: Float32Array;

  /** Order lifecycles in submit order; `lifeIndexOfEvent[i]` maps event i to its order life. */
  readonly lives: OrderLife[] = [];
  readonly lifeIndexOfEvent: Int32Array;
  /** Fill events indices (into e_*), chronological. */
  readonly fillEvents: number[] = [];

  collector: CollectorFacts | null = null;

  constructor(h: Hbr) {
    this.meta = h.meta;
    this.t0 = BigInt(h.meta.t0_ns);
    this.tickSize = h.meta.tick_size;
    this.lotSize = h.meta.lot_size;
    this.frameNs = h.meta.frame_ns;
    this.levels = h.meta.levels;
    this.nFrames = h.meta.n_frames;

    this.frameT = arr<"f64">(h, "frame_t");
    this.bestBidTick = arr<"i32">(h, "best_bid_tick");
    this.bestAskTick = arr<"i32">(h, "best_ask_tick");
    this.bidTick = arr<"i32">(h, "bid_tick");
    this.bidQty = arr<"f32">(h, "bid_qty");
    this.askTick = arr<"i32">(h, "ask_tick");
    this.askQty = arr<"f32">(h, "ask_qty");
    this.position = arr<"f32">(h, "position");
    this.numTrades = arr<"i32">(h, "num_trades");
    this.volume = arr<"f32">(h, "volume");
    this.feedLast = arr<"f32">(h, "feed_lat_last");
    this.feedMin = arr<"f32">(h, "feed_lat_min");
    this.feedMax = arr<"f32">(h, "feed_lat_max");
    this.feedMean = arr<"f32">(h, "feed_lat_mean");
    this.feedBatches = arr<"u32">(h, "feed_batches");
    this.eventsLocal = arr<"f64">(h, "events_local");
    this.eventsExch = arr<"f64">(h, "events_exch");
    this.wallMs = arr<"f32">(h, "wall_ms");
    this.orderStart = arr<"u32">(h, "order_start");
    this.oId = arr<"f64">(h, "o_id");
    this.oSide = arr<"i8">(h, "o_side");
    this.oTick = arr<"i32">(h, "o_tick");
    this.oQty = arr<"f32">(h, "o_qty");
    this.oLeaves = arr<"f32">(h, "o_leaves");
    this.oStatus = arr<"u8">(h, "o_status");
    this.oReq = arr<"u8">(h, "o_req");
    this.oFront = arr<"f32">(h, "o_front");
    this.oLevel = arr<"f32">(h, "o_level");
    this.oSubmitT = arr<"f64">(h, "o_submit_t");
    this.oAckT = arr<"f64">(h, "o_ack_t");
    this.oTradesAtLevel = arr<"u32">(h, "o_trades_at_level");
    this.trExchT = arr<"f64">(h, "tr_exch_t");
    this.trLocalT = arr<"f64">(h, "tr_local_t");
    this.trTick = arr<"i32">(h, "tr_tick");
    this.trQty = arr<"f32">(h, "tr_qty");
    this.trSide = arr<"i8">(h, "tr_side");
    this.eT = arr<"f64">(h, "e_t");
    this.eKind = arr<"u8">(h, "e_kind");
    this.eId = arr<"f64">(h, "e_id");
    this.eSide = arr<"i8">(h, "e_side");
    this.eTick = arr<"i32">(h, "e_tick");
    this.eQty = arr<"f32">(h, "e_qty");
    this.eReqT = arr<"f64">(h, "e_req_t");
    this.eExchT = arr<"f64">(h, "e_exch_t");
    this.eFront = arr<"f32">(h, "e_front");
    this.eLevel = arr<"f32">(h, "e_level");
    this.eExecTick = arr<"i32">(h, "e_exec_tick");
    this.eTradedAtLevel = arr<"f32">(h, "e_traded_at_level");

    this.endT = this.frameT.length ? this.frameT[this.frameT.length - 1] : 0;
    this.lifeIndexOfEvent = new Int32Array(this.eT.length).fill(-1);
    this.buildLives();
  }

  // ---------------------------------------------------------------- derived
  private buildLives(): void {
    const open = new Map<number, number>(); // order id -> life index
    const n = this.eT.length;
    for (let i = 0; i < n; i++) {
      const k = this.eKind[i];
      const id = this.eId[i];
      if (k === EV.SUBMIT) {
        const life: OrderLife = {
          id,
          side: this.eSide[i],
          tick: this.eTick[i],
          qty: this.eQty[i],
          submitT: this.eT[i],
          ackT: NaN,
          exchAckT: NaN,
          frontAtAck: NaN,
          levelAtAck: NaN,
          fillT: NaN,
          exchFillT: NaN,
          execTick: 0,
          fillQty: NaN,
          tradedAtLevel: NaN,
          frontAtFill: NaN,
          cancelSentT: NaN,
          canceledT: NaN,
          expiredT: NaN,
          exchExpiredT: NaN,
          touchT: NaN,
          endT: NaN,
          outcome: "live",
        };
        open.set(id, this.lives.length);
        this.lifeIndexOfEvent[i] = this.lives.length;
        this.lives.push(life);
        continue;
      }
      const li = open.get(id);
      if (li === undefined) continue;
      this.lifeIndexOfEvent[i] = li;
      const life = this.lives[li];
      switch (k) {
        case EV.ACK:
          life.ackT = this.eT[i];
          life.exchAckT = this.eExchT[i];
          life.frontAtAck = this.eFront[i];
          life.levelAtAck = this.eLevel[i];
          break;
        case EV.FILL:
          life.fillT = this.eT[i];
          life.exchFillT = this.eExchT[i];
          life.execTick = this.eExecTick[i];
          life.fillQty = this.eQty[i];
          life.tradedAtLevel = this.eTradedAtLevel[i];
          life.frontAtFill = this.eFront[i];
          life.endT = this.eT[i];
          life.outcome = "filled";
          this.fillEvents.push(i);
          open.delete(id);
          break;
        case EV.CANCEL_SENT:
          life.cancelSentT = this.eT[i];
          break;
        case EV.CANCELED:
          life.canceledT = this.eT[i];
          life.endT = this.eT[i];
          life.outcome = "canceled";
          open.delete(id);
          break;
        case EV.EXPIRED:
          life.expiredT = this.eT[i];
          life.exchExpiredT = this.eExchT[i];
          life.endT = this.eT[i];
          life.outcome = "expired";
          open.delete(id);
          break;
        default:
          break;
      }
    }
    // touch time: first opposite-side trade at the order's price after exchange acceptance
    const byTick = new Map<number, number[]>();
    for (let i = 0; i < this.trTick.length; i++) {
      let list = byTick.get(this.trTick[i]);
      if (!list) {
        list = [];
        byTick.set(this.trTick[i], list);
      }
      list.push(i);
    }
    for (const list of byTick.values()) list.sort((a, b) => this.trExchT[a] - this.trExchT[b]);
    for (const life of this.lives) {
      if (!Number.isFinite(life.exchAckT)) continue;
      const list = byTick.get(life.tick);
      if (!list) continue;
      const limit = Number.isFinite(life.exchFillT) ? life.exchFillT : Infinity;
      // binary search first trade with exch_t >= exchAckT
      let lo = 0;
      let hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.trExchT[list[mid]] < life.exchAckT) lo = mid + 1;
        else hi = mid;
      }
      for (let j = lo; j < list.length; j++) {
        const ti = list[j];
        if (this.trExchT[ti] > limit) break;
        // a bid resting at our price is hit by sell-aggressor trades (side -1) and vice versa
        if (this.trSide[ti] === -life.side) {
          life.touchT = this.trExchT[ti];
          break;
        }
      }
    }
  }

  // ---------------------------------------------------------------- queries
  /** Index of the last frame whose time is <= t (0 if before the first). */
  frameAt(t: number): number {
    const f = Math.floor(t / this.frameNs);
    if (f < 0) return 0;
    if (f >= this.nFrames) return this.nFrames - 1;
    // guard against gaps: walk back while frameT[f] > t
    let i = f;
    while (i > 0 && this.frameT[i] > t) i--;
    return i;
  }

  /** Number of market trades with local receipt time <= t. */
  tradesUpTo(t: number): number {
    return upperBound(this.trLocalT, t);
  }

  /** Number of order events with time <= t. */
  eventsUpTo(t: number): number {
    return upperBound(this.eT, t);
  }

  /** Order rows [start, end) of frame f. */
  orderRange(f: number): [number, number] {
    return [this.orderStart[f], this.orderStart[f + 1]];
  }

  /** Book level quantity at a tick for a frame (0 if not among recorded levels). */
  bookAt(f: number): { bids: Map<number, number>; asks: Map<number, number> } {
    const bids = new Map<number, number>();
    const asks = new Map<number, number>();
    const L = this.levels;
    const base = f * L;
    for (let i = 0; i < L; i++) {
      const bt = this.bidTick[base + i];
      if (bt !== 0) bids.set(bt, this.bidQty[base + i]);
      const at = this.askTick[base + i];
      if (at !== 0) asks.set(at, this.askQty[base + i]);
    }
    return { bids, asks };
  }

  price(tick: number): number {
    return tick * this.tickSize;
  }
}

/** Number of elements <= x in a sorted array. */
export function upperBound(a: Float64Array, x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
