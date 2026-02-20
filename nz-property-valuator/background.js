/**
 * background.js — Service worker for NZ Property Valuator
 *
 * Handles messaging between the content script and external APIs,
 * manages extension state, and coordinates cross-tab logic.
 */

'use strict';

// ─── In-memory cache ──────────────────────────────────────────────────────
// Keyed by fullAddress string; entries expire after 30 minutes.
// The service worker may be terminated between page loads but survives across
// refreshes on the same tab session, making this useful for quick re-visits.

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
/** @type {Map<string, { timestamp: number, results: object[] }>} */
const cache = new Map();

function getCached(fullAddress) {
  const entry = cache.get(fullAddress);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(fullAddress);
    return null;
  }
  return entry.results;
}

function setCached(fullAddress, results) {
  cache.set(fullAddress, { timestamp: Date.now(), results });
}

// ─── Settings ─────────────────────────────────────────────────────────────
// Source keys must match the `source` field returned by each fetcher.
// Defaults are read from chrome.storage.sync; used as fallback if unavailable.

const DISPLAYED_SOURCES = ['OneRoof', 'homes.co.nz', 'PropertyValue'];

const DEFAULT_SOURCE_SETTINGS = {
  OneRoof:       { enabled: true },
  'homes.co.nz': { enabled: true },
  PropertyValue: { enabled: true },
};

function disabledResult(source) {
  return { source, estimate: null, url: null, confidence: null, error: null, disabled: true };
}

// Persist the last fetch outcome for each displayed source so the popup can
// show per-source status without re-fetching.
async function recordFetchStatus(results) {
  const update = {};
  for (const result of results) {
    if (!DISPLAYED_SOURCES.includes(result.source)) continue;
    update[result.source] = {
      ok:       !!result.estimate,
      estimate: result.estimate ?? null,
      error:    result.error    ?? null,
      ts:       Date.now(),
    };
  }
  const { fetchStatus = {} } = await chrome.storage.local.get({ fetchStatus: {} });
  await chrome.storage.local.set({ fetchStatus: { ...fetchStatus, ...update } });
}

// ─── OneRoof auth helpers ─────────────────────────────────────────────────
// Credentials extracted from the public JS bundle (module 6036 in layout
// chunk).  All are embedded in the production app and are intentionally
// public-facing.

const OR_BASE_URL         = 'https://www.oneroof.co.nz';
const OR_PUBLIC_KEY       = 'B41n73ivbk-w0W8OyEkm1-whmnE9w66e:ps4z1a4c5J-NpDc6ujX67-YNyBgX8D7o';
const OR_CF_CLIENT_ID     = '6235e853dd3c95509c3a8568ac1de08b.access';
const OR_CF_CLIENT_SECRET = '7b1f7775f9c1158c683e21a3178eeafb164696c4da426c9b2e2917477f3457e0';

// SHA-256 hex digest using SubtleCrypto (available in MV3 service workers).
async function sha256hex(str) {
  const encoded = new TextEncoder().encode(str);
  const buf     = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}

// Sign algorithm (from module 6036, confirmed live):
//   Iterate the full URL string; for each distinct [a-zA-Z0-9] char (in
//   first-appearance order) emit char + total-count; append epoch ms; SHA-256.
async function orSign(url, timestamp) {
  const seen  = new Map();
  const order = [];
  for (const ch of url) {
    if (/[a-zA-Z0-9]/.test(ch)) {
      if (!seen.has(ch)) { seen.set(ch, 0); order.push(ch); }
      seen.set(ch, seen.get(ch) + 1);
    }
  }
  const payload = order.map(ch => ch + seen.get(ch)).join('') + timestamp;
  return sha256hex(payload);
}

async function orHeaders(url) {
  const ts = Date.now();
  return {
    'Authorization':           'Public ' + btoa(OR_PUBLIC_KEY),
    'Timestamp':               String(ts),
    'Sign':                    await orSign(url, ts),
    'Content-Type':            'application/json',
    'Client':                  'web',
    'CF-Access-Client-Id':     OR_CF_CLIENT_ID,
    'CF-Access-Client-Secret': OR_CF_CLIENT_SECRET,
  };
}

// Fetch with an explicit timeout (AbortController, compatible with MV3).
async function fetchWithTimeout(url, options = {}, timeoutMs = 10_000) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Fetch with exponential backoff on HTTP 429 Too Many Requests.
// Attempts: 0 … maxRetries  →  delays ≈ 1 s, 2 s, 4 s before giving up.
// Jitter (±400 ms random) spreads simultaneous retries across sources.
async function fetchWithBackoff(url, options = {}, timeoutMs = 10_000, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetchWithTimeout(url, options, timeoutMs);
    if (resp.status !== 429) return resp;
    if (attempt === maxRetries) return resp;          // return the 429 so caller can handle
    const delay = 1_000 * 2 ** attempt + Math.random() * 400;
    await new Promise(r => setTimeout(r, delay));
  }
}

// Parse the AVM valuation object out of a OneRoof property page.
// OneRoof uses Next.js RSC streaming: all data is in self.__next_f.push([1,"..."])
// script blocks.  The avm object has been confirmed in RSC block 38 of 54 for
// residential property pages.
function parseOrAvm(html) {
  // Collect and decode all RSC chunks.
  // Each chunk is: self.__next_f.push([1,"<JSON-escaped string>"])
  let allText = '';
  const chunkRe = /self\.__next_f\.push\(\[1\s*,\s*"((?:[^"\\]|\\.)*)"\s*\]\)/g;
  let m;
  while ((m = chunkRe.exec(html)) !== null) {
    try {
      // JSON.parse('"..."') decodes the escape sequences (\", \\, \n, etc.)
      allText += JSON.parse('"' + m[1] + '"');
    } catch {
      allText += m[1];
    }
  }

  // Locate the outer "avm":{...} object (all values are primitives, no nesting).
  const objMatch = /"avm"\s*:\s*(\{[^}]+\})/.exec(allText);
  if (!objMatch) return null;
  const obj = objMatch[1];

  const str  = key => { const r = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`).exec(obj); return r?.[1] ?? null; };
  const bool = key => { const r = new RegExp(`"${key}"\\s*:\\s*(true|false)`).exec(obj); return r ? r[1] === 'true' : null; };

  const rawEst = str('avm');
  const n = rawEst ? Number(rawEst.replace(/[$,]/g, '')) : NaN;
  return {
    estimate:        isFinite(n) && n > 0 ? fmtAmount(n) : (rawEst ?? null),
    confidenceScore: str('confidenceScore'), // "High"|"Medium"|"Low"
    showAvm:         bool('showAvm') ?? true,
  };
}

// ─── OneRoof fetcher ──────────────────────────────────────────────────────
// Flow:
//   1. GET /v2.6/address/search?isMix=1&key=<fullAddress>&typeId=-100
//      Signed with SHA-256 auth headers (public credentials from bundle).
//      → properties[0].slug  e.g. "auckland/remuera/10-mahoe-avenue/qeHJ8"
//   2. GET https://www.oneroof.co.nz/property/<slug>
//      Plain fetch (no auth), returns full Next.js RSC HTML including AVM data.
//      → parse __next_f RSC blocks → find "avm":{avm, confidenceScore, showAvm}
//
// Confidence reflects address-match quality, not AVM model accuracy:
//   "high"   — first result's pureLabel starts with the searched street address
//   "medium" — fuzzy / partial match

async function fetchOneRoof(address) {
  // ── Step 1: Resolve address to slug ───────────────────────────────────────
  const searchUrl = `${OR_BASE_URL}/v2.6/address/search?isMix=1` +
    `&key=${encodeURIComponent(address.fullAddress)}&typeId=-100`;

  let searchData;
  try {
    const resp = await fetchWithBackoff(searchUrl, { headers: await orHeaders(searchUrl) });
    if (!resp.ok) throw new Error(`OneRoof search request failed (HTTP ${resp.status})`);
    searchData = await resp.json();
  } catch (err) {
    return {
      source:     'OneRoof',
      estimate:   null,
      url:        null,
      confidence: null,
      error:      /OneRoof/.test(err.message) ? err.message : 'OneRoof request failed',
    };
  }

  const properties = searchData.properties ?? [];
  if (properties.length === 0) {
    return { source: 'OneRoof', estimate: null, url: null, confidence: null,
             error: 'Address not found on OneRoof' };
  }

  const best    = properties[0];
  const slug    = best.slug;   // "auckland/remuera/10-mahoe-avenue/qeHJ8"
  const pageUrl = `${OR_BASE_URL}/property/${slug}`;

  // Confidence: does the top result's label start with our street address?
  const norm = s => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const confidence = norm(best.pureLabel ?? '').startsWith(norm(address.streetAddress))
    ? 'high' : 'medium';

  // ── Step 2: Fetch property page and parse RSC AVM data ────────────────────
  let html;
  try {
    const resp = await fetchWithTimeout(pageUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible)' },
    });
    if (!resp.ok) throw new Error(`OneRoof page request failed (HTTP ${resp.status})`);
    html = await resp.text();
  } catch (err) {
    return {
      source: 'OneRoof', estimate: null, url: pageUrl, confidence,
      error: /OneRoof/.test(err.message) ? err.message : 'OneRoof request failed',
    };
  }

  const avm = parseOrAvm(html);
  if (!avm) {
    return { source: 'OneRoof', estimate: null, url: pageUrl, confidence,
             error: 'OneRoof returned unexpected format' };
  }
  if (!avm.showAvm || !avm.estimate) {
    return { source: 'OneRoof', estimate: null, url: pageUrl, confidence,
             error: 'OneRoof estimate not available for this property' };
  }

  return {
    source:     'OneRoof',
    estimate:   avm.estimate,   // e.g. "$1,425,000"
    url:        pageUrl,
    confidence,
    error:      null,
  };
}

// ─── homes.co.nz fetcher ─────────────────────────────────────────────────
// Flow:
//   1. GET https://gateway.homes.co.nz/address/search?Address=<fullAddress>
//      → Results[0].PropertyID  (UUID)
//   2. GET https://gateway.homes.co.nz/properties?property_ids=<uuid>
//      → cards[0].property_details.{display_estimated_lower_value_short,
//                                   display_estimated_upper_value_short}
//        cards[0].url  → relative path e.g. "/lower-hutt/korokoro/..."
//
// The gateway requires Origin + Referer headers matching homes.co.nz.
// Display strings are already K/M-formatted ("920K", "1.04M"); prepend "$".

const HG_BASE_URL = 'https://gateway.homes.co.nz';
const HG_HEADERS  = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept':     'application/json',
  'Origin':     'https://homes.co.nz',
  'Referer':    'https://homes.co.nz/',
};

async function fetchHomes(address) {
  // ── Step 1: Resolve address to PropertyID ─────────────────────────────────
  const searchUrl = `${HG_BASE_URL}/address/search` +
    `?Address=${encodeURIComponent(address.fullAddress)}`;

  let searchData;
  try {
    const resp = await fetchWithBackoff(searchUrl, { headers: HG_HEADERS });
    if (!resp.ok) throw new Error(`homes.co.nz search failed (HTTP ${resp.status})`);
    searchData = await resp.json();
  } catch (err) {
    return {
      source:     'homes.co.nz',
      estimate:   null,
      url:        null,
      confidence: null,
      error:      /homes\.co\.nz/.test(err.message) ? err.message : 'homes.co.nz request failed',
    };
  }

  const results = searchData.Results ?? [];
  if (results.length === 0) {
    return { source: 'homes.co.nz', estimate: null, url: null, confidence: null,
             error: 'Address not found on homes.co.nz' };
  }

  // Prefer the result whose title starts with the exact searched street address.
  // Avoids picking "48a Adams Rd" when searching for "48 Adams Rd" (results[0]
  // is sorted by relevance/alpha, not by exactness of house-number match).
  const norm       = s => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const normStreet = norm(address.streetAddress);
  const exact      = results.find(r => norm(r.Title ?? '').startsWith(normStreet));
  const best       = exact ?? results[0];
  const confidence = exact ? 'high' : 'medium';
  const propertyId = best.PropertyID;

  // ── Step 2: Fetch estimate card ───────────────────────────────────────────
  const cardUrl = `${HG_BASE_URL}/properties?property_ids=${propertyId}`;

  let cardData;
  try {
    const resp = await fetchWithBackoff(cardUrl, { headers: HG_HEADERS });
    if (!resp.ok) throw new Error(`homes.co.nz card failed (HTTP ${resp.status})`);
    cardData = await resp.json();
  } catch (err) {
    return {
      source:     'homes.co.nz',
      estimate:   null,
      url:        null,
      confidence,
      error:      /homes\.co\.nz/.test(err.message) ? err.message : 'homes.co.nz request failed',
    };
  }

  const card = (cardData.cards ?? [])[0];
  if (!card) {
    return { source: 'homes.co.nz', estimate: null, url: null, confidence,
             error: 'homes.co.nz returned no property data' };
  }

  const pd      = card.property_details ?? {};
  const lo      = pd.display_estimated_lower_value_short;
  const hi      = pd.display_estimated_upper_value_short;
  const pageUrl = card.url ? 'https://homes.co.nz/address' + card.url : null;

  if (!lo || !hi) {
    return { source: 'homes.co.nz', estimate: null, url: pageUrl, confidence,
             error: 'No estimate available on homes.co.nz' };
  }

  return {
    source:     'homes.co.nz',
    estimate:   `$${lo} \u2013 $${hi}`,   // e.g. "$920K – $1.04M"
    url:        pageUrl,
    confidence,
    error:      null,
  };
}

// ─── PropertyValue fetcher ───────────────────────────────────────────────
// Flow:
//   1. GET /api/public/clapi/suggestions?q=<fullAddress>&suggestionTypes=address&limit=5
//      → suggestions[0].propertyId  (integer)
//   2. GET /api/public/clapi/properties/<propertyId>
//      → estimatedRange: { lowerBand, upperBand, confidence }
//         ratingValuation: { capitalValue, valuationDate }
//   3. GET /api/public/clapi/properties/propertyUrl?propertyId=<id>
//      → plain string path  e.g. "/wellington/wellington-city/…/7120741"
//
// No auth required; Imperva WAF only guards the HTML layer.
// Confidence mapping: "HIGH" → "high", "MEDIUM" → "medium", "LOW" → "low".

const PV_BASE_URL = 'https://www.propertyvalue.co.nz';

// Format a dollar amount using K/M suffixes: 560000 → "$560K", 1425000 → "$1.43M".
function fmtAmount(n) {
  if (n >= 1_000_000) return '$' + parseFloat((n / 1_000_000).toFixed(2)) + 'M';
  return '$' + Math.round(n / 1_000) + 'K';
}

function pvFormatEstimate(lowerBand, upperBand) {
  return `${fmtAmount(lowerBand)} – ${fmtAmount(upperBand)}`;
}

async function fetchPropertyValue(address) {
  // ── Step 1: Autocomplete → propertyId ────────────────────────────────────
  // PropertyValue's suggestions API returns 404 for some suburb+city
  // combinations (e.g. "Red Beach, Auckland") but succeeds when the city is
  // omitted.  Try progressively shorter queries until we get a 200 with hits.
  const pvSuggestQueries = [
    address.fullAddress,                                         // street + suburb + city
    [address.streetAddress, address.suburb].filter(Boolean).join(', '), // street + suburb
    address.streetAddress,                                       // street only
  ].filter((q, i, arr) => q && arr.indexOf(q) === i);           // deduplicate

  let propertyId;
  try {
    let found = false;
    for (const q of pvSuggestQueries) {
      const url  = `${PV_BASE_URL}/api/public/clapi/suggestions` +
        `?q=${encodeURIComponent(q)}&suggestionTypes=address&limit=5`;
      const resp = await fetchWithBackoff(url);
      if (!resp.ok) continue;                   // try next query variant
      const data        = await resp.json();
      const suggestions = data.suggestions ?? [];
      if (suggestions.length === 0) continue;   // no hits, try shorter query
      propertyId = suggestions[0].propertyId;
      found = true;
      break;
    }
    if (!found) {
      return { source: 'PropertyValue', estimate: null, url: null, confidence: null,
               error: 'Address not found on PropertyValue' };
    }
  } catch (err) {
    return {
      source:     'PropertyValue',
      estimate:   null,
      url:        null,
      confidence: null,
      error:      /PropertyValue/.test(err.message) ? err.message : 'PropertyValue request failed',
    };
  }

  // ── Step 2 & 3: Property detail + URL (in parallel) ───────────────────────
  const detailUrl = `${PV_BASE_URL}/api/public/clapi/properties/${propertyId}`;
  const pvUrlUrl  = `${PV_BASE_URL}/api/public/clapi/properties/propertyUrl?propertyId=${propertyId}`;

  let detail, pvPath;
  try {
    const [detailResp, pvUrlResp] = await Promise.all([
      fetchWithBackoff(detailUrl),
      fetchWithBackoff(pvUrlUrl),
    ]);
    if (!detailResp.ok) throw new Error(`PropertyValue request failed (HTTP ${detailResp.status})`);
    detail  = await detailResp.json();
    pvPath  = pvUrlResp.ok ? (await pvUrlResp.text()).trim() : null;
  } catch (err) {
    return {
      source:     'PropertyValue',
      estimate:   null,
      url:        null,
      confidence: null,
      error:      /PropertyValue/.test(err.message) ? err.message : 'PropertyValue request failed',
    };
  }

  const range = detail.estimatedRange;
  if (!range || range.lowerBand == null || range.upperBand == null) {
    return { source: 'PropertyValue', estimate: null,
             url: pvPath ? PV_BASE_URL + pvPath : null, confidence: null,
             error: 'PropertyValue returned unexpected format' };
  }

  const confidenceMap = { HIGH: 'high', MEDIUM: 'medium', LOW: 'low' };
  const confidence = confidenceMap[(range.confidence ?? '').toUpperCase()] ?? null;
  const pageUrl    = pvPath ? PV_BASE_URL + pvPath : null;

  return {
    source:   'PropertyValue',
    estimate: pvFormatEstimate(range.lowerBand, range.upperBand),
    url:      pageUrl,
    confidence,
    error:    null,
  };
}

// ─── Message listener ────────────────────────────────────────────────────
// Handles two message types:
//   FETCH_VALUATIONS — run enabled fetchers, stream partial results, cache.
//   CLEAR_CACHE      — wipe the in-memory cache (sent from popup).

function runFetchers(address, sources, tabId, sendResponse) {
  const enabled = name => sources[name]?.enabled !== false;

  const fetches = [
    enabled('OneRoof')       ? fetchOneRoof(address)      : Promise.resolve(disabledResult('OneRoof')),
    enabled('homes.co.nz')   ? fetchHomes(address)        : Promise.resolve(disabledResult('homes.co.nz')),
    enabled('PropertyValue') ? fetchPropertyValue(address) : Promise.resolve(disabledResult('PropertyValue')),
  ];

  // Stream each result to the tab as soon as it settles so the panel can
  // show partial results without waiting for the slowest source.
  if (tabId != null) {
    fetches.forEach(p => {
      p.then(result => {
        chrome.tabs.sendMessage(tabId, { type: 'VALUATION_UPDATE', result })
          .catch(() => {}); // tab may have navigated away
      });
    });
  }

  // When all fetchers have settled: cache, persist status, send final response.
  Promise.allSettled(fetches).then(outcomes => {
    const results = outcomes.map(outcome => {
      if (outcome.status === 'fulfilled') return outcome.value;
      return {
        source:     'unknown',
        estimate:   null,
        url:        null,
        confidence: null,
        error:      outcome.reason?.message ?? String(outcome.reason),
      };
    });

    setCached(address.fullAddress, results);
    recordFetchStatus(results); // fire-and-forget
    console.log('[NZ-Valuator] Valuations fetched for:', address.fullAddress, results);
    sendResponse({ ok: true, results, fromCache: false });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // ── Clear cache ───────────────────────────────────────────────────────────
  if (message.type === 'CLEAR_CACHE') {
    cache.clear();
    console.log('[NZ-Valuator] Cache cleared');
    sendResponse({ ok: true });
    return false;
  }

  if (message.type !== 'FETCH_VALUATIONS') return false;

  const { address } = message;
  const cacheKey    = address.fullAddress;
  const tabId       = sender.tab?.id ?? null;

  // Return cached results immediately if still fresh.
  const cached = getCached(cacheKey);
  if (cached) {
    console.log('[NZ-Valuator] Cache hit:', cacheKey);
    sendResponse({ ok: true, results: cached, fromCache: true });
    return false;
  }

  // Read per-source enabled settings, then dispatch fetchers.
  // Falls back to all-enabled defaults if storage is unavailable.
  chrome.storage.sync
    .get({ sources: DEFAULT_SOURCE_SETTINGS })
    .then(({ sources }) => runFetchers(address, sources, tabId, sendResponse))
    .catch(()           => runFetchers(address, DEFAULT_SOURCE_SETTINGS, tabId, sendResponse));

  // Return true to keep the message channel open until sendResponse is called.
  return true;
});

// ─── Tab lifecycle ────────────────────────────────────────────────────────
// The extension holds no per-tab state today.  The content script cleans up
// its own timers and observers via the window 'beforeunload' event.
// If per-tab fetch cancellation is ever needed, add "tabs" to the manifest
// permissions and listen to chrome.tabs.onRemoved here.
