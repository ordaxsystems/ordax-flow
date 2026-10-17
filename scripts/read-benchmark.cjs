const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const dbPath = path.join(process.env.LOCALAPPDATA, 'OrdaX', 'Gratis', 'data', 'ordax-gratis.sqlite');
const db = new DatabaseSync(dbPath);
const rows = db.prepare('select id,task_id,status,observer_mode,started_at,completed_at,metrics,error from runs order by started_at desc limit 5').all();
console.log(JSON.stringify(rows,null,2));
