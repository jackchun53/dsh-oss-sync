/**
 * A poll loop for one object. Ticks never overlap: a slow read defers the
 * next tick instead of stacking requests, and {@link PollLoop.stop} settles
 * after the in-flight tick so disposal completes against quiet storage.
 *
 * @module dsh-oss-sync/poll
 */

/** The loop handle: no scheduling before {@link PollLoop.start}, none after stop. */
export class PollLoop {
  private timer: NodeJS.Timeout | undefined
  private inFlight: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(
    private intervalMs: number,
    private readonly tick: () => Promise<void>,
    private readonly onError: (error: unknown) => void,
  ) {}

  /** Begin polling. The timer is unref'd, so a one-shot CLI run still exits. */
  start(): void {
    if (this.stopped || this.timer !== undefined) return
    this.timer = this.schedule()
  }

  /**
   * Change the interval at runtime; the in-flight tick settles first.
   * @param intervalMs - the new interval in milliseconds.
   */
  restart(intervalMs: number): void {
    if (this.stopped) return
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    this.intervalMs = intervalMs
    this.start()
  }

  /**
   * Suspend ticks without ending the loop. The providers pause while no bucket
   * is configured — there is nothing to poll — and {@link start} or
   * {@link restart} resumes afterwards.
   */
  pause(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  /** Arm the timer; separate so a restart reuses the identical callback. */
  private schedule(): NodeJS.Timeout {
    const timer = setInterval(() => {
      this.inFlight = this.inFlight.then(async () => {
        if (!this.stopped) await this.tick()
      }).catch(this.onError)
    }, this.intervalMs)
    timer.unref()
    return timer
  }

  /** Stop polling and wait for the in-flight tick. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    await this.inFlight
  }
}
