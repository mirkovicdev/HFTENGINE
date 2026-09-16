import { CH, CW, el, esc } from "../dom";
import type { Session } from "../session";

export interface RenderCtx {
  t: number; // session time, ns
  f: number; // frame index
  playing: boolean;
  speed: number;
}

export abstract class Panel {
  readonly el: HTMLElement;
  readonly titleEl: HTMLElement;
  readonly body: HTMLElement;
  private lastKey = "";

  constructor(
    readonly key: string,
    readonly num: number,
    readonly name: string,
    protected readonly s: Session,
  ) {
    this.el = el("section", "panel");
    this.el.dataset.panel = key;
    this.el.style.gridArea = key;
    this.titleEl = el("div", "title", this.el);
    this.body = el("div", "body", this.el);
    this.setTitle("");
  }

  setTitle(right: string): void {
    this.titleEl.innerHTML = `<span class="n">${this.num}</span> ${esc(this.name)}<span class="right">${esc(right)}</span>`;
  }

  /** Visible rows / columns of the body in character cells. */
  get rows(): number {
    return Math.max(1, Math.floor(this.body.clientHeight / CH));
  }
  get cols(): number {
    return Math.max(1, Math.floor(this.body.clientWidth / CW));
  }

  /** Skip DOM rebuilds when nothing relevant changed. */
  protected changed(key: string): boolean {
    if (key === this.lastKey) return false;
    this.lastKey = key;
    return true;
  }

  invalidate(): void {
    this.lastKey = "";
  }

  abstract render(c: RenderCtx): void;
}
