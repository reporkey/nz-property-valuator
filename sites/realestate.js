/**
 * sites/realestate.js — RealEstate.co.nz adapter for NZ Property Valuator (stub)
 *
 * Sets window.NZValuatorAdapter before content.js runs.
 *
 * URL pattern: realestate.co.nz/residential/{listing-id}
 *   e.g. /residential/1234567890  (numeric ID, ≥7 digits)
 *
 * The /residential/* match pattern also catches search/browse pages
 * (e.g. /residential/sale/auckland), so isListingPage() uses the
 * numeric last-segment check to distinguish individual listings.
 *
 * tryExtract() returns null → content.js shows the manual input form.
 * Full extraction will be implemented in a future iteration.
 */

(() => {
  'use strict';

  const LOG = '[NZ-Valuator]';

  window.NZValuatorAdapter = {

    isListingPage() {
      // Last path segment must be a numeric listing ID (≥7 digits).
      const parts = location.pathname.split('/').filter(Boolean);
      const last  = parts[parts.length - 1] || '';
      return /^\d{7,}$/.test(last);
    },

    tryExtract() {
      console.log(LOG, 'RealEstate adapter: tryExtract not yet implemented —', location.href);
      return null;
    },

    findPanelAnchor() {
      return null; // panel stays at body.prepend
    },
  };
})();
