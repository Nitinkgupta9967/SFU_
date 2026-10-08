import { cpus, loadavg } from 'node:os';

export class EngineMetrics {
  private lastCpu = process.cpuUsage();
  private lastAt = Date.now();
  private lagMs = 0;
  private cpuLoad = 0;
  private timer?: NodeJS.Timeout;

  start(intervalMs = 500): void {
    this.stop();
    let expected = Date.now() + intervalMs;
    this.timer = setInterval(() => {
      const now = Date.now();
      this.lagMs = Math.max(0, now - expected);
      expected = now + intervalMs;

      const elapsedUs = Math.max(1, (now - this.lastAt) * 1000);
      const usage = process.cpuUsage(this.lastCpu);
      this.lastCpu = process.cpuUsage();
      this.lastAt = now;
      this.cpuLoad = Math.min(1, (usage.user + usage.system) / elapsedUs);
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  snapshot(): { cpuLoad: number; rssMb: number; eventLoopLagMs: number } {
    const hostLoad = loadavg()[0] / Math.max(1, cpus().length);
    return {
      cpuLoad: Number((this.cpuLoad || hostLoad).toFixed(4)),
      rssMb: Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(1)),
      eventLoopLagMs: Math.round(this.lagMs)
    };
  }
}
