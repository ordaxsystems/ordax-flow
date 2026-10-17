const fs = require('fs');
const path = require('path');

const lockPath = path.join(process.env.LOCALAPPDATA || process.cwd(), 'OrdaX', 'Gratis', 'e2e.lock');

function processAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

function acquireE2ELock(kind = 'e2e') {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  if (fs.existsSync(lockPath)) {
    try {
      const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (!current?.pid || !processAlive(current.pid)) fs.rmSync(lockPath, { force: true });
      else throw new Error(`e2e_lock_busy:${current.kind || 'unknown'}:pid_${current.pid}`);
    } catch (error) {
      if (String(error?.message || error).startsWith('e2e_lock_busy:')) throw error;
      fs.rmSync(lockPath, { force: true });
    }
  }
  const fd = fs.openSync(lockPath, 'wx');
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, kind, started_at: new Date().toISOString() }));
  fs.closeSync(fd);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (Number(current?.pid) === process.pid) fs.rmSync(lockPath, { force: true });
    } catch {}
  };
  process.once('exit', release);
  process.once('SIGINT', () => { release(); process.exit(130); });
  process.once('SIGTERM', () => { release(); process.exit(143); });
  return release;
}

module.exports = { acquireE2ELock, lockPath };
