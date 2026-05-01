require('dotenv').config();
const http = require('http');
const https = require('https');
const zlib = require('zlib');
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
  cooldownMins: 30,         // 30 min cooldown on 429 — CSFloat free tier exhausts fast
  lastCallTime: 0,
  minIntervalMs: 300000,    // 5 min between calls
  used: 0,
  maxPerHour: 5,            // conservative — free tier likely ~10/day
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

// ─── Skinport proxy (server-side, 20-min cache, stale fallback on 429) ───────
const SP_FRESH_TTL = 20 * 60 * 1000;
const SP_STALE_TTL = 3 * 60 * 60 * 1000;
const spCooldown = {
  until: 0,
  trigger() { this.until = Date.now() + 20 * 60 * 1000; console.log('[skinport] 429 — cooldown 20min'); },
  active() { return Date.now() < this.until; }
};

async function skinportScan(minPriceCents, maxPriceCents) {
  const freshKey = 'sp_cad:' + minPriceCents + ':' + maxPriceCents;
  const staleKey = 'sp_cad_stale:' + minPriceCents + ':' + maxPriceCents;

  const fresh = getCached(freshKey, SP_FRESH_TTL);
  if (fresh) { console.log('[skinport] cache hit ' + fresh.length); return { candidates: fresh, cached: true }; }

  if (spCooldown.active()) {
    const stale = getCached(staleKey, SP_STALE_TTL);
    console.log('[skinport] cooling — ' + (stale ? 'stale data ' + stale.length : 'empty'));
    return { candidates: stale || [], cooling: true };
  }

  const minUsd = minPriceCents / 100;
  const maxUsd = maxPriceCents / 100;
  console.log('[skinport] fetching $' + minUsd + '-$' + maxUsd);

  return new Promise(resolve => {
    https.get({
      hostname: 'api.skinport.com',
      path: '/v1/items?app_id=730&currency=CAD&tradable=1',
      headers: { 'Accept-Encoding': 'gzip, br', 'Accept': 'application/json', 'User-Agent': 'CS2-Scanner/1.0' }
    }, res => {
      const enc = res.headers['content-encoding'] || 'none';
      console.log('[skinport] ' + res.statusCode + ' ' + enc);
      if (res.statusCode === 429) {
        spCooldown.trigger(); res.resume();
        const stale = getCached(staleKey, SP_STALE_TTL);
        resolve({ candidates: stale || [], cooling: true }); return;
      }
      if (res.statusCode !== 200) { res.resume(); resolve({ candidates: [], error: res.statusCode }); return; }
      let stream = res;
      if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      else if (enc === 'gzip' || enc === 'deflate') stream = res.pipe(zlib.createGunzip());
      let body = '';
      stream.on('data', c => body += c);
      stream.on('end', () => {
        try {
          const arr = JSON.parse(body);
          if (!Array.isArray(arr)) { resolve({ candidates: [], error: 'unexpected shape' }); return; }
          const candidates = arr
            .filter(i => i.min_price != null && i.min_price >= minUsd && i.min_price <= maxUsd && i.quantity > 0)
            .map(i => ({
              name: i.market_hash_name,
              skinportPrice: Math.round(i.min_price * 100),
              ladderMean: Math.round((i.mean_price || 0) * 100),
              ladderMax: Math.round((i.max_price || 0) * 100),
              suggestedPrice: Math.round((i.suggested_price || 0) * 100),
              quantity: i.quantity
            }));
          setCache(freshKey, candidates);
          setCache(staleKey, candidates);
          console.log('[skinport] ' + arr.length + ' total, ' + candidates.length + ' in range');
          resolve({ candidates, cached: false });
        } catch(e) { resolve({ candidates: [], error: e.message }); }
      });
      stream.on('error', e => resolve({ candidates: [], error: e.message }));
    }).on('error', e => resolve({ candidates: [], error: e.message }));
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
    if (pathname === '/api/ping') {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, version: 'skinport-proxy', node: process.version }));
      return;
    }

    if (pathname === '/api/scan') {
      const minPrice = parseFloat(query.min_price || '10000');
      const maxPrice = parseFloat(query.max_price || '300000');
      const result = await skinportScan(minPrice, maxPrice);
      res.writeHead(200);
      res.end(JSON.stringify(result));
      return;
    }

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
