export class SlidingWindowRateLimiter {
  private readonly stamps: number[] = [];

  constructor(private readonly maxPerSec: number) {}

  allow(now = Date.now()): boolean {
    const windowStart = now - 1000;
    while (this.stamps.length > 0 && (this.stamps[0] ?? 0) < windowStart) {
      this.stamps.shift();
    }
    if (this.stamps.length >= this.maxPerSec) {
      return false;
    }
    this.stamps.push(now);
    return true;
  }
}
