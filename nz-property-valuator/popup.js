/**
 * popup.js — Script for the extension popup
 *
 * Displays the extension name and current status.
 * Communicates with the active tab's content script if needed.
 */

'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const statusEl = document.getElementById('status');

  // TODO: Query the active tab to determine if we're on a supported listing page

  // TODO: Display last known valuation result, or prompt user to visit a listing

  statusEl.textContent = 'Navigate to a TradeMe property listing to begin.';
});
