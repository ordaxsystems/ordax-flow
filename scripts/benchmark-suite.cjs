const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dbPath = path.join(process.env.LOCALAPPDATA, 'OrdaX', 'Gratis', 'data', 'ordax-gratis.sqlite');
const requestedRuns = Number.parseInt(process.env.ORDAX_BENCH_RUNS || '5', 10);
const runsPerMode = Math.min(50, Math.max(1, Number.isFinite(requestedRuns) ? requestedRuns : 5));
const modes = String(process.env.ORDAX_BENCH_MODES || 'fast,beta')
  .split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
for (const mode of modes) if (!['auto', 'fast', 'beta'].includes(mode)) throw new Error(`invalid_mode:${mode}`);

const db = new DatabaseSync(dbPath, { readOnly: true });
function parseJsonOutput(stdout) {
  const text = String(stdout || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`benchmark_output_not_json:${text.slice(-500)}`);
  return JSON.parse(text.slice(start, end + 1));
}
function latestMetrics(mode) {
  const row = db.prepare('SELECT id,status,observer_mode,metrics,started_at,completed_at,error FROM runs WHERE observer_mode=? ORDER BY started_at DESC LIMIT 1').get(mode);
  if (!row) return null;
  return { ...row, metrics: row.metrics ? JSON.parse(row.metrics) : null };
}
function percentile(values, p) {
  const xs = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!xs.length) return null;
  if (xs.length === 1) return xs[0];
  const index = (xs.length - 1) * p;
  const lo = Math.floor(index), hi = Math.ceil(index);
  if (lo === hi) return xs[lo];
  return Math.round((xs[lo] + (xs[hi] - xs[lo]) * (index - lo)) * 100) / 100;
}
function summarize(rows, key) {
  const values = rows.map(row => row[key]).filter(Number.isFinite);
  return values.length ? {
    n: values.length,
    min: Math.min(...values),
    p50: percentile(values, 0.50),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: Math.max(...values),
    mean: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100
  } : null;
}

const samples = [];
try {
  for (const mode of modes) {
    for (let iteration = 1; iteration <= runsPerMode; iteration++) {
      const startedAt = new Date().toISOString();
      const child = spawnSync(process.execPath, [path.join(root, 'scripts', 'live-ui-text-smoke.cjs')], {
        cwd: root,
        env: { ...process.env, ORDAX_E2E_MODE: mode },
        encoding: 'utf8',
        timeout: 240000
      });
      if (child.error) throw child.error;
      if (child.status !== 0) throw new Error(`smoke_failed:${mode}:${iteration}\n${child.stdout}\n${child.stderr}`);
      const ui = parseJsonOutput(child.stdout);
      const run = latestMetrics(mode);
      if (!run || run.started_at < startedAt) throw new Error(`run_metrics_not_found:${mode}:${iteration}`);
      const metrics = run.metrics || {};
      samples.push({
        mode, iteration, run_id: run.id,
        ui_ttfv_ms: ui.ttfv_ms,
        ui_total_ms: ui.total_ms,
        prepare_ms: metrics.prepare_ms,
        health_ms: metrics.health_ms,
        draft_check_ms: metrics.draft_check_ms,
        conversation_prepare_ms: metrics.conversation_prepare_ms,
        observer_prepare_ms: metrics.observer_prepare_ms,
        baseline_prepare_ms: metrics.baseline_prepare_ms,
        composer_prepare_ms: metrics.composer_prepare_ms,
        submit_confirm_ms: metrics.submit_confirm_ms,
        network_ttfs_ms: metrics.network_ttfs_ms,
        attempt_to_first_delta_ms: metrics.attempt_to_first_delta_ms,
        fast_ttfs_ms: metrics.fast_ttfs_ms,
        beta_ttfs_ms: metrics.beta_ttfs_ms,
        fast_lead_ms: metrics.fast_lead_ms,
        provider_total_ms: metrics.total_ms,
        observer_used: metrics.observer_used,
        first_observer: metrics.first_observer,
        fast_seen: metrics.fast_seen,
        beta_seen: metrics.beta_seen,
        fast_delivered: metrics.fast_delivered,
        fast_suppressed: metrics.fast_suppressed,
        fast_suppression_reason: metrics.fast_suppression_reason,
        streamed: Boolean(ui.sawLive),
        first_visible_source: ui.firstVisibleSource || null,
        passed: Boolean(ui.passed)
      });
      process.stderr.write(`[${mode} ${iteration}/${runsPerMode}] UI TTFV=${ui.ttfv_ms}ms total=${ui.total_ms}ms observer=${metrics.observer_used || 'unknown'}\n`);
    }
  }
} finally {
  db.close();
}

const byMode = Object.fromEntries(modes.map(mode => {
  const rows = samples.filter(sample => sample.mode === mode);
  return [mode, {
    samples: rows.length,
    passed: rows.filter(row => row.passed).length,
    streamed: rows.filter(row => row.streamed).length,
    streaming_rate: rows.length ? Math.round((rows.filter(row => row.streamed).length / rows.length) * 10000) / 100 : null,
    fast_seen_rate: rows.length ? Math.round((rows.filter(row => row.fast_seen).length / rows.length) * 10000) / 100 : null,
    fast_delivery_rate: rows.length ? Math.round((rows.filter(row => row.fast_delivered).length / rows.length) * 10000) / 100 : null,
    beta_seen_rate: rows.length ? Math.round((rows.filter(row => row.beta_seen).length / rows.length) * 10000) / 100 : null,
    fast_win_rate: rows.length ? Math.round((rows.filter(row => row.first_observer === 'fast').length / rows.length) * 10000) / 100 : null,
    beta_fallback_rate: rows.length ? Math.round((rows.filter(row => row.mode === 'fast' && row.first_observer === 'beta').length / rows.length) * 10000) / 100 : null,
    ui_ttfv_ms: summarize(rows, 'ui_ttfv_ms'),
    ui_total_ms: summarize(rows, 'ui_total_ms'),
    prepare_ms: summarize(rows, 'prepare_ms'),
    health_ms: summarize(rows, 'health_ms'),
    draft_check_ms: summarize(rows, 'draft_check_ms'),
    conversation_prepare_ms: summarize(rows, 'conversation_prepare_ms'),
    observer_prepare_ms: summarize(rows, 'observer_prepare_ms'),
    baseline_prepare_ms: summarize(rows, 'baseline_prepare_ms'),
    composer_prepare_ms: summarize(rows, 'composer_prepare_ms'),
    submit_confirm_ms: summarize(rows, 'submit_confirm_ms'),
    attempt_to_first_delta_ms: summarize(rows, 'attempt_to_first_delta_ms'),
    fast_ttfs_ms: summarize(rows, 'fast_ttfs_ms'),
    beta_ttfs_ms: summarize(rows, 'beta_ttfs_ms'),
    fast_lead_ms: summarize(rows, 'fast_lead_ms'),
    provider_total_ms: summarize(rows, 'provider_total_ms')
  }];
}));

console.log(JSON.stringify({
  generated_at: new Date().toISOString(),
  runs_per_mode: runsPerMode,
  percentile_method: 'linear_interpolation',
  modes: byMode,
  samples
}, null, 2));
