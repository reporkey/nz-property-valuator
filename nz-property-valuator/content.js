/**
 * content.js — Content script for NZ Property Valuator
 *
 * Injected into matching TradeMe property listing pages.
 * Responsible for scraping listing data and rendering the valuation panel.
 *
 * Runs at: document_idle
 * Matches:  https://www.trademe.co.nz/a/*
 */

(() => {
  'use strict';

  const LOG = '[NZ-Valuator]';

  // ─── Strategy 1: JSON-LD ───────────────────────────────────────────────────
  function extractFromJsonLd() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      let data;
      try {
        data = JSON.parse(script.textContent);
      } catch {
        continue;
      }

      // Handle both a single object and an array of objects
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const addr = item.address;
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
  function extractFromNextData() {
    const script = document.getElementById('__NEXT_DATA__');
    if (!script) return null;

    let root;
    try {
      root = JSON.parse(script.textContent);
    } catch {
      return null;
    }

    // Walk the parsed object looking for address-shaped leaves.
    // TradeMe may nest address under props.pageProps.listing or similar.
    function walk(node, depth) {
      if (!node || typeof node !== 'object' || depth > 8) return null;
      if (Array.isArray(node)) {
        for (const child of node) {
          const result = walk(child, depth + 1);
          if (result) return result;
        }
        return null;
      }

      // Look for common address key patterns
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

      // Best-effort split: "123 Main Street, Ponsonby, Auckland"
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
    const fullAddress = parts.join(', ');
    return { streetAddress, suburb, city, fullAddress };
  }

  // ─── Main ─────────────────────────────────────────────────────────────────
  function extractAddress() {
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

    if (!raw) {
      console.log(LOG, 'Address extraction failed — no strategy matched');
      return null;
    }

    const address = normalize(raw);
    console.log(LOG, `Address extracted via ${source}:`, address);
    return address;
  }

  extractAddress();

})();
