"""Turn a raw collector recording into everything the runner and dashboard need.

Steps (all with hftbacktest's own utilities where they exist):
  1. raw <symbol>_<date>.gz  ->  data/npz/<symbol>_<date>.npz      (hftbacktest.data.utils.binancefutures.convert)
  2. feed-latency-derived order latency  ->  data/latency/<symbol>_<date>.npz
     (hftbacktest.data.utils.feed_order_latency.generate_order_latency, entry = mul_entry x feed
      latency, response = mul_resp x feed latency, as in the "Order Latency Data" tutorial)
  3. collector.json  ->  data/npz/<symbol>_<date>.collector.json
     file facts, per-second message counts per stream, and a sampled tail of raw lines so the
     dashboard can show the raw feed that was recorded at the moment being replayed.

A gzip stream cut short by a hard kill is recovered up to the last complete line first.

Usage:
    python tools/prepare.py --raw data/raw/btcusdt_20260915.gz [--mul-entry 4 --mul-resp 3]
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import zlib
from collections import Counter
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]


def recover_gz(src: Path, dst: Path) -> tuple[int, bool]:
    """Copy a possibly truncated gzip file to a well-formed one, keeping complete lines only.

    Returns (line_count, was_truncated)."""
    d = zlib.decompressobj(16 + zlib.MAX_WBITS)
    out = gzip.open(dst, "wb", compresslevel=6)
    buf = b""
    n = 0
    truncated = False
    with open(src, "rb") as f:
        while True:
            chunk = f.read(1 << 20)
            if not chunk:
                break
            try:
                buf += d.decompress(chunk)
            except zlib.error:
                truncated = True
                break
            cut = buf.rfind(b"\n")
            if cut >= 0:
                out.write(buf[: cut + 1])
                n += buf.count(b"\n", 0, cut + 1)
                buf = buf[cut + 1 :]
    if not d.eof:
        truncated = True
    if buf.endswith(b"\n"):
        out.write(buf)
        n += buf.count(b"\n")
    out.close()
    return n, truncated


def collector_facts(gz: Path, sample_every: int, max_line: int) -> dict:
    per_sec: Counter = Counter()
    streams: Counter = Counter()
    sampled = []
    first = None
    last = None
    n = 0
    snapshots = 0
    with gzip.open(gz, "rb") as f:
        for line in f:
            n += 1
            ts = int(line[:19])
            first = ts if first is None else first
            last = ts
            body = line[20:]
            if body.startswith(b'{"stream"'):
                # {"stream":"btcusdt@depth@0ms","data":...
                end = body.find(b'"', 11)
                stream = body[11:end].decode()
                kind = stream.split("@", 1)[1] if "@" in stream else stream
            else:
                kind = "depth snapshot (REST)"
                snapshots += 1
            streams[kind] += 1
            per_sec[(ts // 1_000_000_000, kind)] += 1
            if n % sample_every == 0 or kind.startswith("depth snapshot"):
                text = body.decode("utf-8", "replace").rstrip("\n")
                sampled.append({"t": ts, "k": kind, "s": text[:max_line], "len": len(text)})
    secs = sorted({s for s, _ in per_sec})
    kinds = sorted(streams)
    rate = {k: [per_sec.get((s, k), 0) for s in secs] for k in kinds}
    return {
        "file": gz.name,
        "bytes": gz.stat().st_size,
        "lines": n,
        "first_ns": str(first),
        "last_ns": str(last),
        "streams": dict(streams),
        "snapshots": snapshots,
        "rate_t0_s": secs[0] if secs else 0,
        "rate": rate,
        "sample": sampled,
        "sample_every": sample_every,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", required=True, type=Path)
    ap.add_argument("--tick-size", type=float, default=0.1)
    ap.add_argument("--lot-size", type=float, default=0.001)
    ap.add_argument("--mul-entry", type=float, default=1.0)
    ap.add_argument("--mul-resp", type=float, default=1.0)
    ap.add_argument("--sample-every", type=int, default=25)
    ap.add_argument("--max-line", type=int, default=240)
    a = ap.parse_args()

    from hftbacktest.data.utils import binancefutures
    from hftbacktest.data.utils.feed_order_latency import generate_order_latency
    from hftbacktest import EXCH_EVENT, LOCAL_EVENT, TRADE_EVENT

    raw: Path = a.raw
    stem = raw.name[: -len(".gz")]
    npz_dir = ROOT / "data" / "npz"
    lat_dir = ROOT / "data" / "latency"
    npz_dir.mkdir(parents=True, exist_ok=True)
    lat_dir.mkdir(parents=True, exist_ok=True)

    fixed = npz_dir / f"{stem}.raw.gz"
    lines, truncated = recover_gz(raw, fixed)
    print(f"raw lines: {lines:,} truncated_stream={truncated} -> {fixed.name}")

    # estimate a buffer size: depth messages carry ~10-60 levels each
    buffer = int(max(2_000_000, lines * 40))
    out_npz = npz_dir / f"{stem}.npz"
    data = binancefutures.convert(str(fixed), output_filename=str(out_npz), combined_stream=True, buffer_size=buffer)
    ev = data["ev"]
    m = (ev & LOCAL_EVENT) == LOCAL_EVENT
    both = m & ((ev & EXCH_EVENT) == EXCH_EVENT)
    lat = (data["local_ts"][both] - data["exch_ts"][both]) / 1e6
    p = np.percentile(lat, [50, 90, 99])
    print(f"npz rows {len(data):,} local {int(m.sum()):,} trades {int(((ev & 0xff) == TRADE_EVENT).sum()):,}")
    print(f"feed latency ms p50={p[0]:.1f} p90={p[1]:.1f} p99={p[2]:.1f} min={lat.min():.1f}")

    out_lat = lat_dir / f"{stem}.npz"
    ol = generate_order_latency(str(out_npz), output_file=str(out_lat), mul_entry=a.mul_entry, mul_resp=a.mul_resp)
    e = (ol["exch_ts"] - ol["req_ts"]) / 1e6
    r = (ol["resp_ts"] - ol["exch_ts"]) / 1e6
    print(f"order latency rows {len(ol)} entry p50={np.median(e):.1f}ms resp p50={np.median(r):.1f}ms")

    # keep the sampled raw tail around 30k lines regardless of session length
    sample_every = max(a.sample_every, lines // 30_000)
    facts = collector_facts(fixed, sample_every, a.max_line)
    facts["source_file"] = raw.name
    facts["source_bytes"] = raw.stat().st_size
    facts["truncated_stream_recovered"] = truncated
    facts["npz"] = {"file": out_npz.name, "bytes": out_npz.stat().st_size, "rows": int(len(data)),
                    "local_rows": int(m.sum()), "feed_latency_ms_p50": float(p[0]),
                    "feed_latency_ms_p90": float(p[1]), "feed_latency_ms_p99": float(p[2])}
    facts["order_latency"] = {"file": out_lat.name, "rows": int(len(ol)), "mul_entry": a.mul_entry,
                              "mul_resp": a.mul_resp, "entry_ms_p50": float(np.median(e)),
                              "resp_ms_p50": float(np.median(r))}
    with open(npz_dir / f"{stem}.collector.json", "w", encoding="utf-8") as f:
        json.dump(facts, f)
    print(f"collector facts -> {stem}.collector.json ({len(facts['sample'])} sampled lines)")
    os.remove(fixed) if not truncated else None


if __name__ == "__main__":
    main()
