/**
 * The 60-second artefact: detection latency, false alarms, and a controller
 * that converges. Run: `npm run demo`
 */
import {
  buildBaseline, buildGlobalBaseline, mad, score, stdev,
} from './baseline.ts';
import { DEFAULT_CONFIG, NAIVE_CONFIG, assessStability } from './control.ts';
import { run } from './detect.ts';
import { runPacing, simulate, type Incident } from './sim.ts';

const TRAIN = 168 * 12;
const TOTAL = 168 * 16;
const INCIDENTS: Incident[] = [
  { kind: 'BID_RUNAWAY', startHour: 168 * 13 + 20, durationHours: 6 },
  { kind: 'CREATIVE_BREAK', startHour: 168 * 14 + 40, durationHours: 8 },
  { kind: 'TRACKING_OUTAGE', startHour: 168 * 14 + 120, durationHours: 5 },
  { kind: 'FRAUD_SPIKE', startHour: 168 * 15 + 30, durationHours: 4 },
];

const stream = simulate(TOTAL, INCIDENTS, 7);
const result = run(stream, TRAIN);

console.log('\n  PACINGLOOP - the alert nobody mutes');
console.log('  ' + '='.repeat(76));
console.log(`  ${TOTAL.toLocaleString()} hours of telemetry, ` +
            `${TRAIN.toLocaleString()} used for the baseline, ` +
            `${INCIDENTS.length} planted incidents.\n`);

// --- why the default detector fails ----------------------------------------
const spendHistory = stream.observations.slice(0, TRAIN).map((o) => o.spend);
const robust = buildBaseline(spendHistory);
const naive = buildGlobalBaseline(spendHistory);

console.log('  WHY MEAN + 3 SIGMA FIRES EVERY SATURDAY');
console.log('  ' + '-'.repeat(76));
const samples: Array<[string, number]> = [
  ['Tue 03:00', 1 * 24 + 3],
  ['Tue 10:00', 1 * 24 + 10],
  ['Sat 20:00', 5 * 24 + 20],
  ['Sun 19:00', 6 * 24 + 19],
];
console.log(`  ${'hour'.padEnd(12)}${'typical spend'.padEnd(16)}` +
            `${'global threshold'.padEnd(19)}hour-of-week threshold`);
for (const [label, h] of samples) {
  const level = robust.centre[h]!;
  const globalTop = naive.centre[h]! + 3 * naive.spread[h]!;
  const robustTop = level + 4 * Math.max(robust.spread[h]!, level * 0.12);
  const flag = level > globalTop ? '  <- ALERTS on a normal hour' : '';
  console.log(`  ${label.padEnd(12)}${level.toFixed(0).padStart(13)}   ` +
              `${globalTop.toFixed(0).padStart(16)}   ` +
              `${robustTop.toFixed(0).padStart(16)}${flag}`);
}

const contaminated = [...spendHistory.slice(0, 400), 40_000, 42_000, 39_000];
console.log(`\n  And after three incidents enter the history:`);
console.log(`    stdev  ${stdev(spendHistory.slice(0, 400)).toFixed(0)} -> ` +
            `${stdev(contaminated).toFixed(0)}   (threshold WIDENS)`);
console.log(`    MAD    ${mad(spendHistory.slice(0, 400)).toFixed(0)} -> ` +
            `${mad(contaminated).toFixed(0)}   (barely moves)`);
console.log('  Each incident makes the next one harder to see. After a few,');
console.log('  the detector is blind - and nothing announces that.\n');

// --- detection -------------------------------------------------------------
console.log('  DETECTION');
console.log('  ' + '-'.repeat(76));
console.log(`  ${'incident'.padEnd(20)}${'planted at'.padEnd(14)}` +
            `${'detected after'.padEnd(17)}classified as`);
INCIDENTS.forEach((incident, i) => {
  const latency = result.latencies.get(i);
  const alert = result.alerts.find(
    (a) => a.hour >= incident.startHour
        && a.hour < incident.startHour + incident.durationHours);
  console.log(`  ${incident.kind.padEnd(20)}h${String(incident.startHour).padEnd(13)}` +
              `${(latency === undefined ? 'MISSED' : `${latency}h`).padEnd(17)}` +
              `${alert?.kind ?? '-'}`);
});
console.log(`\n    ${result.detected}/${INCIDENTS.length} detected, ` +
            `${result.falseAlarmsPerWeek.toFixed(2)} false alarms per week.`);

const quiet = run(simulate(TOTAL, [], 11), TRAIN);
console.log(`    On a stream with NO incidents: ${quiet.detected} detections, ` +
            `${quiet.falseAlarmsPerWeek.toFixed(2)} false alarms per week.`);
console.log('    Below about one a week is what keeps it unmuted, and an');
console.log('    unmuted detector is the only kind that catches anything.\n');

const outage = result.alerts.find((a) => a.kind === 'TRACKING_OUTAGE');
if (outage) {
  console.log('  THE HARD CASE');
  console.log('  ' + '-'.repeat(76));
  console.log(`    ${outage.detail}`);
  console.log(`    spend ${outage.spendDeviations.toFixed(1)}σ, ` +
              `clicks ${outage.clickDeviations.toFixed(1)}σ, ` +
              `installs ${outage.installDeviations.toFixed(1)}σ`);
  console.log('    A single-signal detector reports this as a performance');
  console.log('    collapse and sends the team to pause the campaign - when');
  console.log('    the campaign is fine and the tracking is broken.\n');
}

// --- the controller --------------------------------------------------------
const pacingStream = simulate(168 * 3, [], 21);
const damped = runPacing(pacingStream, 30_000, DEFAULT_CONFIG);
const naivePacing = runPacing(pacingStream, 30_000, NAIVE_CONFIG);
const a = assessStability(damped.multiplierTrace, damped.paceErrorTrace);
const b = assessStability(
  naivePacing.multiplierTrace, naivePacing.paceErrorTrace);

console.log('  THE CONTROLLER');
console.log('  ' + '-'.repeat(76));
console.log(`  ${'controller'.padEnd(22)}${'adjustments'.padEnd(14)}` +
            `${'direction reversals'.padEnd(22)}final pace error`);
console.log(`  ${'damped + deadband'.padEnd(22)}` +
            `${String(damped.adjustments).padEnd(14)}` +
            `${String(a.oscillations).padEnd(22)}${(a.finalError * 100).toFixed(1)}%`);
console.log(`  ${'proportional (naive)'.padEnd(22)}` +
            `${String(naivePacing.adjustments).padEnd(14)}` +
            `${String(b.oscillations).padEnd(22)}${(b.finalError * 100).toFixed(1)}%`);
console.log('\n    The naive loop reverses direction constantly: cut hard,');
console.log('    under-deliver, boost hard, over-deliver. It destabilises');
console.log('    delivery worse than doing nothing, and the team turns it off.\n');

// --- the ceiling -----------------------------------------------------------
const brokenConfig = {
  ...NAIVE_CONFIG, gain: -50, maxStep: 100, maxMultiplier: 1_000,
};
const broken = runPacing(simulate(168, [], 31), 5_000, brokenConfig);
const days = Math.ceil(168 / 24);
console.log('  THE HARD CEILING');
console.log('  ' + '-'.repeat(76));
console.log('    Controller with an INVERTED gain - it boosts when overspending:');
console.log(`      cap over the period   ${(5_000 * days).toLocaleString()}`);
console.log(`      actually spent        ${broken.totalSpend.toFixed(0).toLocaleString()}`);
console.log(`      ceiling engaged       ${broken.capBreached}`);
console.log('    The ceiling is enforced outside the controller, so a bug in');
console.log('    the controller cannot spend the money. A limit that lives');
console.log('    inside the thing it limits is not a limit.\n');
