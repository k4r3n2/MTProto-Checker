function log(msg, isError = false) {
  const c = document.getElementById('console');
  const line = document.createElement('div');
  line.className = isError ? 'err' : 'ok';
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  c.appendChild(line);
  c.scrollTop = c.scrollHeight;
}

function parseLink(line) {
  try {
    const clean = line.trim().replace('.&', '&');
    if (!clean.includes('://')) return null;
    const u = new URL(clean);
    const p = new URLSearchParams(u.search);
    const server = p.get('server');
    const port = Number(p.get('port'));
    const secret = p.get('secret');

    if (!server || !Number.isFinite(port) || port < 1 || port > 65535 || !secret) return null;
    if (secret.length > 170 || secret.includes('AAAAAAAAAAAAAAAAAAAA')) return null;

    return { server, port, secret, original: clean };
  } catch {
    return null;
  }
}

async function pool(items, concurrency, worker) {
  let i = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}

function updateProgress(done, total) {
  const percent = total ? (done / total) * 100 : 0;
  document.getElementById('progressBar').style.width = `${percent}%`;
}

function setStatus(text) {
  document.getElementById('statusText').textContent = text;
}

function setStats(text) {
  document.getElementById('statsText').textContent = text;
}

function formatOutput(list) {
  list.sort((a, b) => a.ping - b.ping);
  return list.map(x => `${x.link} # Ping: ${x.ping}ms`).join('\n\n');
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

async function showConfig() {
  try {
    const r = await fetch('/config');
    const j = await r.json();
    log(`Config: ${JSON.stringify(j)}`);
  } catch {
    log('Failed to load /config', true);
  }
}

async function start() {
  const input = document.getElementById('inputProxies').value;
  if (!input.trim()) return alert('Empty input');

  const lines = input.split('\n');
  const valid = lines.map(parseLink).filter(Boolean);
  if (!valid.length) return alert('No valid links');

  const concurrency = Math.max(1, Math.min(100, Number(document.getElementById('concurrency').value) || 10));
  const clientTimeout = Math.max(1000, Math.min(60000, Number(document.getElementById('clientTimeout').value) || 12000));

  const startBtn = document.getElementById('startBtn');
  startBtn.disabled = true;

  const working = [];
  let done = 0;
  let okCount = 0;
  let failCount = 0;
  let cachedCount = 0;

  updateProgress(0, valid.length);
  setStatus('Processing...');
  setStats('');

  log(`Parsed ${valid.length} links | clientConcurrency=${concurrency} | timeout=${clientTimeout}ms`);

  await pool(valid, concurrency, async (proxy) => {
    try {
      const r = await fetchWithTimeout('/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(proxy)
      }, clientTimeout);

      const j = await r.json();
      if (j.ok) {
        okCount++;
        if (j.cached) cachedCount++;
        working.push({ link: proxy.original, ping: j.ping });
        log(`OK ${proxy.server}:${proxy.port} ping=${j.ping}ms${j.cached ? ' (cached)' : ''}`);
      } else {
        failCount++;
        log(`FAIL ${proxy.server}:${proxy.port} code=${j?.error?.code || 'FAILED'}`, true);
      }
    } catch {
      failCount++;
      log(`FAIL ${proxy.server}:${proxy.port} code=CLIENT_TIMEOUT_OR_NETWORK`, true);
    } finally {
      done++;
      updateProgress(done, valid.length);
      setStatus(`Done ${done}/${valid.length}`);
      setStats(`OK=${okCount} FAIL=${failCount} CACHED=${cachedCount}`);
      document.getElementById('outputProxies').value = formatOutput(working);
    }
  });

  setStatus('Finished');
  startBtn.disabled = false;
}

async function copyOut() {
  const text = document.getElementById('outputProxies').value;
  if (!text.trim()) return;
  try {
    await navigator.clipboard.writeText(text);
    alert('Copied');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    alert('Copied');
  }
}

document.getElementById('startBtn').addEventListener('click', start);
document.getElementById('copyBtn').addEventListener('click', copyOut);
document.getElementById('btnConfig').addEventListener('click', showConfig);
