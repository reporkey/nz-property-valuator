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

  const LOG         = '[NZ-Valuator]';
  const TIMEOUT_MS  = 10_000;   // give up address extraction after 10 s
  const INTERVAL_MS = 300;      // poll every 300 ms

  // Sources shown in the panel (fetched via background.js).
  const SOURCES = ['OneRoof', 'homes.co.nz', 'PropertyValue', 'RealEstate.co.nz'];

  // ─── Module state ─────────────────────────────────────────────────────────
  let currentShadow = null;   // shadow root of the active panel
  let pollTimer     = null;   // setTimeout handle for the active poll cycle
  let pollStart     = 0;      // Date.now() when the current poll cycle began

  // ─── Strategy 1: JSON-LD ──────────────────────────────────────────────────
  // TradeMe injects a <script type="application/ld+json"> with:
  //   @type: "RealEstateListing"
  //   mainEntity.address: { @type: "PostalAddress",
  //                         streetAddress, addressLocality, addressRegion }
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
  // Not used by TradeMe (Angular app), kept for completeness.
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
  // TradeMe renders the full address in an <h1>.
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
    // TradeMe sometimes appends the suburb to the streetAddress field in JSON-LD,
    // e.g. "865 Waikaretu Valley Road Tuakau" when suburb = "Tuakau".
    // Strip it so it doesn't duplicate in fullAddress and corrupt search queries.
    let street = streetAddress;
    if (suburb) {
      const esc = suburb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      street = street.replace(new RegExp('\\s+' + esc + '\\s*$', 'i'), '').trim();
    }
    const parts = [street, suburb, city].filter(Boolean);
    return { streetAddress: street, suburb, city, fullAddress: parts.join(', ') };
  }

  // TradeMe's JSON-LD uses addressLocality for the *district* (e.g. "Waitakere City"),
  // not the actual suburb (e.g. "Sunnyvale").  The real suburb is always in the URL:
  //   /a/property/{type}/{status}/{region}/{district}/{suburb}/listing/{id}
  // Extracting it from the slug is more reliable than any DOM heuristic.
  function suburbFromUrl() {
    const parts      = location.pathname.split('/');
    const listingIdx = parts.indexOf('listing');
    if (listingIdx < 2) return null;
    const slug = parts[listingIdx - 1];
    if (!slug) return null;
    // "waitakere-city" → "Waitakere City", "st-heliers" → "St Heliers"
    return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }

  function tryExtract() {
    let raw = extractFromJsonLd();
    let source = raw ? 'JSON-LD' : null;
    if (!raw) { raw = extractFromNextData(); source = raw ? '__NEXT_DATA__' : null; }
    if (!raw) { raw = extractFromDom();      source = raw ? 'DOM' : null; }
    if (!raw) return null;

    // Override suburb with the URL slug — it's always the true suburb on TradeMe.
    const urlSuburb = suburbFromUrl();
    if (urlSuburb && urlSuburb !== raw.suburb) {
      console.log(LOG, `Suburb corrected from URL: "${raw.suburb}" → "${urlSuburb}"`);
      raw = { ...raw, suburb: urlSuburb };
    }

    const address = normalize(raw);
    console.log(LOG, `Address extracted via ${source}:`, address);
    return address;
  }

  // ─── Panel HTML helpers ───────────────────────────────────────────────────

  function buildCardHTML(name) {
    return `
      <div class="nzvp-card" id="nzvp-card-${name}">
        <div class="nzvp-source-name">${name}</div>
        <div class="nzvp-estimate"><span class="nzvp-spinner"></span></div>
        <a class="nzvp-link" href="#" target="_blank" rel="noopener noreferrer" hidden>
          View on ${name} →
        </a>
      </div>`;
  }

  function buildPanelHTML() {
    const cssUrl = chrome.runtime.getURL('panel.css');
    return `
      <link rel="stylesheet" href="${cssUrl}">
      <div class="nzvp-panel">
        <header class="nzvp-header" id="nzvp-header">
          <div class="nzvp-header-text">
            <span class="nzvp-title">🏠 Property Valuations</span>
            <span class="nzvp-subtitle" id="nzvp-subtitle">Detecting address…</span>
          </div>
          <button class="nzvp-toggle" aria-expanded="true" aria-label="Toggle panel">▾</button>
        </header>
        <div class="nzvp-body" id="nzvp-body">
          <div class="nzvp-cards" id="nzvp-cards">
            ${SOURCES.map(buildCardHTML).join('')}
          </div>
        </div>
        <footer class="nzvp-footer">Powered by NZ Property Valuator</footer>
      </div>`;
  }

  // ─── Panel injection ──────────────────────────────────────────────────────
  // Inserts at document.body.prepend immediately (before Angular renders) so
  // the user sees the panel in loading state right away.  relocatePanel()
  // moves it to a better position once Angular has rendered the property page.

  function injectPanel() {
    const existing = document.getElementById('nz-valuator-host');
    if (existing) return existing.shadowRoot;

    const host   = document.createElement('div');
    host.id      = 'nz-valuator-host';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = buildPanelHTML();

    // Collapse / expand toggle
    const header = shadow.getElementById('nzvp-header');
    const toggle = shadow.querySelector('.nzvp-toggle');
    const body   = shadow.getElementById('nzvp-body');
    header.addEventListener('click', () => {
      const collapsed = body.classList.toggle('nzvp-hidden');
      toggle.classList.toggle('nzvp-collapsed', collapsed);
      toggle.setAttribute('aria-expanded', String(!collapsed));
    });

    document.body.prepend(host);
    return shadow;
  }

  // Move the panel to a better location once Angular has rendered the page.
  function relocatePanel() {
    const host = document.getElementById('nz-valuator-host');
    if (!host) return;

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
      if (el) { el.insertAdjacentElement('afterend', host); return; }
    }

    // For the h1 fallback, prefer a heading inside the main content area
    // so we don't accidentally land in the agent sidebar.
    const mainEl = document.querySelector('main, article, [role="main"]');
    const h1     = mainEl ? mainEl.querySelector('h1') : document.querySelector('h1');
    if (h1) h1.insertAdjacentElement('afterend', host);
    // else leave at body.prepend position
  }

  // ─── Panel state helpers ──────────────────────────────────────────────────

  function setSubtitle(shadow, text) {
    const sub = shadow.getElementById('nzvp-subtitle');
    if (!sub) return;
    if (text) { sub.textContent = text; sub.hidden = false; }
    else      { sub.hidden = true; }
  }

  // Replace the cards grid with a "could not detect" message + manual input.
  function showNoAddressState(shadow) {
    setSubtitle(shadow, null);
    const cardsEl = shadow.getElementById('nzvp-cards');
    if (!cardsEl) return;

    cardsEl.innerHTML = `
      <div class="nzvp-no-address">
        <p class="nzvp-no-addr-msg">Could not detect property address.</p>
        <div class="nzvp-manual-input">
          <input class="nzvp-addr-input" type="text"
                 placeholder="e.g. 10 Mahoe Ave, Remuera, Auckland"
                 aria-label="Property address">
          <button class="nzvp-search-btn">Search</button>
        </div>
      </div>`;

    const input = cardsEl.querySelector('.nzvp-addr-input');
    const btn   = cardsEl.querySelector('.nzvp-search-btn');

    function doSearch() {
      const text = input.value.trim();
      if (!text) return;
      cardsEl.innerHTML = SOURCES.map(buildCardHTML).join('');
      const address = { streetAddress: text, suburb: '', city: '', fullAddress: text };
      requestValuations(address);
    }

    btn.addEventListener('click', doSearch);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  }

  // Prepend an "all failed" banner inside the panel body.
  function showAllFailedState(shadow, address) {
    const body = shadow.getElementById('nzvp-body');
    if (!body) return;
    body.querySelector('.nzvp-all-failed')?.remove();

    const banner = document.createElement('div');
    banner.className = 'nzvp-all-failed';
    banner.innerHTML = `
      <span>Unable to fetch valuations. Check your internet connection.</span>
      <button class="nzvp-retry-all">Retry all</button>`;

    banner.querySelector('.nzvp-retry-all').addEventListener('click', () => {
      banner.remove();
      for (const source of SOURCES) setCardState(shadow, source, null);
      requestValuations(address);
    });

    body.prepend(banner);
  }

  // ─── Card state ───────────────────────────────────────────────────────────

  // result = null  → LOADING (spinner)
  // result.estimate → SUCCESS (green)
  // result.error matches /not found|not available/  → NOT_FOUND (grey)
  // result.error (other) → ERROR (orange)
  function setCardState(shadow, sourceName, result) {
    const card = shadow.getElementById(`nzvp-card-${sourceName}`);
    if (!card) return;

    const estimateEl = card.querySelector('.nzvp-estimate');
    const linkEl     = card.querySelector('.nzvp-link');
    card.querySelector('.nzvp-retry')?.remove();

    if (!result) {
      estimateEl.className  = 'nzvp-estimate';
      estimateEl.innerHTML  = '<span class="nzvp-spinner"></span>';
      linkEl.hidden = true;
      return;
    }

    if (result.estimate) {
      estimateEl.className  = 'nzvp-estimate nzvp-success';
      estimateEl.textContent = result.estimate;
      if (result.url) { linkEl.href = result.url; linkEl.hidden = false; }
    } else if (!result.error || /not found|not available|no estimate/i.test(result.error)) {
      estimateEl.className  = 'nzvp-estimate nzvp-not-found';
      estimateEl.textContent = 'No estimate';
      linkEl.hidden = true;
    } else {
      estimateEl.className  = 'nzvp-estimate nzvp-error-state';
      estimateEl.textContent = 'Failed to load';
      linkEl.hidden = true;
    }
  }

  // Apply a full results array; wire retry buttons; detect all-sources-failed.
  function applyResults(shadow, results, address) {
    // Remove stale retry buttons and the all-failed banner before re-evaluating.
    shadow.querySelectorAll('.nzvp-retry').forEach(btn => btn.remove());
    shadow.querySelector('.nzvp-all-failed')?.remove();

    for (const result of results) {
      if (SOURCES.includes(result.source)) setCardState(shadow, result.source, result);
    }

    // If every displayed source is in the error state, show the all-failed banner.
    const allFailed = SOURCES.every(source =>
      shadow.getElementById(`nzvp-card-${source}`)
            ?.querySelector('.nzvp-estimate')
            ?.classList.contains('nzvp-error-state')
    );

    if (allFailed) {
      showAllFailedState(shadow, address);
      return; // no per-card retry buttons alongside the all-failed banner
    }

    // Per-card retry buttons for individual errors.
    for (const sourceName of SOURCES) {
      const card = shadow.getElementById(`nzvp-card-${sourceName}`);
      if (!card) continue;
      const estimateEl = card.querySelector('.nzvp-estimate');
      if (!estimateEl.classList.contains('nzvp-error-state')) continue;

      const retryBtn = document.createElement('button');
      retryBtn.className   = 'nzvp-retry';
      retryBtn.textContent = 'Retry';
      retryBtn.addEventListener('click', () => {
        setCardState(shadow, sourceName, null);
        requestValuations(address);
      });
      card.appendChild(retryBtn);
    }
  }

  // ─── Messaging ────────────────────────────────────────────────────────────

  // Receive incremental VALUATION_UPDATE messages streamed from background.js
  // as each source resolves, so cards update as data arrives.
  chrome.runtime.onMessage.addListener(message => {
    if (message.type !== 'VALUATION_UPDATE') return;
    if (!currentShadow) return;
    const { result } = message;
    if (SOURCES.includes(result.source)) setCardState(currentShadow, result.source, result);
  });

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
        if (currentShadow) applyResults(currentShadow, response.results, address);
      }
    );
  }

  // ─── Polling ──────────────────────────────────────────────────────────────

  function startPolling() {
    if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; }
    pollStart = Date.now();
    schedulePoll();
  }

  function schedulePoll() {
    pollTimer = setTimeout(doPoll, INTERVAL_MS);
  }

  function doPoll() {
    pollTimer = null;
    const address = tryExtract();
    if (address) {
      relocatePanel();
      setSubtitle(currentShadow, null);     // hide "Detecting address…"
      requestValuations(address);
      return;
    }
    if (Date.now() - pollStart >= TIMEOUT_MS) {
      console.log(LOG, 'Address extraction timed out — showing manual input');
      showNoAddressState(currentShadow);
      return;
    }
    schedulePoll();
  }

  // ─── SPA navigation ───────────────────────────────────────────────────────
  // TradeMe uses Angular's pushState router.  Patch history.pushState /
  // replaceState and listen for popstate so we restart on every navigation.

  let lastUrl = location.href;

  function handleNavigation() {
    if (location.href === lastUrl) return; // replaceState with the same URL
    lastUrl = location.href;

    console.log(LOG, 'SPA navigation detected, restarting:', location.href);

    // Tear down the old panel.
    document.getElementById('nz-valuator-host')?.remove();
    currentShadow = null;

    // Start fresh — inject panel with loading state, then re-poll.
    currentShadow = injectPanel();
    setSubtitle(currentShadow, 'Detecting address…');
    startPolling();
  }

  ['pushState', 'replaceState'].forEach(method => {
    const original = history[method].bind(history);
    history[method] = (...args) => { original(...args); handleNavigation(); };
  });
  window.addEventListener('popstate', handleNavigation);

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  window.addEventListener('beforeunload', () => {
    if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; }
  });

  // ─── Bootstrap ────────────────────────────────────────────────────────────
  // Show the panel immediately in loading state so the user knows the
  // extension is active, even before Angular has rendered the listing data.

  currentShadow = injectPanel();
  setSubtitle(currentShadow, 'Detecting address…');
  startPolling();

})();
