import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBaseline, buildGlobalBaseline, mad, median, score, stdev,
} from '../src/baseline.ts';
import {
  DEFAULT_CONFIG, NAIVE_CONFIG, applyCeiling, assessStability, newState, step,
} from '../src/control.ts';
import { classify, run, train } from '../src/detect.ts';
import { runPacing, seasonalIntensity, simulate, type Incident } from '../src/sim.ts';

const TRAIN_HOURS = 168 * 12;
const TOTAL_HOURS = 168 * 16;

const INCIDENTS: Incident[] = [
  { kind: 'BID_RUNAWAY', startHour: 168 * 13 + 20, durationHours: 6 },
  { kind: 'CREATIVE_BREAK', startHour: 168 * 14 + 40, durationHours: 8 },
  { kind: 'TRACKING_OUTAGE', startHour: 168 * 14 + 120, durationHours: 5 },
  { kind: 'FRAUD_SPIKE', startHour: 168 * 15 + 30, durationHours: 4 },
];

describe('robust baselines', () => {
  test('median and MAD survive contamination that breaks mean and stdev', () => {
    const clean = [10, 11, 9, 10, 12, 10, 11];
    const contaminated = [...clean, 900, 850];

    assert.ok(Math.abs(median(contaminated) - median(clean)) < 2,
      'the median barely moves');
    assert.ok(Math.abs(mad(contaminated) - mad(clean)) < 3,
      'the MAD barely moves');

    // The non-robust pair moves enormously, and the standard deviation moving
    // is the dangerous half: it RAISES the alert threshold.
    assert.ok(stdev(contaminated) > stdev(clean) * 10);
  });

  test('THE SELF-DEFEATING DETECTOR: incidents raise a stdev threshold', () => {
    const quiet = Array.from({ length: 200 }, (_, i) => 100 + (i % 7));
    const withIncidents = [...quiet, 4_000, 4_200, 3_900];

    assert.ok(
      stdev(withIncidents) > stdev(quiet) * 5,
      'each incident widens the stdev threshold, so the next one is harder ' +
      'to see - after a few, the detector is blind',
    );
    assert.ok(
      mad(withIncidents) < mad(quiet) * 3,
      'the robust spread does not reward incidents with a wider threshold',
    );
  });

  test('the baseline is per hour-of-week, not global', () => {
    const stream = simulate(TRAIN_HOURS, [], 3);
    const baseline = buildBaseline(stream.observations.map((o) => o.spend));
    const saturdayEvening = baseline.centre[5 * 24 + 19]!;
    const tuesdayDawn = baseline.centre[1 * 24 + 3]!;
    assert.ok(saturdayEvening > tuesdayDawn * 4,
      'a global threshold cannot serve both of these');
  });

  test('an hour with too little history is reported, not assumed fine', () => {
    const baseline = buildBaseline([100, 110]);
    const s = score(baseline, 0, 9_999);
    assert.equal(s.insufficientData, true);
    assert.equal(s.anomalous, false);
  });

  test('a zero-spread hour does not produce infinite deviations', () => {
    const constant = Array.from({ length: 168 * 5 }, () => 100);
    const baseline = buildBaseline(constant);
    const s = score(baseline, 0, 101);
    assert.ok(Number.isFinite(s.deviations));
    assert.equal(s.anomalous, false, 'a 1% move must not alert');
  });
});

describe('detection', () => {
  const stream = simulate(TOTAL_HOURS, INCIDENTS, 7);
  const result = run(stream, TRAIN_HOURS);

  test('THE HEADLINE: every planted incident is detected', () => {
    assert.equal(result.detected, INCIDENTS.length,
      `detected ${result.detected}/${INCIDENTS.length}`);
  });

  test('bid runaway is caught within the latency budget', () => {
    const latency = result.latencies.get(0);
    assert.ok(latency !== undefined);
    assert.ok(latency! <= 1,
      `bid runaway detected after ${latency} hours; overnight it burns a ` +
      `week of budget`);
  });

  test('THE OTHER HALF: the false-alarm rate stays low enough to trust', () => {
    // A detector nobody mutes is one that is quiet on ordinary weekends.
    assert.ok(
      result.falseAlarmsPerWeek < 1.0,
      `${result.falseAlarmsPerWeek.toFixed(2)} false alarms per week - above ` +
      `about one a week it gets muted, and then it catches nothing`,
    );
  });

  test('ZERO alerts on a stream with no incidents at all', () => {
    const quiet = simulate(TOTAL_HOURS, [], 11);
    const clean = run(quiet, TRAIN_HOURS);
    assert.equal(
      clean.detected, 0,
      'nothing to detect, so nothing should be reported');
    assert.ok(clean.falseAlarmsPerWeek < 1.0,
      `${clean.falseAlarmsPerWeek.toFixed(2)} weekend false alarms`);
  });

  test('THE HARD CASE: a tracking outage is distinguished from a real collapse', () => {
    const outage = simulate(
      TOTAL_HOURS,
      [{ kind: 'TRACKING_OUTAGE', startHour: 168 * 13 + 30, durationHours: 6 }],
      13);
    const collapse = simulate(
      TOTAL_HOURS,
      [{ kind: 'CREATIVE_BREAK', startHour: 168 * 13 + 30, durationHours: 6 }],
      13);

    const a = run(outage, TRAIN_HOURS);
    const b = run(collapse, TRAIN_HOURS);
    assert.ok(a.alerts.some((x) => x.kind === 'TRACKING_OUTAGE'),
      'a measurement failure must not be reported as a performance failure');
    assert.ok(b.alerts.some((x) => x.kind === 'CREATIVE_BREAK'));
  });

  test('the alert explains itself in terms an engineer can act on', () => {
    const alert = result.alerts[0]!;
    assert.ok(alert.detail.length > 25);
    assert.ok(Number.isFinite(alert.spendDeviations));
  });
});

describe('the controller', () => {
  const stream = simulate(168 * 3, [], 21);
  const budget = 30_000;

  test('THE DIFFERENTIATOR: the damped loop converges, the naive one oscillates', () => {
    const damped = runPacing(stream, budget, DEFAULT_CONFIG);
    const naive = runPacing(stream, budget, NAIVE_CONFIG);

    const a = assessStability(damped.multiplierTrace, damped.paceErrorTrace);
    const b = assessStability(naive.multiplierTrace, naive.paceErrorTrace);

    assert.ok(
      a.oscillations < b.oscillations,
      `damped oscillated ${a.oscillations} times, naive ${b.oscillations} - ` +
      `an oscillating controller destabilises delivery worse than doing nothing`,
    );
  });

  test('the deadband stops it chasing noise', () => {
    const state = newState();
    for (let h = 0; h < 50; h++) {
      step(state, 0.01 * (h % 2 ? 1 : -1), h, DEFAULT_CONFIG);
    }
    assert.equal(state.adjustments, 0,
      'a 1% pace error is noise, not a signal');
  });

  test('the rate limit caps any single adjustment', () => {
    const state = newState();
    step(state, 5.0, 0, DEFAULT_CONFIG);   // absurd error
    assert.ok(state.multiplier >= 1 - DEFAULT_CONFIG.maxStep - 1e-9,
      'a spike in the input must not become a spike in the output');
  });

  test('the multiplier stays inside its declared bounds', () => {
    const state = newState();
    for (let h = 0; h < 400; h++) step(state, 3.0, h, DEFAULT_CONFIG);
    assert.ok(state.multiplier >= DEFAULT_CONFIG.minMultiplier - 1e-9);
    for (let h = 0; h < 400; h++) step(state, -3.0, h, DEFAULT_CONFIG);
    assert.ok(state.multiplier <= DEFAULT_CONFIG.maxMultiplier + 1e-9);
  });

  test('every adjustment is logged with its reason', () => {
    const state = newState();
    step(state, 0.5, 42, DEFAULT_CONFIG);
    assert.equal(state.log.length, 1);
    assert.equal(state.log[0]!.hour, 42);
    assert.match(state.log[0]!.reason, /overspending/);
  });
});

describe('the hard ceiling', () => {
  test('enforced independently of the controller', () => {
    assert.equal(applyCeiling(500, 900, 1_000), 100);
    assert.equal(applyCeiling(500, 1_000, 1_000), 0);
    assert.equal(applyCeiling(500, 0, 1_000), 500);
  });

  test('A BROKEN CONTROLLER CANNOT OVERSPEND', () => {
    // The property that matters most: a limit living inside the thing it
    // limits is not a limit.
    const broken = {
      ...NAIVE_CONFIG, gain: -50, maxStep: 100, maxMultiplier: 1_000,
    };
    const stream = simulate(168, [], 31);
    const budget = 5_000;
    const result = runPacing(stream, budget, broken);

    const days = Math.ceil(stream.observations.length / 24);
    assert.ok(
      result.totalSpend <= budget * days + 1e-6,
      `a controller with an inverted gain spent ${result.totalSpend} against ` +
      `a cap of ${budget * days}`,
    );
    assert.ok(result.capBreached, 'and the ceiling should record that it bit');
  });
});

describe('seasonality', () => {
  test('weekend evenings are the peak', () => {
    assert.ok(seasonalIntensity(5 * 24 + 19) > seasonalIntensity(1 * 24 + 10));
  });

  test('the overnight trough is genuinely quiet', () => {
    assert.ok(seasonalIntensity(3 * 24 + 3) < seasonalIntensity(3 * 24 + 19) / 5);
  });
});
