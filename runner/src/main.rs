//! hftengine runner: runs a grid market-making strategy (the one from hftbacktest's own examples,
//! `hftbacktest/examples/algo.rs` / "High-Frequency Grid Trading" tutorial) inside the hftbacktest
//! engine and records what the engine sees and decides, frame by frame, into a `.hbr` session file.
//!
//! Nothing shown by the dashboard is computed here from anything but engine state:
//! the local order book, the local order map, the exchange-side queue estimate of each resting
//! order (via the QueueModel wrapper in `queue.rs`), market trades, feed latency samples and
//! order request/exchange/response timestamps.

mod queue;
mod record;

use std::{
    cell::RefCell,
    collections::HashMap,
    path::{Path, PathBuf},
    rc::Rc,
    time::Instant,
};

use anyhow::{Context, Result, anyhow, bail};
use clap::Parser;
use hftbacktest::{
    backtest::{
        Backtest, DataSource, ExchangeKind, L2AssetBuilder,
        assettype::LinearAsset,
        data::{Data, read_npz_file},
        models::{
            CommonFees, ConstantLatency, IntpOrderLatency, LatencyModel, LogProbQueueFunc2,
            PowerProbQueueFunc, PowerProbQueueFunc2, PowerProbQueueFunc3, ProbQueueModel,
            RiskAdverseQueueModel, TradingValueFeeModel,
        },
    },
    prelude::{
        ApplySnapshot, BUY_EVENT, Bot, EXCH_EVENT, ElapseResult, Event, HashMapMarketDepth,
        INVALID_MAX, INVALID_MIN, LOCAL_EVENT, MarketDepth, OrdType, Order, SELL_EVENT, Side,
        Status, TRADE_EVENT, TimeInForce,
    },
};
use serde_json::json;

use crate::{
    queue::{RecordingQueueModel, SharedQueue},
    record::Recording,
};

/// Order lifecycle event kinds written to the recording (mirrored in the dashboard).
const EV_SUBMIT: u8 = 1;
const EV_ACK: u8 = 2;
const EV_FILL: u8 = 3;
const EV_CANCEL_SENT: u8 = 4;
const EV_CANCELED: u8 = 5;
const EV_EXPIRED: u8 = 6;
const EV_CANCEL_REJECTED: u8 = 7;

#[derive(Parser, Debug, Clone)]
#[command(version, about)]
struct Args {
    /// Normalized feed data files (.npz, key "data"), in chronological order.
    #[arg(long, required = true, num_args = 1..)]
    data: Vec<PathBuf>,

    /// Optional initial market depth snapshot (.npz, key "data").
    #[arg(long)]
    snapshot: Option<PathBuf>,

    /// Historical order latency data for IntpOrderLatency (.npz, key "data"), chronological.
    #[arg(long, num_args = 1..)]
    latency: Option<Vec<PathBuf>>,

    /// Constant order latency in microseconds "entry,response" (used when --latency is absent).
    #[arg(long, value_delimiter = ',', num_args = 2)]
    const_latency_us: Option<Vec<i64>>,

    #[arg(long, default_value = "BTCUSDT")]
    symbol: String,

    #[arg(long, default_value = "Binance USDT-M Futures")]
    exchange: String,

    #[arg(long, default_value_t = 0.1)]
    tick_size: f64,

    #[arg(long, default_value_t = 0.001)]
    lot_size: f64,

    /// Output session file (.hbr).
    #[arg(long, required = true)]
    out: PathBuf,

    /// Frame interval in milliseconds of simulated time (also the strategy's decision interval).
    #[arg(long, default_value_t = 100)]
    frame_ms: i64,

    /// Number of book levels per side recorded each frame.
    #[arg(long, default_value_t = 24)]
    levels: usize,

    /// Stop after this many minutes of simulated time (0 = whole data).
    #[arg(long, default_value_t = 0.0)]
    max_minutes: f64,

    // ---- strategy (hftbacktest examples) ----
    /// queue: joins the best bid/ask queue with book-pressure fair price and inventory skew
    ///        ("Queue-Based Market Making in Large Tick Size Assets" tutorial: half spread 0.49 tick,
    ///        grid interval 1 tick).
    /// grid:  grid market making with inventory skew ("High-Frequency Grid Trading" tutorial).
    #[arg(long, default_value = "queue")]
    strategy: String,

    #[arg(long, default_value_t = 0.002)]
    order_qty: f64,

    /// Half spread in ticks (grid strategy only; the queue strategy uses 0.49).
    #[arg(long, default_value_t = 1.0)]
    half_spread_ticks: f64,

    /// Grid interval in ticks (grid strategy only; the queue strategy uses 1).
    #[arg(long, default_value_t = 5.0)]
    grid_interval_ticks: f64,

    #[arg(long, default_value_t = 5)]
    grid_num: usize,

    /// grid strategy: reservation price skew in ticks per unit of normalized position.
    /// queue strategy: skew_adj multiplier of the tutorial (skew = half_spread / grid_num * skew_adj).
    #[arg(long, default_value_t = 1.0)]
    skew_ticks: f64,

    /// Maximum absolute position; defaults to grid_num * order_qty.
    #[arg(long)]
    max_position: Option<f64>,

    // ---- models ----
    /// Queue position model: power3 | power | power2 | log2 | riskadverse
    #[arg(long, default_value = "power3")]
    queue_model: String,

    #[arg(long, default_value_t = 3.0)]
    queue_n: f64,

    #[arg(long, default_value_t = -0.00005)]
    maker_fee: f64,

    #[arg(long, default_value_t = 0.0007)]
    taker_fee: f64,
}

#[derive(Clone)]
enum Latency {
    Const(ConstantLatency),
    Intp(IntpOrderLatency),
}

impl LatencyModel for Latency {
    fn entry(&mut self, timestamp: i64, order: &Order) -> i64 {
        match self {
            Latency::Const(m) => m.entry(timestamp, order),
            Latency::Intp(m) => m.entry(timestamp, order),
        }
    }

    fn response(&mut self, timestamp: i64, order: &Order) -> i64 {
        match self {
            Latency::Const(m) => m.response(timestamp, order),
            Latency::Intp(m) => m.response(timestamp, order),
        }
    }
}

/// What the local side last knew about an order (to detect state transitions at response time).
#[derive(Clone, Copy, PartialEq)]
struct Seen {
    status: Status,
    req: Status,
    exch_ts: i64,
}

#[derive(Clone, Copy)]
struct OrderMeta {
    submit_t: i64,
    ack_t: i64,
    exch_ack_t: i64,
}

#[derive(Default)]
struct Buffers {
    // frames
    frame_t: Vec<f64>,
    best_bid_tick: Vec<i32>,
    best_ask_tick: Vec<i32>,
    bid_tick: Vec<i32>,
    bid_qty: Vec<f32>,
    ask_tick: Vec<i32>,
    ask_qty: Vec<f32>,
    position: Vec<f32>,
    num_trades: Vec<i32>,
    volume: Vec<f32>,
    feed_lat_last: Vec<f32>,
    feed_lat_min: Vec<f32>,
    feed_lat_max: Vec<f32>,
    feed_lat_mean: Vec<f32>,
    feed_batches: Vec<u32>,
    events_local: Vec<f64>,
    events_exch: Vec<f64>,
    wall_ms: Vec<f32>,
    order_start: Vec<u32>,
    // per-frame order rows
    o_id: Vec<f64>,
    o_side: Vec<i8>,
    o_tick: Vec<i32>,
    o_qty: Vec<f32>,
    o_leaves: Vec<f32>,
    o_status: Vec<u8>,
    o_req: Vec<u8>,
    o_front: Vec<f32>,
    o_level: Vec<f32>,
    o_submit_t: Vec<f64>,
    o_ack_t: Vec<f64>,
    o_trades_at_level: Vec<u32>,
    // market trades
    tr_exch_t: Vec<f64>,
    tr_local_t: Vec<f64>,
    tr_tick: Vec<i32>,
    tr_qty: Vec<f32>,
    tr_side: Vec<i8>,
    // order lifecycle events
    e_t: Vec<f64>,
    e_kind: Vec<u8>,
    e_id: Vec<f64>,
    e_side: Vec<i8>,
    e_tick: Vec<i32>,
    e_qty: Vec<f32>,
    e_req_t: Vec<f64>,
    e_exch_t: Vec<f64>,
    e_front: Vec<f32>,
    e_level: Vec<f32>,
    e_exec_tick: Vec<i32>,
    e_traded_at_level: Vec<f32>,
}

struct FeedStats {
    last: f64,
    min: f64,
    max: f64,
    sum: f64,
    n: u32,
}

impl FeedStats {
    fn new() -> Self {
        Self { last: f64::NAN, min: f64::INFINITY, max: f64::NEG_INFINITY, sum: 0.0, n: 0 }
    }
}

struct DataFileInfo {
    path: String,
    bytes: u64,
    rows: usize,
    local_rows: usize,
    exch_rows: usize,
    trade_rows: usize,
    first_local_ts: i64,
    last_local_ts: i64,
}

fn main() -> Result<()> {
    let args = Args::parse();
    let t_start = Instant::now();

    // ---- scan the feed data once for counters (progress / events processed) ----
    let mut local_ts: Vec<i64> = Vec::new();
    let mut exch_ts: Vec<i64> = Vec::new();
    let mut files = Vec::new();
    for p in &args.data {
        let path = p.to_string_lossy().to_string();
        let d: Data<Event> = read_npz_file(&path, "data").with_context(|| format!("reading {path}"))?;
        let mut info = DataFileInfo {
            path: path.clone(),
            bytes: std::fs::metadata(p)?.len(),
            rows: d.len(),
            local_rows: 0,
            exch_rows: 0,
            trade_rows: 0,
            first_local_ts: i64::MAX,
            last_local_ts: i64::MIN,
        };
        for i in 0..d.len() {
            let ev = &d[i];
            if ev.ev & LOCAL_EVENT == LOCAL_EVENT {
                local_ts.push(ev.local_ts);
                info.local_rows += 1;
                info.first_local_ts = info.first_local_ts.min(ev.local_ts);
                info.last_local_ts = info.last_local_ts.max(ev.local_ts);
            }
            if ev.ev & EXCH_EVENT == EXCH_EVENT {
                exch_ts.push(ev.exch_ts);
                info.exch_rows += 1;
            }
            if ev.ev & 0xff == TRADE_EVENT {
                info.trade_rows += 1;
            }
        }
        eprintln!(
            "data {path}: {} rows ({} local, {} exch, {} trades)",
            info.rows, info.local_rows, info.exch_rows, info.trade_rows
        );
        files.push(info);
    }
    local_ts.sort_unstable();
    exch_ts.sort_unstable();

    let snapshot: Option<Data<Event>> = match &args.snapshot {
        Some(p) => Some(read_npz_file(&p.to_string_lossy(), "data").context("reading snapshot")?),
        None => None,
    };

    // ---- models ----
    let latency = match (&args.latency, &args.const_latency_us) {
        (Some(ps), _) => Latency::Intp(IntpOrderLatency::new(
            ps.iter().map(|p| DataSource::File(p.to_string_lossy().to_string())).collect(),
            0,
        )),
        (None, Some(v)) if v.len() == 2 => {
            Latency::Const(ConstantLatency::new(v[0] * 1000, v[1] * 1000))
        }
        _ => bail!("provide --latency <npz> or --const-latency-us <entry>,<response>"),
    };
    let latency_desc = match (&args.latency, &args.const_latency_us) {
        (Some(ps), _) => json!({
            "kind": "IntpOrderLatency",
            "source": ps.iter().map(|p| p.file_name().map(|s| s.to_string_lossy().to_string())).collect::<Vec<_>>(),
        }),
        (None, Some(v)) => json!({ "kind": "ConstantLatency", "entry_us": v[0], "response_us": v[1] }),
        _ => unreachable!(),
    };

    let shared: SharedQueue = Rc::new(RefCell::new(HashMap::new()));
    let qm_desc;
    let tick = args.tick_size;
    let lot = args.lot_size;
    let snap = snapshot.clone();
    let depth_builder = move || {
        let mut d = HashMapMarketDepth::new(tick, lot);
        if let Some(s) = &snap {
            d.apply_snapshot(s);
        }
        d
    };

    macro_rules! build_with {
        ($qm:expr) => {{
            let asset = L2AssetBuilder::new()
                .data(args.data.iter().map(|p| DataSource::File(p.to_string_lossy().to_string())).collect())
                .latency_model(latency.clone())
                .asset_type(LinearAsset::new(1.0))
                .fee_model(TradingValueFeeModel::new(CommonFees::new(args.maker_fee, args.taker_fee)))
                .exchange(ExchangeKind::NoPartialFillExchange)
                .last_trades_capacity(50_000)
                .queue_model(RecordingQueueModel::new($qm, shared.clone()))
                .depth(depth_builder.clone())
                .build()
                .map_err(|e| anyhow!("asset build error: {e:?}"))?;
            Backtest::builder()
                .add_asset(asset)
                .build()
                .map_err(|e| anyhow!("backtest build error: {e:?}"))?
        }};
    }

    let mut hbt: Backtest<HashMapMarketDepth> = match args.queue_model.as_str() {
        "power3" => {
            qm_desc = json!({ "kind": "PowerProbQueueModel3", "n": args.queue_n });
            build_with!(ProbQueueModel::<PowerProbQueueFunc3, HashMapMarketDepth>::new(
                PowerProbQueueFunc3::new(args.queue_n)
            ))
        }
        "power" => {
            qm_desc = json!({ "kind": "PowerProbQueueModel", "n": args.queue_n });
            build_with!(ProbQueueModel::<PowerProbQueueFunc, HashMapMarketDepth>::new(
                PowerProbQueueFunc::new(args.queue_n)
            ))
        }
        "power2" => {
            qm_desc = json!({ "kind": "PowerProbQueueModel2", "n": args.queue_n });
            build_with!(ProbQueueModel::<PowerProbQueueFunc2, HashMapMarketDepth>::new(
                PowerProbQueueFunc2::new(args.queue_n)
            ))
        }
        "log2" => {
            qm_desc = json!({ "kind": "LogProbQueueModel2" });
            build_with!(ProbQueueModel::<LogProbQueueFunc2, HashMapMarketDepth>::new(
                LogProbQueueFunc2::new()
            ))
        }
        "riskadverse" => {
            qm_desc = json!({ "kind": "RiskAdverseQueueModel" });
            build_with!(RiskAdverseQueueModel::<HashMapMarketDepth>::new())
        }
        other => bail!("unknown queue model {other}"),
    };

    // ---- strategy parameters ----
    let order_qty = args.order_qty;
    let queue_strategy = match args.strategy.as_str() {
        "queue" => true,
        "grid" => false,
        other => bail!("unknown strategy {other}"),
    };
    let grid_num = args.grid_num;
    let (half_spread, grid_interval, skew) = if queue_strategy {
        let hs = tick * 0.49;
        (hs, tick, hs / grid_num as f64 * args.skew_ticks)
    } else {
        (
            args.half_spread_ticks * tick,
            (args.grid_interval_ticks).round().max(1.0) * tick,
            args.skew_ticks * tick,
        )
    };
    let max_position = args.max_position.unwrap_or(grid_num as f64 * order_qty);
    let frame_ns = args.frame_ms * 1_000_000;
    let levels = args.levels;

    // ---- run ----
    let mut b = Buffers::default();
    let mut seen: HashMap<u64, Seen> = HashMap::new();
    let mut meta: HashMap<u64, OrderMeta> = HashMap::new();
    let mut feed = FeedStats::new();
    let mut last_lat: Option<(i64, i64, i64)> = None;

    // Initialise the event set and land on the first event timestamp.
    match hbt.elapse(0)? {
        ElapseResult::EndOfData => bail!("no data"),
        _ => {}
    }
    let first_ts = hbt.current_timestamp();
    let t0 = (first_ts / frame_ns + 1) * frame_ns;
    let t_stop = if args.max_minutes > 0.0 {
        t0 + (args.max_minutes * 60.0 * 1e9) as i64
    } else {
        i64::MAX
    };
    let rel = |ts: i64| -> f64 { (ts - t0) as f64 };
    let mut next_frame = t0;
    let mut n_submits = 0u64;
    let mut n_cancels = 0u64;
    let mut last_progress = Instant::now();

    'run: loop {
        let now = hbt.current_timestamp();
        if now >= next_frame {
            // ---------------- frame boundary: record, then act ----------------
            if now >= t_stop {
                break 'run;
            }
            hbt.clear_inactive_orders(Some(0));
            seen.retain(|id, _| hbt.orders(0).contains_key(id));
            {
                let live: Vec<u64> = hbt.orders(0).keys().copied().collect();
                meta.retain(|id, _| live.contains(id));
                shared.borrow_mut().retain(|id, s| live.contains(id) && !s.filled);
            }

            let (bb, ba, best_bid, best_ask, best_bid_qty, best_ask_qty) = {
                let d = hbt.depth(0);
                (d.best_bid_tick(), d.best_ask_tick(), d.best_bid(), d.best_ask(), d.best_bid_qty(), d.best_ask_qty())
            };
            let book_ok = bb != INVALID_MIN && ba != INVALID_MAX;

            record_frame(&mut b, &hbt, now, rel(now), levels, &shared, &meta, &feed, &local_ts, &exch_ts, t_start);
            feed = FeedStats::new();

            // market trades since the previous frame
            for tr in hbt.last_trades(0) {
                b.tr_exch_t.push(rel(tr.exch_ts));
                b.tr_local_t.push(rel(tr.local_ts));
                b.tr_tick.push((tr.px / tick).round() as i32);
                b.tr_qty.push(tr.qty as f32);
                b.tr_side.push(if tr.ev & BUY_EVENT == BUY_EVENT { 1 } else if tr.ev & SELL_EVENT == SELL_EVENT { -1 } else { 0 });
            }
            hbt.clear_last_trades(Some(0));

            if book_ok {
                // ---------------- grid market making with inventory skew ----------------
                // fair price: mid for the grid strategy, book pressure (micro-price) for the queue
                // strategy, exactly as in the tutorials.
                let fair = if queue_strategy && best_bid_qty + best_ask_qty > 0.0 {
                    (best_bid * best_ask_qty + best_ask * best_bid_qty) / (best_bid_qty + best_ask_qty)
                } else {
                    (best_bid + best_ask) / 2.0
                };
                let position = hbt.position(0);
                let normalized_position = position / order_qty;
                let reservation = fair - skew * normalized_position;
                let mut bid_price = (reservation - half_spread).min(best_bid);
                let mut ask_price = (reservation + half_spread).max(best_ask);
                bid_price = (bid_price / grid_interval).floor() * grid_interval;
                ask_price = (ask_price / grid_interval).ceil() * grid_interval;

                let mut new_bids: HashMap<u64, f64> = HashMap::new();
                if position < max_position && bid_price.is_finite() {
                    for _ in 0..grid_num {
                        let t = (bid_price / tick).round() as u64;
                        new_bids.insert(t, t as f64 * tick);
                        bid_price -= grid_interval;
                    }
                }
                let mut new_asks: HashMap<u64, f64> = HashMap::new();
                if position > -max_position && ask_price.is_finite() {
                    for _ in 0..grid_num {
                        let t = (ask_price / tick).round() as u64;
                        new_asks.insert(t, t as f64 * tick);
                        ask_price += grid_interval;
                    }
                }

                let cancel_ids: Vec<(u64, Side, i64, f64)> = hbt
                    .orders(0)
                    .values()
                    .filter(|o| {
                        o.cancellable()
                            && ((o.side == Side::Buy && !new_bids.contains_key(&o.order_id))
                                || (o.side == Side::Sell && !new_asks.contains_key(&o.order_id)))
                    })
                    .map(|o| (o.order_id, o.side, o.price_tick, o.leaves_qty))
                    .collect();
                for (id, side, ptick, leaves) in cancel_ids {
                    hbt.cancel(0, id, false)?;
                    n_cancels += 1;
                    push_event(&mut b, rel(now), EV_CANCEL_SENT, id, side, ptick, leaves, rel(now), f64::NAN, &shared, 0);
                }

                let mut to_submit: Vec<(u64, f64, Side)> = new_bids
                    .iter()
                    .filter(|(id, _)| !hbt.orders(0).contains_key(id))
                    .map(|(id, px)| (*id, *px, Side::Buy))
                    .collect();
                to_submit.extend(
                    new_asks
                        .iter()
                        .filter(|(id, _)| !hbt.orders(0).contains_key(id))
                        .map(|(id, px)| (*id, *px, Side::Sell)),
                );
                // deterministic order: best prices first
                to_submit.sort_by(|a, c| match (a.2, c.2) {
                    (Side::Buy, Side::Buy) => c.0.cmp(&a.0),
                    (Side::Sell, Side::Sell) => a.0.cmp(&c.0),
                    (Side::Buy, _) => std::cmp::Ordering::Less,
                    _ => std::cmp::Ordering::Greater,
                });
                for (id, px, side) in to_submit {
                    let r = match side {
                        Side::Buy => hbt.submit_buy_order(0, id, px, order_qty, TimeInForce::GTX, OrdType::Limit, false),
                        _ => hbt.submit_sell_order(0, id, px, order_qty, TimeInForce::GTX, OrdType::Limit, false),
                    };
                    if r.is_err() {
                        continue;
                    }
                    n_submits += 1;
                    meta.insert(id, OrderMeta { submit_t: now, ack_t: 0, exch_ack_t: 0 });
                    seen.insert(id, Seen { status: Status::None, req: Status::New, exch_ts: 0 });
                    push_event(&mut b, rel(now), EV_SUBMIT, id, side, id as i64, order_qty, rel(now), f64::NAN, &shared, 0);
                }
            }

            next_frame += frame_ns;
            if last_progress.elapsed().as_secs() >= 5 {
                last_progress = Instant::now();
                eprintln!(
                    "sim {} | frames {} | orders {} | fills {} | wall {:.1}s",
                    fmt_ts(now),
                    b.frame_t.len(),
                    n_submits,
                    b.e_kind.iter().filter(|k| **k == EV_FILL).count(),
                    t_start.elapsed().as_secs_f64()
                );
            }
            continue;
        }

        // ---------------- advance to the next feed batch / order response / frame ----------------
        match hbt.wait_next_feed(true, next_frame - now)? {
            ElapseResult::EndOfData => break 'run,
            ElapseResult::MarketFeed => {
                if let Some((ets, lts)) = hbt.feed_latency(0) {
                    let l = (lts - ets) as f64 / 1e6;
                    feed.last = l;
                    feed.min = feed.min.min(l);
                    feed.max = feed.max.max(l);
                    feed.sum += l;
                    feed.n += 1;
                }
            }
            ElapseResult::OrderResponse => {
                let ts = hbt.current_timestamp();
                if let Some(lat) = hbt.order_latency(0) {
                    if last_lat != Some(lat) {
                        last_lat = Some(lat);
                    }
                }
                // detect transitions
                let mut changes: Vec<(u64, Seen, Seen, Side, i64, f64, f64, i64, i64, f64)> = Vec::new();
                for (id, o) in hbt.orders(0).iter() {
                    let cur = Seen { status: o.status, req: o.req, exch_ts: o.exch_timestamp };
                    let prev = seen.get(id).copied().unwrap_or(Seen { status: Status::None, req: Status::None, exch_ts: 0 });
                    if prev != cur {
                        changes.push((*id, prev, cur, o.side, o.price_tick, o.qty, o.leaves_qty, o.exec_price_tick, o.local_timestamp, o.exec_qty));
                        seen.insert(*id, cur);
                    }
                }
                for (id, prev, cur, side, ptick, qty, leaves, exec_tick, local_ts_o, exec_qty) in changes {
                    let req_t = rel(local_ts_o);
                    let exch_t = if cur.exch_ts > 0 { rel(cur.exch_ts) } else { f64::NAN };
                    if prev.status == Status::None && cur.status == Status::New {
                        if let Some(m) = meta.get_mut(&id) {
                            m.ack_t = ts;
                            m.exch_ack_t = cur.exch_ts;
                        }
                        push_event(&mut b, rel(ts), EV_ACK, id, side, ptick, qty, req_t, exch_t, &shared, 0);
                    } else if cur.status == Status::Filled && prev.status != Status::Filled {
                        push_event(&mut b, rel(ts), EV_FILL, id, side, ptick, exec_qty, req_t, exch_t, &shared, exec_tick);
                    } else if cur.status == Status::Canceled && prev.status != Status::Canceled {
                        push_event(&mut b, rel(ts), EV_CANCELED, id, side, ptick, leaves, req_t, exch_t, &shared, 0);
                    } else if cur.status == Status::Expired && prev.status != Status::Expired {
                        push_event(&mut b, rel(ts), EV_EXPIRED, id, side, ptick, qty, req_t, exch_t, &shared, 0);
                    } else if prev.req == Status::Canceled && cur.req == Status::None && cur.status == Status::New {
                        push_event(&mut b, rel(ts), EV_CANCEL_REJECTED, id, side, ptick, leaves, req_t, exch_t, &shared, 0);
                    }
                }
            }
            ElapseResult::Ok => {}
        }
    }

    let t_end = hbt.current_timestamp();
    let wall = t_start.elapsed();
    hbt.close()?;

    let n_frames = b.frame_t.len();
    b.order_start.push(b.o_id.len() as u32);
    let fills = b.e_kind.iter().filter(|k| **k == EV_FILL).count();
    let events_total = local_ts.len() + exch_ts.len();
    eprintln!(
        "done: {n_frames} frames, {} order events, {fills} fills, {} trades, wall {:.1}s, {:.0} events/s",
        b.e_kind.len(),
        b.tr_tick.len(),
        wall.as_secs_f64(),
        events_total as f64 / wall.as_secs_f64()
    );

    // ---- write ----
    let mut rec = Recording::default();
    rec.f64("frame_t", &b.frame_t, 1);
    rec.i32("best_bid_tick", &b.best_bid_tick, 1);
    rec.i32("best_ask_tick", &b.best_ask_tick, 1);
    rec.i32("bid_tick", &b.bid_tick, levels);
    rec.f32("bid_qty", &b.bid_qty, levels);
    rec.i32("ask_tick", &b.ask_tick, levels);
    rec.f32("ask_qty", &b.ask_qty, levels);
    rec.f32("position", &b.position, 1);
    rec.i32("num_trades", &b.num_trades, 1);
    rec.f32("volume", &b.volume, 1);
    rec.f32("feed_lat_last", &b.feed_lat_last, 1);
    rec.f32("feed_lat_min", &b.feed_lat_min, 1);
    rec.f32("feed_lat_max", &b.feed_lat_max, 1);
    rec.f32("feed_lat_mean", &b.feed_lat_mean, 1);
    rec.u32("feed_batches", &b.feed_batches, 1);
    rec.f64("events_local", &b.events_local, 1);
    rec.f64("events_exch", &b.events_exch, 1);
    rec.f32("wall_ms", &b.wall_ms, 1);
    rec.u32("order_start", &b.order_start, 1);
    rec.f64("o_id", &b.o_id, 1);
    rec.i8("o_side", &b.o_side, 1);
    rec.i32("o_tick", &b.o_tick, 1);
    rec.f32("o_qty", &b.o_qty, 1);
    rec.f32("o_leaves", &b.o_leaves, 1);
    rec.u8("o_status", &b.o_status, 1);
    rec.u8("o_req", &b.o_req, 1);
    rec.f32("o_front", &b.o_front, 1);
    rec.f32("o_level", &b.o_level, 1);
    rec.f64("o_submit_t", &b.o_submit_t, 1);
    rec.f64("o_ack_t", &b.o_ack_t, 1);
    rec.u32("o_trades_at_level", &b.o_trades_at_level, 1);
    rec.f64("tr_exch_t", &b.tr_exch_t, 1);
    rec.f64("tr_local_t", &b.tr_local_t, 1);
    rec.i32("tr_tick", &b.tr_tick, 1);
    rec.f32("tr_qty", &b.tr_qty, 1);
    rec.i8("tr_side", &b.tr_side, 1);
    rec.f64("e_t", &b.e_t, 1);
    rec.u8("e_kind", &b.e_kind, 1);
    rec.f64("e_id", &b.e_id, 1);
    rec.i8("e_side", &b.e_side, 1);
    rec.i32("e_tick", &b.e_tick, 1);
    rec.f32("e_qty", &b.e_qty, 1);
    rec.f64("e_req_t", &b.e_req_t, 1);
    rec.f64("e_exch_t", &b.e_exch_t, 1);
    rec.f32("e_front", &b.e_front, 1);
    rec.f32("e_level", &b.e_level, 1);
    rec.i32("e_exec_tick", &b.e_exec_tick, 1);
    rec.f32("e_traded_at_level", &b.e_traded_at_level, 1);

    let meta_json = json!({
        "format": "hftengine-session/1",
        "generated_at": chrono::Utc::now().to_rfc3339(),
        "symbol": args.symbol,
        "exchange": args.exchange,
        "tick_size": tick,
        "lot_size": lot,
        "t0_ns": t0.to_string(),
        "t0_iso": fmt_ts(t0),
        "t_end_ns": t_end.to_string(),
        "t_end_iso": fmt_ts(t_end),
        "frame_ns": frame_ns,
        "n_frames": n_frames,
        "levels": levels,
        "data_files": files.iter().map(|f| json!({
            "path": f.path,
            "name": Path::new(&f.path).file_name().map(|s| s.to_string_lossy().to_string()),
            "bytes": f.bytes,
            "rows": f.rows,
            "local_rows": f.local_rows,
            "exch_rows": f.exch_rows,
            "trade_rows": f.trade_rows,
            "first_local_iso": fmt_ts(f.first_local_ts),
            "last_local_iso": fmt_ts(f.last_local_ts),
        })).collect::<Vec<_>>(),
        "initial_snapshot": args.snapshot.as_ref().map(|p| p.file_name().map(|s| s.to_string_lossy().to_string())),
        "models": {
            "latency": latency_desc,
            "queue": qm_desc,
            "exchange": "NoPartialFillExchange",
            "fee": { "kind": "TradingValueFeeModel", "maker": args.maker_fee, "taker": args.taker_fee },
            "asset": { "kind": "LinearAsset", "contract_size": 1.0 },
            "depth": "HashMapMarketDepth",
        },
        "strategy": {
            "kind": args.strategy,
            "name": if queue_strategy {
                "queue-based market making: book-pressure fair price, inventory skew (hftbacktest tutorial)"
            } else {
                "grid market making with inventory skew (hftbacktest tutorial)"
            },
            "order_qty": order_qty,
            "half_spread_ticks": half_spread / tick,
            "grid_interval_ticks": grid_interval / tick,
            "grid_num": grid_num,
            "skew_ticks": skew / tick,
            "fair_price": if queue_strategy { "book pressure (best_bid*ask_qty + best_ask*bid_qty)/(bid_qty+ask_qty)" } else { "mid" },
            "max_position": max_position,
            "time_in_force": "GTX",
            "order_type": "LIMIT",
            "decision_interval_ms": args.frame_ms,
        },
        "run": {
            "wall_ms": wall.as_millis() as u64,
            "sim_ns": (t_end - t0).to_string(),
            "events_total": events_total,
            "events_local": local_ts.len(),
            "events_exch": exch_ts.len(),
            "events_per_wall_sec": events_total as f64 / wall.as_secs_f64(),
            "frames": n_frames,
            "submits": n_submits,
            "cancels": n_cancels,
            "fills": fills,
            "order_events": b.e_kind.len(),
            "market_trades": b.tr_tick.len(),
        },
        "engine": {
            "name": "hftbacktest",
            "crate_version": "0.9.4",
            "rustc": rustc_version(),
            "runner": "hftengine-runner 0.1.0",
            "os": std::env::consts::OS,
        },
        "event_kinds": { "1": "SUBMIT", "2": "ACK", "3": "FILL", "4": "CANCEL_SENT", "5": "CANCELED", "6": "EXPIRED", "7": "CANCEL_REJECTED" },
    });
    if let Some(parent) = args.out.parent() {
        std::fs::create_dir_all(parent)?;
    }
    rec.write(&args.out, meta_json)?;
    eprintln!("wrote {}", args.out.display());
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn record_frame(
    b: &mut Buffers,
    hbt: &Backtest<HashMapMarketDepth>,
    now: i64,
    now_rel: f64,
    levels: usize,
    shared: &SharedQueue,
    meta: &HashMap<u64, OrderMeta>,
    feed: &FeedStats,
    local_ts: &[i64],
    exch_ts: &[i64],
    t_start: Instant,
) {
    let depth = hbt.depth(0);
    let bb = depth.best_bid_tick();
    let ba = depth.best_ask_tick();
    b.frame_t.push(now_rel);
    b.best_bid_tick.push(if bb == INVALID_MIN { 0 } else { bb as i32 });
    b.best_ask_tick.push(if ba == INVALID_MAX { 0 } else { ba as i32 });

    // book ladder: `levels` non-empty levels per side, best first, scanning at most 5000 ticks
    let mut n = 0;
    if bb != INVALID_MIN {
        let mut t = bb;
        while n < levels && t > bb - 5000 {
            let q = depth.bid_qty_at_tick(t);
            if q > 0.0 {
                b.bid_tick.push(t as i32);
                b.bid_qty.push(q as f32);
                n += 1;
            }
            t -= 1;
        }
    }
    while n < levels {
        b.bid_tick.push(0);
        b.bid_qty.push(0.0);
        n += 1;
    }
    n = 0;
    if ba != INVALID_MAX {
        let mut t = ba;
        while n < levels && t < ba + 5000 {
            let q = depth.ask_qty_at_tick(t);
            if q > 0.0 {
                b.ask_tick.push(t as i32);
                b.ask_qty.push(q as f32);
                n += 1;
            }
            t += 1;
        }
    }
    while n < levels {
        b.ask_tick.push(0);
        b.ask_qty.push(0.0);
        n += 1;
    }

    let sv = hbt.state_values(0);
    b.position.push(sv.position as f32);
    b.num_trades.push(sv.num_trades as i32);
    b.volume.push(sv.trading_volume as f32);

    b.feed_lat_last.push(feed.last as f32);
    b.feed_lat_min.push(if feed.n > 0 { feed.min as f32 } else { f32::NAN });
    b.feed_lat_max.push(if feed.n > 0 { feed.max as f32 } else { f32::NAN });
    b.feed_lat_mean.push(if feed.n > 0 { (feed.sum / feed.n as f64) as f32 } else { f32::NAN });
    b.feed_batches.push(feed.n);
    b.events_local.push(local_ts.partition_point(|&x| x <= now) as f64);
    b.events_exch.push(exch_ts.partition_point(|&x| x <= now) as f64);
    b.wall_ms.push(t_start.elapsed().as_secs_f64() as f32 * 1000.0);

    b.order_start.push(b.o_id.len() as u32);
    let t0 = now - now_rel as i64;
    let q = shared.borrow();
    let mut orders: Vec<&Order> = hbt.orders(0).values().collect();
    orders.sort_by_key(|o| std::cmp::Reverse(o.price_tick));
    for o in orders {
        b.o_id.push(o.order_id as f64);
        b.o_side.push(match o.side { Side::Buy => 1, Side::Sell => -1, _ => 0 });
        b.o_tick.push(o.price_tick as i32);
        b.o_qty.push(o.qty as f32);
        b.o_leaves.push(o.leaves_qty as f32);
        b.o_status.push(o.status as u8);
        b.o_req.push(o.req as u8);
        match q.get(&o.order_id) {
            Some(s) => {
                b.o_front.push(s.front as f32);
                b.o_level.push(s.level as f32);
                b.o_trades_at_level.push(s.trades_at_level);
            }
            None => {
                b.o_front.push(f32::NAN);
                b.o_level.push(f32::NAN);
                b.o_trades_at_level.push(0);
            }
        }
        match meta.get(&o.order_id) {
            Some(m) => {
                b.o_submit_t.push((m.submit_t - t0) as f64);
                b.o_ack_t.push(if m.ack_t > 0 { (m.ack_t - t0) as f64 } else { f64::NAN });
            }
            None => {
                b.o_submit_t.push(f64::NAN);
                b.o_ack_t.push(f64::NAN);
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn push_event(
    b: &mut Buffers,
    t: f64,
    kind: u8,
    id: u64,
    side: Side,
    tick: i64,
    qty: f64,
    req_t: f64,
    exch_t: f64,
    shared: &SharedQueue,
    exec_tick: i64,
) {
    let q = shared.borrow();
    let (front, level, traded) = match q.get(&id) {
        Some(s) => (
            if kind == EV_ACK { s.front_at_new as f32 } else { s.front as f32 },
            if kind == EV_ACK { s.level_at_new as f32 } else { s.level as f32 },
            s.traded_at_level as f32,
        ),
        None => (f32::NAN, f32::NAN, 0.0),
    };
    b.e_t.push(t);
    b.e_kind.push(kind);
    b.e_id.push(id as f64);
    b.e_side.push(match side { Side::Buy => 1, Side::Sell => -1, _ => 0 });
    b.e_tick.push(tick as i32);
    b.e_qty.push(qty as f32);
    b.e_req_t.push(req_t);
    b.e_exch_t.push(exch_t);
    b.e_front.push(front);
    b.e_level.push(level);
    b.e_exec_tick.push(exec_tick as i32);
    b.e_traded_at_level.push(traded);
}

fn fmt_ts(ns: i64) -> String {
    use chrono::{DateTime, Utc};
    let dt: DateTime<Utc> = DateTime::from_timestamp(ns.div_euclid(1_000_000_000), ns.rem_euclid(1_000_000_000) as u32)
        .unwrap_or_default();
    dt.format("%Y-%m-%dT%H:%M:%S%.6fZ").to_string()
}

fn rustc_version() -> String {
    option_env!("HFTENGINE_RUSTC").unwrap_or("unknown").to_string()
}
