/**
 * sites/trademe.js — TradeMe adapter for NZ Property Valuator
 *
 * Sets window.NZValuatorAdapter before content.js runs (guaranteed by
 * manifest content_scripts js array order).
 *
 * Encapsulates all TradeMe-specific logic:
 *   isListingPage()   — detect individual listing pages
 *   tryExtract()      — address extraction (JSON-LD → __NEXT_DATA__ → DOM)
 *   findPanelAnchor() — preferred DOM insertion point
 */

(() => {
  'use strict';

  const LOG = '[NZ-Valuator]';

  // ─── Strategy 1: JSON-LD ──────────────────────────────────────────────────
  function extractFromJsonLd() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      let data;
      try { data = JSON.parse(script.textContent); } catch { continue; }

      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const addr = item.address || (item.mainEntity && item.mainEntity.address);
        if (!addr) continue;
        const streetAddress = (addr.streetAddress || '').trim();
        const suburb        = (addr.addressLocality || '').trim();
        const city          = (addr.addressRegion   || '').trim();
        if (streetAddress) return { streetAddress, suburb, city };
      }
    }
    return null;
  }

  // ─── Strategy 2: __NEXT_DATA__ ────────────────────────────────────────────
  function extractFromNextData() {
    const script = document.getElementById('__NEXT_DATA__');
    if (!script) return null;
    let root;
    try { root = JSON.parse(script.textContent); } catch { return null; }

    function walk(node, depth) {
      if (!node || typeof node !== 'object' || depth > 8) return null;
      if (Array.isArray(node)) {
        for (const child of node) {
          const r = walk(child, depth + 1);
          if (r) return r;
        }
        return null;
      }
      const streetAddress = node.streetAddress || node.street || node.address1 || '';
      const suburb = node.suburb || node.addressLocality || node.locality || node.district || '';
      const city   = node.city  || node.addressRegion   || node.region  || '';
      if (streetAddress) {
        return {
          streetAddress: String(streetAddress).trim(),
          suburb:        String(suburb).trim(),
          city:          String(city).trim(),
        };
      }
      for (const value of Object.values(node)) {
        const r = walk(value, depth + 1);
        if (r) return r;
      }
      return null;
    }
    return walk(root, 0);
  }

  // ─── Strategy 3: DOM fallback ─────────────────────────────────────────────
  function extractFromDom() {
    const selectors = [
      '[data-testid*="address"]', '[data-testid*="Address"]',
      '[class*="property-address"]', '[class*="propertyAddress"]',
      '[class*="listing-address"]', 'h1',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const text  = el.textContent.trim();
      if (!text) continue;
      const parts = text.split(',').map(p => p.trim()).filter(Boolean);
      if (parts.length >= 1) {
        return { streetAddress: parts[0] || '', suburb: parts[1] || '', city: parts[2] || '' };
      }
    }
    return null;
  }

  function normalize({ streetAddress, suburb, city }) {
    let street = streetAddress;
    if (suburb) {
      const esc = suburb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      street = street.replace(new RegExp('\\s+' + esc + '\\s*$', 'i'), '').trim();
    }
    const parts = [street, suburb, city].filter(Boolean);
    return { streetAddress: street, suburb, city, fullAddress: parts.join(', ') };
  }

  // TradeMe's JSON-LD uses addressLocality for the *district* (e.g. "Waitakere City"),
  // not the actual suburb. The real suburb is always in the URL:
  //   /a/property/{type}/{status}/{region}/{district}/{suburb}/listing/{id}
  function suburbFromUrl() {
    const parts      = location.pathname.split('/');
    const listingIdx = parts.indexOf('listing');
    if (listingIdx < 2) return null;
    const slug = parts[listingIdx - 1];
    if (!slug) return null;
    return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }

  window.NZValuatorAdapter = {

    isListingPage() {
      return location.pathname.includes('/listing/');
    },

    tryExtract() {
      let raw = extractFromJsonLd();
      let source = raw ? 'JSON-LD' : null;
      if (!raw) { raw = extractFromNextData(); source = raw ? '__NEXT_DATA__' : null; }
      if (!raw) { raw = extractFromDom();      source = raw ? 'DOM' : null; }
      if (!raw) return null;

      // Override suburb with the URL slug — it's usually the true suburb on TradeMe.
      const urlSuburb = suburbFromUrl();
      if (urlSuburb && urlSuburb !== raw.suburb) {
        raw = { ...raw, suburb: urlSuburb };
      }

      // When TradeMe has no distinct suburb it repeats the district slug in the URL
      // (e.g. /ashburton/ashburton/listing/...). Fall back to the DOM h1.
      const urlParts   = location.pathname.split('/');
      const listingIdx = urlParts.indexOf('listing');
      if (listingIdx >= 2 && urlParts[listingIdx - 1] === urlParts[listingIdx - 2]) {
        const domRaw = extractFromDom();
        if (domRaw?.suburb && domRaw.suburb !== raw.suburb) {
          raw = { ...raw, suburb: domRaw.suburb };
        }
      }

      const address = normalize(raw);
      return address;
    },

    findPanelAnchor() {
      // Only use highly specific anchors — broad class selectors like
      // [class*="property-header"] falsely match sidebar widgets on some listings.
      const anchors = [
        'tm-property-homes-estimate',
        '[data-testid*="homes-estimate"]',
        '[class*="homes-estimate"]',
        '[class*="HomesEstimate"]',
      ];
      for (const sel of anchors) {
        const el = document.querySelector(sel);
        if (el) return el;
      }

      // For the h1 fallback, prefer a heading inside the main content area.
      const mainEl = document.querySelector('main, article, [role="main"]');
      return mainEl ? mainEl.querySelector('h1') : document.querySelector('h1');
    },
  };
})();
