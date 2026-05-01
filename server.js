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

// ─── Skinport cooldown tracker ────────────────────────────────────────────────
const spTracker = {
  cooldownUntil: 0,
  trigger429() {
    this.cooldownUntil = Date.now() + 15 * 60 * 1000;
    console.log('[skinport] 429 — cooldown 15min until ' + new Date(this.cooldownUntil).toLocaleTimeString());
  },
  isCooling() { return Date.now() < this.cooldownUntil; },
  status() {
    const cooling = this.isCooling();
    return { cooling, cooldownEndsAt: cooling ? new Date(this.cooldownUntil).toLocaleTimeString() : null };
  }
};

// ─── CSFloat cooldown tracker ─────────────────────────────────────────────────
const cfloat = {
  cooldownUntil: 0,        // timestamp when cooldown ends
  cooldownMins: 65,        // minutes to cool down after 429
  lastCallTime: 0,         // throttle between calls
  minIntervalMs: 600000,   // 10 minutes between CSFloat calls during recovery
  used: 0,
  maxPerHour: 20,
  windowStart: Date.now(),

  isCooling() {
    return Date.now() < this.cooldownUntil;
  },

  cooldownEndsAt() {
    return this.cooldownUntil;
  },

  trigger429() {
    this.cooldownUntil = Date.now() + (this.cooldownMins * 60 * 1000);
    console.log('[csfloat] 429 — cooling down for ' + this.cooldownMins + 'min until ' + new Date(this.cooldownUntil).toLocaleTimeString());
  },

  reset() {
    this.cooldownUntil = 0;
    this.used = 0;
    this.windowStart = Date.now();
    this.lastCallTime = 0;
    console.log('[csfloat] cooldown manually reset');
  },

  canCall() {
    if (this.isCooling()) return false;
    const now = Date.now();
    // Reset hourly window
    if (now - this.windowStart > 3600000) {
      this.used = 0;
      this.windowStart = now;
    }
    if (this.used >= this.maxPerHour) return false;
    // Enforce min interval between calls
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
    const cooldownSecsLeft = cooling ? Math.round((this.cooldownUntil - now) / 1000) : 0;
    const resetIn = Math.max(0, 3600 - Math.round((now - this.windowStart) / 1000));
    const nextCallIn = Math.max(0, Math.round((this.lastCallTime + this.minIntervalMs - now) / 1000));
    return {
      cooling,
      cooldownUntil: this.cooldownUntil,
      cooldownSecsLeft,
      cooldownEndsAt: cooling ? new Date(this.cooldownUntil).toLocaleTimeString() : null,
      used: this.used,
      max: this.maxPerHour,
      remaining: Math.max(0, this.maxPerHour - this.used),
      resetInSeconds: resetIn,
      nextCallInSeconds: nextCallIn
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── CSFloat fetch (no retry on 429 — just trigger cooldown) ─────────────────
function fetchCSFloat(apiUrl) {
  return new Promise((resolve, reject) => {
    https.get(apiUrl, { headers: { 'Authorization': CSFLOAT_KEY, 'Accept': 'application/json' } }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (res.statusCode === 429) {
            cfloat.trigger429();
            reject(new Error('429'));
            return;
          }
          if (res.statusCode >= 400) {
            reject(new Error('API ' + res.statusCode + ': ' + JSON.stringify(data).slice(0, 100)));
            return;
          }
          resolve(data);
        } catch(e) { reject(new Error('JSON: ' + e.message)); }
      });
    }).on('error', reject);
  });
}

// ─── Skinport broad scan (rate-limit aware, stale cache fallback) ─────────────
const SP_FRESH_TTL = 15 * 60 * 1000;
const SP_STALE_TTL = 3 * 60 * 60 * 1000;

async function skinportListings(minPriceCents, maxPriceCents) {
  const freshKey = 'sp:' + minPriceCents + ':' + maxPriceCents;
  const staleKey = 'sp_stale:' + minPriceCents + ':' + maxPriceCents;

  const fresh = getCached(freshKey, SP_FRESH_TTL);
  if (fresh) { console.log('[skinport cache] ' + fresh.length + ' items'); return { candidates: fresh, source: 'skinport' }; }

  if (spTracker.isCooling()) {
    const stale = getCached(staleKey, SP_STALE_TTL);
    if (stale) { console.log('[skinport] cooling — stale cache (' + stale.length + ')'); return { candidates: stale, source: 'skinport-stale' }; }
    console.log('[skinport] cooling — no stale data');
    return { candidates: [], source: 'skinport-cooling' };
  }

  const minUsd = minPriceCents / 100;
  const maxUsd = maxPriceCents / 100;
  console.log('[skinport] fetching $' + minUsd + '-$' + maxUsd + '...');

  return new Promise((resolve) => {
    const zlib = require('zlib');
    const opts = {
      hostname: 'api.skinport.com',
      path: '/v1/items?app_id=730&currency=USD&tradable=0',
      headers: { 'Accept-Encoding': 'gzip, br', 'Accept': 'application/json', 'User-Agent': 'CS2-Scanner/1.0' }
    };
    https.get(opts, (res) => {
      const enc = res.headers['content-encoding'] || 'none';
      console.log('[skinport] status=' + res.statusCode + ' encoding=' + enc);

      if (res.statusCode === 429) {
        spTracker.trigger429();
        res.resume();
        const stale = getCached(staleKey, SP_STALE_TTL);
        resolve({ candidates: stale || [], source: 'skinport-cooling' });
        return;
      }
      if (res.statusCode !== 200) {
        console.log('[skinport] non-200:', res.statusCode); res.resume();
        resolve({ candidates: [], source: 'skinport-error' }); return;
      }

      let stream = res;
      if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      else if (enc === 'gzip' || enc === 'deflate') stream = res.pipe(zlib.createGunzip());

      let body = '';
      stream.on('data', c => body += c);
      stream.on('end', () => {
        try {
          const arr = JSON.parse(body);
          if (!Array.isArray(arr)) {
            console.log('[skinport] unexpected shape:', JSON.stringify(arr).slice(0, 200));
            resolve({ candidates: [], source: 'skinport-error' }); return;
          }
          const candidates = arr
            .filter(i => i.min_price != null && i.min_price >= minUsd && i.min_price <= maxUsd && i.quantity > 0)
            .map(i => ({
              name: i.market_hash_name,
              skinportPrice: Math.round(i.min_price * 100),
              suggestedPrice: Math.round((i.suggested_price || i.median_sale_price || 0) * 100),
              quantity: i.quantity,
              url: i.item_page
            }));
          setCache(freshKey, candidates);
          setCache(staleKey, candidates);
          console.log('[skinport] ' + arr.length + ' total, ' + candidates.length + ' in range');
          resolve({ candidates, source: 'skinport' });
        } catch(e) {
          console.log('[skinport parse error]', e.message, '| body:', body.slice(0, 100));
          resolve({ candidates: [], source: 'skinport-error' });
        }
      });
      stream.on('error', e => { console.log('[skinport stream error]', e.message); resolve({ candidates: [], source: 'skinport-error' }); });
    }).on('error', e => { console.log('[skinport error]', e.message); resolve({ candidates: [], source: 'skinport-error' }); });
  });
}

// ─── CSFloat broad scan (fallback when Skinport is cooling) ──────────────────
async function csfloatBroadScan(minPriceCents, maxPriceCents) {
  const cacheKey = 'cf_broad:' + minPriceCents + ':' + maxPriceCents;
  const cached = getCached(cacheKey, 10 * 60 * 1000);
  if (cached) { console.log('[csfloat] broad scan cache hit'); return { candidates: cached, source: 'csfloat-scan' }; }
  if (cfloat.isCooling() || !cfloat.canCall()) { console.log('[csfloat] broad scan skipped — cooling or throttled'); return null; }
  const apiUrl = 'https://csfloat.com/api/v1/listings?min_price=' + minPriceCents + '&max_price=' + maxPriceCents + '&limit=50&sort_by=lowest_price&type=buy_now';
  console.log('[csfloat] broad scan $' + minPriceCents/100 + '-$' + maxPriceCents/100);
  try {
    const data = await fetchCSFloat(apiUrl);
    cfloat.record();
    const listings = data.data || data || [];
    const byName = {};
    listings.forEach(l => {
      const name = l.item && l.item.market_hash_name ? l.item.market_hash_name : null;
      if (!name) return;
      if (!byName[name] || l.price < byName[name].price) byName[name] = l;
    });
    const candidates = Object.values(byName).map(l => ({
      name: l.item.market_hash_name,
      skinportPrice: l.price,
      suggestedPrice: 0,
      quantity: 1,
      url: 'https://csfloat.com/item/' + l.id
    }));
    setCache(cacheKey, candidates);
    console.log('[csfloat] broad scan: ' + candidates.length + ' unique items');
    return { candidates, source: 'csfloat-scan' };
  } catch(e) {
    console.log('[csfloat broad scan error]', e.message);
    return null;
  }
}

// ─── CSFloat validation (cooldown-aware, no aggressive retry) ─────────────────
async function csfloatLadder(marketHashName, limit) {
  const key = 'cf:' + marketHashName;
  const cached = getCached(key, 720000);
  if (cached) {
    console.log('[csfloat cache] ' + marketHashName);
    return { data: cached, fromCache: true };
  }

  if (cfloat.isCooling()) {
    console.log('[csfloat] cooling — skipping ' + marketHashName);
    return { data: null, cooling: true, cooldownEndsAt: cfloat.cooldownEndsAt() };
  }

  if (!cfloat.canCall()) {
    console.log('[csfloat] not ready yet — throttled');
    return { data: null, throttled: true };
  }

  const apiUrl = 'https://csfloat.com/api/v1/listings?market_hash_name=' + encodeURIComponent(marketHashName) + '&limit=' + (limit || 10) + '&sort_by=lowest_price&type=buy_now';
  console.log('[csfloat] validating: ' + marketHashName + ' (' + cfloat.used + '/' + cfloat.maxPerHour + ')');

  try {
    const data = await fetchCSFloat(apiUrl);
    const result = data.data || data || [];
    cfloat.record();
    setCache(key, result);
    console.log('[csfloat] got ' + result.length + ' listings for ' + marketHashName);
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
      res.end(JSON.stringify({ csfloat: cfloat.status(), skinport: spTracker.status() }));
      return;
    }

    if (pathname === '/api/budget/reset' && req.method === 'POST') {
      cfloat.reset();
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, message: 'CSFloat cooldown reset' }));
      return;
    }

    if (pathname === '/api/scan') {
      const minPrice = parseFloat(query.min_price || '5000');
      const maxPrice = parseFloat(query.max_price || '300000');
      const spResult = await skinportListings(minPrice, maxPrice);
      if (spResult.candidates.length > 0) {
        res.writeHead(200);
        res.end(JSON.stringify({ candidates: spResult.candidates, source: spResult.source }));
        return;
      }
      console.log('[scan] Skinport unavailable — trying CSFloat broad scan');
      const cfResult = await csfloatBroadScan(minPrice, maxPrice);
      if (cfResult) {
        res.writeHead(200);
        res.end(JSON.stringify({ candidates: cfResult.candidates, source: cfResult.source }));
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify({ candidates: [], source: spResult.source }));
      return;
    }

    // Debug: raw Skinport connectivity test — visit /api/sp-debug in browser
    if (pathname === '/api/sp-debug') {
      const zlib = require('zlib');
      const result = await new Promise((resolve) => {
        const opts = {
          hostname: 'api.skinport.com',
          path: '/v1/items?app_id=730&currency=USD&tradable=0',
          headers: { 'Accept-Encoding': 'gzip, br', 'Accept': 'application/json', 'User-Agent': 'CS2-Scanner/1.0' }
        };
        https.get(opts, (res2) => {
          const enc = res2.headers['content-encoding'] || 'none';
          const status = res2.statusCode;
          let stream = res2;
          if (enc === 'br') stream = res2.pipe(zlib.createBrotliDecompress());
          else if (enc === 'gzip' || enc === 'deflate') stream = res2.pipe(zlib.createGunzip());
          let body = '';
          stream.on('data', c => body += c);
          stream.on('end', () => {
            try {
              const arr = JSON.parse(body);
              const isArray = Array.isArray(arr);
              const sample = isArray ? arr.slice(0, 2) : arr;
              const inRange = isArray ? arr.filter(i => i.min_price != null && i.min_price >= 100 && i.min_price <= 3000 && i.quantity > 0).length : 0;
              resolve({ status, encoding: enc, isArray, totalItems: isArray ? arr.length : 0, inRange_100_3000: inRange, sample });
            } catch(e) {
              resolve({ status, encoding: enc, parseError: e.message, bodyPreview: body.slice(0, 300) });
            }
          });
          stream.on('error', e => resolve({ status, encoding: enc, streamError: e.message }));
        }).on('error', e => resolve({ connectError: e.message }));
      });
      res.writeHead(200);
      res.end(JSON.stringify(result, null, 2));
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
