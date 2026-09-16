# Patches applied to the hftbacktest clone

`0001-expose-queue-position-getters.patch` adds two read-only getters to `QueuePos`
(`hftbacktest/src/backtest/models/queue.rs`): `front_q_qty()` and `cum_trade_qty()`.

Why: the queue position model keeps its per-order state in a private struct that the exchange
model uses to decide fills. The runner's `RecordingQueueModel` wrapper (runner/src/queue.rs)
delegates every call to the real model unchanged and only *reads* this value afterwards, so the
dashboard can show the exact quantity the engine believes is ahead of each resting order. No
modelling logic is changed.

The patch is applied in the working tree of `hftbacktest/` (uncommitted). To re-apply on a fresh
clone at commit `5f3ec40b`:

```
cd hftbacktest && git apply ../patches/0001-expose-queue-position-getters.patch
```
