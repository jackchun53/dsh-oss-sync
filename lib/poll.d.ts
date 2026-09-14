/**
 * A poll loop for one object. Ticks never overlap: a slow read defers the
 * next tick instead of stacking requests, and {@link PollLoop.stop} settles
 * after the in-flight tick so disposal completes against quiet storage.
 *
 * @module dsh-oss-sync/poll
 */
/** The loop handle: no scheduling before {@link PollLoop.start}, none after stop. */
export declare class PollLoop {
    private intervalMs;
    private readonly tick;
    private readonly onError;
    private timer;
    private inFlight;
    private stopped;
    constructor(intervalMs: number, tick: () => Promise<void>, onError: (error: unknown) => void);
    /** Begin polling. The timer is unref'd, so a one-shot CLI run still exits. */
    start(): void;
    /**
     * Change the interval at runtime; the in-flight tick settles first.
     * @param intervalMs - the new interval in milliseconds.
     */
    restart(intervalMs: number): void;
    /** Arm the timer; separate so a restart reuses the identical callback. */
    private schedule;
    /** Stop polling and wait for the in-flight tick. */
    stop(): Promise<void>;
}
