"""Start / stop the hftbacktest data collector as a detached process on Windows.

The collector (hftbacktest/collector, Rust) records the raw Binance Futures websocket
streams (trade, bookTicker, depth@0ms) plus REST depth snapshots into
<out>/<symbol>_<YYYYMMDD>.gz, one line per message: "<local_recv_ns> <raw json>".

Stopping must be graceful (Ctrl+C) so the gzip stream is finished properly; a hard kill
leaves the last deflate block unflushed.  `stop` attaches to the collector's hidden
console and raises CTRL_C_EVENT there.

The collector is started in its own hidden console WITHOUT CREATE_NEW_PROCESS_GROUP: that flag
disables Ctrl+C for the new process on Windows, which is exactly the signal `stop` sends.

Usage:
    python tools/collect.py start [--symbols BTCUSDT ETHUSDT] [--exchange binancefutures] [--out data/raw]
    python tools/collect.py stop
    python tools/collect.py status
"""
from __future__ import annotations

import argparse
import ctypes
import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COLLECTOR = ROOT / "hftbacktest" / "target" / "release" / "collector.exe"
RAW_DIR = ROOT / "data" / "raw"
STATE = RAW_DIR / "collector.json"
LOG = RAW_DIR / "collector.log"


def use_out(out: Path) -> None:
    global RAW_DIR, STATE, LOG
    RAW_DIR = out
    STATE = out / "collector.json"
    LOG = out / "collector.log"

CREATE_NEW_CONSOLE = 0x00000010
CREATE_NEW_PROCESS_GROUP = 0x00000200
STARTF_USESHOWWINDOW = 0x00000001
SW_HIDE = 0
CTRL_C_EVENT = 0


def start(symbols: list[str], exchange: str) -> None:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    if STATE.exists():
        st = json.loads(STATE.read_text())
        if _alive(st["pid"]):
            print(f"collector already running, pid {st['pid']}")
            return
    if not COLLECTOR.exists():
        sys.exit(f"collector binary not found: {COLLECTOR} (cargo build --release -p collector)")

    si = subprocess.STARTUPINFO()
    si.dwFlags |= STARTF_USESHOWWINDOW
    si.wShowWindow = SW_HIDE
    # A child inherits its parent's "ignore Ctrl+C" flag. Shells often start non-interactive
    # children with that flag set, which would make the collector deaf to the Ctrl+C that
    # `stop` sends; clear it for ourselves right before spawning.
    ctypes.windll.kernel32.SetConsoleCtrlHandler(None, False)
    env = dict(os.environ, RUST_LOG="info")
    log = open(LOG, "ab")
    proc = subprocess.Popen(
        [str(COLLECTOR), str(RAW_DIR), exchange, *symbols],
        stdout=log,
        stderr=log,
        stdin=subprocess.DEVNULL,
        creationflags=CREATE_NEW_CONSOLE,
        startupinfo=si,
        env=env,
        cwd=str(ROOT),
    )
    STATE.write_text(json.dumps({
        "pid": proc.pid,
        "started_utc_ns": time.time_ns(),
        "exchange": exchange,
        "symbols": symbols,
        "out_dir": str(RAW_DIR),
    }, indent=2))
    print(f"collector started, pid {proc.pid}, exchange={exchange}, symbols={' '.join(symbols)}")
    print(f"raw files -> {RAW_DIR}, log -> {LOG}")


def stop() -> None:
    if not STATE.exists():
        sys.exit("no collector state file; nothing to stop")
    st = json.loads(STATE.read_text())
    pid = st["pid"]
    if not _alive(pid):
        print(f"collector pid {pid} is not running")
        STATE.unlink()
        return
    k32 = ctypes.windll.kernel32
    # Attach to the collector's console, make ourselves immune to the Ctrl+C we are about to
    # raise, then signal every process attached to that console (only the collector).
    k32.FreeConsole()
    if not k32.AttachConsole(pid):
        sys.exit(f"AttachConsole({pid}) failed: {ctypes.get_last_error()}")
    k32.SetConsoleCtrlHandler(None, True)
    if not k32.GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0):
        sys.exit(f"GenerateConsoleCtrlEvent failed: {ctypes.get_last_error()}")
    k32.FreeConsole()
    for _ in range(300):
        if not _alive(pid):
            break
        time.sleep(0.1)
    if _alive(pid):
        sys.exit("collector did not exit after Ctrl+C; leaving it running")
    st["stopped_utc_ns"] = time.time_ns()
    STATE.write_text(json.dumps(st, indent=2))
    print(f"collector pid {pid} stopped gracefully after "
          f"{(st['stopped_utc_ns'] - st['started_utc_ns']) / 60e9:.1f} min")


def status() -> None:
    if not STATE.exists():
        print("no collector state file")
        return
    st = json.loads(STATE.read_text())
    alive = _alive(st["pid"])
    mins = (time.time_ns() - st["started_utc_ns"]) / 60e9
    print(f"pid {st['pid']} alive={alive} running for {mins:.1f} min symbols={st['symbols']}")
    for f in sorted(RAW_DIR.glob("*.gz")):
        print(f"  {f.name:32s} {f.stat().st_size / 1e6:9.2f} MB")
    if LOG.exists():
        tail = LOG.read_bytes()[-1500:].decode("utf-8", "replace")
        print("--- log tail ---")
        print(tail)


def _alive(pid: int) -> bool:
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    h = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return False
    code = ctypes.c_ulong()
    ok = ctypes.windll.kernel32.GetExitCodeProcess(h, ctypes.byref(code))
    ctypes.windll.kernel32.CloseHandle(h)
    return bool(ok) and code.value == 259  # STILL_ACTIVE


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("start")
    s.add_argument("--symbols", nargs="+", default=["BTCUSDT", "ETHUSDT"])
    s.add_argument("--exchange", default="binancefutures")
    s.add_argument("--out", type=Path, default=None, help="output directory (default data/raw)")
    st = sub.add_parser("stop")
    st.add_argument("--out", type=Path, default=None)
    su = sub.add_parser("status")
    su.add_argument("--out", type=Path, default=None)
    a = ap.parse_args()
    if a.out is not None:
        use_out(a.out.resolve())
    {"start": lambda: start(a.symbols, a.exchange), "stop": stop, "status": status}[a.cmd]()
