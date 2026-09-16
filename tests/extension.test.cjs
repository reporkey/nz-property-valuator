const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const source = file => fs.readFileSync(`${__dirname}/../${file}`, 'utf8');
const sale = 'https://www.trademe.co.nz/a/property/residential/sale/auckland/auckland-city/city-centre/listing/1234567890';
const rental = sale.replace('/sale/', '/rent/');
const address = { streetAddress: '13D/2 White Street', suburb: 'City Centre', city: 'Auckland', fullAddress: '13D/2 White Street, City Centre, Auckland' };

function page(url = sale, adapter = 'trademe', html = '<main><h1>13D/2 White Street, City Centre, Auckland</h1><h2>$500,000</h2></main>') {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  const w = dom.window;
  Object.defineProperty(w.document, 'readyState', { configurable: true, value: 'complete' });
  const requests = [];
  let listener, tick;
  w.chrome = { runtime: {
    getURL: name => `chrome-extension://test/${name}`,
    onMessage: { addListener: fn => { listener = fn; } },
    sendMessage: (message, callback) => requests.push({ message, callback }),
  } };
  w.setInterval = fn => { tick = fn; return 1; };
  w.clearInterval = () => {};
  w.requestAnimationFrame = fn => fn();
  w.eval(source('addressMatcher.js'));
  w.eval(source(`sites/${adapter}.js`));
  return { w, requests, run: () => w.eval(source('content.js')), tick: () => tick(),
    send: message => listener(message), host: () => w.document.getElementById('nz-valuator-host'), close: () => w.close() };
}

test('sale panel is embedded after its anchor, scrolls with the page and can collapse', () => {
  const p = page();
  const main = p.w.document.querySelector('main');
  const heading = main.querySelector('h1');
  const original = heading.outerHTML;
  p.run();
  assert.equal(p.host().parentElement, main);
  assert.equal(heading.nextElementSibling, p.host());
  assert.equal(heading.outerHTML, original);
  assert.equal(p.host().style.position, 'static');
  assert.equal(p.requests.length, 1);
  p.tick(); p.tick();
  assert.equal(p.requests.length, 1, 'unchanged page must not refetch');
  const shadow = p.host().shadowRoot;
  shadow.querySelector('.nzvp-toggle').click();
  assert.equal(shadow.getElementById('nzvp-body').hidden, true);
  shadow.querySelector('.nzvp-toggle').click();
  assert.equal(shadow.getElementById('nzvp-body').hidden, false);
  p.close();
});

test('inline insertion waits for page load and pending Angular hydration', () => {
  const p = page();
  Object.defineProperty(p.w.document, 'readyState', { configurable: true, value: 'loading' });
  p.run();
  assert.equal(p.host(), null);
  assert.equal(p.requests.length, 0);
  const main = p.w.document.querySelector('main');
  main.setAttribute('ngh', '0');
  Object.defineProperty(p.w.document, 'readyState', { configurable: true, value: 'complete' });
  p.tick();
  assert.equal(p.host(), null);
  assert.equal(p.requests.length, 0);
  main.removeAttribute('ngh');
  p.tick();
  assert.equal(p.host().parentElement, main);
  assert.equal(p.requests.length, 1);
  p.close();
});

test('platinum listing embeds after its summary and restores after a site rerender', () => {
  const p = page(sale, 'trademe', '<main><h1>Spacious, Stylish & Easy to Enjoy</h1><div class="property-info"><h2>Summary</h2></div><script type="application/ld+json">' + JSON.stringify({ address }) + '</script></main>');
  p.run();
  const summary = p.w.document.querySelector('.property-info');
  assert.equal(summary.nextElementSibling, p.host());
  p.host().remove();
  p.tick();
  assert.equal(summary.nextElementSibling, p.host());
  assert.equal(p.w.document.querySelectorAll('#nz-valuator-host').length, 1);
  p.close();
});

test('rental, commercial, motors and search pages never show a panel or fetch', () => {
  for (const url of [rental, sale.replace('/residential/', '/commercial/'), sale.replace('/a/property/residential/sale/', '/a/motors/cars/'), sale.replace('/listing/1234567890', '/search')]) {
    const p = page(url); p.run(); p.tick();
    assert.equal(p.host(), null, url);
    assert.equal(p.requests.length, 0, url);
    p.close();
  }
});

test('error page suppresses stale structured address data and recovers at the same URL', () => {
  const p = page(); p.run();
  const request = p.requests[0];
  const stale = p.w.document.createElement('script');
  stale.type = 'application/ld+json';
  stale.textContent = JSON.stringify({ address });
  p.w.document.head.appendChild(stale);
  p.w.document.querySelector('main').innerHTML = '<h1>Whoops!</h1>';
  p.tick();
  assert.equal(p.host(), null);
  request.callback({ ok: true, results: [{ source: 'homes.co.nz', estimate: '$100K' }] });
  p.send({ type: 'VALUATION_UPDATE', requestId: request.message.requestId, result: { source: 'homes.co.nz', estimate: '$100K' } });
  assert.equal(p.host(), null);
  assert.equal(p.requests.length, 1);
  p.w.document.querySelector('h1').textContent = address.fullAddress;
  p.tick();
  assert.ok(p.host());
  assert.equal(p.requests.length, 2);
  p.close();
});

test('SPA sale -> rental -> sale cancels old updates and starts a new request', () => {
  const p = page(); p.run();
  const old = p.requests[0];
  p.w.history.pushState({}, '', rental); p.tick();
  assert.equal(p.host(), null);
  assert.equal(p.requests.length, 1);
  p.w.history.pushState({}, '', sale); p.tick();
  const fresh = p.requests[1];
  old.callback({ ok: true, results: [{ source: 'homes.co.nz', estimate: 'OLD' }] });
  p.send({ type: 'VALUATION_UPDATE', requestId: old.message.requestId, result: { source: 'homes.co.nz', estimate: 'OLD' } });
  assert.equal(p.host().shadowRoot.textContent.includes('OLD'), false);
  p.send({ type: 'VALUATION_UPDATE', requestId: fresh.message.requestId, result: { source: 'homes.co.nz', estimate: '$150K' } });
  assert.ok(p.host().shadowRoot.textContent.includes('$150K'));
  p.close();
});

test('an in-flight update is rejected immediately after navigation, before the next poll', () => {
  const p = page(); p.run();
  const old = p.requests[0];
  p.w.history.pushState({}, '', rental);
  old.callback({ ok: true, results: [{ source: 'homes.co.nz', estimate: 'OLD' }] });
  assert.equal(p.host().shadowRoot.textContent.includes('OLD'), false);
  p.tick(); assert.equal(p.host(), null); p.close();
});

test('stale canonical URL and non-address headings cause no requests', () => {
  for (const html of ['<h1>Whoops!</h1>', '<h1>Property unavailable</h1>', '<h1>Listing Description</h1>', `<link rel="canonical" href="${rental}"><h1>${address.fullAddress}</h1>`]) {
    const p = page(sale, 'trademe', html); p.run(); p.tick();
    assert.equal(p.host(), null); assert.equal(p.requests.length, 0); p.close();
  }
});

test('RealEstate only allows numeric residential sale listing routes', () => {
  for (const [path, eligible] of [['/12345678/residential/sale/2-white-street', true], ['/12345678/residential/rent/2-white-street', false], ['/12345678/commercial/sale/2-white-street', false], ['/residential/sale/auckland', false]]) {
    const p = page(`https://www.realestate.co.nz${path}`, 'realestate');
    assert.equal(p.w.NZValuatorAdapter.isListingPage(), eligible); p.close();
  }
});

test('OneRoof requires property-specific sale evidence, excluding rental and off-market pages', () => {
  for (const [title, breadcrumb, eligible] of [['Houses for Sale', 'For sale', true], ['Houses for Rent', 'For rent', false], ['Property estimates', 'For sale', false], ['Houses for Sale', 'For rent', false]]) {
    const p = page('https://www.oneroof.co.nz/property/auckland/glendowie/381-riddell-road/foAPR', 'oneroof', `<title>381 Riddell Road | ${title} - OneRoof</title><header><a href="/search/houses-for-sale/all">For sale</a></header><main><a href="/search/houses-for-sale/all">${breadcrumb}</a><h1>381 Riddell Road</h1></main>`);
    assert.equal(p.w.NZValuatorAdapter.isListingPage(), eligible); p.close();
  }
});

test('manifest never injects TradeMe/RealEstate content scripts into rental pages', () => {
  const manifest = JSON.parse(source('manifest.json'));
  const matches = (pattern, url) => new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(url);
  const allowed = url => manifest.content_scripts.some(entry => entry.matches.some(pattern => matches(pattern, url)));
  assert.equal(allowed(sale), true);
  assert.equal(allowed(rental), false);
  assert.equal(allowed('https://www.realestate.co.nz/12345678/residential/rent/test'), false);
  assert.equal(allowed('https://www.realestate.co.nz/12345678/residential/sale/test'), true);
});

function background() {
  const context = vm.createContext({ console, setTimeout, clearTimeout, AbortController, Response, TextEncoder, crypto, URL,
    chrome: { runtime: { onMessage: { addListener(fn) { context.listener = fn; } } } }, importScripts() {} });
  vm.runInContext(source('addressMatcher.js'), context);
  vm.runInContext(source('background.js'), context);
  return context;
}

test('only supported sources are fetched and streamed, even with legacy settings', async () => {
  const ctx = background();
  const messages = [], calls = [];
  ctx.chrome.tabs = { sendMessage: async (tab, message) => messages.push({ tab, message }) };
  ctx.chrome.storage = { local: { get: async () => ({}), set: async () => {} } };
  for (const [fn, name] of [['fetchOneRoof', 'OneRoof'], ['fetchHomes', 'homes.co.nz'], ['fetchRealEstate', 'RealEstate.co.nz']]) {
    ctx[fn] = async () => { calls.push(name); return { source: name, estimate: '$605K', error: null }; };
  }
  ctx.fetch = async () => { throw new Error('Unexpected network request'); };
  const result = await new Promise(resolve => ctx.runFetchers(address, { PropertyValue: { enabled: true } }, 42, 'request-A', resolve));
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['OneRoof', 'homes.co.nz', 'RealEstate.co.nz']);
  assert.equal(result.results.length, 3);
  assert.equal(messages.length, 3);
  assert.ok(messages.every(({ tab, message }) => tab === 42 && message.requestId === 'request-A'));
  assert.equal(ctx.getCached(address.fullAddress).length, 3);
  assert.equal(ctx.fmtAmount(605000), '$605K');
});

test('sale search bootstraps SPA listing navigation without activating on search or rental', () => {
  const manifest = JSON.parse(source('manifest.json'));
  const entry = manifest.content_scripts.find(entry => entry.js.includes('sites/realestate.js'));
  for (const path of ['/residential/sale', '/residential/sale?by=latest', '/residential/sale/auckland', '/residential/sale/auckland?by=latest']) {
    const url = `https://www.realestate.co.nz${path}`;
    assert.ok(entry.matches.some(pattern => new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(url)));
    const p = page(url, 'realestate'); p.run(); p.tick();
    assert.equal(p.host(), null);
    assert.equal(p.requests.length, 0);
    p.w.history.pushState({}, '', '/12345678/residential/sale/2-white-street'); p.tick();
    assert.ok(p.host()); assert.equal(p.requests.length, 1);
    p.w.history.pushState({}, '', '/12345678/residential/rent/2-white-street'); p.tick();
    assert.equal(p.host(), null); assert.equal(p.requests.length, 1);
    p.close();
  }
});

test('homes fallback retains original city at every search tier', async () => {
  const query = { streetAddress: '42 Main Street', suburb: 'City Centre', city: 'Auckland', fullAddress: '42 Main Street, City Centre, Auckland' };
  for (const title of ['42 Main Street, City Centre, Christchurch', '42 Main Street, Riccarton, Christchurch', '42 Main Street', '42 Main Street, North Auckland']) {
    const ctx = background(); let cards = 0;
    ctx.fetch = async url => {
      if (!url.includes('/address/search')) cards++;
      return Response.json({ Results: [{ Title: title, PropertyID: 'wrong' }] });
    };
    const result = await ctx.fetchHomes(query);
    assert.equal(result.estimate, null, title);
    assert.equal(cards, 0, title);
  }
  for (const title of ['42 Main Street, Different Suburb, Auckland', '42 Main Street, Different Suburb, Auckland City', '42 Main Street, Auckland']) {
    const ctx = background(); let searches = 0, cards = 0;
    ctx.fetch = async url => {
      if (url.includes('/address/search')) return Response.json({ Results: ++searches < 4 ? [] : [{ Title: title, PropertyID: 'correct' }] });
      cards++;
      return Response.json({ cards: [{ url: '/auckland/correct', property_details: { display_estimated_lower_value_short: '800K', display_estimated_upper_value_short: '900K' } }] });
    };
    const result = await ctx.fetchHomes(query);
    assert.equal(result.estimate, '$800K – $900K', title);
    assert.equal(cards, 1);
  }
});

test('source settings partition cache, including results finishing after a toggle', async () => {
  const ctx = background();
  let enabled = false, calls = 0, finish;
  ctx.chrome.storage = {
    sync: { get: async () => ({ sources: { OneRoof: { enabled: false }, 'homes.co.nz': { enabled }, 'RealEstate.co.nz': { enabled: false } } }) },
    local: { get: async () => ({}), set: async () => {} },
  };
  ctx.fetchHomes = async () => { calls++; await new Promise(resolve => { finish = resolve; }); return { source: 'homes.co.nz', estimate: '$800K', error: null }; };
  const send = () => new Promise(resolve => ctx.listener({ type: 'FETCH_VALUATIONS', address }, {}, resolve));
  assert.equal((await send()).results[1].disabled, true);
  enabled = true;
  const pending = send();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  enabled = false;
  assert.equal((await send()).results[1].disabled, true);
  finish(); await pending;
  assert.equal((await send()).results[1].disabled, true, 'old enabled request cannot overwrite disabled cache');
  enabled = true;
  const restored = await send();
  assert.equal(restored.results[1].estimate, '$800K');
  assert.equal(restored.fromCache, true);
  assert.equal(calls, 1);
});

test('timeout covers stalled response bodies and buffered responses remain readable', async t => {
  const http = require('node:http');
  let stalled = false;
  const server = http.createServer((req, res) => {
    if (req.url === '/stall') {
      stalled = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{');
    } else if (req.url === '/empty') { res.writeHead(204); res.end(); }
    else { res.setHeader('Content-Type', 'application/json'); res.end('{"value":42}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const ctx = background(); ctx.fetch = fetch;
  await assert.rejects(ctx.fetchWithTimeout(`${base}/stall`, {}, 100), error => error.name === 'AbortError');
  assert.equal(stalled, true, 'headers and a partial body must arrive before the deadline');
  assert.deepEqual(await (await ctx.fetchWithTimeout(base)).json(), { value: 42 });
  assert.equal(await (await ctx.fetchWithTimeout(base)).text(), '{"value":42}');
  assert.equal((await ctx.fetchWithTimeout(`${base}/empty`)).status, 204);
});

test('removed source has no card, settings row or host permission', () => {
  const p = page(); p.run();
  const cards = p.host().shadowRoot.querySelectorAll('.nzvp-card');
  assert.equal(cards.length, 3);
  assert.equal(p.host().shadowRoot.textContent.includes('PropertyValue'), false);
  assert.equal(source('popup.html').includes('PropertyValue'), false);
  assert.equal(source('popup.js').includes('PropertyValue'), false);
  assert.equal(source('manifest.json').includes('propertyvalue.co.nz'), false);
  p.close();
});
