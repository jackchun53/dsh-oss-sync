/**
 * A poll loop for one object. Ticks never overlap: a slow read defers the
 * next tick instead of stacking requests, and {@link PollLoop.stop} settles
 * after the in-flight tick so disposal completes against quiet storage.
 *
 * @module dsh-oss-sync/poll
 */
/** The loop handle: no scheduling before {@link PollLoop.start}, none after stop. */
export class PollLoop {
    intervalMs;
    tick;
    onError;
    timer;
    inFlight = Promise.resolve();
    stopped = false;
    constructor(intervalMs, tick, onError) {
        this.intervalMs = intervalMs;
        this.tick = tick;
        this.onError = onError;
    }
    /** Begin polling. The timer is unref'd, so a one-shot CLI run still exits. */
    start() {
        if (this.stopped || this.timer !== undefined)
            return;
        this.timer = setInterval(() => {
            this.inFlight = this.inFlight.then(async () => {
                if (!this.stopped)
                    await this.tick();
            }).catch(this.onError);
        }, this.intervalMs);
        this.timer.unref();
    }
    /** Stop polling and wait for the in-flight tick. */
    async stop() {
        this.stopped = true;
        if (this.timer !== undefined)
            clearInterval(this.timer);
        this.timer = undefined;
        await this.inFlight;
    }
}
