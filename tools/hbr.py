"""Reader for hftengine session recordings (.hbr) — see runner/src/record.rs for the layout.

    python tools/hbr.py data/recordings/<name>.hbr      # prints a summary
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

DTYPES = {"f64": "<f8", "f32": "<f4", "i32": "<i4", "u32": "<u4", "i8": "<i1", "u8": "<u1"}


def load(path: str | Path) -> tuple[dict, dict[str, np.ndarray]]:
    buf = Path(path).read_bytes()
    assert buf[:8] == b"HFTREC01", "not an hbr file"
    hlen = int.from_bytes(buf[8:12], "little")
    header = json.loads(buf[12 : 12 + hlen])
    start = 12 + hlen
    start += (8 - start % 8) % 8
    arrays = {}
    for a in header["arrays"]:
        raw = buf[start + a["offset"] : start + a["offset"] + a["length"]]
        arr = np.frombuffer(raw, dtype=DTYPES[a["dtype"]])
        arrays[a["name"]] = arr.reshape(a["shape"])
    return header["meta"], arrays


def summary(path: str) -> None:
    meta, a = load(path)
    print(json.dumps({k: v for k, v in meta.items() if k not in ("data_files",)}, indent=1)[:3000])
    n = meta["n_frames"]
    print(f"frames {n}  duration {(a['frame_t'][-1] - a['frame_t'][0]) / 60e9:.2f} min")
    kinds = {1: "SUBMIT", 2: "ACK", 3: "FILL", 4: "CANCEL_SENT", 5: "CANCELED", 6: "EXPIRED", 7: "CANCEL_REJECTED"}
    ek = a["e_kind"]
    for k, name in kinds.items():
        print(f"  {name:16s} {int((ek == k).sum()):8d}")
    ack = ek == 2
    fill = ek == 3
    if ack.any():
        entry = (a["e_exch_t"][ack] - a["e_req_t"][ack]) / 1e6
        resp = (a["e_t"][ack] - a["e_exch_t"][ack]) / 1e6
        print(f"  entry latency ms p50={np.nanmedian(entry):.1f} p95={np.nanpercentile(entry, 95):.1f} | "
              f"resp p50={np.nanmedian(resp):.1f} p95={np.nanpercentile(resp, 95):.1f}")
        print(f"  queue ahead at ack (qty) p50={np.nanmedian(a['e_front'][ack]):.3f} "
              f"p90={np.nanpercentile(a['e_front'][ack], 90):.3f} | level p50={np.nanmedian(a['e_level'][ack]):.3f}")
    if fill.any():
        # wait in queue = fill exch time - ack exch time (matched by order id, latest ack before the fill)
        ids = a["e_id"]
        t = a["e_exch_t"]
        waits = []
        by_id: dict[float, float] = {}
        for i in range(len(ek)):
            if ek[i] == 2:
                by_id[ids[i]] = t[i]
            elif ek[i] == 3 and ids[i] in by_id:
                waits.append((t[i] - by_id.pop(ids[i])) / 1e9)
            elif ek[i] in (5, 6):
                by_id.pop(ids[i], None)  # order ids (price ticks) are reused by later orders
        w = np.array(waits)
        print(f"  fills {int(fill.sum())}: wait s p50={np.median(w):.2f} p90={np.percentile(w, 90):.2f} max={w.max():.1f} | "
              f"traded at level while waiting p50={np.nanmedian(a['e_traded_at_level'][fill]):.3f}")
    fl = a["feed_lat_mean"]
    print(f"  feed latency ms (frame mean) p50={np.nanmedian(fl):.1f} p95={np.nanpercentile(fl, 95):.1f}")
    print(f"  market trades {len(a['tr_tick'])}  | orders per frame mean {np.diff(a['order_start']).mean():.1f}")
    print(f"  position min/max {a['position'].min():.3f}/{a['position'].max():.3f}")


def moments(path: str, n: int = 8) -> None:
    """Print replay times worth recording: longest-resting fills, most-hit resting orders,
    biggest queues joined, and the busiest post-only rejection bursts."""
    meta, a = load(path)
    ek = a["e_kind"]; et = a["e_t"]; ids = a["e_id"]; front = a["e_front"]; lvl = a["e_level"]
    sec = lambda ns: f"t={ns / 1e9:8.1f}s"
    # fills with the longest rest (exchange ack -> exchange fill)
    ack_t: dict[float, float] = {}
    rest = []
    for i in range(len(ek)):
        if ek[i] == 2:
            ack_t[ids[i]] = a["e_exch_t"][i]
        elif ek[i] == 3 and ids[i] in ack_t:
            rest.append((a["e_exch_t"][i] - ack_t.pop(ids[i]), i))
        elif ek[i] in (5, 6):
            ack_t.pop(ids[i], None)
    rest.sort(reverse=True)
    print("longest queue waits before a fill (open the BOOK/QUEUE panel a few seconds earlier):")
    for r, i in rest[:n]:
        side = "BUY " if a["e_side"][i] == 1 else "SELL"
        print(f"  {sec(et[i])}  {side} {a['e_tick'][i] * meta['tick_size']:.{1}f}  rested {r / 1e9:6.1f}s  "
              f"traded at level while waiting {a['e_traded_at_level'][i]:.3f}")
    # largest queues joined
    acks = [(front[i], i) for i in range(len(ek)) if ek[i] == 2 and front[i] == front[i]]
    acks.sort(reverse=True)
    print("largest queues joined (qty ahead at acceptance):")
    for f, i in acks[:n]:
        side = "BUY " if a["e_side"][i] == 1 else "SELL"
        print(f"  {sec(et[i])}  {side} {a['e_tick'][i] * meta['tick_size']:.1f}  ahead {f:.3f} of {lvl[i]:.3f}")
    # most-hit resting orders (per frame max of trades at level)
    hits = a["o_trades_at_level"]; os_ = a["order_start"]; ft = a["frame_t"]
    best = []
    for f in range(len(os_) - 1):
        s0, s1 = os_[f], os_[f + 1]
        if s1 > s0:
            j = s0 + int(hits[s0:s1].argmax())
            if hits[j] > 0:
                best.append((int(hits[j]), f, j))
    best.sort(reverse=True)
    seen = set()
    print("orders hit most often while still resting:")
    for h, f, j in best:
        key = a["o_id"][j]
        if key in seen:
            continue
        seen.add(key)
        side = "BUY " if a["o_side"][j] == 1 else "SELL"
        print(f"  {sec(ft[f])}  {side} {a['o_tick'][j] * meta['tick_size']:.1f}  hit {h} times, ahead {a['o_front'][j]:.3f}")
        if len(seen) >= n:
            break
    # post-only rejection bursts per 10 s
    rej = et[ek == 6]
    if len(rej):
        bins = np.floor(rej / 10e9).astype(int)
        u, c = np.unique(bins, return_counts=True)
        order = np.argsort(-c)[:n]
        print("busiest post-only rejection windows (10 s):")
        for k in order:
            print(f"  t={u[k] * 10:8d}s  {c[k]} rejections")


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[2] == "moments":
        moments(sys.argv[1])
    else:
        summary(sys.argv[1])
