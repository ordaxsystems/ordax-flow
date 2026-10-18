'use strict';

// Canonical statistical methods for OrdaX Grátis benchmark reports.
// Do not infer zero latency from missing, failed or unobserved milestones.
const METRIC_KEYS=Object.freeze([
  'prepare_ms','health_ms','draft_check_ms','conversation_prepare_ms',
  'observer_prepare_ms','baseline_prepare_ms','composer_prepare_ms',
  'submit_confirm_ms','network_ttfs_ms','attempt_to_first_delta_ms',
  'fast_ttfs_ms','beta_ttfs_ms','total_ms'
]);

function percentile(values, p) {
  const xs=values.filter(x=>Number.isFinite(x)&&x>=0).slice().sort((a,b)=>a-b);
  if(!xs.length)return null;
  if(xs.length===1)return xs[0];
  const index=(xs.length-1)*p,lo=Math.floor(index),hi=Math.ceil(index);
  return Math.round((xs[lo]+(xs[hi]-xs[lo])*(index-lo))*100)/100;
}
function summarize(rows, key) {
  const values=rows.map(r=>r[key]).filter(x=>Number.isFinite(x)&&x>=0);
  if(!values.length)return null;
  const mean=values.reduce((a,b)=>a+b,0)/values.length;
  return {
    n:values.length,
    min:Math.min(...values),
    p50:percentile(values,0.50),
    p95:values.length>=5?percentile(values,0.95):null,
    p99:values.length>=20?percentile(values,0.99):null,
    max:Math.max(...values),
    mean:Math.round(mean*100)/100,
    p95_reliable_sample:values.length>=5
  };
}
const KNOWN_ERRORS=new Set([
  'send_not_observed','send_confirmation_unknown','response_not_observed',
  'chatgpt_draft_present','chatgpt_verification_required',
  'chatgpt_authentication_in_progress','chatgpt_login_required',
  'new_chat_composer_unavailable','new_chat_composer_not_empty',
  'new_chat_composer_focus_failed','new_chat_composer_clear_failed',
  'send_control_unavailable','composer_input_not_recognized'
]);
function errorCode(value) {
  const raw=String(value||'').split(':').at(-1).trim();
  return KNOWN_ERRORS.has(raw)?raw:'other_failure';
}
function completed(rows) {
  return rows.filter(row=>row?.status==='succeeded'||row?.status==='failed');
}
function buildHistoryReport(rows,{limit=100,generatedAt=new Date().toISOString()}={}) {
  const settled=completed(rows);
  const byMode={};
  for(const mode of ['auto','fast','beta']){
    const relevant=settled.filter(r=>r.observer_mode===mode);
    if(!relevant.length)continue;
    const succeeded=relevant.filter(r=>r.status==='succeeded');
    const failed=relevant.filter(r=>r.status==='failed');
    const sampled=relevant.map(r=>{
      let m={};try{const parsed=typeof r.metrics==='string'?JSON.parse(r.metrics):(r.metrics||{});if(parsed&&typeof parsed==='object')m=parsed}catch{}
      return {status:r.status,...Object.fromEntries(METRIC_KEYS.map(k=>[k,Number.isFinite(m[k])&&m[k]>=0?m[k]:null])),failed_stage:typeof m.failed_stage==='string'?m.failed_stage:null};
    });
    const failureCodes={};
    for(const f of failed){const code=errorCode(f.error);failureCodes[code]=(failureCodes[code]||0)+1}
    byMode[mode]={
      completed:relevant.length,
      succeeded:succeeded.length,
      failed:failed.length,
      success_rate_pct:Math.round(succeeded.length/relevant.length*10000)/100,
      failure_codes:failureCodes,
      successful_timings:Object.fromEntries(METRIC_KEYS.map(k=>[k,summarize(sampled.filter(x=>x.status==='succeeded'),k)])),
      failed_timings:Object.fromEntries(['prepare_ms','submit_confirm_ms','total_ms'].map(k=>[k,summarize(sampled.filter(x=>x.status==='failed'),k)])),
      incomplete_success_metrics:succeeded.filter(r=>!r.metrics).length
    };
  }
  return {
    generated_at:generatedAt,
    source:'local_sqlite_read_only',
    examined:rows.length,
    completed:settled.length,
    running:rows.filter(row=>row?.status==='running').length,
    interrupted:rows.filter(row=>row?.status==='interrupted').length,
    other_states:rows.filter(row=>!['succeeded','failed','running','interrupted'].includes(row?.status)).length,
    sample_limit:limit,
    note:'p95 is suppressed below 5 samples; p99 below 20. UI and provider timings are not interchangeable. This report does not send prompts.',
    modes:byMode
  };
}
module.exports={METRIC_KEYS,percentile,summarize,errorCode,buildHistoryReport};
