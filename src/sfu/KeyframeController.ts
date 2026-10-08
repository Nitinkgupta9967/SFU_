import type { Clock } from '../util/time.js';
import { systemClock } from '../util/time.js';

export interface KeyframeRequester {
  requestKeyframe(): void;
}

export class KeyframeController {
  private lastRequestAt = -Infinity;
  private retryTimer?: NodeJS.Timeout;
  private retries = 0;
  plisSent = 0;

  constructor(
    private readonly requester: KeyframeRequester,
    private readonly options: { throttleMs: number; retryMs?: number; maxRetries?: number; clock?: Clock }
  ) {}

  request(reason: string): void {
    void reason;
    const clock = this.clock;
    const now = clock.now();
    if (now - this.lastRequestAt >= this.options.throttleMs) {
      this.lastRequestAt = now;
      this.plisSent += 1;
      this.requester.requestKeyframe();
    }
    this.ensureRetry();
  }

  keyframeReceived(): void {
    if (this.retryTimer) {
      this.clock.clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.retries = 0;
  }

  close(): void {
    if (this.retryTimer) {
      this.clock.clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  private ensureRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = undefined;
      if (this.retries >= (this.options.maxRetries ?? 5)) return;
      this.retries += 1;
      this.lastRequestAt = -Infinity;
      this.request('retry');
    }, this.options.retryMs ?? 1000);
  }

  private get clock(): Clock {
    return this.options.clock ?? systemClock;
  }
}
