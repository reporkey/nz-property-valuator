# NZ Property Valuator – Site Research

Manual research notes gathered via browser DevTools / Network tab inspection.
Fill in each TODO before implementing any fetching logic.

---

## OneRoof (oneroof.co.nz)

### Base URL
```
TODO: e.g. https://www.oneroof.co.nz
```

### Search URL Pattern
```
TODO: e.g. https://www.oneroof.co.nz/search?q=<address>
```

### Known API Endpoints
```
TODO: document any XHR/fetch requests observed in the Network tab, e.g.
  GET /api/v1/properties?address=...
  Response shape: { ... }
```

### Property Page URL Pattern
```
TODO: e.g. https://www.oneroof.co.nz/property/<suburb>/<address>-<id>
```

### Valuation Estimate CSS Selector
```
TODO: e.g. [data-testid="property-estimate"] or .property-value__amount
```

### Anti-Scraping Measures
- TODO: Note any rate limiting, bot detection (Cloudflare, reCAPTCHA, etc.)
- TODO: Note required cookies or session tokens
- TODO: Note CORS policy on API endpoints

### Notes
> TODO: Any additional observations (login required, data freshness, etc.)

---

## homes.co.nz

### Base URL
```
TODO: e.g. https://homes.co.nz
```

### Search URL Pattern
```
TODO: e.g. https://homes.co.nz/search?q=<address>
```

### Known API Endpoints
```
TODO: document any XHR/fetch requests observed in the Network tab, e.g.
  GET /api/property?address=...
  Response shape: { ... }
```

### Property Page URL Pattern
```
TODO: e.g. https://homes.co.nz/address/<suburb>/<street-address>
```

### Valuation Estimate CSS Selector
```
TODO: e.g. .estimate-value or [class*="valuation"]
```

### Anti-Scraping Measures
- TODO: Note any rate limiting, bot detection (Cloudflare, reCAPTCHA, etc.)
- TODO: Note required cookies or session tokens
- TODO: Note CORS policy on API endpoints

### Notes
> TODO: Any additional observations (login required, data freshness, etc.)

---

## PropertyValue (propertyvalue.co.nz)

### Base URL
```
TODO: e.g. https://www.propertyvalue.co.nz
```

### Search URL Pattern
```
TODO: e.g. https://www.propertyvalue.co.nz/search?address=<address>
```

### Known API Endpoints
```
TODO: document any XHR/fetch requests observed in the Network tab, e.g.
  GET /api/estimate?address=...
  Response shape: { ... }
```

### Property Page URL Pattern
```
TODO: e.g. https://www.propertyvalue.co.nz/property/<id>
```

### Valuation Estimate CSS Selector
```
TODO: e.g. .valuation-figure or #property-estimate
```

### Anti-Scraping Measures
- TODO: Note any rate limiting, bot detection (Cloudflare, reCAPTCHA, etc.)
- TODO: Note required cookies or session tokens
- TODO: Note CORS policy on API endpoints

### Notes
> TODO: Any additional observations (login required, data freshness, etc.)
