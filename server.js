require('dotenv').config();
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const CSFLOAT_KEY = process.env.CSFLOAT_API_KEY;

if (!CSFLOAT_KEY) {
  console.error('CSFLOAT_API_KEY not found in .env');
  process.exit(1);
}

// ─── CSFloat rate limiter ─────────────────────────────────────────────────────
const cfloat = {
  cooldownUntil: 0,
  cooldownMins: 10,         // 10 min cooldown on 429
  lastCallTime: 0,
  minIntervalMs: 120000,    // 2 min between calls
  used: 0,
  maxPerHour: 20,
  windowStart: Date.now(),

  isCooling() { return Date.now() < this.cooldownUntil; },

  trigger429() {
    this.cooldownUntil = Date.now() + this.cooldownMins * 60 * 1000;
    console.log('[csfloat] 429 — cooling ' + this.cooldownMins + 'min until ' + new Date(this.cooldownUntil).toLocaleTimeString());
  },

  reset() {
    this.cooldownUntil = 0;
    this.used = 0;
    this.windowStart = Date.now();
    this.lastCallTime = 0;
    console.log('[csfloat] reset');
  },

  canCall() {
    if (this.isCooling()) return false;
    const now = Date.now();
    if (now - this.windowStart > 3600000) { this.used = 0; this.windowStart = now; }
    if (this.used >= this.maxPerHour) return false;
    if (now - this.lastCallTime < this.minIntervalMs) return false;
    return true;
  },

  record() {
    this.used++;
    this.lastCallTime = Date.now();
  },

  status() {
    const now = Date.now();
    const cooling = this.isCooling();
    return {
      cooling,
      cooldownUntil: this.cooldownUntil,
      cooldownEndsAt: cooling ? new Date(this.cooldownUntil).toLocaleTimeString() : null,
      cooldownSecsLeft: cooling ? Math.round((this.cooldownUntil - now) / 1000) : 0,
      used: this.used,
      max: this.maxPerHour,
      remaining: Math.max(0, this.maxPerHour - this.used),
      nextCallInSeconds: Math.max(0, Math.round((this.lastCallTime + this.minIntervalMs - now) / 1000)),
      resetInSeconds: Math.max(0, 3600 - Math.round((now - this.windowStart) / 1000))
    };
  }
};

// ─── Cache ────────────────────────────────────────────────────────────────────
const cache = new Map();

function getCached(key, ttlMs) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > ttlMs) { cache.delete(key); return null; }
  return entry.data;
}

function setCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
}

// ─── CSFloat fetch ────────────────────────────────────────────────────────────
function fetchCSFloat(apiUrl) {
  return new Promise((resolve, reject) => {
    https.get(apiUrl, { headers: { 'Authorization': CSFLOAT_KEY, 'Accept': 'application/json' } }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (res.statusCode === 429) { cfloat.trigger429(); reject(new Error('429')); return; }
          if (res.statusCode >= 400) { reject(new Error('API ' + res.statusCode + ': ' + JSON.stringify(data).slice(0, 100))); return; }
          resolve(data);
        } catch(e) { reject(new Error('JSON: ' + e.message)); }
      });
    }).on('error', reject);
  });
}

// ─── CSFloat ladder validation ────────────────────────────────────────────────
async function csfloatLadder(marketHashName, limit) {
  const key = 'cf:' + marketHashName;
  const cached = getCached(key, 720000); // 12 min cache
  if (cached) {
    console.log('[csfloat cache] ' + marketHashName);
    return { data: cached, fromCache: true };
  }

  if (cfloat.isCooling()) {
    console.log('[csfloat] cooling — skip ' + marketHashName);
    return { data: null, cooling: true, cooldownEndsAt: cfloat.cooldownUntil };
  }

  if (!cfloat.canCall()) {
    const secs = cfloat.status().nextCallInSeconds;
    console.log('[csfloat] throttled — next call in ' + secs + 's');
    return { data: null, throttled: true, nextCallInSeconds: secs };
  }

  const apiUrl = 'https://csfloat.com/api/v1/listings?market_hash_name='
    + encodeURIComponent(marketHashName)
    + '&limit=' + (limit || 10)
    + '&sort_by=lowest_price&type=buy_now';
  console.log('[csfloat] validate: ' + marketHashName + ' (' + cfloat.used + '/' + cfloat.maxPerHour + ')');

  try {
    const data = await fetchCSFloat(apiUrl);
    const result = data.data || data || [];
    cfloat.record();
    setCache(key, result);
    console.log('[csfloat] ' + result.length + ' listings for ' + marketHashName);
    return { data: result, fromCache: false };
  } catch(e) {
    console.log('[csfloat error]', e.message);
    return { data: null, error: e.message, cooling: cfloat.isCooling() };
  }
}

// ─── HTTP server ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const query = parsedUrl.query;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  try {
    if (pathname === '/api/budget') {
      res.writeHead(200);
      res.end(JSON.stringify(cfloat.status()));
      return;
    }

    if (pathname === '/api/budget/reset' && req.method === 'POST') {
      cfloat.reset();
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (pathname === '/api/validate') {
      const name = query.market_hash_name;
      const depth = parseInt(query.depth || '10');
      if (!name) { res.writeHead(400); res.end(JSON.stringify({ error: 'market_hash_name required' })); return; }
      const result = await csfloatLadder(name, depth);
      res.writeHead(200);
      res.end(JSON.stringify(result));
      return;
    }

    if (pathname === '/' || pathname === '/index.html') {
      const filePath = path.join(__dirname, 'public', 'index.html');
      fs.readFile(filePath, (err, content) => {
        if (err) { res.setHeader('Content-Type', 'text/plain'); res.writeHead(500); res.end('Cannot load UI'); return; }
        res.setHeader('Content-Type', 'text/html');
        res.writeHead(200);
        res.end(content);
      });
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));

  } catch(err) {
    console.error('[server error]', err.message);
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log('CS2 Deal Scanner running on port ' + PORT);
});
