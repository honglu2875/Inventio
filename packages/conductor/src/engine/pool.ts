/** Global worker pool (DESIGN §6.4): at most `max` concurrent codex workers. */
export class WorkerPool {
  private max: number;
  private running = 0;
  private waiters: (() => void)[] = [];

  constructor(max: number) {
    this.max = Math.max(1, max);
  }

  get active(): number {
    return this.running;
  }

  get queued(): number {
    return this.waiters.length;
  }

  setMax(n: number): void {
    this.max = Math.max(1, n);
    this.drain();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.running += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.running -= 1;
    this.drain();
  }

  private drain(): void {
    while (this.running < this.max && this.waiters.length > 0) {
      this.waiters.shift()!();
    }
  }
}
