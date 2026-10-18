import {test} from 'node:test';
import assert from 'node:assert/strict';
import metrics from '../src/benchmark-metrics.cjs';
const {percentile,summarize,errorCode,buildHistoryReport}=metrics;

test('percentiles use interpolation and ignore missing/nonfinite/negative values',()=>{
  assert.equal(percentile([10,20,30,40,50],0.95),48);
  assert.equal(percentile([-1,NaN,Infinity],0.95),null);
  assert.equal(summarize([{ms:1},{ms:3},{ms:5},{ms:7},{ms:9}],'ms').p50,5);
});
test('p95 is not presented as reliable from two successful samples',()=>{
  const a=summarize([{x:100},{x:200}],'x');
  assert.equal(a.p50,150);assert.equal(a.p95,null);assert.equal(a.p95_reliable_sample,false);
});
test('history separates successful and failed runs and does not leak raw errors',()=>{
  const rows=[
    {status:'succeeded',observer_mode:'auto',metrics:JSON.stringify({prepare_ms:110,total_ms:7000})},
    {status:'succeeded',observer_mode:'auto',metrics:JSON.stringify({prepare_ms:90,total_ms:6500})},
    {status:'failed',observer_mode:'auto',metrics:JSON.stringify({prepare_ms:800,failed_stage:'submit'}),error:'submit:send_not_observed'},
    {status:'running',observer_mode:'auto',metrics:null},
    {status:'failed',observer_mode:'beta',metrics:'{broken',error:'something containing token SECRET'},
  ];
  const report=buildHistoryReport(rows,{limit:5,generatedAt:'fixed'});
  assert.equal(report.completed,4);assert.equal(report.running,1);
  assert.equal(report.modes.auto.success_rate_pct,66.67);
  assert.equal(report.modes.auto.successful_timings.prepare_ms.p50,100);
  assert.equal(report.modes.auto.successful_timings.prepare_ms.p95,null);
  assert.equal(report.modes.auto.failed_timings.prepare_ms.p50,800);
  assert.equal(report.modes.auto.failure_codes.send_not_observed,1);
  assert.equal(report.modes.beta.failure_codes.other_failure,1);
  assert.ok(!JSON.stringify(report).includes('SECRET'));
});
test('invalid or absent metrics do not become fabricated zero measurements',()=>{
  const report=buildHistoryReport([{status:'failed',observer_mode:'fast',metrics:null,error:'unknown'}]);
  assert.equal(report.modes.fast.failed_timings.total_ms,null);
  assert.equal(report.modes.fast.failure_codes.other_failure,1);
});
