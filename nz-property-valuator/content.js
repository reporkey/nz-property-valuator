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

  // Sources displayed in the panel (homes.co.nz excluded by design).
  const SOURCES = ['OneRoof', 'PropertyValue'];

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

  // ─── Panel ────────────────────────────────────────────────────────────────

  function buildPanelHTML() {
    const cssUrl = chrome.runtime.getURL('panel.css');
    const cards  = SOURCES.map(name => `
      <div class="nzvp-card" id="nzvp-card-${name}">
        <div class="nzvp-source-name">${name}</div>
        <div class="nzvp-estimate"><span class="nzvp-spinner"></span></div>
        <a class="nzvp-link" href="#" target="_blank" rel="noopener noreferrer" hidden>
          View on ${name} →
        </a>
      </div>`).join('');

    return `
      <link rel="stylesheet" href="${cssUrl}">
      <div class="nzvp-panel">
        <header class="nzvp-header" id="nzvp-header">
          <span class="nzvp-title">🏠 Property Valuations</span>
          <button class="nzvp-toggle" aria-expanded="true" aria-label="Toggle panel">▾</button>
        </header>
        <div class="nzvp-body" id="nzvp-body">
          <div class="nzvp-cards">${cards}</div>
        </div>
        <footer class="nzvp-footer">Powered by NZ Property Valuator</footer>
      </div>`;
  }

  // Returns the shadow root (creating the host element and inserting it into
  // the page if it doesn't already exist).
  function injectPanel() {
    const existing = document.getElementById('nz-valuator-host');
    if (existing) return existing.shadowRoot;

    const host   = document.createElement('div');
    host.id      = 'nz-valuator-host';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = buildPanelHTML();

    // ── Collapse / expand toggle ────────────────────────────────────────────
    const header = shadow.getElementById('nzvp-header');
    const toggle = shadow.querySelector('.nzvp-toggle');
    const body   = shadow.getElementById('nzvp-body');
    header.addEventListener('click', () => {
      const collapsed = body.classList.toggle('nzvp-hidden');
      toggle.classList.toggle('nzvp-collapsed', collapsed);
      toggle.setAttribute('aria-expanded', String(!collapsed));
    });

    // ── Find insertion point ────────────────────────────────────────────────
    // Prefer known TradeMe structural elements; fall back to h1 or page top.
    const anchorSelectors = [
      'tm-property-homes-estimate',       // HomesEstimate Angular component
      '[data-testid*="homes"]',
      '[class*="homes-estimate"]',
      '[class*="HomesEstimate"]',
      '[class*="listing-header"]',
      '[class*="property-header"]',
    ];

    let inserted = false;
    for (const sel of anchorSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        el.insertAdjacentElement('afterend', host);
        inserted = true;
        break;
      }
    }

    if (!inserted) {
      const h1 = document.querySelector('h1');
      if (h1) {
        h1.insertAdjacentElement('afterend', host);
      } else {
        const main = document.querySelector('main') || document.body;
        main.insertAdjacentElement('afterbegin', host);
      }
    }

    return shadow;
  }

  // ─── Card state updater ───────────────────────────────────────────────────

  // Sets one card to LOADING (result = null), SUCCESS, NOT_FOUND, or ERROR.
  function setCardState(shadow, sourceName, result) {
    const card = shadow.getElementById(`nzvp-card-${sourceName}`);
    if (!card) return;

    const estimateEl = card.querySelector('.nzvp-estimate');
    const linkEl     = card.querySelector('.nzvp-link');
    card.querySelector('.nzvp-retry')?.remove();

    if (!result) {
      // LOADING
      estimateEl.className = 'nzvp-estimate';
      estimateEl.innerHTML  = '<span class="nzvp-spinner"></span>';
      linkEl.hidden = true;
      return;
    }

    if (result.estimate) {
      // SUCCESS
      estimateEl.className  = 'nzvp-estimate nzvp-success';
      estimateEl.textContent = result.estimate;
      if (result.url) {
        linkEl.href   = result.url;
        linkEl.hidden = false;
      }
    } else if (!result.error || /not found|not available/i.test(result.error)) {
      // NOT_FOUND
      estimateEl.className  = 'nzvp-estimate nzvp-not-found';
      estimateEl.textContent = 'No estimate';
      linkEl.hidden = true;
    } else {
      // ERROR
      estimateEl.className  = 'nzvp-estimate nzvp-error-state';
      estimateEl.textContent = 'Failed to load';
      linkEl.hidden = true;
    }
  }

  // Applies a full results array to all cards, then attaches retry buttons
  // to any card that ended up in the ERROR state.
  function applyResults(shadow, results, address) {
    // Remove stale retry buttons before re-evaluating states.
    shadow.querySelectorAll('.nzvp-retry').forEach(btn => btn.remove());

    for (const result of results) {
      if (SOURCES.includes(result.source)) {
        setCardState(shadow, result.source, result);
      }
    }

    // Attach retry buttons to error cards.
    for (const sourceName of SOURCES) {
      const card = shadow.getElementById(`nzvp-card-${sourceName}`);
      if (!card) continue;
      const estimateEl = card.querySelector('.nzvp-estimate');
      if (!estimateEl.classList.contains('nzvp-error-state')) continue;

      const retryBtn = document.createElement('button');
      retryBtn.className   = 'nzvp-retry';
      retryBtn.textContent = 'Retry';
      retryBtn.addEventListener('click', () => {
        setCardState(shadow, sourceName, null); // show spinner on this card
        requestValuations(address, shadow);
      });
      card.appendChild(retryBtn);
    }
  }

  // ─── Background messaging ─────────────────────────────────────────────────

  function requestValuations(address, shadow) {
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
        if (shadow) applyResults(shadow, response.results, address);
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
      const shadow = injectPanel();   // show panel with spinners immediately
      requestValuations(address, shadow);
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
