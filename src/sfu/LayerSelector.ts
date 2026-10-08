export type LayerDecision = 'down' | 'up' | undefined;

export class LayerSelector {
  private consecutiveHighLoss = 0;
  private goodSince?: number;

  constructor(
    private readonly options: {
      downLoss: number;
      upLoss: number;
      downReports: number;
      upHoldMs: number;
      now?: () => number;
    } = {
      downLoss: 0.1,
      upLoss: 0.02,
      downReports: 2,
      upHoldMs: 10_000
    }
  ) {}

  onReceiverReport(fractionLost: number): LayerDecision {
    const now = this.options.now?.() ?? Date.now();
    if (fractionLost > this.options.downLoss) {
      this.goodSince = undefined;
      this.consecutiveHighLoss += 1;
      if (this.consecutiveHighLoss >= this.options.downReports) {
        this.consecutiveHighLoss = 0;
        return 'down';
      }
      return undefined;
    }

    this.consecutiveHighLoss = 0;
    if (fractionLost < this.options.upLoss) {
      this.goodSince ??= now;
      if (now - this.goodSince >= this.options.upHoldMs) {
        this.goodSince = now;
        return 'up';
      }
      return undefined;
    }

    this.goodSince = undefined;
    return undefined;
  }
}
