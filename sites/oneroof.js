/**
 * sites/oneroof.js — OneRoof adapter for NZ Property Valuator (stub)
 *
 * Sets window.NZValuatorAdapter before content.js runs.
 *
 * URL pattern: oneroof.co.nz/property/{region}/{suburb}/{address-slug}/{property-id}
 *   e.g. /property/auckland/remuera/10-mahoe-avenue/qeHJ8
 *
 * tryExtract() returns null → content.js shows the manual input form.
 * Full extraction will be implemented in a future iteration.
 */

(() => {
  'use strict';

  const LOG = '[NZ-Valuator]';

  window.NZValuatorAdapter = {

    isListingPage() {
      // Require at least 4 path segments after /property/
      // e.g. /property/region/suburb/address-slug/property-id
      const parts = location.pathname.split('/').filter(Boolean);
      return parts[0] === 'property' && parts.length >= 4;
    },

    tryExtract() {
      console.log(LOG, 'OneRoof adapter: tryExtract not yet implemented —', location.href);
      return null;
    },

    findPanelAnchor() {
      return null; // panel stays at body.prepend
    },
  };
})();
