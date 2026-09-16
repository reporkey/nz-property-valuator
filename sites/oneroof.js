/**
 * sites/oneroof.js — OneRoof adapter for NZ Property Valuator
 *
 * Sets window.NZValuatorAdapter before content.js runs.
 *
 * URL: oneroof.co.nz/property/{region}/{suburb}/{address-slug}/{property-id}
 *   e.g. /property/auckland/remuera/10-mahoe-avenue/qeHJ8
 *
 * Address extraction:
 *   1. JSON-LD (present on some pages; provides structured locality data)
 *   2. URL slug (always available at document_idle — no polling delay)
 */

(() => {
  'use strict';

  // ─── JSON-LD extraction ───────────────────────────────────────────────────
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

  // ─── URL slug extraction ──────────────────────────────────────────────────
  // OneRoof encodes the full address directly in its URL slug:
  //   /property/{region}/{suburb}/{address-slug}/{property-id}
  //   e.g. /property/auckland/mount-eden/93-halesowen-avenue/jlvQp
  //
  // This is always available at document_idle so tryExtract() succeeds on the
  // first poll with no waiting — no need for a timeout or retry cycle.
  function extractFromUrl() {
    const parts = location.pathname.split('/').filter(Boolean);
    // Need at least: property / region / suburb / address-slug
    if (parts[0] !== 'property' || parts.length < 4) return null;

    const regionSlug  = parts[1]; // e.g. "auckland"
    const suburbSlug  = parts[2]; // e.g. "remuera", "mount-eden"
    const addressSlug = parts[3]; // e.g. "10-mahoe-avenue", "93-halesowen-avenue"

    // Kebab slug → title case: "mount-eden" → "Mount Eden"
    function titleCase(slug) {
      return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }

    const streetAddress = titleCase(addressSlug);
    // Sanity check: must begin with a house number
    if (!/^\d/.test(streetAddress)) return null;

    return {
      streetAddress,
      suburb: titleCase(suburbSlug),  // "Remuera", "Mount Eden"
      city:   titleCase(regionSlug),  // "Auckland", "Wellington"
    };
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

  window.NZValuatorAdapter = {

    findPanelAnchor() {
      return document.querySelector('main h1, article h1, h1');
    },

    isListingPage() {
      // Must have: property / region / suburb / address-slug [/ property-id]
      const parts = location.pathname.split('/').filter(Boolean);
      // OneRoof uses the same URL shape for sale, rental and off-market records.
      // Require the listing's sale title AND its main-content sale breadcrumb;
      // a sale link in global navigation is not evidence about this property.
      return location.hostname === 'www.oneroof.co.nz' &&
        parts[0] === 'property' && parts.length === 5 &&
        /\|\s*Houses for Sale\s*-\s*OneRoof$/i.test(document.title) &&
        [...document.querySelectorAll('main a[href^="/search/houses-for-sale/"]')]
          .some(link => /^for sale$/i.test(link.textContent.trim()));
    },

    tryExtract() {
      // Strategy 1: JSON-LD — richer locality data if present.
      const jsonLd = extractFromJsonLd();
      if (jsonLd && jsonLd.streetAddress) {
        const address = { ...normalize(jsonLd), oneRoofUrl: location.href };
        return address;
      }

      // Strategy 2: URL slug — always available, no rendering required.
      const fromUrl = extractFromUrl();
      if (fromUrl) {
        const address = { ...normalize(fromUrl), oneRoofUrl: location.href };
        return address;
      }

      return null;
    },

  };
})();
