/**
 * background.js — Service worker for NZ Property Valuator
 *
 * Handles messaging between the content script and external APIs,
 * manages extension state, and coordinates cross-tab logic.
 */

'use strict';

importScripts('addressMatcher.js');

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

const DISPLAYED_SOURCES = ['OneRoof', 'homes.co.nz', 'PropertyValue', 'RealEstate.co.nz'];

const DEFAULT_SOURCE_SETTINGS = {
  OneRoof:            { enabled: true },
  'homes.co.nz':      { enabled: true },
  PropertyValue:      { enabled: true },
  'RealEstate.co.nz': { enabled: true },
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
  const qParsed = parseAddress(address.streetAddress, address.suburb, address.city);

  let pageUrl, confidence;

  if (address.oneRoofUrl) {
    // ── Shortcut: already on an OneRoof property page — URL is known ──────────
    pageUrl    = address.oneRoofUrl;
    confidence = 'high';
  } else {
    // ── Step 1: Resolve address to slug via search API ────────────────────────
    async function orSearch(key) {
      const url = `${OR_BASE_URL}/v2.6/address/search?isMix=1` +
        `&key=${encodeURIComponent(key)}&typeId=-100`;
      const resp = await fetchWithBackoff(url, { headers: await orHeaders(url) });
      if (!resp.ok) throw new Error(`OneRoof search request failed (HTTP ${resp.status})`);
      const data = await resp.json();
      return data.properties ?? [];
    }

    function findBest(properties) {
      const ranked = properties
        .map(p => ({ p, r: matchAddress(qParsed, parseAddress(p.pureLabel ?? '')) }))
        .filter(x => x.r.match);
      if (!ranked.length) return null;
      // Prefer building-level (no unit) over unit fallbacks, then highest confidence.
      const CONF = ['high', 'medium', 'low'];
      ranked.sort((a, b) =>
        (a.r.unitFallback ? 1 : 0) - (b.r.unitFallback ? 1 : 0) ||
        CONF.indexOf(a.r.confidence) - CONF.indexOf(b.r.confidence)
      );
      return ranked[0].p;
    }

    // Fallback query cascade: fullAddress → street + suburb (drops city) → street alone.
    // The city/region from TradeMe (e.g. "Canterbury") can be picked up as a street-name
    // keyword by the OneRoof search API, returning completely unrelated results.
    // Continuing past such false-positive result sets lets us reach a cleaner query.
    const streetSuburb = [address.streetAddress, address.suburb].filter(Boolean).join(', ');
    const queryList = [address.fullAddress, streetSuburb, address.streetAddress]
      .filter((q, i, arr) => q && arr.indexOf(q) === i); // dedup

    let best = null;
    try {
      for (let qi = 0; qi < queryList.length; qi++) {
        best = findBest(await orSearch(queryList[qi]));
        if (best) break;
      }
    } catch (err) {
      return {
        source:     'OneRoof',
        estimate:   null,
        url:        null,
        confidence: null,
        error:      /OneRoof/.test(err.message) ? err.message : 'OneRoof request failed',
      };
    }

    if (!best) {
      return { source: 'OneRoof', estimate: null, url: null, confidence: null,
               error: 'Address not found on OneRoof' };
    }

    pageUrl    = `${OR_BASE_URL}/property/${best.slug}`;
    confidence = matchAddress(qParsed, parseAddress(best.pureLabel ?? '')).confidence ?? 'medium';
  }

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
             error: 'No estimate available on OneRoof' };
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
  // ── Step 1 + 2: Progressive search → card, stop at first estimate ──────────
  //
  // Unit-prefixed NZ addresses like "2L/6 Burgoyne St" normalise to
  // "2l6 burgoyne st" (slash stripped), which won't start with "6 burgoyne st",
  // so unit results are excluded.
  //
  // We try three progressively shorter queries, fetching the card for each
  // matching PropertyID.  We return as soon as a card yields an estimate.
  // This handles two problem cases:
  //
  //  a) Apartment blocks — the building-level record ("6 Burgoyne St") doesn't
  //     appear in the full-address search but surfaces in a street-only query.
  //  b) Suburb-name mismatches — TradeMe's "Terrace End" differs from homes'
  //     "Palmerston North", so the full-address query finds a record with no
  //     estimate while the street+city query finds the city-level record that
  //     does have one.
  //
  // Query order:
  //   1. fullAddress        — fastest for standard houses; no locality check.
  //   2. streetAddress+city — skips suburb; fixes mismatch; no locality check.
  //   3. streetAddress only — widest net; locality check (suburb OR city in
  //                           title) to avoid cross-city false positives.

  // Three qParsed variants — progressively looser locality matching per tier:
  //   qParsed:         suburb+city gate (fullAddress and street+suburb queries)
  //   qParsedCityOnly: city gate only   (street+city query — handles suburb-name mismatches)
  //   qParsedStreet:   no locality gate (street-only query — widest net)
  const qParsed         = parseAddress(address.streetAddress, address.suburb, address.city);
  const qParsedCityOnly = parseAddress(address.streetAddress, null, address.city);
  const qParsedStreet   = parseAddress(address.streetAddress);

  async function homesSearch(query) {
    const resp = await fetchWithBackoff(
      `${HG_BASE_URL}/address/search?Address=${encodeURIComponent(query)}`,
      { headers: HG_HEADERS },
    );
    if (!resp.ok) throw new Error(`homes.co.nz search failed (HTTP ${resp.status})`);
    return (await resp.json()).Results ?? [];
  }

  function findExact(results, qp) {
    const matches = results.filter(r => matchAddress(qp, parseAddress(r.Title ?? '')).match);
    if (!matches.length) return null;
    // Prefer building-level record (no unit) when query has no unit.
    if (qp.unitNum === null) {
      const noUnit = matches.find(r => parseAddress(r.Title ?? '').unitNum === null);
      if (noUnit) return noUnit;
    }
    return matches[0];
  }

  // Construct a homes.co.nz map URL from a search result when no card URL is
  // available (e.g. new builds where PropertyID is empty).
  // Pattern: /map/{city-slug}/{suburb-slug}/{street-slug}/{house-number}
  function homesMapUrl(r) {
    const sl = s => (s || '').toLowerCase().replace(/\s+/g, '-');
    const city = sl(r.City), suburb = sl(r.Suburb), street = sl(r.Street);
    const num  = r.StreetNumber;
    return (city && suburb && street && num)
      ? `https://homes.co.nz/map/${city}/${suburb}/${street}/${num}`
      : null;
  }

  // Query cascade: fullAddress → street+suburb → street+city → street alone.
  // Each tier uses a progressively looser qParsed so that suburb-name mismatches
  // between TradeMe and homes.co.nz (e.g. "Coatesville" vs "Lucas Heights") are
  // resolved by the time the street+city or street-only tier runs.
  const streetSuburb = [address.streetAddress, address.suburb].filter(Boolean).join(', ');
  const streetCity   = [address.streetAddress, address.city].filter(Boolean).join(', ');

  // Pair each query string with the appropriate matcher for that tier.
  const tiers = [
    { q: address.fullAddress,   qp: qParsed },
    { q: streetSuburb,          qp: qParsed },
    { q: streetCity,            qp: qParsedCityOnly },
    { q: address.streetAddress, qp: qParsedStreet },
  ].filter((t, i, arr) => t.q && arr.findIndex(x => x.q === t.q) === i); // dedup

  let lastError = 'Address not found on homes.co.nz';
  let lastUrl   = null;

  for (const { q, qp } of tiers) {
    // ── Search ──────────────────────────────────────────────────────────────
    let exact;
    try {
      exact = findExact(await homesSearch(q), qp);
    } catch (err) {
      return {
        source:     'homes.co.nz',
        estimate:   null,
        url:        null,
        confidence: null,
        error:      /homes\.co\.nz/.test(err.message) ? err.message : 'homes.co.nz request failed',
      };
    }
    if (!exact) continue;

    // New-build / address-only record: PropertyID is empty, so no card exists.
    // Construct the map URL from the search result fields and skip the card fetch.
    if (!exact.PropertyID) {
      lastError = 'No estimate available on homes.co.nz';
      lastUrl   = homesMapUrl(exact);
      continue;
    }

    // ── Card ─────────────────────────────────────────────────────────────
    let cardData;
    try {
      const resp = await fetchWithBackoff(
        `${HG_BASE_URL}/properties?property_ids=${exact.PropertyID}`,
        { headers: HG_HEADERS },
      );
      if (!resp.ok) throw new Error(`homes.co.nz card failed (HTTP ${resp.status})`);
      cardData = await resp.json();
    } catch (err) {
      return {
        source:     'homes.co.nz',
        estimate:   null,
        url:        null,
        confidence: null,
        error:      /homes\.co\.nz/.test(err.message) ? err.message : 'homes.co.nz request failed',
      };
    }

    const card = (cardData.cards ?? [])[0];
    if (!card) { lastError = 'No estimate available on homes.co.nz'; lastUrl = homesMapUrl(exact); continue; }

    const pd      = card.property_details ?? {};
    const lo      = pd.display_estimated_lower_value_short;
    const hi      = pd.display_estimated_upper_value_short;
    const pageUrl = card.url ? 'https://homes.co.nz/address' + card.url : homesMapUrl(exact);

    if (!lo || !hi) { lastError = 'No estimate available on homes.co.nz'; lastUrl = pageUrl; continue; }

    return {
      source:     'homes.co.nz',
      estimate:   `$${lo} \u2013 $${hi}`,   // e.g. "$920K – $1.04M"
      url:        pageUrl,
      confidence: 'high',
      error:      null,
    };
  }

  return { source: 'homes.co.nz', estimate: null, url: lastUrl, confidence: null, error: lastError };
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
  const qParsed = parseAddress(address.streetAddress, address.suburb, address.city);

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

  // Validate that the resolved property matches our street address.
  // PV suggestions sometimes return a unit record when we searched for the
  // building (e.g. "1/20 Charlotte Street" when we want "20 Charlotte Street").
  // Parse the slug as an address and compare components.
  if (pvPath) {
    const lastSlug = pvPath.split('/').filter(Boolean).pop() ?? '';
    const slugStr  = lastSlug.replace(/-/g, ' ').replace(/\d{5,}\s*$/, '').trim();
    const cParsed  = parseAddress(slugStr);
    const unitMismatch  = qParsed.unitNum === null && cParsed.unitNum !== null;
    const houseMismatch = qParsed.houseNum && cParsed.houseNum && qParsed.houseNum !== cParsed.houseNum;
    if (unitMismatch || houseMismatch) {
      return { source: 'PropertyValue', estimate: null,
               url: PV_BASE_URL + pvPath, confidence: null,
               error: 'No estimate available on PropertyValue' };
    }
  }

  const range = detail.estimatedRange;
  if (!range || range.lowerBand == null || range.upperBand == null) {
    return { source: 'PropertyValue', estimate: null,
             url: pvPath ? PV_BASE_URL + pvPath : null, confidence: null,
             error: 'No estimate available on PropertyValue' };
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

// ─── RealEstate.co.nz fetcher ────────────────────────────────────────────
// Flow:
//   1. GET platform.realestate.co.nz/search/v1/listings/smart?q=<fullAddress>
//         &filter[category][0]=res_sale
//      → flat array; find entry with 'listing-id'; prefer exact street match.
//   2. GET platform.realestate.co.nz/search/v1/listings/<listing-id>
//      → JSONAPI: data.attributes['property-short-id']
//   3. GET platform.realestate.co.nz/search/v1/properties/<property-short-id>
//      → data.attributes['estimated-value'].{value-low, value-high,
//                                            confidence-rating}
//         data.attributes['website-full-url']  ← canonical property page URL
//
// CORS: platform.realestate.co.nz requires Origin: https://www.realestate.co.nz.
// The extension service worker can set this when it has host_permissions for
// platform.realestate.co.nz (same approach as homes.co.nz / gateway).

const RE_API_BASE = 'https://platform.realestate.co.nz';
const RE_SITE     = 'https://www.realestate.co.nz';
const RE_HEADERS  = {
  'Accept':  'application/json',
  'Origin':  RE_SITE,
  'Referer': RE_SITE + '/',
};

async function fetchRealEstate(address) {
  // ── Step 1: Smart search → listing ID ─────────────────────────────────────
  // Try fullAddress first; if no listings found, retry with streetAddress only.
  // The suburb from TradeMe (e.g. "Terrace End") may not match RealEstate's
  // indexing, so the shorter query surfaces listings that the full query misses.

  const qParsed = parseAddress(address.streetAddress, address.suburb, address.city);

  async function reSmartSearch(q) {
    const resp = await fetchWithBackoff(
      `${RE_API_BASE}/search/v1/listings/smart?q=${encodeURIComponent(q)}&filter[category][0]=res_sale`,
      { headers: RE_HEADERS },
    );
    if (!resp.ok) throw new Error(`search failed (HTTP ${resp.status})`);
    const hits = await resp.json();
    return (Array.isArray(hits) ? hits : (hits.data ?? [])).filter(r => r['listing-id']);
  }

  function pickBest(listings) {
    const ranked = listings
      .map(r => ({ r, m: matchAddress(qParsed, parseAddress(r['street-address'] ?? '')) }))
      .filter(x => x.m.match);
    if (!ranked.length) return null;
    // Prefer building-level (no unit) over unit fallbacks, then highest confidence.
    const CONF = ['high', 'medium', 'low'];
    ranked.sort((a, b) =>
      (a.m.unitFallback ? 1 : 0) - (b.m.unitFallback ? 1 : 0) ||
      CONF.indexOf(a.m.confidence) - CONF.indexOf(b.m.confidence)
    );
    return ranked[0].r;
  }

  let listingId;
  try {
    // First try: full address.
    let listings = await reSmartSearch(address.fullAddress);

    // Retry with street address only if no listings found.
    if (listings.length === 0 && address.streetAddress !== address.fullAddress) {
      listings = await reSmartSearch(address.streetAddress);
    }

    const best = pickBest(listings);
    if (!best) {
      return { source: 'RealEstate.co.nz', estimate: null, url: null, confidence: null,
               error: 'Address not found on RealEstate.co.nz' };
    }

    listingId = best['listing-id'];
  } catch (err) {
    return { source: 'RealEstate.co.nz', estimate: null, url: null, confidence: null,
             error: 'RealEstate.co.nz request failed' };
  }

  // ── Step 2: Listing detail → property short ID ────────────────────────────
  let propertyShortId;
  try {
    const resp = await fetchWithTimeout(
      `${RE_API_BASE}/search/v1/listings/${listingId}`,
      { headers: RE_HEADERS },
    );
    if (resp.ok) {
      const detail = await resp.json();
      // JSONAPI: { data: { attributes: { 'property-short-id': '...' } } }
      propertyShortId = detail.data?.attributes?.['property-short-id']
        ?? detail.data?.['property-short-id']
        ?? detail['property-short-id'];
    }
  } catch { /* non-fatal — fall through without AVM */ }

  if (!propertyShortId) {
    return { source: 'RealEstate.co.nz', estimate: null, url: null, confidence: null,
             error: 'Address not found on RealEstate.co.nz' };
  }

  // ── Step 3: Properties API → AVM + canonical URL ──────────────────────────
  // This is a direct JSON API endpoint; no HTML scraping required.
  try {
    const resp = await fetchWithTimeout(
      `${RE_API_BASE}/search/v1/properties/${propertyShortId}`,
      { headers: RE_HEADERS },
    );
    if (!resp.ok) throw new Error(`properties API failed (HTTP ${resp.status})`);
    const data = await resp.json();

    const attrs    = data.data?.attributes ?? {};
    const ev       = attrs['estimated-value'];
    const pageUrl  = attrs['website-full-url'] ?? null;

    // confidence-rating 1 = minimum (API has essentially no confidence) → suppress.
    // confidence-rating 2+ = show with appropriate label.
    const confMap    = { 5: 'high', 4: 'high', 3: 'medium', 2: 'low' };
    const confidence = ev ? (confMap[ev['confidence-rating']] ?? null) : null;

    if (!ev || ev['value-low'] == null || ev['value-high'] == null || confidence === null) {
      return { source: 'RealEstate.co.nz', estimate: null, url: pageUrl, confidence: null,
               error: 'No estimate available on RealEstate.co.nz' };
    }

    return {
      source:   'RealEstate.co.nz',
      estimate: `${fmtAmount(ev['value-low'])} \u2013 ${fmtAmount(ev['value-high'])}`,
      url:      pageUrl,
      confidence,
      error:    null,
    };
  } catch {
    return { source: 'RealEstate.co.nz', estimate: null, url: null, confidence: null,
             error: 'No estimate available on RealEstate.co.nz' };
  }
}

// ─── Message listener ────────────────────────────────────────────────────
// Handles two message types:
//   FETCH_VALUATIONS — run enabled fetchers, stream partial results, cache.
//   CLEAR_CACHE      — wipe the in-memory cache (sent from popup).

function runFetchers(address, sources, tabId, sendResponse) {
  const enabled = name => sources[name]?.enabled !== false;

  const fetches = [
    enabled('OneRoof')            ? fetchOneRoof(address)       : Promise.resolve(disabledResult('OneRoof')),
    enabled('homes.co.nz')        ? fetchHomes(address)         : Promise.resolve(disabledResult('homes.co.nz')),
    enabled('PropertyValue')      ? fetchPropertyValue(address)  : Promise.resolve(disabledResult('PropertyValue')),
    enabled('RealEstate.co.nz')   ? fetchRealEstate(address)    : Promise.resolve(disabledResult('RealEstate.co.nz')),
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
