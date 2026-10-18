'use strict';
// Offline-only report from the installed OrdaX Grátis SQLite database.
const {DatabaseSync}=require('node:sqlite');
const path=require('node:path');
const {buildHistoryReport}=require('../src/benchmark-metrics.cjs');
const raw=Number(process.env.ORDAX_BENCH_HISTORY_LIMIT||100);
if(!Number.isInteger(raw)||raw<1||raw>1000)throw new Error('invalid_benchmark_history_limit');
const base=process.env.LOCALAPPDATA;
if(!base)throw new Error('localappdata_unavailable');
const db=new DatabaseSync(path.join(base,'OrdaX','Gratis','data','ordax-gratis.sqlite'),{readOnly:true});
try {
  const rows=db.prepare('SELECT status,observer_mode,metrics,error FROM runs ORDER BY started_at DESC LIMIT ?').all(raw);
  console.log(JSON.stringify(buildHistoryReport(rows,{limit:raw}),null,2));
} finally {db.close()}
