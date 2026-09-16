/** Replay clock: maps wall-clock time to session time with play/pause/speed/seek. */

export class ReplayClock {
  private _t = 0; // session time, ns
  private _playing = false;
  private _speed = 1;
  private last = 0;
  readonly endT: number;
  onChange: (() => void) | null = null;

  constructor(endT: number) {
    this.endT = endT;
  }

  get t(): number {
    return this._t;
  }

  get playing(): boolean {
    return this._playing;
  }

  get speed(): number {
    return this._speed;
  }

  set speed(v: number) {
    this._speed = Math.max(0.05, Math.min(64, v));
    this.onChange?.();
  }

  seek(t: number): void {
    this._t = Math.max(0, Math.min(this.endT, t));
    this.onChange?.();
  }

  play(): void {
    if (this._playing) return;
    this._playing = true;
    this.last = performance.now();
    this.onChange?.();
  }

  pause(): void {
    this._playing = false;
    this.onChange?.();
  }

  toggle(): void {
    if (this._playing) this.pause();
    else this.play();
  }

  /** Advance according to wall time; call once per animation frame. Returns true if time moved. */
  tick(nowMs: number): boolean {
    if (!this._playing) return false;
    const dt = Math.min(0.25, (nowMs - this.last) / 1000);
    this.last = nowMs;
    const next = this._t + dt * 1e9 * this._speed;
    if (next >= this.endT) {
      this._t = this.endT;
      this._playing = false;
      this.onChange?.();
      return true;
    }
    this._t = next;
    return true;
  }
}
