import { HOURS_PER_WEEK } from './baseline.ts';
import {
  DEFAULT_CONFIG, applyCeiling, newState, step, type ControllerConfig,
} from './control.ts';

/**
 * Synthetic campaign telemetry with hour-of-week seasonality and INCIDENTS
 * planted at known hours.
 *
 * Detection latency and the false-alarm rate are both measured against this,
 * so "we catch bid runaways quickly" is a number rather than a hope.
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hour-of-day intensity: quiet overnight, peak mid-evening. */
const HOUR_OF_DAY = [
  0.25, 0.16, 0.11, 0.09, 0.10, 0.16, 0.32, 0.58,
  0.86, 1.02, 1.06, 1.04, 1.08, 1.05, 1.02, 1.06,
  1.18, 1.42, 1.68, 1.82, 1.64, 1.20, 0.72, 0.40,
];
/** Day-of-week multiplier, Monday first. Weekends are much heavier. */
const DAY_OF_WEEK = [0.88, 0.90, 0.92, 0.98, 1.22, 1.58, 1.44];

export function seasonalIntensity(hourOfWeek: number): number {
  const h = hourOfWeek % HOURS_PER_WEEK;
  return HOUR_OF_DAY[h % 24]! * DAY_OF_WEEK[Math.floor(h / 24) % 7]!;
}

export type IncidentKind =
  | 'BID_RUNAWAY' | 'CREATIVE_BREAK' | 'TRACKING_OUTAGE' | 'FRAUD_SPIKE';

export interface Incident {
  readonly kind: IncidentKind;
  /** Hour index into the stream. Ground truth. */
  readonly startHour: number;
  readonly durationHours: number;
}

export interface Observation {
  readonly hour: number;
  readonly hourOfWeek: number;
  readonly spend: number;
  readonly clicks: number;
  readonly installs: number;
}

export interface Stream {
  readonly observations: Observation[];
  readonly incidents: readonly Incident[];
}

export function simulate(
  hours: number, incidents: readonly Incident[] = [], seed = 1,
  baseSpendPerHour = 1_200,
): Stream {
  const rnd = mulberry32(seed);
  const observations: Observation[] = [];

  for (let hour = 0; hour < hours; hour++) {
    const hourOfWeek = hour % HOURS_PER_WEEK;
    const intensity = seasonalIntensity(hourOfWeek);

    let spend = baseSpendPerHour * intensity * (0.88 + 0.24 * rnd());
    let clicks = spend / 0.85 * (0.9 + 0.2 * rnd());
    let installs = clicks * 0.042 * (0.85 + 0.3 * rnd());

    for (const incident of incidents) {
      const active = hour >= incident.startHour
        && hour < incident.startHour + incident.durationHours;
      if (!active) continue;
      switch (incident.kind) {
        case 'BID_RUNAWAY':
          spend *= 7.5;
          clicks *= 1.35;
          break;
        case 'CREATIVE_BREAK':
          clicks *= 0.12;
          installs *= 0.05;
          break;
        case 'TRACKING_OUTAGE':
          // Spend and clicks are normal; only the install signal vanishes.
          // Distinguishing this from a real performance collapse is the
          // reason a single-signal detector is not enough.
          installs *= 0.02;
          break;
        case 'FRAUD_SPIKE':
          clicks *= 4.2;
          installs *= 1.1;
          break;
      }
    }

    observations.push({
      hour, hourOfWeek,
      spend: Math.max(0, spend),
      clicks: Math.max(0, clicks),
      installs: Math.max(0, installs),
    });
  }
  return { observations, incidents };
}

// ---------------------------------------------------------------------------
// Controller simulation
// ---------------------------------------------------------------------------

export interface PacingResult {
  readonly multiplierTrace: number[];
  readonly paceErrorTrace: number[];
  readonly totalSpend: number;
  readonly capBreached: boolean;
  readonly adjustments: number;
}

/**
 * Run the controller against a stream with a daily budget.
 *
 * The stream's natural spend is deliberately mismatched to the budget, so the
 * controller has real work to do.
 */
export function runPacing(
  stream: Stream, dailyBudget: number,
  config: ControllerConfig = DEFAULT_CONFIG,
  noise = 0.18, seed = 5,
): PacingResult {
  const rnd = mulberry32(seed);
  const state = newState();
  const multiplierTrace: number[] = [];
  const paceErrorTrace: number[] = [];

  let spentToday = 0;
  let total = 0;
  let capBreached = false;

  for (const obs of stream.observations) {
    const hourOfDay = obs.hourOfWeek % 24;
    if (hourOfDay === 0) spentToday = 0;

    // Noise on the observed spend signal: the thing a naive controller chases.
    const observed = obs.spend * state.multiplier * (1 + noise * (rnd() - 0.5) * 2);
    const allowed = applyCeiling(observed, spentToday, dailyBudget);
    if (allowed < observed) capBreached = true;

    spentToday += allowed;
    total += allowed;

    // Target pace: budget spread across the day in proportion to seasonality.
    const dayStart = obs.hourOfWeek - hourOfDay;
    let dayIntensity = 0;
    for (let h = 0; h < 24; h++) dayIntensity += seasonalIntensity(dayStart + h);
    let elapsedIntensity = 0;
    for (let h = 0; h <= hourOfDay; h++) {
      elapsedIntensity += seasonalIntensity(dayStart + h);
    }
    const targetSoFar = dailyBudget * (elapsedIntensity / dayIntensity);
    const paceError = targetSoFar > 0
      ? (spentToday - targetSoFar) / targetSoFar : 0;

    step(state, paceError, obs.hour, config);
    multiplierTrace.push(state.multiplier);
    paceErrorTrace.push(paceError);
  }

  return {
    multiplierTrace,
    paceErrorTrace,
    totalSpend: total,
    capBreached,
    adjustments: state.adjustments,
  };
}
