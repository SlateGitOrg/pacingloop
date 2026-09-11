/**
 * Robust seasonal baselines.
 *
 * THE DIFFERENTIATOR LIVES HERE (first half).
 *
 * Mean plus three standard deviations is the default anomaly detector, and on
 * campaign data it fires every Saturday evening. Two reasons, and both are
 * fatal:
 *
 *   SEASONALITY. Spend on a Saturday evening is genuinely several times a
 *   Tuesday morning. A single global threshold calls that an anomaly, so the
 *   detector is wrong on schedule, every week.
 *
 *   THE MEAN AND THE STANDARD DEVIATION ARE NOT ROBUST. A single genuine
 *   incident inflates both, which RAISES the threshold - so the detector
 *   becomes less sensitive precisely because something went wrong. After two
 *   incidents it cannot see the third.
 *
 * So the baseline is a per-hour-of-week MEDIAN, and the spread is the median
 * absolute deviation. Both have a 50% breakdown point: half the history could
 * be incidents and the baseline would still be right.
 */

export const HOURS_PER_WEEK = 168;

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Median absolute deviation, scaled to be comparable with a standard
 *  deviation on normally distributed data. */
export function mad(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const m = median(values);
  return 1.4826 * median(values.map((v) => Math.abs(v - m)));
}

export function mean(values: readonly number[]): number {
  return values.length
    ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

export function stdev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(
    values.reduce((a, v) => a + (v - m) ** 2, 0) / (values.length - 1));
}

export interface Baseline {
  /** hour-of-week -> expected level */
  readonly centre: readonly number[];
  /** hour-of-week -> robust spread */
  readonly spread: readonly number[];
  readonly samplesPerHour: readonly number[];
}

/** Build an hour-of-week baseline from a history of hourly observations. */
export function buildBaseline(
  history: readonly number[], startHourOfWeek = 0,
): Baseline {
  const buckets: number[][] = Array.from(
    { length: HOURS_PER_WEEK }, () => []);
  history.forEach((value, i) => {
    buckets[(startHourOfWeek + i) % HOURS_PER_WEEK]!.push(value);
  });
  return {
    centre: buckets.map(median),
    spread: buckets.map(mad),
    samplesPerHour: buckets.map((b) => b.length),
  };
}

/** The naive alternative, included so the comparison can be measured. */
export function buildGlobalBaseline(history: readonly number[]): Baseline {
  const centre = mean(history);
  const spread = stdev(history);
  return {
    centre: Array(HOURS_PER_WEEK).fill(centre),
    spread: Array(HOURS_PER_WEEK).fill(spread),
    samplesPerHour: Array(HOURS_PER_WEEK).fill(history.length),
  };
}

export interface Score {
  readonly hourOfWeek: number;
  readonly observed: number;
  readonly expected: number;
  readonly deviations: number;
  readonly anomalous: boolean;
  /** Not enough history for this hour to judge it. Reported, not assumed OK. */
  readonly insufficientData: boolean;
}

//: Weeks of history needed before an hour-of-week bucket is judged at all.
//: A MAD computed from three observations is itself noise.
export const MIN_SAMPLES = 6;

//: Floor on the spread, as a fraction of the expected level.
//:
//: Campaign noise is multiplicative - a quiet 3am hour varies by a few pounds
//: and a Saturday peak by a few hundred - so an absolute floor is wrong at one
//: end or the other. Without any floor, an hour that happened to be stable
//: across the training weeks gets a tiny MAD and then alerts on ordinary
//: variation, which is where most of the weekend false alarms come from.
export const MIN_SPREAD_FRACTION = 0.12;

export function score(
  baseline: Baseline, hourOfWeek: number, observed: number,
  threshold = 4.0,
): Score {
  const h = hourOfWeek % HOURS_PER_WEEK;
  const expected = baseline.centre[h]!;
  const spread = baseline.spread[h]!;
  const samples = baseline.samplesPerHour[h]!;

  if (samples < MIN_SAMPLES) {
    return {
      hourOfWeek: h, observed, expected, deviations: 0,
      anomalous: false, insufficientData: true,
    };
  }

  // The spread is floored relative to the expected level. A zero spread would
  // give infinite deviations; a merely SMALL spread is the more common and
  // more damaging case, because it alerts on ordinary variation and buries
  // the real incidents in weekend noise.
  const effective = Math.max(spread, expected * MIN_SPREAD_FRACTION, 1);
  const deviations = (observed - expected) / effective;
  return {
    hourOfWeek: h, observed, expected, deviations,
    anomalous: Math.abs(deviations) > threshold,
    insufficientData: false,
  };
}
