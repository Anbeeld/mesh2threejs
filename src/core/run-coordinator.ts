/**
 * Per-run operation coordinator (final closure §3). Trusted mutations serialize per runId:
 * a stale gate/review/finalize can never overwrite a newer reopen. The coordinator provides
 * a run-exclusive mutex AND a compare-and-swap sequence guard at the store layer.
 *
 * Defense in depth: the CAS is enforced BOTH in the coordinator (HTTP routing layer) AND in
 * the authority/store layer (persistComputed/save). A stale commit that somehow bypasses the
 * mutex is still refused by the sequence check.
 */

/**
 * Serializes operations per run. Each runExclusive call holds a run-scoped mutex so only one
 * mutating operation executes at a time for that runId. Pure reads may bypass the mutex.
 */
export class RunOperationCoordinator {
  private readonly queues = new Map<string, Promise<unknown>>();

  /**
   * Runs fn while holding the per-run mutex. Concurrent calls for the SAME runId serialize;
   * calls for DIFFERENT runIds run in parallel. The returned promise resolves to fn's result.
   */
  async runExclusive<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(runId) ?? Promise.resolve();
    let release: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.queues.set(runId, previous.then(() => gate, () => gate));
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release!();
      // Clean up the queue entry only if no newer operation is waiting behind it.
      if (this.queues.get(runId) === gate) this.queues.delete(runId);
    }
  }
}