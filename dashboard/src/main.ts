/** HFTENGINE dashboard: replays an hftbacktest session recording (.hbr) written by the runner.
 *
 * URL parameters
 *   session=<name>      public/sessions/<name>.hbr (+ <name>.collector.json)     default: sample
 *   layout=landscape|portrait                                                      default: landscape
 *   panels=book,queue   panels shown in portrait layout (top to bottom)            default: book,queue
 *   panel=<key>         focus a single panel (book queue latency fills market tape log engine collector)
 *   zoom=1|2|3          integer zoom (bitmap font stays crisp)                     default: auto
 *   safe=0.16           fraction of the height left empty at top and bottom in portrait
 *   t=<seconds>         start time into the session                               default: 0
 *   speed=<x>           replay speed                                              default: 1
 *   play=0|1            autoplay                                                  default: 1
 *   keys=0|1            show the key bar                                          default: 1
 *
 * Keys: SPACE play/pause, Left/Right seek 5 s, Shift+Left/Right seek 30 s, Up/Down speed,
 *       1-9 focus a panel, 0 all panels, L toggle layout, H toggle key bar, R restart
 */
import { ReplayClock } from "./clock";
import { el, sp } from "./dom";
import { clock, dateOf, elapsed } from "./fmt";
import { fetchHbr } from "./hbr";
import { Panel, type RenderCtx } from "./panels/base";
import { BookPanel } from "./panels/book";
import { CollectorPanel } from "./panels/collector";
import { EnginePanel } from "./panels/engine";
import { FillsPanel } from "./panels/fills";
import { LatencyPanel } from "./panels/latency";
import { LogPanel } from "./panels/log";
import { MarketPanel } from "./panels/market";
import { QueuePanel } from "./panels/queue";
import { TapePanel } from "./panels/tape";
import { Session, type CollectorFacts } from "./session";

const q = new URLSearchParams(location.search);
let sessionName = q.get("session") ?? "";

async function main(): Promise<void> {
  const app = document.getElementById("app")!;
  const loading = el("div", "loading", app);
  if (!sessionName) {
    // the most recently built session, recorded by tools/session.py; the repo sample otherwise
    try {
      const r = await fetch("/sessions/default.json");
      sessionName = r.ok ? ((await r.json()).session as string) : "sample";
    } catch {
      sessionName = "sample";
    }
  }
  loading.textContent = `loading sessions/${sessionName}.hbr`;
  await Promise.all([document.fonts.load("16px VGA"), document.fonts.load("8px EGA8")]).catch(() => {});

  const load = () =>
    fetchHbr(`/sessions/${sessionName}.hbr`, (l, t) => {
      loading.textContent = `loading sessions/${sessionName}.hbr  ${(l / 1e6).toFixed(1)}${t ? " / " + (t / 1e6).toFixed(1) : ""} MB`;
    });
  let hbr;
  try {
    hbr = await load();
  } catch (e) {
    // a default.json can name a session that is not present in this checkout: use the bundled sample
    if (q.get("session") || sessionName === "sample") throw e;
    sessionName = "sample";
    hbr = await load();
  }
  const session = new Session(hbr);
  try {
    const r = await fetch(`/sessions/${sessionName}.collector.json`);
    if (r.ok) session.collector = (await r.json()) as CollectorFacts;
  } catch {
    /* optional */
  }
  loading.remove();
  new App(app, session).start();
}

class App {
  private readonly panels: Panel[];
  private readonly byKey = new Map<string, Panel>();
  private readonly clock: ReplayClock;
  private readonly header: HTMLElement;
  private readonly safeTop: HTMLElement;
  private readonly work: HTMLElement;
  private readonly safeBottom: HTMLElement;
  private readonly status: HTMLElement;
  private readonly keys: HTMLElement;
  private layout: "landscape" | "portrait";
  private focus: string | null;
  private portraitPanels: string[];
  private safe: number;
  private showKeys: boolean;
  private frameH = 0;
  private zoom = 1;
  private lastRenderKey = "";

  constructor(
    root: HTMLElement,
    private readonly s: Session,
  ) {
    this.panels = [
      new BookPanel(s),
      new QueuePanel(s),
      new LatencyPanel(s),
      new FillsPanel(s),
      new MarketPanel(s),
      new TapePanel(s),
      new LogPanel(s),
      new EnginePanel(s),
      new CollectorPanel(s),
    ];
    for (const p of this.panels) this.byKey.set(p.key, p);
    this.clock = new ReplayClock(s.endT);
    const zoom = q.get("zoom") ?? "auto";
    const z = zoom === "auto" ? (window.innerWidth >= 1800 ? 2 : 1) : Math.max(1, Math.min(3, parseInt(zoom, 10) || 1));
    root.className = `zoom-${z}`;
    this.zoom = z;
    // always the full grid unless portrait is asked for explicitly (layout=portrait or the L key)
    this.layout = q.get("layout") === "portrait" ? "portrait" : "landscape";
    this.focus = q.get("panel");
    // panels=book:3,queue:2 -> keys with optional relative heights
    this.portraitPanels = (q.get("panels") ?? "book:3,queue:2")
      .split(",")
      .map((x) => x.trim())
      .filter((x) => this.byKey.has(x.split(":")[0]));
    if (this.portraitPanels.length === 0) this.portraitPanels = ["book:3", "queue:2"];
    this.safe = Math.max(0, Math.min(0.4, parseFloat(q.get("safe") ?? "0.16")));
    this.showKeys = q.get("keys") !== "0";

    // optional fixed frame in device px (e.g. frame=1080x1920) centred in the window, for
    // screen recording; the app is zoomed, so its CSS size is the frame divided by the zoom
    const frame = q.get("frame");
    if (frame && /^\d+x\d+$/.test(frame)) {
      const [fw, fh] = frame.split("x").map(Number);
      root.classList.add("framed");
      root.style.width = `${Math.round(fw / z)}px`;
      root.style.height = `${Math.round(fh / z)}px`;
      this.frameH = fh;
    }
    this.safeTop = el("div", "safe", root);
    this.header = el("div", "bar", root);
    this.work = el("div", "work", root);
    this.status = el("div", "bar status", root);
    this.keys = el("div", "bar", root);
    this.safeBottom = el("div", "safe", root);
    this.keys.innerHTML =
      sp("k", "SPACE") + " play/pause  " +
      sp("k", "←→") + " 5s  " +
      sp("k", "⇑⇓") + " speed  " +
      sp("k", "1-9") + " panel  " +
      sp("k", "0") + " all  " +
      sp("k", "L") + " layout  " +
      sp("k", "R") + " restart  " +
      sp("k", "B") + " ladder  " +
      sp("k", "H") + " keys";

    this.clock.speed = parseFloat(q.get("speed") ?? "1") || 1;
    this.clock.seek((parseFloat(q.get("t") ?? "0") || 0) * 1e9);
    if (q.get("play") !== "0") this.clock.play();
    this.applyLayout();
    window.addEventListener("resize", () => this.applyLayout());
    window.addEventListener("keydown", (e) => this.onKey(e));
    this.clock.onChange = () => this.syncUrl();
  }

  private applyLayout(): void {
    const s = this.s;
    this.work.innerHTML = "";
    this.work.className = "work";
    const portrait = this.layout === "portrait";
    // safe strips are a fraction of the app height, in the app (zoomed) CSS px
    const appH = (this.frameH || window.innerHeight) / this.zoom;
    const safePx = portrait ? Math.round(appH * this.safe) : 0;
    this.safeTop.style.height = `${safePx}px`;
    this.safeBottom.style.height = `${safePx}px`;
    let visible: Panel[];
    let weights: number[] = [];
    if (this.focus && this.byKey.has(this.focus)) {
      this.work.classList.add("focus");
      visible = [this.byKey.get(this.focus)!];
    } else if (portrait) {
      this.work.classList.add("portrait");
      visible = this.portraitPanels.map((k) => this.byKey.get(k.split(":")[0])!);
      weights = this.portraitPanels.map((k) => Math.max(1, parseFloat(k.split(":")[1] ?? "1") || 1));
      this.work.style.gridTemplateRows = weights.map((w) => `minmax(0, ${w}fr)`).join(" ");
    } else {
      this.work.classList.add("landscape");
      visible = this.panels;
    }
    if (!portrait) this.work.style.gridTemplateRows = "";
    for (const p of visible) {
      p.el.style.gridArea = this.work.classList.contains("landscape") ? p.key : "auto";
      this.work.appendChild(p.el);
      p.invalidate();
    }
    this.keys.style.display = this.showKeys ? "" : "none";
    const m = s.meta;
    const cols = Math.floor(this.header.clientWidth / 9);
    const wide = cols >= 110;
    const medium = cols >= 72;
    this.header.innerHTML =
      sp("hi", " HFTENGINE ") +
      ` ${m.engine.name} ${m.engine.crate_version}  │  ${m.symbol}` +
      (medium ? ` · ${m.exchange}  │  recorded ${dateOf(s.t0)}` : "") +
      (wide ? sp("right", `session ${sessionName} `) : "");
    this.keys.innerHTML = medium
      ? sp("k", "SPACE") + " play/pause  " + sp("k", "←→") + " 5s  " + sp("k", "⇑⇓") + " speed  " + sp("k", "1-9") + " panel  " + sp("k", "0") + " all  " + sp("k", "L") + " layout  " + sp("k", "R") + " restart  " + sp("k", "B") + " ladder  " + sp("k", "H") + " keys"
      : sp("k", "SPACE") + " play  " + sp("k", "←→") + " 5s  " + sp("k", "⇑⇓") + " speed  " + sp("k", "1-9") + " panel  " + sp("k", "0") + " all  " + sp("k", "L") + " " + sp("k", "R") + " " + sp("k", "B") + " " + sp("k", "H");
    this.lastRenderKey = "";
    this.syncUrl();
  }

  private onKey(e: KeyboardEvent): void {
    const c = this.clock;
    const big = e.shiftKey ? 30e9 : 5e9;
    switch (e.key) {
      case " ":
        c.toggle();
        break;
      case "ArrowLeft":
        c.seek(c.t - big);
        break;
      case "ArrowRight":
        c.seek(c.t + big);
        break;
      case "ArrowUp":
        c.speed = c.speed >= 1 ? c.speed * 2 : c.speed * 2;
        break;
      case "ArrowDown":
        c.speed = c.speed / 2;
        break;
      case "r":
      case "R":
        c.seek(0);
        break;
      case "l":
      case "L":
        this.layout = this.layout === "landscape" ? "portrait" : "landscape";
        this.applyLayout();
        break;
      case "h":
      case "H":
        this.showKeys = !this.showKeys;
        this.applyLayout();
        break;
      case "b":
      case "B": {
        const book = this.byKey.get("book") as BookPanel;
        book.mode = book.mode === "levels" ? "ticks" : "levels";
        book.invalidate();
        break;
      }
      case "0":
        this.focus = null;
        this.applyLayout();
        break;
      default: {
        const n = parseInt(e.key, 10);
        if (n >= 1 && n <= 9) {
          const p = this.panels.find((x) => x.num === n);
          if (p) {
            this.focus = this.focus === p.key ? null : p.key;
            this.applyLayout();
          }
        } else return;
      }
    }
    e.preventDefault();
  }

  private syncUrl(): void {
    const p = new URLSearchParams(location.search);
    p.set("session", sessionName);
    p.set("layout", this.layout);
    if (this.focus) p.set("panel", this.focus);
    else p.delete("panel");
    p.set("t", (this.clock.t / 1e9).toFixed(1));
    p.set("speed", String(this.clock.speed));
    p.set("play", this.clock.playing ? "1" : "0");
    if (!this.showKeys) p.set("keys", "0");
    else p.delete("keys");
    history.replaceState(null, "", `${location.pathname}?${p.toString()}`);
  }

  start(): void {
    const loop = (now: number) => {
      this.clock.tick(now);
      this.render();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private render(): void {
    const s = this.s;
    const t = this.clock.t;
    const f = s.frameAt(t);
    const ctx: RenderCtx = { t, f, playing: this.clock.playing, speed: this.clock.speed };
    for (const p of this.panels) if (p.el.isConnected) p.render(ctx);
    const key = `${Math.floor(t / 1e8)}|${this.clock.playing}|${this.clock.speed}`;
    if (key !== this.lastRenderKey) {
      this.lastRenderKey = key;
      const pos = s.position[f];
      const cols = Math.floor(this.status.clientWidth / 9);
      const medium = cols >= 90;
      this.status.innerHTML =
        sp(this.clock.playing ? "play" : "pause", this.clock.playing ? " ► " : " ‖ ") +
        sp("v", clock(s.t0, t, medium)) +
        " UTC  " +
        sp("v", `x${this.clock.speed}`) +
        `  │  ${medium ? "elapsed " : ""}${sp("v", elapsed(t))}${medium ? " of " : "/"}${elapsed(s.endT)}` +
        `  │  pos${medium ? "ition" : ""} ${sp(pos > 0 ? "g" : pos < 0 ? "r" : "v", (pos >= 0 ? "+" : "") + pos.toFixed(3))}` +
        `  │  ${sp("v", String(s.numTrades[f]))} fills` +
        (medium ? sp("right", `${this.layout}${this.focus ? " · " + this.focus : ""} `) : "");
      if (this.clock.playing && Math.floor(t / 1e9) % 5 === 0) this.syncUrl();
    }
  }
}

main().catch((e) => {
  const app = document.getElementById("app")!;
  app.innerHTML = `<div class="loading">error: ${String(e)}</div>`;
  console.error(e);
});
