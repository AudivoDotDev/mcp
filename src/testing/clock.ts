/**
 * A clock the suites own: `sleep` advances it instead of waiting, so a tool
 * that polls a job for a minute runs in a millisecond and a suite can say
 * exactly how many polls fit in a wait.
 *
 * Test support only: excluded from the package build.
 */
import { HOSTED_WAIT, type WaitPolicy } from '../transcribe.js';
import type { ToolContext } from '../tools.js';

export type FakeClock = {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Every pause taken, in order. */
  readonly slept: number[];
};

export function fakeClock(start = Date.parse('2026-09-08T09:00:00.000Z')): FakeClock {
  let at = start;
  const slept: number[] = [];
  return {
    now: () => at,
    sleep: async (ms) => {
      slept.push(ms);
      at += ms;
    },
    slept,
  };
}

/** The waiting half of a `ToolContext`, over a fake clock, with the hosted policy unless told otherwise. */
export function waitContext(
  clock: FakeClock = fakeClock(),
  wait: WaitPolicy = HOSTED_WAIT,
): Pick<ToolContext, 'wait' | 'now' | 'sleep'> {
  return { wait, now: clock.now, sleep: clock.sleep };
}
