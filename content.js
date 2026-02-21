/**
 * content.js — Content script for NZ Property Valuator
 *
 * Injected after a site adapter (e.g. sites/trademe.js) which sets
 * window.NZValuatorAdapter before this file runs.
 *
 * Responsible for rendering the valuation panel and requesting estimates
 * from background.js via chrome.runtime messaging.
 *
 * Site-specific logic (address extraction, listing-page detection,
 * panel anchor selection) lives entirely in the adapter.
 *
 * Runs at: document_idle
 */

(() => {
  'use strict';

  const LOG         = '[NZ-Valuator]';
  const TIMEOUT_MS  = 10_000;   // give up address extraction after 10 s
  const INTERVAL_MS = 300;      // poll every 300 ms

  // Sources shown in the panel (fetched via background.js).
  const SOURCES = ['OneRoof', 'homes.co.nz', 'PropertyValue', 'RealEstate.co.nz'];

  // Shorter display names used in link labels.
  const LINK_NAME = { 'homes.co.nz': 'homes', 'RealEstate.co.nz': 'RealEstate' };
  function linkName(source) { return LINK_NAME[source] || source; }

  // ─── Module state ─────────────────────────────────────────────────────────
  let currentShadow  = null;   // shadow root of the active panel
  let currentAddress = null;   // last address passed to requestValuations
  let pollTimer      = null;   // setTimeout handle for the active poll cycle
  let pollStart      = 0;      // Date.now() when the current poll cycle began
  let panelObserver  = null;   // MutationObserver watching for panel removal

  // ─── Search URL builder ───────────────────────────────────────────────────
  // Returns a URL the user can visit to manually search for the property on
  // the given source.  Used when a source returns "Not found" so we can still
  // show a useful fallback link.

  function buildSearchUrl(sourceName, address) {
    function slugify(s) { return (s || '').toLowerCase().replace(/\s+/g, '-'); }

    switch (sourceName) {
      case 'OneRoof':
        // No URL-based pre-fill (needs numeric location ID); link to estimate map.
        return 'https://www.oneroof.co.nz/estimate/map/region_all-new-zealand-1';

      case 'homes.co.nz': {
        // Verified URL pattern: /map/{city}/{suburb}/{street}
        const city   = slugify(address.city);
        const suburb = slugify(address.suburb);
        // Strip leading house number ("20 Charlotte Street" → "charlotte-street")
        const street = slugify((address.streetAddress || '').replace(/^\d+\w*\s+/, ''));
        if (city && suburb && street)
          return `https://homes.co.nz/map/${city}/${suburb}/${street}`;
        if (city && suburb)
          return `https://homes.co.nz/map/${city}/${suburb}`;
        return 'https://homes.co.nz/';
      }

      case 'PropertyValue':
        // No search results page; autocomplete navigates directly to property page.
        return 'https://www.propertyvalue.co.nz/';

      case 'RealEstate.co.nz': {
        // Verified URL pattern: /residential/sale/{region}/{district}/{suburb}
        // Use address components so this works on all host sites (not just TradeMe).
        const suburb = slugify(address.suburb);
        const city   = slugify(address.city);
        if (suburb && city)
          return `https://www.realestate.co.nz/residential/sale/all/${city}/${suburb}`;
        return 'https://www.realestate.co.nz/residential/sale/';
      }

      default:
        return null;
    }
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
        <div class="nzvp-body" id="nzvp-body">
          <div class="nzvp-cards" id="nzvp-cards">
            ${SOURCES.map(buildCardHTML).join('')}
          </div>
        </div>
        <footer class="nzvp-footer">Powered by NZ Property Valuator</footer>
      </div>`;
  }

  // ─── Panel injection ──────────────────────────────────────────────────────
  // Inserts at document.body.prepend immediately so the user sees the panel
  // in loading state right away.  relocatePanel() moves it once the page
  // has rendered the preferred anchor element.

  function injectPanel() {
    const existing = document.getElementById('nz-valuator-host');
    if (existing) return existing.shadowRoot;

    const host   = document.createElement('div');
    host.id      = 'nz-valuator-host';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = buildPanelHTML();

    document.body.prepend(host);
    return shadow;
  }

  // Move the panel to the adapter's preferred anchor, if one is found.
  function relocatePanel() {
    const host = document.getElementById('nz-valuator-host');
    if (!host) return;

    const anchor = window.NZValuatorAdapter.findPanelAnchor();
    if (anchor) anchor.insertAdjacentElement('afterend', host);
    // else leave at body.prepend position
  }

  // ─── Panel state helpers ──────────────────────────────────────────────────

  // Replace the cards grid with a "could not detect" message + manual input.
  function showNoAddressState(shadow) {
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
  function setCardState(shadow, sourceName, result, address = null) {
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
      estimateEl.className   = 'nzvp-estimate nzvp-success';
      estimateEl.textContent = result.estimate;
      if (result.url) {
        linkEl.href        = result.url;
        linkEl.textContent = `View on ${linkName(sourceName)} \u2192`;
        linkEl.hidden      = false;
      } else { linkEl.hidden = true; }
    } else if (result.disabled || !result.error || /address not found/i.test(result.error)) {
      estimateEl.className   = 'nzvp-estimate nzvp-not-found';
      estimateEl.textContent = result.disabled ? 'No estimate' : 'Not found';
      if (!result.disabled && address) {
        const sUrl = buildSearchUrl(sourceName, address);
        if (sUrl) {
          linkEl.href        = sUrl;
          linkEl.textContent = `Search on ${linkName(sourceName)} \u2192`;
          linkEl.hidden      = false;
        } else { linkEl.hidden = true; }
      } else { linkEl.hidden = true; }
    } else if (/no estimate|not available/i.test(result.error)) {
      estimateEl.className   = 'nzvp-estimate nzvp-no-estimate';
      estimateEl.textContent = 'No estimate';
      if (result.url) {
        linkEl.href        = result.url;
        linkEl.textContent = `View on ${linkName(sourceName)} \u2192`;
        linkEl.hidden      = false;
      } else { linkEl.hidden = true; }
    } else {
      estimateEl.className   = 'nzvp-estimate nzvp-error-state';
      estimateEl.textContent = 'Failed to load';
      linkEl.hidden          = true;
    }
  }

  // Apply a full results array; wire retry buttons; detect all-sources-failed.
  function applyResults(shadow, results, address) {
    // Remove stale retry buttons and the all-failed banner before re-evaluating.
    shadow.querySelectorAll('.nzvp-retry').forEach(btn => btn.remove());
    shadow.querySelector('.nzvp-all-failed')?.remove();

    for (const result of results) {
      if (SOURCES.includes(result.source)) setCardState(shadow, result.source, result, address);
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
        setCardState(shadow, sourceName, null, address);
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
    if (SOURCES.includes(result.source)) setCardState(currentShadow, result.source, result, currentAddress);
  });

  function requestValuations(address) {
    currentAddress = address;
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
    const address = window.NZValuatorAdapter.tryExtract();
    if (address) {
      relocatePanel();
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
  // Next.js and Angular both use pushState routing.  Patch history.pushState /
  // replaceState and listen for popstate so we restart on every navigation.

  let lastUrl = location.href;

  function handleNavigation() {
    if (location.href === lastUrl) return; // replaceState with the same URL
    lastUrl = location.href;

    console.log(LOG, 'SPA navigation detected, restarting:', location.href);

    // Tear down the old panel and observer — we may have navigated away.
    stopPanelObserver();
    document.getElementById('nz-valuator-host')?.remove();
    currentShadow = null;
    currentAddress = null;

    if (!window.NZValuatorAdapter.isListingPage()) return;

    // Start fresh — inject panel with loading state, then re-poll.
    currentShadow = injectPanel();
    startPanelObserver();
    startPolling();
  }

  ['pushState', 'replaceState'].forEach(method => {
    const original = history[method].bind(history);
    history[method] = (...args) => { original(...args); handleNavigation(); };
  });
  window.addEventListener('popstate', handleNavigation);

  // ─── Panel survival observer ───────────────────────────────────────────────
  // Some SPA frameworks (e.g. Ember.js on realestate.co.nz) do a full DOM
  // replacement after their initial render, wiping any element prepended to
  // document.body.  Watch for the host being removed and re-inject it.

  function startPanelObserver() {
    if (panelObserver) return;
    panelObserver = new MutationObserver(() => {
      if (document.getElementById('nz-valuator-host')) return; // still in DOM
      if (!window.NZValuatorAdapter.isListingPage()) { stopPanelObserver(); return; }

      console.log(LOG, 'Panel removed by framework — re-injecting');
      currentShadow = injectPanel();

      if (currentAddress) {
        // Results may be cached; request again (fast cache hit) and try to
        // relocate once the framework has finished rendering the anchor element.
        requestValuations(currentAddress);
        setTimeout(relocatePanel, 500);
      } else {
        startPolling();
      }
    });
    panelObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  function stopPanelObserver() {
    if (panelObserver) { panelObserver.disconnect(); panelObserver = null; }
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  window.addEventListener('beforeunload', () => {
    if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; }
    stopPanelObserver();
  });

  // ─── Bootstrap ────────────────────────────────────────────────────────────
  // Show the panel immediately in loading state so the user knows the
  // extension is active, even before the page has rendered listing data.
  // Only activate on individual listing pages, not search/browse pages.

  if (window.NZValuatorAdapter.isListingPage()) {
    currentShadow = injectPanel();
    startPanelObserver();
    startPolling();
  }

})();
