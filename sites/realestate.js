/**
 * sites/realestate.js — RealEstate.co.nz adapter for NZ Property Valuator
 *
 * Sets window.NZValuatorAdapter before content.js runs.
 *
 * URL pattern: realestate.co.nz/{listing-id}/residential/{type}/{slug}
 *   e.g. /42987162/residential/sale/2-91-princes-street-northcote-point
 *
 * The listing ID is the FIRST path segment (numeric, ≥6 digits).
 * Search/browse pages start with "residential" directly and are excluded.
 *
 * Address extraction:
 *   1. JSON-LD (SingleFamilyResidence — always present, confirmed live)
 *      streetAddress has suburb appended: "10 Pukehina Parade, Pukehina"
 *      → split on first comma to isolate the street portion
 *   2. h1 text (DOM fallback — comma-separated: street, suburb, region)
 *
 * Panel anchor: the h1's enclosing section block (div.border-b), placing
 * the panel between the address heading and the price row.
 */

(() => {
  'use strict';

  // ─── JSON-LD extraction ───────────────────────────────────────────────────
  // RealEstate.co.nz always injects a SingleFamilyResidence JSON-LD block.
  // streetAddress includes the suburb after a comma:
  //   "2/91 Princes Street, Northcote Point"
  // Split on the first comma to get the clean street address.
  function extractFromJsonLd() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      let data;
      try { data = JSON.parse(script.textContent); } catch { continue; }
      const addr = data.address;
      if (!addr) continue;
      // First comma separates street from appended suburb
      const streetAddress = (addr.streetAddress || '').split(',')[0].trim();
      const suburb        = (addr.addressLocality || '').trim();
      const city          = (addr.addressRegion   || '').trim();
      if (streetAddress && /^\d/.test(streetAddress)) return { streetAddress, suburb, city };
    }
    return null;
  }

  // ─── DOM fallback ─────────────────────────────────────────────────────────
  // The h1 text is "street, suburb, region" — same order as fullAddress.
  function extractFromDom() {
    const h1 = document.querySelector('h1');
    if (!h1) return null;
    const parts = h1.textContent.trim().split(',').map(p => p.trim()).filter(Boolean);
    if (!parts[0] || !/^\d/.test(parts[0])) return null;
    return {
      streetAddress: parts[0],
      suburb:        parts[1] || '',
      city:          parts[2] || '',
    };
  }

  function normalize({ streetAddress, suburb, city }) {
    const parts = [streetAddress, suburb, city].filter(Boolean);
    return { streetAddress, suburb, city, fullAddress: parts.join(', ') };
  }

  window.NZValuatorAdapter = {

    isListingPage() {
      // Listing URLs: /{numeric-id}/residential/{type}/{slug}
      // Browse/search: /residential/sale/auckland (first segment is "residential")
      const parts = location.pathname.split('/').filter(Boolean);
      return /^\d{6,}$/.test(parts[0]) && parts[1] === 'residential';
    },

    tryExtract() {
      // Strategy 1: JSON-LD — present at document_idle, no polling needed.
      const jsonLd = extractFromJsonLd();
      if (jsonLd) {
        const address = normalize(jsonLd);
        return address;
      }

      // Strategy 2: h1 text — rendered by Ember.js, may not be present yet.
      const dom = extractFromDom();
      if (dom) {
        const address = normalize(dom);
        return address;
      }

      return null;
    },

    findPanelAnchor() {
      // h1 → flex wrapper → border-b section block (address heading).
      // Inserting after the section block places the panel between the
      // address heading and the price row.
      const h1 = document.querySelector('h1');
      return h1?.parentElement?.parentElement ?? h1 ?? null;
    },
  };
})();
