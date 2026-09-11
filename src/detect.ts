import { buildBaseline, score, type Baseline } from './baseline.ts';
import type { IncidentKind, Observation, Stream } from './sim.ts';

/**
 * Multi-signal detection.
 *
 * Spend alone cannot tell a tracking outage from a real performance collapse:
 * in both the install count falls off a cliff. The difference is that under a
 * tracking outage spend and clicks are completely normal, and under a real
 * collapse they are not. Classifying by the COMBINATION is what turns an alert
 * into something the on-call engineer can act on rather than investigate.
 */

export interface Alert {
  readonly hour: number;
  readonly kind: IncidentKind | 'UNKNOWN';
  readonly detail: string;
  readonly spendDeviations: number;
  readonly clickDeviations: number;
  readonly installDeviations: number;
}

export interface Detector {
  readonly spend: Baseline;
  readonly clicks: Baseline;
  readonly installs: Baseline;
}

export function train(history: readonly Observation[]): Detector {
  return {
    spend: buildBaseline(history.map((o) => o.spend), history[0]?.hourOfWeek ?? 0),
    clicks: buildBaseline(history.map((o) => o.clicks), history[0]?.hourOfWeek ?? 0),
    installs: buildBaseline(
      history.map((o) => o.installs), history[0]?.hourOfWeek ?? 0),
  };
}

export function classify(
  detector: Detector, obs: Observation, threshold = 4.0,
): Alert | null {
  const spend = score(detector.spend, obs.hourOfWeek, obs.spend, threshold);
  const clicks = score(detector.clicks, obs.hourOfWeek, obs.clicks, threshold);
  const installs = score(
    detector.installs, obs.hourOfWeek, obs.installs, threshold);

  if (spend.insufficientData) return null;
  if (!spend.anomalous && !clicks.anomalous && !installs.anomalous) return null;

  const base = {
    hour: obs.hour,
    spendDeviations: spend.deviations,
    clickDeviations: clicks.deviations,
    installDeviations: installs.deviations,
  };

  if (spend.deviations > threshold) {
    return { ...base, kind: 'BID_RUNAWAY',
      detail: `spend ${spend.deviations.toFixed(1)} deviations above the ` +
              `hour-of-week baseline` };
  }
  if (clicks.deviations > threshold && installs.deviations < threshold) {
    return { ...base, kind: 'FRAUD_SPIKE',
      detail: 'clicks far above baseline with installs unchanged' };
  }
  if (installs.deviations < -threshold
      && Math.abs(clicks.deviations) < threshold
      && Math.abs(spend.deviations) < threshold) {
    // The distinguishing case: the money and the clicks are fine.
    return { ...base, kind: 'TRACKING_OUTAGE',
      detail: 'installs collapsed while spend and clicks are normal - this ' +
              'is a measurement failure, not a performance failure' };
  }
  if (clicks.deviations < -threshold) {
    return { ...base, kind: 'CREATIVE_BREAK',
      detail: 'clicks collapsed against normal spend' };
  }
  return { ...base, kind: 'UNKNOWN',
    detail: 'anomalous but does not match a known signature' };
}

export interface DetectionResult {
  readonly alerts: Alert[];
  /** incident index -> hours between onset and first alert. */
  readonly latencies: Map<number, number>;
  readonly detected: number;
  /** Alerts in hours with no active incident. */
  readonly falseAlarms: number;
  readonly falseAlarmsPerWeek: number;
  readonly correctlyClassified: number;
}

export function run(
  stream: Stream, trainOn: number, threshold = 4.0,
): DetectionResult {
  const history = stream.observations.slice(0, trainOn);
  const detector = train(history);

  const alerts: Alert[] = [];
  const latencies = new Map<number, number>();
  let falseAlarms = 0;
  let correctlyClassified = 0;

  for (const obs of stream.observations.slice(trainOn)) {
    const alert = classify(detector, obs, threshold);
    if (!alert) continue;
    alerts.push(alert);

    const activeIndex = stream.incidents.findIndex(
      (i) => obs.hour >= i.startHour
          && obs.hour < i.startHour + i.durationHours);

    if (activeIndex === -1) {
      falseAlarms++;
      continue;
    }
    const incident = stream.incidents[activeIndex]!;
    if (!latencies.has(activeIndex)) {
      latencies.set(activeIndex, obs.hour - incident.startHour);
    }
    if (alert.kind === incident.kind) correctlyClassified++;
  }

  const observedHours = stream.observations.length - trainOn;
  return {
    alerts,
    latencies,
    detected: latencies.size,
    falseAlarms,
    falseAlarmsPerWeek: falseAlarms / Math.max(1, observedHours / 168),
    correctlyClassified,
  };
}
