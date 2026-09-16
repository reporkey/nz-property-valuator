/**
 * content.js — Content script for NZ Property Valuator
 *
 * Injected after a site adapter (e.g. sites/trademe.js) which sets
 * window.NZValuatorAdapter before this file runs.
 *
 * Responsible for rendering the valuation panel and requesting estimates
 * from background.js via chrome.runtime messaging.
 *
 * Site-specific address extraction and sale-listing detection live in the adapter.
 * The panel is embedded only after its insertion area is ready for DOM changes.
 *
 * Runs at: document_idle
 */

(() => {
  'use strict';

  const LOG         = '[NZ-Valuator]';
  const INTERVAL_MS = 300;      // poll every 300 ms

  // Sources shown in the panel (fetched via background.js).
  const SOURCES = ['OneRoof', 'homes.co.nz', 'RealEstate.co.nz'];

  // Shorter display names used in link labels.
  const LINK_NAME = { 'homes.co.nz': 'homes', 'RealEstate.co.nz': 'RealEstate' };
  function linkName(source) { return LINK_NAME[source] || source; }

  // ─── Module state ─────────────────────────────────────────────────────────
  let currentShadow  = null;   // shadow root of the active panel
  let currentAddress = null;   // last address passed to requestValuations
  let activeRequest = null;
  let pageKey = null;
  let activated = false;

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
      <div class="nzvp-panel" role="region" aria-label="Property valuations">
        <button class="nzvp-toggle" aria-expanded="true" aria-controls="nzvp-body">
          <span id="nzvp-address">Property valuations</span>
          <span class="nzvp-toggle-label">Hide estimates</span>
        </button>
        <div class="nzvp-body" id="nzvp-body">
          <div class="nzvp-cards" id="nzvp-cards">
            ${SOURCES.map(buildCardHTML).join('')}
          </div>
        </div>
        <footer class="nzvp-footer">Powered by NZ Property Valuator</footer>
      </div>`;
  }

  // Do not alter server-rendered nodes while the page is still loading or
  // Angular has unclaimed hydration markers in the insertion area.
  function panelAnchor() {
    if (document.readyState !== 'complete') return null;
    const anchor = window.NZValuatorAdapter.findPanelAnchor();
    if (!anchor?.isConnected || !anchor.parentElement) return null;
    if (anchor.closest('[ngh]') || anchor.parentElement.querySelector('[ngh]')) return null;
    return anchor;
  }

  function injectPanel(anchor) {
    const host = document.createElement('div');
    host.id = 'nz-valuator-host';
    host.style.cssText = 'display:block;position:static;clear:both;width:100%;margin:16px 0 20px;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = buildPanelHTML();
    const toggle = shadow.querySelector('.nzvp-toggle');
    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(expanded));
      shadow.getElementById('nzvp-body').hidden = !expanded;
      shadow.querySelector('.nzvp-toggle-label').textContent = expanded ? 'Hide estimates' : 'Show estimates';
    });
    anchor.insertAdjacentElement('afterend', host);
    return shadow;
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
      estimateEl.textContent = /blocked/i.test(result.error) ? 'Access blocked by provider' : 'Failed to load';
      estimateEl.title = result.error;
      linkEl.hidden = !result.url;
      if (result.url) {
        linkEl.href = result.url;
        linkEl.textContent = `Open ${linkName(sourceName)} →`;
      }
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

  // Results belong to a single request on a single page. Late responses must
  // not recreate a panel on a rental page or overwrite another property's data.
  function isCurrentRequest(requestId) {
    return requestId === activeRequest && currentShadow &&
      pageKey === location.origin + location.pathname && isEligiblePage();
  }

  chrome.runtime.onMessage.addListener(message => {
    if (message.type !== 'VALUATION_UPDATE' || !isCurrentRequest(message.requestId)) return;
    const { result } = message;
    if (SOURCES.includes(result.source)) setCardState(currentShadow, result.source, result, currentAddress);
  });

  function requestValuations(address) {
    if (!currentShadow || !isEligiblePage()) return;
    currentAddress = address;
    const requestId = crypto.randomUUID();
    activeRequest = requestId;
    currentShadow.getElementById('nzvp-address').textContent = address.fullAddress;
    chrome.runtime.sendMessage(
      { type: 'FETCH_VALUATIONS', address, requestId },
      response => {
        const error = chrome.runtime.lastError;
        if (!isCurrentRequest(requestId)) return;
        if (error || !response?.ok) {
          console.error(LOG, 'Valuation request failed:', error?.message || response);
          applyResults(currentShadow, SOURCES.map(source => ({ source, error: 'Valuation request failed' })), address);
          return;
        }
        applyResults(currentShadow, response.results, address);
      }
    );
  }

  function isEligiblePage() {
    if (!window.NZValuatorAdapter.isListingPage()) return false;
    const heading = document.querySelector('h1');
    if (!heading || /^(whoops!?|oops!?|.*not found|.*unavailable|access denied|.*listing (?:has )?(?:closed|expired))$/i.test(heading.textContent.trim())) return false;
    // During SPA navigation, the URL can change before the old listing DOM.
    const canonical = document.querySelector('link[rel="canonical"]')?.href;
    if (canonical && new URL(canonical, location.href).pathname !== location.pathname) return false;
    return true;
  }

  function clearPanel() {
    activeRequest = null;
    currentShadow = null;
    currentAddress = null;
    document.getElementById('nz-valuator-host')?.remove();
  }

  function syncPage() {
    if (!activated) return;
    const nextKey = location.origin + location.pathname;
    if (nextKey !== pageKey) {
      clearPanel();
      pageKey = nextKey;
    }
    if (!isEligiblePage()) { clearPanel(); return; }
    const address = window.NZValuatorAdapter.tryExtract();
    if (!address || !parseAddress(address.streetAddress).valid) { clearPanel(); return; }
    const anchor = panelAnchor();
    if (!anchor) { clearPanel(); return; }
    const host = document.getElementById('nz-valuator-host');
    if (currentShadow && host && currentAddress?.fullAddress === address.fullAddress) {
      if (anchor.nextElementSibling !== host) anchor.insertAdjacentElement('afterend', host);
      return;
    }
    clearPanel();
    currentShadow = injectPanel(anchor);
    requestValuations(address);
  }

  // Content scripts have an isolated JS world. Polling catches page-world
  // pushState, same-URL error renders, and delayed sale-status/address updates.
  const pageTimer = setInterval(syncPage, INTERVAL_MS);
  window.addEventListener('popstate', syncPage);
  window.addEventListener('beforeunload', () => {
    clearInterval(pageTimer);
    clearPanel();
  });
  requestAnimationFrame(() => { activated = true; syncPage(); });
})();
