/**
 * addressMatcher.js — Shared address parsing and matching for NZ Property Valuator.
 *
 * Loaded via importScripts('addressMatcher.js') in background.js (service worker).
 * Exposes four globals: parseAddress, matchAddress, expandSuburbAbbrev, STREET_TYPE_MAP.
 *
 * Strategy: component-based matching (unitNum, houseNum, streetName, streetType,
 * suburb, city, postcode). Strict on house/unit/street; soft on locality (scoring).
 */

(function () {
  'use strict';

  // ── Street type abbreviation map ──────────────────────────────────────────
  // Maps abbreviated forms to canonical full words (all lowercase).

  const STREET_TYPE_MAP = {
    st:   'street', rd:   'road',    ave:  'avenue',  av:   'avenue',
    dr:   'drive',  cres: 'crescent', cr:  'crescent',
    pl:   'place',  tce:  'terrace', tc:   'terrace',
    hwy:  'highway', ln:  'lane',    ct:   'court',
    pde:  'parade', esp:  'esplanade', blvd: 'boulevard', bvd: 'boulevard',
    gr:   'grove',  gv:   'grove',   rs:   'rise',
    wy:   'way',    cl:   'close',   clo:  'close',
    sq:   'square', pk:   'park',    gdn:  'garden',   gdns: 'gardens',
    bch:  'beach',  bdwy: 'broadway', fwy: 'freeway',
  };

  const CANONICAL_STREET_TYPES = new Set([
    'street', 'road', 'avenue', 'drive', 'crescent', 'place', 'terrace', 'highway',
    'lane', 'court', 'parade', 'esplanade', 'boulevard', 'grove', 'rise', 'way',
    'close', 'square', 'park', 'garden', 'gardens', 'beach', 'broadway', 'freeway',
    'mews', 'quay', 'track', 'walk', 'loop', 'access', 'view', 'heights',
  ]);

  // ── Suburb prefix abbreviation map ────────────────────────────────────────

  const SUBURB_ABBREV_MAP = [
    ['st ', 'saint '],   // "St Heliers" → "Saint Heliers"
    ['mt ', 'mount '],   // "Mt Eden" → "Mount Eden"
    ['pt ', 'point '],   // "Pt Chevalier" → "Point Chevalier"
  ];

  function expandSuburbAbbrev(s) {
    if (!s) return s;
    const low = s.toLowerCase();
    for (const [abbr, full] of SUBURB_ABBREV_MAP) {
      if (low.startsWith(abbr)) return full + s.slice(abbr.length);
    }
    return s;
  }

  // ── parseAddress ──────────────────────────────────────────────────────────
  // Accepts a raw address string (API result or query) plus optional pre-split
  // suburb and city hints (used when the caller already has structured data).
  //
  // Returns:
  //   { unitNum, houseNum, streetName, streetType, suburb, city, postcode, valid }
  // All string fields are lowercased and trimmed; null when absent.
  // valid: false if houseNum cannot be parsed.

  function parseAddress(raw, suburbHint, cityHint) {
    if (!raw || typeof raw !== 'string') return _invalid();

    let input = raw.trim();

    // ── Detect run-on PropertyValue slug format ───────────────────────────
    // e.g. "865 Waikaretu Valley Road Tuakau Tuakau 2121"
    // Heuristic: no commas, contains a 4-digit postcode, and is long enough
    // to have a locality suffix. Parse postcode, strip trailing property ID,
    // then split at the boundary after the street type.
    let runOnLocality = null;
    if (!input.includes(',') && !input.includes(';')) {
      const postcodeMatch = /\b(\d{4})\b/.exec(input);
      if (postcodeMatch) {
        const postcode = postcodeMatch[1];
        // Strip property ID (5+ digit number at end) and postcode
        const cleaned = input
          .replace(/\d{5,}\s*$/, '')
          .replace(postcode, '')
          .trim();
        // Try to identify the end of the street portion by finding a street type
        // word, then treat everything after as locality.
        const words = cleaned.split(/\s+/);
        let streetTypeIdx = -1;
        for (let i = words.length - 1; i >= 1; i--) {
          const w = words[i].toLowerCase();
          if (CANONICAL_STREET_TYPES.has(w) || STREET_TYPE_MAP[w]) {
            streetTypeIdx = i;
            break;
          }
        }
        if (streetTypeIdx > 0) {
          const streetPart   = words.slice(0, streetTypeIdx + 1).join(' ');
          const localityPart = words.slice(streetTypeIdx + 1).join(' ').trim();
          runOnLocality = { streetPart, localityPart, postcode };
        }
      }
    }

    // ── Split street from locality ─────────────────────────────────────────
    let streetPart, localityParts;

    if (runOnLocality) {
      streetPart    = runOnLocality.streetPart;
      localityParts = runOnLocality.localityPart ? [runOnLocality.localityPart] : [];
    } else {
      const splitIdx = input.search(/[,;]/);
      if (splitIdx === -1) {
        streetPart    = input;
        localityParts = [];
      } else {
        streetPart    = input.slice(0, splitIdx).trim();
        localityParts = input.slice(splitIdx + 1).split(/[,;]/).map(s => s.trim()).filter(Boolean);
      }
    }

    // If streetPart is just a unit prefix ("Flat 2", "Unit 1") with no house
    // number, the comma split consumed the house+street into localityParts[0].
    // Re-join so Pattern B can parse it as one string.
    if (/^(?:unit|flat|apt|apartment|lot)\s+\d+[a-z]?$/i.test(streetPart) && localityParts.length > 0) {
      streetPart = streetPart + ', ' + localityParts.shift();
    }

    // ── Parse unit + house number from streetPart ─────────────────────────
    let unitNum = null, houseNum = null, streetBody = null;

    // Pattern A: "1/42 Smith Street" or "1A/42B Smith St"
    const patA = /^(\d+[a-z]?)\/(\d+[a-z]?)\s+(.+)/i.exec(streetPart);
    if (patA) {
      unitNum    = patA[1].toLowerCase();
      houseNum   = patA[2].toLowerCase();
      streetBody = patA[3];
    }

    // Pattern B: "Unit 1, 42 Smith Street" / "Flat 2 8 Jones Road" / "Apt 3, 10 Oak Ave"
    if (!patA) {
      const patB = /^(?:unit|flat|apt|apartment|lot)\s+(\d+[a-z]?)[,\s]+(\d+[a-z]?)\s+(.+)/i.exec(streetPart);
      if (patB) {
        unitNum    = patB[1].toLowerCase();
        houseNum   = patB[2].toLowerCase();
        streetBody = patB[3];
      }
    }

    // Pattern C: plain "42 Smith Street"
    if (!patA && !streetBody) {
      const patC = /^(\d+[a-z]?)\s+(.+)/i.exec(streetPart);
      if (patC) {
        unitNum    = null;
        houseNum   = patC[1].toLowerCase();
        streetBody = patC[2];
      }
    }

    if (!streetBody) return _invalid();

    // ── Parse street name and type from streetBody ────────────────────────
    const words    = streetBody.trim().split(/\s+/);
    const lastWord = words[words.length - 1].toLowerCase();
    let streetType = null;
    let nameWords;

    if (STREET_TYPE_MAP[lastWord]) {
      streetType = STREET_TYPE_MAP[lastWord];
      nameWords  = words.slice(0, -1);
    } else if (CANONICAL_STREET_TYPES.has(lastWord)) {
      streetType = lastWord;
      nameWords  = words.slice(0, -1);
    } else {
      streetType = null;
      nameWords  = words;
    }

    let streetName = nameWords.join(' ').toLowerCase();

    // Apply suburb expansion to street name (handles "Mt Eden Road" etc.)
    streetName = expandSuburbAbbrev(streetName);

    // ── Parse locality ────────────────────────────────────────────────────
    let suburb = null, city = null, postcode = runOnLocality?.postcode ?? null;

    // If hints are provided, use them (caller has structured data).
    if (suburbHint != null || cityHint != null) {
      suburb = suburbHint ? suburbHint.toLowerCase().trim() : null;
      city   = cityHint   ? cityHint.toLowerCase().trim()   : null;
      // Still extract postcode from locality parts if present
      for (const part of localityParts) {
        const pm = /\b(\d{4})\b/.exec(part);
        if (pm && !postcode) postcode = pm[1];
      }
    } else {
      // Extract from comma-separated locality parts
      const cleanParts = localityParts.map(p => {
        // Strip "- City" or "- <word>" suffix (OneRoof appends "Auckland - City")
        return p.replace(/\s*-\s*\w+$/, '').trim();
      });

      for (const part of cleanParts) {
        // Extract 4-digit postcode token
        const pm = /\b(\d{4})\b/.exec(part);
        if (pm && !postcode) postcode = pm[1];
      }

      // First non-postcode locality part → suburb; second → city
      const localWords = cleanParts.map(p => p.replace(/\b\d{4}\b/, '').trim()).filter(Boolean);
      if (localWords[0]) suburb = expandSuburbAbbrev(localWords[0].toLowerCase());
      if (localWords[1]) city   = expandSuburbAbbrev(localWords[1].toLowerCase());
    }

    return {
      unitNum,
      houseNum,
      streetName,
      streetType,
      suburb:   suburb || null,
      city:     city   || null,
      postcode: postcode || null,
      valid:    true,
    };
  }

  function _invalid() {
    return { unitNum: null, houseNum: null, streetName: null, streetType: null,
             suburb: null, city: null, postcode: null, valid: false };
  }

  // ── matchAddress ──────────────────────────────────────────────────────────
  // Compares two parsed address objects component-by-component.
  // Returns { match: bool, confidence: 'high'|'medium'|'low'|null, unitFallback: bool }
  // unitFallback: true when the query has no unit but the candidate has one —
  // the match is valid but callers should prefer building-level records first.

  function matchAddress(q, c) {
    const NO = { match: false, confidence: null };

    // Guard: invalid parse → no match
    if (!q || !q.valid || !c || !c.valid) return NO;

    // Rule 1: House number — exact string match
    if (q.houseNum !== c.houseNum) return NO;

    // Rule 2: Unit number — strict both ways.
    //   • If query specifies a unit, candidate must match it exactly.
    //   • If query has NO unit, candidate must also have NO unit.
    //     (Prevents linking a building-address query to a random unit record.)
    if (q.unitNum !== null) {
      if (c.unitNum === null || q.unitNum !== c.unitNum) return NO;
    } else {
      if (c.unitNum !== null) return NO;
    }

    // Rule 3: Street name — must match (both already expanded + lowercased)
    if (q.streetName !== c.streetName) return NO;

    // Rule 4: Street type — if both present, must match after expansion
    if (q.streetType !== null && c.streetType !== null) {
      if (q.streetType !== c.streetType) return NO;
    }

    // Rule 5: Suburb — if both present, must be compatible (hard gate)
    if (q.suburb && c.suburb) {
      const qSub = expandSuburbAbbrev(q.suburb);
      const cSub = expandSuburbAbbrev(c.suburb);
      const compatible = qSub === cSub || qSub.includes(cSub) || cSub.includes(qSub);
      if (!compatible) return NO;
    }

    // ── Core match established — score locality for confidence ────────────
    let score = 0;

    if (q.suburb && c.suburb) {
      const qSub = expandSuburbAbbrev(q.suburb);
      const cSub = expandSuburbAbbrev(c.suburb);
      if (qSub === cSub || qSub.includes(cSub) || cSub.includes(qSub)) score += 2;
    }
    if (q.city && c.city) {
      const qCity = q.city;
      const cCity = c.city;
      if (qCity === cCity || qCity.includes(cCity) || cCity.includes(qCity)) score += 1;
    }
    if (q.postcode && c.postcode && q.postcode === c.postcode) score += 2;

    const confidence = score >= 3 ? 'high' : score >= 1 ? 'medium' : 'low';
    // unitFallback: query had no unit but candidate is a specific unit record.
    // Callers should prefer exact building-level matches over these.
    const unitFallback = q.unitNum === null && c.unitNum !== null;
    return { match: true, confidence, unitFallback };
  }

  // ── Expose globals ────────────────────────────────────────────────────────
  /* global globalThis */
  const root = (typeof globalThis !== 'undefined') ? globalThis
             : (typeof self      !== 'undefined') ? self
             : (typeof global    !== 'undefined') ? global
             : this;

  root.STREET_TYPE_MAP    = STREET_TYPE_MAP;
  root.expandSuburbAbbrev = expandSuburbAbbrev;
  root.parseAddress       = parseAddress;
  root.matchAddress       = matchAddress;

})();
