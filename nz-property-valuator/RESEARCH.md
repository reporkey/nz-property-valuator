# NZ Property Valuator – Site Research

Manual research notes gathered via browser DevTools / Network tab inspection.
Fill in each TODO before implementing any fetching logic.

---

## OneRoof (oneroof.co.nz)

### Base URL
```
https://www.oneroof.co.nz
```

### Search URL Pattern
```
# Regional listing search (browse):
https://www.oneroof.co.nz/search/houses-for-sale/region_<region-name>-<region-id>_page_<n>

# Examples:
https://www.oneroof.co.nz/search/houses-for-sale/region_auckland-35_page_1
https://www.oneroof.co.nz/search/houses-for-sale/region_all-new-zealand-1_page_1

# Estimate / map search (used to look up a specific address):
https://www.oneroof.co.nz/estimate/map/region_all-new-zealand-1
# Address lookup is handled client-side via the search component; no query-string
# parameter is present in the initial URL — the address is submitted via JS state.
```

### Known API Endpoints
```
# Official OpenAPI docs (JS-rendered Swagger/ReDoc UI — open in browser):
https://docs.oneroof.co.nz/openapi/index.html

# No plain XHR endpoints detected via static HTML inspection.
# The site uses Next.js React Server Components (RSC): all property and valuation
# data is streamed as serialised JSON inside <script> tags of the form:
#   self.__next_f.push([...])
# There are NO separate REST/GraphQL XHR calls to intercept for the estimate value;
# the data arrives inline with the page HTML.

# Static assets / CDN:
https://assets.oneroof.co.nz/...
https://s.oneroof.co.nz/...

# TODO: Open the estimate page in DevTools (Network → Fetch/XHR) while typing an
# address to capture any autocomplete or property-lookup calls.
```

### Property Page URL Pattern
```
https://www.oneroof.co.nz/property/<region>/<suburb>/<address-slug>/<property-id>

# Examples (confirmed via live search results):
https://www.oneroof.co.nz/property/auckland/remuera/10-mahoe-avenue/qeHJ8
https://www.oneroof.co.nz/property/auckland/mount-eden/93-halesowen-avenue/jlvQp
https://www.oneroof.co.nz/property/auckland/westmere/80-warnock-street/RoHzS

# Segments:
#   <region>      — lowercase region slug, e.g. "auckland", "wellington"
#   <suburb>      — lowercase suburb slug, e.g. "remuera", "mount-eden"
#   <address-slug>— kebab-case street address, e.g. "10-mahoe-avenue"
#   <property-id> — short alphanumeric hash, e.g. "qeHJ8"
```

### Valuation Estimate CSS Selector
```
# ⚠️  No stable CSS selector found.
#
# Valuation data (OneRoof estimate + low/high range + council RV) is embedded
# inside Next.js RSC serialised state, not in a plain DOM element:
#
#   self.__next_f.push([...large JSON blob...])
#
# Approach: parse the page HTML, extract the __next_f script blocks, JSON-parse
# the payload, and walk the React component tree to find the estimate node.
#
# Observed display format on property pages (e.g. qeHJ8):
#   OneRoof estimate:  $1.43M  (labelled "High Accuracy")
#   Low:               $1.29M
#   High:              $1.57M
#   Rating valuation:  $1.5M   (Auckland City Council, 2024)
#
# TODO: Confirm with DevTools whether a simpler selector exists after hydration,
# e.g. something like [class*="estimate"] or [class*="valuation"].
```

### Anti-Scraping Measures
- **Next.js RSC streaming**: Data is not returned by a simple REST endpoint; it is
  embedded inline as serialised React state. A plain `fetch()` of the page HTML
  will include the data, but parsing it is non-trivial.
- **A/B testing**: Abtasty tracker present — page content may vary between sessions.
- **Analytics**: Google Tag Manager (GTM-58D24DV) — behavioural tracking in place.
- **No Cloudflare challenge** detected on basic property page fetches (as of research date).
- **No login required** for viewing estimate data on public property pages.
- **CDN assets** on separate origins (`assets.oneroof.co.nz`, `s.oneroof.co.nz`) —
  CORS policy on these is TODO; the main page HTML should be accessible without CORS issues.
- TODO: Test whether a server-side `fetch()` (no browser headers) returns the full
  RSC payload or a stripped/bot-blocked response.

### Notes
> - AVM (Automated Valuation Model) is provided by **Valocity** — mentioned in the
>   "Valocity Disclaimers" section of `/property-valuations`.
> - The estimate gauge shows a confidence band (low / mid / high) plus the local
>   council Rating Valuation (RV) for comparison.
> - Official API docs exist at `docs.oneroof.co.nz/openapi/index.html` but require
>   JavaScript to render — check whether an unauthenticated API key is available.
> - Property IDs are short base-62 hashes (e.g. `qeHJ8`); the address slug and
>   region/suburb are human-readable but the ID is the canonical identifier.

---

## PropertyValue (propertyvalue.co.nz)

### Base URL
```
https://www.propertyvalue.co.nz
```

### Search URL Pattern
```
# Hierarchical browse (region → district → suburb):
https://www.propertyvalue.co.nz/<region>
https://www.propertyvalue.co.nz/<region>/<district>/<suburb-id>

# Examples:
https://www.propertyvalue.co.nz/auckland
https://www.propertyvalue.co.nz/wellington
https://www.propertyvalue.co.nz/canterbury/christchurch-city/60

# Address search is handled by a client-side search form on the homepage.
# TODO: Intercept via DevTools (Network → Fetch/XHR) while typing an address
# to capture the autocomplete API call (likely POST or GET to /api/...).
# No query-string search URL was found in static analysis.
```

### Known API Endpoints
```
# ⚠️  No REST API endpoints found via static HTML analysis.
#
# The site is a React + Redux SPA with SERVER-SIDE RENDERING (SSR).
# ALL property and valuation data is embedded in the initial HTML inside a
# <script> tag as:
#
#   window.REDUX_DATA = { ... }
#
# This means a single fetch() of the property page URL returns the full
# estimate — no separate XHR call is needed.
#
# Confirmed by: PropertyDetails.isServerRender === true in the Redux state.
#
# Redux state structure relevant to valuations:
#   window.REDUX_DATA.PropertyDetails.estimatedRange
#     → { lowerBand: 2200000, upperBand: 2400000, confidence: "MEDIUM" }
#   window.REDUX_DATA.PropertyDetails.ratingValuation
#     → { capitalValue, landValue, improvementValue, valuationDate, valuationRef }
#   window.REDUX_DATA.PropertyDetails.propertyId
#     → integer, e.g. 7120741
#
# Images CDN: https://images.corelogic.asia/...  (signed URLs)
#
# TODO: Use DevTools Network tab to confirm whether any autocomplete or
# property-lookup XHR calls exist that are not visible in static HTML.
```

### Property Page URL Pattern
```
https://www.propertyvalue.co.nz/<region>/<district>/<suburb-postcode>/<address-slug>-<property-id>

# Examples (confirmed via live site):
https://www.propertyvalue.co.nz/wellington/wellington-city/wadestown-6012/14-sefton-street-wadestown-wellington-6012-7120741
https://www.propertyvalue.co.nz/wellington/upper-hutt-city/ebdentown-5018/5-victoria-street-ebdentown-upper-hutt-5018-8769929
https://www.propertyvalue.co.nz/otago/queenstown-lakes-district/jacks-point-9371/15-inder-street-jacks-point-9371-62817321

# Segments:
#   <region>          — lowercase region slug, e.g. "auckland", "wellington", "otago"
#   <district>        — lowercase district slug, e.g. "wellington-city", "queenstown-lakes-district"
#   <suburb-postcode> — suburb slug + postcode, e.g. "wadestown-6012"
#   <address-slug>    — full address as kebab-case, e.g. "14-sefton-street-wadestown-wellington-6012"
#   <property-id>     — plain integer from CoreLogic, e.g. "7120741"
```

### Valuation Estimate CSS Selector
```
# ⚠️  No CSS selector needed — parse window.REDUX_DATA from the initial HTML.
#
# Approach:
#   1. Fetch the property page URL
#   2. Extract the JSON blob: window.REDUX_DATA = { ... }  (brace-match to end)
#   3. Parse JSON → data.PropertyDetails.estimatedRange
#
# Confirmed data shape (from live page 7120741):
#   estimatedRange: {
#     lowerBand:  2200000,   // integer, NZD
#     upperBand:  2400000,   // integer, NZD
#     confidence: "MEDIUM"   // "LOW" | "MEDIUM" | "HIGH"
#   }
#   ratingValuation: {
#     capitalValue:     "2370000",
#     landValue:        "1530000",
#     improvementValue: "840000",
#     valuationDate:    "2024-09-01",
#     valuationRef:     "16851/36800"
#   }
#
# If a CSS selector IS required (after JS hydration), TODO: inspect in DevTools.
```

### Anti-Scraping Measures
- **Imperva Incapsula WAF**: `/_Incapsula_Resource?SWJIYLWA=...` script injected on every page.
  Basic curl fetches still returned full REDUX_DATA during research, but this may
  activate for repeated/automated requests. Test with real browser headers.
- **SSR data in initial HTML**: No second request needed; estimate is in page HTML.
  This is actually favourable for scraping — no CORS issue to solve.
- **No Cloudflare** challenge detected on basic property page fetches.
- **No login required** for viewing estimate data on public property pages.
- **Convert.com A/B testing**: `cdn-4.convertexperiments.com` script present — UI
  variants possible, but REDUX_DATA structure should remain stable.
- **Analytics**: Google Tag Manager ×2 (GTM-WS5J7MD, GTM-W2GFLV8).
- TODO: Test with `fetch()` from extension context (no browser cookies) to confirm
  Incapsula does not block and REDUX_DATA is still populated.

### Notes
> - AVM data powered by **CoreLogic / Cotality** (`cotality.com/nz`) — same data
>   provider used by NZ banks and councils. Signed image URLs from `images.corelogic.asia`.
> - Property IDs are plain **integers** (CoreLogic IDs), not hashes, e.g. `7120741`.
>   The full address slug in the URL is human-readable but the integer ID is canonical.
> - `robots.txt` has no Disallow rules — all paths permitted for crawlers.
> - The property page returns `isServerRender: true` — reliable indicator that data
>   will be present in the initial HTML without JS execution.
