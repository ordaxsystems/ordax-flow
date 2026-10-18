const { acquireE2ELock } = require('./e2e-lock.cjs');
const { DatabaseSync } = require('node:sqlite');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');

acquireE2ELock('history-smoke');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const getJson = url => new Promise((resolve, reject) => http.get(url, response => {
  let text = '';
  response.on('data', chunk => { text += chunk; });
  response.on('end', () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } });
}).on('error', reject));

async function main() {
  const target = (await getJson('http://127.0.0.1:9444/json/list'))
    .find(row => row.type === 'page' && String(row.url).endsWith('/desktop/ui.html'));
  if (!target) throw new Error('ordax_ui_target_not_found');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
  };
  const evaluate = async expression => {
    const id = ++seq;
    const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    ws.send(JSON.stringify({ id, method:'Runtime.evaluate',
      params:{ expression, awaitPromise:true, returnByValue:true } }));
    const result = await response;
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'ui_evaluation_failed');
    return result.result.value;
  };
  const until = async (predicate, label) => {
    for (let i = 0; i < 150; i++) {
      const value = await predicate();
      if (value) return value;
      await sleep(80);
    }
    throw new Error('ui_timeout:' + label);
  };

  let taskId = null;
  let db = null;
  const seed = Date.now().toString(36);
  const marker = 'ORDAX_PAGE_E2E_' + seed + '_';
  const capture = () => evaluate(`(() => {
    const nodes = [...document.querySelectorAll('#messageList .message .message-content')];
    return {
      task:document.querySelector('#taskId')?.textContent || '',
      status:document.querySelector('#historyPageStatus')?.textContent || '',
      count:nodes.length, first:nodes[0]?.textContent || '', last:nodes.at(-1)?.textContent || '',
      olderDisabled:document.querySelector('#olderMessages')?.disabled,
      newerDisabled:document.querySelector('#newerMessages')?.disabled,
      liveCount:document.querySelectorAll('#messages .message.live').length
    };
  })()`);
  const expectPage = async (index, first, last, count) => until(async () => {
    const state = await capture();
    return state.task === taskId && state.status.includes('Página ' + index) &&
      state.count === count && state.first === marker + first && state.last === marker + last ? state : null;
  }, 'page_' + index);
  try {
    const previous = await evaluate("document.querySelector('#taskId')?.textContent || ''");
    await evaluate("document.querySelector('#newTask').click();true");
    taskId = await until(async () => {
      const current = await evaluate("document.querySelector('#taskId')?.textContent || ''");
      return current && current !== previous ? current : null;
    }, 'fixture_created');
    db = new DatabaseSync(path.join(process.env.LOCALAPPDATA, 'OrdaX', 'Gratis',
      'data', 'ordax-gratis.sqlite'));
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;');
    try {
      const insert = db.prepare('INSERT INTO messages(id,task_id,role,content,created_at) VALUES(?,?,?,?,?)');
      for (let i = 0; i < 125; i++) {
        const ordinal = String(i).padStart(3, '0');
        insert.run('e2e_history_' + seed + '_' + ordinal, taskId, i % 2 ? 'assistant' : 'user',
          marker + ordinal, '2026-10-17T00:00:00.000Z');
      }
      db.exec('COMMIT;');
    } catch (error) { db.exec('ROLLBACK;'); throw error; }

    await evaluate(`(() => {
      const button = document.querySelector('.task[data-id=' + JSON.stringify(${JSON.stringify(taskId)}) + ']');
      if (!button) throw new Error('fixture_nav_missing');
      button.click(); return true;
    })()`);
    const first = await expectPage(1, '075', '124', 50);
    assert.equal(first.olderDisabled, false);
    assert.equal(first.newerDisabled, true);
    assert.equal(first.liveCount, 0);

    await evaluate("document.querySelector('#olderMessages').click();true");
    const second = await expectPage(2, '025', '074', 50);
    assert.equal(second.olderDisabled, false);
    assert.equal(second.newerDisabled, false);

    await evaluate("document.querySelector('#olderMessages').click();true");
    const third = await expectPage(3, '000', '024', 25);
    assert.equal(third.olderDisabled, true);
    assert.equal(third.newerDisabled, false);

    await evaluate("document.querySelector('#newerMessages').click();true");
    await expectPage(2, '025', '074', 50);
    await evaluate("document.querySelector('#newerMessages').click();true");
    const returned = await expectPage(1, '075', '124', 50);
    assert.equal(returned.newerDisabled, true);
    console.log(JSON.stringify({ taskId, fixtureMessages:125, pageSizes:[50,50,25],
      pageOrder:'latest > older > oldest > older > latest', oldest:'000', newest:'124',
      noDuplicateLiveNodes:true, passed:true }, null, 2));
  } finally {
    if (taskId) {
      try {
        await evaluate(`(() => {
          const other = [...document.querySelectorAll('.task')].find(button =>
            button.dataset.id !== ${JSON.stringify(taskId)});
          if (other) other.click();
          return true;
        })()`);
        await until(async () => (await capture()).task !== taskId, 'fixture_unselected');
        if (db) {
          db.exec('BEGIN IMMEDIATE;');
          try {
            db.prepare('DELETE FROM events WHERE task_id=?').run(taskId);
            db.prepare('DELETE FROM tasks WHERE id=?').run(taskId);
            db.exec('COMMIT;');
          } catch (error) { db.exec('ROLLBACK;'); throw error; }
        }
        await evaluate("location.reload();true");
      } catch (error) { console.error('fixture_cleanup_failed:', error); }
    }
    db?.close();
    ws.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
