const { spawn } = require('child_process');
const path = require('path');
const { execSync } = require('child_process');
let fetch;
try {
  fetch = require('node:undici').fetch;
} catch (e) {
  fetch = (...args) => import('node:undici').then(m => m.fetch(...args));
}

function spawnInCwd(command, args, cwd, name) {
  const child = spawn(command, args, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => process.stdout.write(`[${name}] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
  child.on('exit', (code) => console.log(`${name} exited with ${code}`));
  return child;
}

const net = require('net');

async function checkTcp(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;
    const onDone = (ok) => {
      if (resolved) return;
      resolved = true;
      try { socket.destroy(); } catch (e) {}
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => onDone(false));
    socket.on('error', () => onDone(false));
    socket.connect(port, host, () => onDone(true));
  });
}

async function waitFor(urlOrHost, timeoutMs = 20000) {
  const start = Date.now();
  // accept either a full URL or host:port
  let url = urlOrHost;
  let host = 'localhost';
  let port = null;
  try {
    const u = new URL(urlOrHost);
    url = u.href;
    host = u.hostname || host;
    port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  } catch (e) {
    // not a URL; try to parse host:port
    const m = String(urlOrHost).match(/^(.*?):(\d+)$/);
    if (m) { host = m[1]; port = Number(m[2]); }
  }

  while (Date.now() - start < timeoutMs) {
    try {
      if (fetch) {
        try {
          const r = await fetch(url);
          if (r && typeof r.status === 'number') {
            console.log(`Probe ${url} responded with ${r.status}`);
            return true;
          }
        } catch (e) {
          // fetch failed; will try tcp below
        }
      }

      if (port) {
        const ok = await checkTcp(host, port, 1000);
        if (ok) {
          console.log(`TCP probe to ${host}:${port} succeeded`);
          return true;
        }
      }
    } catch (e) {
      // ignore and retry
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const backendCwd = path.join(root, 'backend');
  const frontendCwd = path.join(root, 'frontend');

  // Free ports if occupied (Windows and Unix compatible)
  try {
    console.log('Killing processes on ports 4000 and 4173 if present...');
    if (process.platform === 'win32') {
      try { execSync('for /f "tokens=5" %a in (\'netstat -ano ^| findstr :4000\') do taskkill /PID %a /F'); } catch (e) {}
      try { execSync('for /f "tokens=5" %a in (\'netstat -ano ^| findstr :4173\') do taskkill /PID %a /F'); } catch (e) {}
    } else {
      try { execSync("fuser -k 4000/tcp || true"); } catch (e) {}
      try { execSync("fuser -k 4173/tcp || true"); } catch (e) {}
    }
  } catch (e) {
    console.warn('Port cleanup failed (non-fatal):', e && e.message);
  }

  console.log('Starting backend in', backendCwd);
  const backend = spawnInCwd('npm', ['run', 'dev'], backendCwd, 'backend');

  console.log('Starting frontend in', frontendCwd);
  const frontend = spawnInCwd('npm', ['run', 'dev'], frontendCwd, 'frontend');

  console.log('Waiting for backend at http://localhost:4000');
  const backOk = await waitFor('http://localhost:4000', 30000);
  console.log('Backend ready:', backOk);

  console.log('Waiting for frontend at http://localhost:4173');
  const frontOk = await waitFor('http://localhost:4173', 30000);
  console.log('Frontend ready:', frontOk);

  if (!backOk || !frontOk) {
    console.error('One or more services failed to start in time. Check logs above.');
    process.exit(1);
  }

  console.log('Both services are up. Press Ctrl+C to exit.');

  process.on('SIGINT', () => {
    console.log('Shutting down child processes');
    backend.kill();
    frontend.kill();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error('Start script failed', e);
  process.exit(1);
});
