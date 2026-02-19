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

  // TODO: Extract property details from the page DOM

  // TODO: Send listing data to background.js via chrome.runtime.sendMessage

  // TODO: Receive valuation response and inject the side panel into the page

})();
