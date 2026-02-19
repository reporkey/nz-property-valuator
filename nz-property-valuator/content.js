/**
 * content.js — Content script for NZ Property Valuator
 *
 * Injected into matching TradeMe property listing pages.
 * Responsible for scraping listing data and rendering the valuation panel.
 *
 * Runs at: document_idle
 * Matches:  https://www.trademe.co.nz/a/*
 *
 * TradeMe is a fully client-side Angular SPA.
 * JSON-LD and DOM content are injected dynamically after bootstrap, so we
 * observe the DOM and retry until the address is found or a timeout is hit.
 */

(() => {
  'use strict';

  const LOG = '[NZ-Valuator]';
  const TIMEOUT_MS  = 10_000;   // give up after 10 s
  const INTERVAL_MS = 300;      // poll every 300 ms

  // ─── Strategy 1: JSON-LD ───────────────────────────────────────────────────
  // TradeMe injects a <script type="application/ld+json"> with:
  //   @type: "RealEstateListing"
  //   mainEntity.address: { @type: "PostalAddress",
  //                         streetAddress, addressLocality, addressRegion }
  // (address may also appear directly on the root object for other schemas)
  function extractFromJsonLd() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      let data;
      try {
        data = JSON.parse(script.textContent);
      } catch {
        continue;
      }

      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        // Check root-level address and nested mainEntity.address
        const addr = item.address || (item.mainEntity && item.mainEntity.address);
        if (!addr) continue;

        const streetAddress = (addr.streetAddress || '').trim();
        const suburb        = (addr.addressLocality || '').trim();
        const city          = (addr.addressRegion   || '').trim();

        if (streetAddress) {
          return { streetAddress, suburb, city };
        }
      }
    }
    return null;
  }

  // ─── Strategy 2: __NEXT_DATA__ ────────────────────────────────────────────
  // Not used by TradeMe (Angular app), but kept for completeness.
  function extractFromNextData() {
    const script = document.getElementById('__NEXT_DATA__');
    if (!script) return null;

    let root;
    try {
      root = JSON.parse(script.textContent);
    } catch {
      return null;
    }

    function walk(node, depth) {
      if (!node || typeof node !== 'object' || depth > 8) return null;
      if (Array.isArray(node)) {
        for (const child of node) {
          const result = walk(child, depth + 1);
          if (result) return result;
        }
        return null;
      }

      const streetAddress =
        node.streetAddress || node.street || node.address1 || '';
      const suburb =
        node.suburb || node.addressLocality || node.locality || node.district || '';
      const city =
        node.city || node.addressRegion || node.region || '';

      if (streetAddress) {
        return {
          streetAddress: String(streetAddress).trim(),
          suburb:        String(suburb).trim(),
          city:          String(city).trim(),
        };
      }

      for (const value of Object.values(node)) {
        const result = walk(value, depth + 1);
        if (result) return result;
      }
      return null;
    }

    return walk(root, 0);
  }

  // ─── Strategy 3: DOM fallback ─────────────────────────────────────────────
  // TradeMe renders the full address string in an <h1> element (the `location`
  // attribute from the listing data).  e.g. "123 Main Street, Ponsonby, Auckland"
  // Additional selectors are kept for robustness.
  function extractFromDom() {
    const selectors = [
      '[data-testid*="address"]',
      '[data-testid*="Address"]',
      '[class*="property-address"]',
      '[class*="propertyAddress"]',
      '[class*="listing-address"]',
      'h1',
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const text = el.textContent.trim();
      if (!text) continue;

      // "123 Main Street, Ponsonby, Auckland" → split on comma
      const parts = text.split(',').map(p => p.trim()).filter(Boolean);
      if (parts.length >= 1) {
        return {
          streetAddress: parts[0] || '',
          suburb:        parts[1] || '',
          city:          parts[2] || '',
        };
      }
    }
    return null;
  }

  // ─── Normalize ────────────────────────────────────────────────────────────
  function normalize({ streetAddress, suburb, city }) {
    const parts = [streetAddress, suburb, city].filter(Boolean);
    return { streetAddress, suburb, city, fullAddress: parts.join(', ') };
  }

  // ─── Single extraction attempt ────────────────────────────────────────────
  function tryExtract() {
    let raw = null;
    let source = null;

    raw = extractFromJsonLd();
    if (raw) {
      source = 'JSON-LD';
    } else {
      raw = extractFromNextData();
      if (raw) {
        source = '__NEXT_DATA__';
      } else {
        raw = extractFromDom();
        if (raw) source = 'DOM';
      }
    }

    if (!raw) return null;

    const address = normalize(raw);
    console.log(LOG, `Address extracted via ${source}:`, address);
    return address;
  }

  // ─── Send address to background and log results ──────────────────────────
  function requestValuations(address) {
    chrome.runtime.sendMessage(
      { type: 'FETCH_VALUATIONS', address },
      response => {
        if (chrome.runtime.lastError) {
          console.log(LOG, 'Messaging error:', chrome.runtime.lastError.message);
          return;
        }
        if (!response?.ok) {
          console.log(LOG, 'Background returned an error response:', response);
          return;
        }
        const tag = response.fromCache ? '(cached)' : '(live)';
        console.log(LOG, `Valuations received ${tag}:`, response.results);
      }
    );
  }

  // ─── Main — poll until Angular has rendered ───────────────────────────────
  // TradeMe bootstraps Angular asynchronously; the JSON-LD script and DOM
  // content are inserted well after document_idle fires.
  const startTime = Date.now();

  function poll() {
    const address = tryExtract();
    if (address) {
      requestValuations(address);
      return;
    }

    if (Date.now() - startTime >= TIMEOUT_MS) {
      console.log(LOG, 'Address extraction timed out — Angular may not have rendered yet');
      return;
    }

    setTimeout(poll, INTERVAL_MS);
  }

  poll();

})();
