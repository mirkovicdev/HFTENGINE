//! A transparent wrapper around any hftbacktest [`QueueModel`] that mirrors the exchange-side queue
//! estimate of every resting order into a shared map, so the runner can record it.
//!
//! The wrapper delegates every call to the inner model unchanged; it only *reads* the resulting
//! state (`QueuePos::front_q_qty`, see patches/0001) after each call. Fill decisions are entirely
//! the inner model's.

use std::{cell::RefCell, collections::HashMap, rc::Rc};

use hftbacktest::{
    backtest::models::{QueueModel, QueuePos},
    depth::MarketDepth,
    types::{Order, Side},
};

#[derive(Clone, Debug)]
pub struct QueueSnap {
    /// Estimated quantity ahead of the order at its price level (exchange side).
    pub front: f64,
    /// Total quantity at the order's price level as seen by the exchange at the last update.
    pub level: f64,
    /// `front` right after the exchange accepted the order.
    pub front_at_new: f64,
    /// `level` right after the exchange accepted the order.
    pub level_at_new: f64,
    /// Number of market trades that hit this price level while the order rested.
    pub trades_at_level: u32,
    /// Traded quantity at the level while the order rested.
    pub traded_at_level: f64,
    /// Number of depth changes applied at the level while the order rested.
    pub depth_updates: u32,
    /// Set when the inner model reported the order as filled.
    pub filled: bool,
}

pub type SharedQueue = Rc<RefCell<HashMap<u64, QueueSnap>>>;

pub struct RecordingQueueModel<QM> {
    inner: QM,
    shared: SharedQueue,
}

impl<QM> RecordingQueueModel<QM> {
    pub fn new(inner: QM, shared: SharedQueue) -> Self {
        Self { inner, shared }
    }
}

fn front_of(order: &Order) -> Option<f64> {
    let any = order.q.as_any();
    if let Some(q) = any.downcast_ref::<QueuePos>() {
        Some(q.front_q_qty())
    } else {
        any.downcast_ref::<f64>().copied()
    }
}

fn level_of<MD: MarketDepth>(order: &Order, depth: &MD) -> f64 {
    if order.side == Side::Buy {
        depth.bid_qty_at_tick(order.price_tick)
    } else {
        depth.ask_qty_at_tick(order.price_tick)
    }
}

impl<QM, MD> QueueModel<MD> for RecordingQueueModel<QM>
where
    QM: QueueModel<MD>,
    MD: MarketDepth,
{
    fn new_order(&self, order: &mut Order, depth: &MD) {
        self.inner.new_order(order, depth);
        let front = front_of(order).unwrap_or(f64::NAN);
        let level = level_of(order, depth);
        self.shared.borrow_mut().insert(
            order.order_id,
            QueueSnap {
                front,
                level,
                front_at_new: front,
                level_at_new: level,
                trades_at_level: 0,
                traded_at_level: 0.0,
                depth_updates: 0,
                filled: false,
            },
        );
    }

    fn trade(&self, order: &mut Order, qty: f64, depth: &MD) {
        self.inner.trade(order, qty, depth);
        let mut map = self.shared.borrow_mut();
        if let Some(s) = map.get_mut(&order.order_id) {
            s.front = front_of(order).unwrap_or(s.front);
            s.level = level_of(order, depth);
            s.trades_at_level += 1;
            s.traded_at_level += qty;
        }
    }

    fn depth(&self, order: &mut Order, prev_qty: f64, new_qty: f64, depth: &MD) {
        self.inner.depth(order, prev_qty, new_qty, depth);
        let mut map = self.shared.borrow_mut();
        if let Some(s) = map.get_mut(&order.order_id) {
            s.front = front_of(order).unwrap_or(s.front);
            s.level = new_qty;
            s.depth_updates += 1;
        }
    }

    fn is_filled(&self, order: &mut Order, depth: &MD) -> f64 {
        let exec = self.inner.is_filled(order, depth);
        if exec > 0.0 {
            let mut map = self.shared.borrow_mut();
            if let Some(s) = map.get_mut(&order.order_id) {
                s.front = 0.0;
                s.filled = true;
            }
        }
        exec
    }
}
