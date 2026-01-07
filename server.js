'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const open = require('open');
const rateLimit = require('express-rate-limit');

const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');

const app = express();

const PORT = Number(process.env.PORT || 3000);
const AUTO_OPEN = (process.env.AUTO_OPEN || '0') === '1';

const API_ID = Number(process.env.TG_API_ID);
const API_HASH = process.env.TG_API_HASH;

const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 8000);
const PROXY_TIMEOUT_SEC = Number(process.env.PROXY_TIMEOUT_SEC || 4);
const CONNECTION_RETRIES = Number(process.env.CONNECTION_RETRIES || 1);

const SERVER_CONCURRENCY = Number(process.env.SERVER_CONCURRENCY || 20);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 60_000);

if (!API_ID || !API_HASH) {
  console.error('Missing TG_API_ID or TG_API_HASH in .env');
  process.exit(1);
}

app.use(express.json({ limit: '2mb' }));

app.use('/check', rateLimit({
  windowMs: 60_000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
}));

app.use(express.static(path.join(__dirname, 'public')));

// --------------------
// Simple concurrency limiter (server-side)
// --------------------
let inFlight = 0;
const queue = [];

function acquire() {
  return new Promise((resolve) => {
    if (inFlight < SERVER_CONCURRENCY) {
      inFlight++;
      return resolve();
    }
    queue.push(resolve);
  });
}

function release() {
  inFlight--;
  const next = queue.shift();
  if (next) {
    inFlight++;
    next();
  }
}

// --------------------
// Simple TTL cache
// key: server:port:secret
// value: { exp, data }
// --------------------
const cache = new Map();

function cacheGet(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() > v.exp) {
    cache.delete(key);
    return null;
  }
  return v.data;
}

function cacheSet(key, data) {
  cache.set(key, { exp: Date.now() + CACHE_TTL_MS, data });
}

function normalizeInput(body) {
  const server = String(body?.server || '').trim();
  const port = Number(body?.port);
  const secret = String(body?.secret || '').trim();

  if (!server) return { ok: false, status: 400, error: { code: 'BAD_INPUT', message: 'server is required' } };
  if (!Number.isFinite(port) || port < 1 || port > 65535) return { ok: false, status: 400, error: { code: 'BAD_INPUT', message: 'port must be 1..65535' } };
  if (!secret) return { ok: false, status: 400, error: { code: 'BAD_INPUT', message: 'secret is required' } };
  if (secret.length > 170) return { ok: false, status: 400, error: { code: 'BAD_INPUT', message: 'secret too long' } };

  return { ok: true, server, port, secret };
}

function classifyError(err) {
  const msg = (err && err.message) ? String(err.message) : 'UNKNOWN';
  const low = msg.toLowerCase();
  if (msg.includes('TIMEOUT')) return { code: 'TIMEOUT', message: 'Request timed out' };
  if (low.includes('auth') || low.includes('unauthorized')) return { code: 'AUTH', message: msg };
  if (low.includes('secret')) return { code: 'BAD_SECRET', message: msg };
  if (low.includes('connect') || low.includes('socket') || low.includes('econn')) return { code: 'CONNECT_FAILED', message: msg };
  return { code: 'FAILED', message: msg };
}

async function checkProxy({ server, port, secret }) {
  const client = new TelegramClient(
    new StringSession(''),
    API_ID,
    API_HASH,
    {
      connectionRetries: CONNECTION_RETRIES,
      useWSS: false,
      proxy: {
        ip: server,
        port,
        secret,
        MTProxy: true,
        socksType: 5,
        timeout: PROXY_TIMEOUT_SEC,
      }
    }
  );

  client.setLogLevel('none');

  const start = Date.now();

  const checkPromise = (async () => {
    await client.connect();
    await client.invoke(new Api.help.GetConfig());
    const ping = Date.now() - start;
    await client.disconnect();
    return ping;
  })();

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('TIMEOUT')), TIMEOUT_MS)
  );

  try {
    const ping = await Promise.race([checkPromise, timeoutPromise]);
    return { ok: true, ping };
  } catch (err) {
    try { await client.destroy(); } catch {}
    return { ok: false, error: classifyError(err) };
  }
}

app.get('/health', (req, res) => {
  res.json({ ok: true, inFlight, queue: queue.length });
});

app.get('/config', (req, res) => {
  res.json({
    ok: true,
    PORT,
    TIMEOUT_MS,
    PROXY_TIMEOUT_SEC,
    CONNECTION_RETRIES,
    SERVER_CONCURRENCY,
    CACHE_TTL_MS
  });
});

app.post('/check', async (req, res) => {
  const parsed = normalizeInput(req.body);
  if (!parsed.ok) return res.status(parsed.status).json({ ok: false, error: parsed.error });

  const { server, port, secret } = parsed;
  const cacheKey = `${server}:${port}:${secret}`;

  const cached = cacheGet(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  await acquire();
  try {
    const out = await checkProxy({ server, port, secret });
    cacheSet(cacheKey, out);
    return res.json({ ...out, cached: false });
  } finally {
    release();
  }
});

app.listen(PORT, async () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`Server running at ${url}`);
  if (AUTO_OPEN) {
    try { await open(url); } catch {}
  }
});
