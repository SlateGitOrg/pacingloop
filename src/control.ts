/**
 * The pacing controller.
 *
 * THE DIFFERENTIATOR LIVES HERE (second half).
 *
 * The obvious controller is proportional: spend is above pace, so cut the bid
 * by the size of the error. On a noisy hourly spend signal that oscillates -
 * cut hard, under-deliver, boost hard, over-deliver - and the delivery it
 * destabilises is worse than leaving it alone. The team then turns it off,
 * which is the correct decision given what it was doing.
 *
 * Three things fix that, and all three are boring:
 *
 *   DAMPING. The correction is scaled down, so the loop approaches the target
 *   rather than crossing it.
 *   RATE LIMITING. No single adjustment may move the bid more than a set
 *   fraction, so a spike in the input cannot produce a spike in the output.
 *   A DEADBAND. Errors below a threshold produce no action at all, so the
 *   controller stops chasing noise.
 *
 * Separately, and independently of all of it: a hard spend ceiling enforced
 * outside the controller, so a controller bug cannot overspend.
 */

export interface ControllerConfig {
  /** Fraction of the error corrected per step. Below 1 for damping. */
  readonly gain: number;
  /** Maximum fractional change to the bid multiplier per step. */
  readonly maxStep: number;
  /** Errors smaller than this are ignored. */
  readonly deadband: number;
  readonly minMultiplier: number;
  readonly maxMultiplier: number;
}

export const DEFAULT_CONFIG: ControllerConfig = {
  gain: 0.35,
  maxStep: 0.08,
  deadband: 0.04,
  minMultiplier: 0.2,
  maxMultiplier: 2.0,
};

/** A proportional controller with no damping. Kept for the comparison. */
export const NAIVE_CONFIG: ControllerConfig = {
  gain: 1.6,
  maxStep: 1.0,
  deadband: 0.0,
  minMultiplier: 0.2,
  maxMultiplier: 2.0,
};

export interface ControllerState {
  multiplier: number;
  adjustments: number;
  /** Every change, with the reason, for the audit trail. */
  readonly log: Array<{ hour: number; from: number; to: number; reason: string }>;
}

export function newState(): ControllerState {
  return { multiplier: 1.0, adjustments: 0, log: [] };
}

/**
 * One control step.
 *
 * `paceError` is (actual spend so far - target spend so far) / target, so
 * positive means overspending.
 */
export function step(
  state: ControllerState, paceError: number, hour: number,
  config: ControllerConfig = DEFAULT_CONFIG,
): ControllerState {
  if (Math.abs(paceError) < config.deadband) {
    return state;
  }

  const desired = state.multiplier * (1 - config.gain * paceError);
  const maxUp = state.multiplier * (1 + config.maxStep);
  const maxDown = state.multiplier * (1 - config.maxStep);
  const limited = Math.min(maxUp, Math.max(maxDown, desired));
  const next = Math.min(
    config.maxMultiplier, Math.max(config.minMultiplier, limited));

  if (next !== state.multiplier) {
    state.log.push({
      hour, from: state.multiplier, to: next,
      reason: paceError > 0
        ? `overspending by ${(paceError * 100).toFixed(1)}%`
        : `underspending by ${(-paceError * 100).toFixed(1)}%`,
    });
    state.multiplier = next;
    state.adjustments++;
  }
  return state;
}

/**
 * The hard ceiling, enforced OUTSIDE the controller.
 *
 * If the controller has a bug, this is what stops the money leaving. A limit
 * that lives inside the thing it is limiting is not a limit.
 */
export function applyCeiling(
  spend: number, spentSoFar: number, periodCap: number,
): number {
  const headroom = Math.max(0, periodCap - spentSoFar);
  return Math.min(spend, headroom);
}

export interface StabilityReport {
  readonly oscillations: number;
  readonly maxOvershoot: number;
  readonly finalError: number;
  readonly converged: boolean;
}

/**
 * Count direction reversals in the multiplier trace.
 *
 * An oscillating controller and a converging one can end at the same place;
 * what separates them is how they got there, and a spend trace that swings
 * every hour is destabilising delivery even if the daily total looks fine.
 */
export function assessStability(
  trace: readonly number[], targetError: readonly number[],
): StabilityReport {
  let reversals = 0;
  let previousDirection = 0;
  for (let i = 1; i < trace.length; i++) {
    const delta = trace[i]! - trace[i - 1]!;
    const direction = Math.sign(delta);
    if (direction !== 0 && previousDirection !== 0
        && direction !== previousDirection) {
      reversals++;
    }
    if (direction !== 0) previousDirection = direction;
  }
  const overshoot = Math.max(...targetError.map(Math.abs), 0);
  const finalError = Math.abs(targetError[targetError.length - 1] ?? 0);
  return {
    oscillations: reversals,
    maxOvershoot: overshoot,
    finalError,
    converged: finalError < 0.10 && reversals < trace.length / 4,
  };
}
