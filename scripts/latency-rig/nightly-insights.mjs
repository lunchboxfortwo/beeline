#!/usr/bin/env node
/** Credential-free Loops projection. The scheduled agent sends the prepared PUT through Squire. */
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { caseKey } from './nightly-history.mjs';
import { compareNightly, summarizeLoad, contention } from './nightly-compare.mjs';

export function latencyLoops(current, verdict, updatedAt = new Date().toISOString()) {
  if (!verdict.final) throw new Error('Only a final nightly verdict may be published');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(verdict.night)) throw new Error('Verdict needs an Eastern calendar date');
  const result = structuredClone(current);
  const loop = result.loops?.find((item) => item.slug === 'latency');
  if (!loop || !Array.isArray(loop.charts)) throw new Error('Missing latency loop charts');
  const report = verdict.report;
  const contended = verdict.contended === true || contention(summarizeLoad(verdict.load ?? verdict.hostLoad));
  const measured = verdict.capture?.pass !== false && compareNightly(report).capture.pass &&
    report?.commit === verdict.head && contended === false && report.rows.every((row) =>
      Number.isFinite(row.p50Ms) && row.p50Ms >= 0 && row.p95Ms >= row.p50Ms);
  const rows = measured ? report.rows : [];
  const web = verdict.webInventory;
  const currentWeb = !!web && typeof web.commit === 'string' && web.commit === verdict.head;
  const webRows = (currentWeb ? web.rows ?? [] : []).filter((row) =>
    row.samples === 40 && Number.isFinite(row.p50Ms) && row.p50Ms > 0 &&
    Number.isFinite(row.p95Ms) && row.p95Ms >= row.p50Ms &&
    row.captures?.length === 2 && new Set(row.captures.map(pair => pair.capture)).size === 2 &&
    row.captures.every(pair => [1, 2].includes(pair.capture) && pair.samples === 20))
    .map(row => ({ ...row, kind: 'web', variant: 'paired', budgetMs: 150 }));
  const routeCaptureSize = web?.routeInventory?.samplesPerCapture;
  const routeRows = (currentWeb && Number.isInteger(routeCaptureSize) && routeCaptureSize >= 3
    ? web.routeInventory.rows ?? [] : []).filter(row =>
      row.samples === routeCaptureSize * 2 && Number.isFinite(row.p50Ms) && row.p50Ms > 0 &&
      Number.isFinite(row.p95Ms) && row.p95Ms >= row.p50Ms && row.captures?.length === 2 &&
      new Set(row.captures.map(pair => pair.capture)).size === 2 &&
      row.captures.every(pair => [1, 2].includes(pair.capture) && pair.samples === routeCaptureSize))
    .map(row => ({ ...row, kind: 'web-route', variant: 'paired', budgetMs: 450 }));
  for (const row of [...rows, ...webRows, ...routeRows]) {
    const key = caseKey(row);
    const seriesKey = (percentile) => `case:${key}:${percentile}`;
    let chart = loop.charts.find((chart) => chart.series.some((series) => series.key === seriesKey('p50')));
    if (!chart) {
      chart = { label: `${key}: nightly p50 (solid) and p95 (dotted), ms${row.kind === 'web' ? ' (headless rendered-feedback upper bounds)' : ''}`, series: [
        { key: seriesKey('p50'), label: 'p50', style: 'solid', points: [] },
        { key: seriesKey('p95'), label: 'p95', style: 'dotted', points: [] },
      ] };
      loop.charts.push(chart);
      loop.limits ??= [];
      loop.limits.push({ series: seriesKey('p50'), value: row.budgetMs, label: `limit ${row.budgetMs} ms` });
    }
    for (const percentile of ['p50', 'p95']) {
      const series = chart.series.find((series) => series.key === seriesKey(percentile));
      series.points = [...series.points.filter((point) => point.date !== verdict.night),
        { date: verdict.night, value: row[`${percentile}Ms`] }].sort((a, b) => a.date.localeCompare(b.date));
    }
  }
  const note = rows.length ? `Measured ${rows.length} local emulator cases on ${verdict.night}; ${verdict.pass ? 'PASS' : 'FAIL'}. Per-case p50/p95 are measured native-frame timings, not production phone timings.` :
    `${contended === true ? 'Contended capture' : 'No usable capture'} on ${verdict.night}; no latency point added. Next measurement: the next scheduled 03:00 Eastern run.`;
  const webScore = currentWeb && webRows.length === web.coverage?.total && !web.unmeasured?.length
    ? web.fullInventoryScore : null;
  const webNote = verdict.webInventory !== undefined
    ? ` Web inventory: ${webRows.length}/${web?.coverage?.total ?? verdict.unmeasured?.length ?? 'unknown'}; full-inventory score ${webScore ?? 'unavailable'}. Web timings are headless rendered-feedback upper bounds.` : '';
  const routeNote = web?.routeInventory ? ` Web routes: ${routeRows.length}/${web.routeInventory.coverage?.total ?? 'unknown'}; fixture states: ${JSON.stringify(web.routeInventory.states)}.` : '';
  loop.note = note + webNote + routeNote;
  loop.log ??= [];
  const webDetails = [...routeRows.map(row => `${row.name}: p50=${row.p50Ms} ms p95=${row.p95Ms} ms`),
    ...(web?.routeInventory?.unmeasured ?? []).map(gap => `${gap.name}: unmeasured — ${gap.reason}`),
    ...webRows.map(row => `${row.name}: p50=${row.p50Ms} ms p95=${row.p95Ms} ms`),
    ...(verdict.unmeasured ?? []).map(gap => `${gap.name}: ${gap.availability ?? 'unmeasured'} — ${gap.reason}`)];
  loop.log = [{ date: verdict.night, text: `${note}${webNote}${routeNote} Run ${verdict.runId}. ${verdict.failures.join('; ')}${webDetails.length ? ` ${webDetails.join('; ')}` : ''}` },
    ...loop.log.filter((entry) => entry.date !== verdict.night)];
  result.updatedAt = updatedAt;
  return result;
}

export function prepareInsights(contents, verdict, updatedAt) {
  const current = JSON.parse(Buffer.from(contents.content, 'base64').toString('utf8'));
  if (!contents.sha) throw new Error('GitHub contents SHA required for optimistic concurrency');
  return { message: `Record latency night ${verdict.night}`, branch: 'main', sha: contents.sha,
    content: Buffer.from(JSON.stringify(latencyLoops(current, verdict, updatedAt), null, 2) + '\n').toString('base64') };
}

/** Transport stays with the first-party connection; conflicts always re-read and re-project. */
async function publishInsights(transport, verdict) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const contents = await transport.read();
    const response = await transport.write(prepareInsights(contents, verdict));
    if (response.status >= 200 && response.status < 300) return response;
    if (response.status !== 409) throw new Error(`Insights publication failed (${response.status})`);
  }
  throw new Error('Insights publication conflicted three times; retry with a fresh contents read');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const option = (key) => args[args.indexOf(key) + 1];
  if (!['--contents', '--verdict', '--out'].every((key) => args.includes(key))) throw new Error('Require --contents, --verdict and --out');
  const contents = JSON.parse(await readFile(option('--contents'), 'utf8'));
  const verdict = JSON.parse(await readFile(option('--verdict'), 'utf8'));
  await writeFile(option('--out'), JSON.stringify(prepareInsights(contents, verdict), null, 2) + '\n');
}
