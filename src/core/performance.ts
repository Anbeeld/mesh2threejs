import { performance } from "node:perf_hooks";

export interface OperatorPerformance {
  operator: string;
  elapsedMs: number;
  rssBeforeBytes: number;
  rssAfterBytes: number;
  peakObservedRssBytes: number;
}

export class PerformanceRecorder {
  readonly rows: OperatorPerformance[] = [];

  start(): { time: number; rss: number } {
    return { time: performance.now(), rss: process.memoryUsage().rss };
  }

  recordSince(operator: string, started: { time: number; rss: number }): void {
    const rssAfterBytes = process.memoryUsage().rss;
    this.rows.push({
      operator,
      elapsedMs: Number((performance.now() - started.time).toFixed(3)),
      rssBeforeBytes: started.rss,
      rssAfterBytes,
      peakObservedRssBytes: Math.max(started.rss, rssAfterBytes),
    });
  }

  measure<T>(operator: string, operation: () => T): T {
    const started = this.start();
    try { return operation(); } finally { this.recordSince(operator, started); }
  }

  async measureAsync<T>(operator: string, operation: () => Promise<T>): Promise<T> {
    const started = this.start();
    let peak = started.rss;
    const interval = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 10);
    try { return await operation(); } finally {
      clearInterval(interval);
      const rssAfterBytes = process.memoryUsage().rss;
      this.rows.push({ operator, elapsedMs: Number((performance.now() - started.time).toFixed(3)), rssBeforeBytes: started.rss, rssAfterBytes, peakObservedRssBytes: Math.max(peak, rssAfterBytes) });
    }
  }

  report(): { schemaVersion: 1; operators: OperatorPerformance[]; peakObservedRssBytes: number } {
    return { schemaVersion: 1, operators: this.rows.map((row) => ({ ...row })), peakObservedRssBytes: Math.max(process.memoryUsage().rss, ...this.rows.map((row) => row.peakObservedRssBytes)) };
  }
}
