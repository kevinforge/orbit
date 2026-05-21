export class QuietWindowTurnDetector {
  private lastOutputAt: number | undefined;

  constructor(private readonly quietWindowMs: number) {
    if (!Number.isFinite(quietWindowMs) || quietWindowMs < 0) {
      throw new Error("quietWindowMs must be a non-negative finite number");
    }
  }

  markOutput(now = Date.now()): void {
    this.lastOutputAt = now;
  }

  isQuiet(now = Date.now()): boolean {
    if (this.lastOutputAt === undefined) {
      return false;
    }

    return now - this.lastOutputAt >= this.quietWindowMs;
  }
}
