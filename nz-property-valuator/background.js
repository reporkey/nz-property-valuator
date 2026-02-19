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

// ─── OneRoof fetcher ──────────────────────────────────────────────────────
// Live plan (see RESEARCH.md):
//   1. GET /v2.6/address/search?isMix=1&key=<fullAddress>&typeId=-100
//      (signed with SHA-256 + public key headers)
//      → properties[0].slug  e.g. "auckland/remuera/10-mahoe-avenue/qeHJ8"
//   2. GET https://www.oneroof.co.nz/property/<slug>
//      → parse __next_f RSC blocks → find "avm":{avm,high,low,rv,...}

async function fetchOneRoof(address) {
  // STUB — returns mock data after a simulated 1 s network delay
  await new Promise(resolve => setTimeout(resolve, 1000));

  return {
    source:     'OneRoof',
    estimate:   '$850,000',
    url:        'https://www.oneroof.co.nz/estimate/map/region_all-new-zealand-1',
    confidence: 'high',
    error:      null,
  };
}

// ─── homes.co.nz fetcher ─────────────────────────────────────────────────
// Placeholder — homes.co.nz was removed from the active research as a data
// source.  Stub retained so the plumbing can be wired up or swapped later.

async function fetchHomes(address) {
  // STUB — returns mock data after a simulated 1 s network delay
  await new Promise(resolve => setTimeout(resolve, 1000));

  return {
    source:     'homes.co.nz',
    estimate:   '$820,000 – $900,000',
    url:        'https://homes.co.nz/',
    confidence: 'medium',
    error:      null,
  };
}

// ─── PropertyValue fetcher ───────────────────────────────────────────────
// Live plan (see RESEARCH.md):
//   1. GET /api/public/clapi/suggestions?q=<fullAddress>&suggestionTypes=address&limit=5
//      → suggestions[0].propertyId  (integer)
//   2. GET /api/public/clapi/properties/<propertyId>
//      → estimatedRange: { lowerBand, upperBand, confidence }
//         ratingValuation: { capitalValue, valuationDate }

async function fetchPropertyValue(address) {
  // STUB — returns mock data after a simulated 1 s network delay
  await new Promise(resolve => setTimeout(resolve, 1000));

  return {
    source:     'PropertyValue',
    estimate:   '$875,000',
    url:        'https://www.propertyvalue.co.nz/',
    confidence: 'high',
    error:      null,
  };
}

// ─── Message listener ────────────────────────────────────────────────────
// Listens for { type: "FETCH_VALUATIONS", address: { streetAddress, suburb,
// city, fullAddress } } sent from content.js, runs all three fetchers in
// parallel, and replies with the combined results array.

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'FETCH_VALUATIONS') return false;

  const { address } = message;
  const cacheKey = address.fullAddress;

  // Return cached results immediately if still fresh
  const cached = getCached(cacheKey);
  if (cached) {
    console.log('[NZ-Valuator] Cache hit:', cacheKey);
    sendResponse({ ok: true, results: cached, fromCache: true });
    return false;
  }

  // Run all three fetchers in parallel; allSettled ensures one failure
  // does not block the others
  Promise.allSettled([
    fetchOneRoof(address),
    fetchHomes(address),
    fetchPropertyValue(address),
  ]).then(outcomes => {
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

    setCached(cacheKey, results);
    console.log('[NZ-Valuator] Valuations fetched for:', cacheKey, results);
    sendResponse({ ok: true, results, fromCache: false });
  });

  // Return true to keep the message channel open until sendResponse is called
  return true;
});
