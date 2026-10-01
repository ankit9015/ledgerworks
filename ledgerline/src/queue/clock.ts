/** Time source. Everything in the queue takes time from here so tests can drive it. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A clock that only moves when told to. */
export class FakeClock implements Clock {
  private ms: number;
  constructor(start: Date | number = Date.UTC(2026, 0, 1)) {
    this.ms = typeof start === 'number' ? start : start.getTime();
  }
  now(): Date {
    return new Date(this.ms);
  }
  advance(ms: number): void {
    this.ms += ms;
  }
  set(ms: number): void {
    this.ms = ms;
  }
}
