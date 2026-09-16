"""One command from a raw collector file to a replayable dashboard session.

    python tools/session.py --raw data/raw/btcusdt_20260915.gz --name btcusdt_20260915 [runner args...]

Steps
  1. tools/prepare.py      raw .gz -> data/npz/<stem>.npz, data/latency/<stem>.npz, <stem>.collector.json
  2. runner                hftbacktest backtest + frame recording -> data/recordings/<name>.hbr
  3. stage                 copies the recording and collector facts to dashboard/public/sessions/<name>.*

Extra arguments after `--` go to the runner unchanged, e.g.
    python tools/session.py --raw data/raw/btcusdt_20260915.gz --name live -- --grid-num 5 --order-qty 0.002
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PY = ROOT / ".venv" / "Scripts" / "python.exe"
RUNNER = ROOT / "runner" / "target" / "release" / "hftengine-runner.exe"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", required=True, type=Path)
    ap.add_argument("--name", required=True)
    ap.add_argument("--symbol", default=None, help="defaults to the upper-cased file stem prefix")
    ap.add_argument("--tick-size", type=float, default=0.1)
    ap.add_argument("--lot-size", type=float, default=0.001)
    ap.add_argument("--mul-entry", type=float, default=1.0,
                    help="order entry latency = mul-entry x feed latency (tutorial default 4; 1 = one network hop)")
    ap.add_argument("--mul-resp", type=float, default=1.0,
                    help="order response latency = mul-resp x feed latency (tutorial default 3; 1 = one network hop)")
    ap.add_argument("--skip-prepare", action="store_true")
    ap.add_argument("runner_args", nargs="*")
    a = ap.parse_args()

    stem = a.raw.name[: -len(".gz")]
    symbol = a.symbol or stem.split("_")[0].upper()
    npz = ROOT / "data" / "npz" / f"{stem}.npz"
    lat = ROOT / "data" / "latency" / f"{stem}.npz"
    facts = ROOT / "data" / "npz" / f"{stem}.collector.json"
    out = ROOT / "data" / "recordings" / f"{a.name}.hbr"

    if not a.skip_prepare or not npz.exists():
        print(f"== prepare {a.raw}")
        subprocess.run([str(PY), str(ROOT / "tools" / "prepare.py"), "--raw", str(a.raw),
                        "--tick-size", str(a.tick_size), "--lot-size", str(a.lot_size),
                        "--mul-entry", str(a.mul_entry), "--mul-resp", str(a.mul_resp)], check=True, cwd=ROOT)

    if not RUNNER.exists():
        sys.exit(f"runner not built: {RUNNER}  (cd runner && cargo build --release)")
    cmd = [str(RUNNER), "--data", str(npz), "--latency", str(lat), "--symbol", symbol,
           "--tick-size", str(a.tick_size), "--lot-size", str(a.lot_size), "--out", str(out), *a.runner_args]
    print("== run:", " ".join(cmd))
    subprocess.run(cmd, check=True, cwd=ROOT)

    dst = ROOT / "dashboard" / "public" / "sessions"
    dst.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(out, dst / f"{a.name}.hbr")
    if facts.exists():
        shutil.copyfile(facts, dst / f"{a.name}.collector.json")
    (dst / "default.json").write_text(json.dumps({"session": a.name}))
    subprocess.run([str(PY), str(ROOT / "tools" / "hbr.py"), str(out)], cwd=ROOT)
    print(f"\nstaged -> {dst / (a.name + '.hbr')}")
    print(f"open   -> http://127.0.0.1:5180/?session={a.name}")


if __name__ == "__main__":
    main()
