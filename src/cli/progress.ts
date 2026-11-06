import type { TermCaps } from "../render/term.js";
import type { Io } from "./args.js";

/**
 * A progress line for a command that waits on the chain (demo, burn): TTY only, written in place with `\r` and cleared
 * with `\r\x1b[K` before the next print. Its timers are unref'd, so a progress line never keeps the process alive.
 */
export class Progress {
  private shown = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly on: boolean;

  constructor(
    private readonly io: Io,
    caps: TermCaps,
  ) {
    this.on = caps.tty && io.write !== undefined;
  }

  show(text: string): void {
    if (!this.on) return;
    this.io.write!(`\r${text}`);
    this.shown = true;
  }

  /** `text(1)`, `text(2)`, … once a second until stop(). */
  every(text: (secs: number) => string): void {
    this.stop();
    if (!this.on) return;
    let secs = 0;
    this.timer = setInterval(() => this.show(text(++secs)), 1000);
    this.timer.unref?.();
  }

  /** `text` once a second has passed, unless stop() comes first. */
  after(text: string): void {
    this.stop();
    if (!this.on) return;
    this.timer = setTimeout(() => this.show(text), 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  clear(): void {
    if (!this.shown) return;
    this.io.write!("\r\x1b[K");
    this.shown = false;
  }
}
