import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const storageKey = 'ride-ledger-web-v1';

function client(initialState) {
  const storage = new Map(initialState ? [[storageKey, JSON.stringify(initialState)]] : []);
  const elements = new Map();
  const context = vm.createContext({
    TextEncoder, TextDecoder, crypto: webcrypto, btoa, atob,
    history: {},
    navigator: { onLine: false },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, {
          addEventListener() {},
          querySelectorAll: () => [],
          classList: { toggle(name, enabled) { this[name] = enabled; } },
        });
        return elements.get(id);
      },
      querySelectorAll: () => [],
      addEventListener() {},
    },
    window: { addEventListener() {}, scrollTo() {} },
    requestAnimationFrame() {},
    setInterval() {},
  });
  // Evaluate the production script unchanged; only browser platform APIs are stubbed.
  vm.runInContext(source, context, { filename: 'web/app.js' });
  const api = vm.runInContext(`({
    base64url, fromBase64url, encryptedBundle, decryptBundle, syncNow, save,
    setState: value => state = value,
    getState: () => state,
  })`, context);
  return {
    api, context,
    stored: () => JSON.parse(storage.get(storageKey)),
    badge: () => elements.get('sync-badge'),
  };
}

function makeTrip() {
  return {
    id: webcrypto.randomUUID(), name: '旅行', personA: 'A', personB: 'B',
    secret: Buffer.alloc(32, 7).toString('base64url'), localPerson: 'a',
  };
}

function expense(trip, index = 0) {
  return {
    id: webcrypto.randomUUID(), tripId: trip.id, kind: 'expense', at: 1700000000000 + index,
    data: { payer: 'a', currency: 'CNY', amount: 1000, shareA: 5000,
      mode: 'shared', note: '房费、饭费、骑行补给' },
  };
}

function stateFor(trips, events = []) {
  return { trips, events, quickPrefs: {}, activeTripId: trips[0].id,
    deviceId: webcrypto.randomUUID() };
}

test('base64url round-trips a 1 MiB byte array without an argument-limit failure', () => {
  const { api } = client();
  const bytes = Uint8Array.from({ length: 1024 * 1024 }, (_, index) => index % 256);
  const encoded = api.base64url(bytes);
  assert.equal(encoded, Buffer.from(bytes).toString('base64url'));
  assert.deepEqual(Buffer.from(api.fromBase64url(encoded)), Buffer.from(bytes));
});

test('large real ledger snapshots encrypt and decrypt without losing records', async () => {
  const { api } = client();
  const trip = makeTrip();
  const events = Array.from({ length: 5000 }, (_, index) => expense(trip, index));
  assert.ok(Buffer.byteLength(JSON.stringify({ events })) > 1024 * 1024);
  api.setState(stateFor([trip], events));

  const bundle = await api.encryptedBundle(trip);
  const received = await api.decryptBundle(trip, bundle);
  assert.deepEqual(JSON.parse(JSON.stringify(received)), events);
});

test('records merged before a later trip fails survive reload and successful retries', async () => {
  const browser = client();
  const { api, context } = browser;
  const first = makeTrip(), second = makeTrip();
  const event = expense(first);
  api.setState(stateFor([first], [event]));
  const remote = await api.encryptedBundle(first);
  api.setState(stateFor([first, second]));
  api.save();
  context.navigator.onLine = true;
  let failSecond = true;
  context.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.tripId === second.id && failSecond) throw new Error('connection interrupted');
    return { ok: true, json: async () => ({ snapshots: request.tripId === first.id ? [remote] : [] }) };
  };

  await api.syncNow();
  assert.equal(api.getState().events.length, 1);
  assert.deepEqual(browser.stored().events, [event]);
  assert.equal(client(browser.stored()).api.getState().events.length, 1);

  failSecond = false;
  await api.syncNow();
  assert.equal(api.getState().events.length, 1, 'retry must not duplicate the imported record');
  assert.deepEqual(browser.stored().events, [event]);
});

test('records merged before a later snapshot fails decryption are still persisted', async () => {
  const browser = client();
  const { api, context } = browser;
  const trip = makeTrip();
  const event = expense(trip);
  api.setState(stateFor([trip], [event]));
  const remote = await api.encryptedBundle(trip);
  api.setState(stateFor([trip]));
  api.save();
  context.navigator.onLine = true;
  context.fetch = async () => ({
    ok: true,
    json: async () => ({ snapshots: [remote, { ...remote, data: 'invalid' }] }),
  });

  await api.syncNow();
  assert.equal(api.getState().events.length, 1);
  assert.deepEqual(browser.stored().events, [event]);
});

test('a successful bundle is persisted before a later trip request finishes', async () => {
  const browser = client();
  const { api, context } = browser;
  const first = makeTrip(), second = makeTrip();
  const event = expense(first);
  api.setState(stateFor([first], [event]));
  const remote = await api.encryptedBundle(first);
  api.setState(stateFor([first, second]));
  api.save();
  context.navigator.onLine = true;
  let markSecondStarted, finishSecond;
  const secondStarted = new Promise(resolve => { markSecondStarted = resolve; });
  const secondResponse = new Promise(resolve => { finishSecond = resolve; });
  context.fetch = async (_url, options) => {
    if (JSON.parse(options.body).tripId === second.id) {
      markSecondStarted();
      return secondResponse;
    }
    return { ok: true, json: async () => ({ snapshots: [remote] }) };
  };

  const pending = api.syncNow();
  await secondStarted;
  try {
    assert.deepEqual(browser.stored().events, [event]);
    assert.equal(client(browser.stored()).api.getState().events.length, 1);
  } finally {
    finishSecond({ ok: true, json: async () => ({ snapshots: [] }) });
    await pending;
  }
});

test('a failed storage write does not mark imported events as already persisted', async () => {
  const browser = client();
  const { api, context } = browser;
  const trip = makeTrip();
  const event = expense(trip);
  api.setState(stateFor([trip], [event]));
  const remote = await api.encryptedBundle(trip);
  api.setState(stateFor([trip]));
  api.save();
  context.navigator.onLine = true;
  context.fetch = async () => ({ ok: true, json: async () => ({ snapshots: [remote] }) });
  const setItem = context.localStorage.setItem;
  let failNextWrite = true;
  context.localStorage.setItem = (key, value) => {
    if (failNextWrite) {
      failNextWrite = false;
      throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
    }
    setItem(key, value);
  };

  await api.syncNow();
  assert.equal(api.getState().events.length, 0, 'failed imports must remain eligible for retry');
  assert.deepEqual(browser.stored().events, []);
  assert.equal(browser.badge().classList.waiting, true);

  await api.syncNow();
  assert.equal(api.getState().events.length, 1);
  assert.deepEqual(browser.stored().events, [event]);
  assert.equal(browser.badge().classList.waiting, false);
});

test('one failed trip does not prevent a later healthy trip from syncing', async () => {
  const browser = client();
  const { api, context } = browser;
  const first = makeTrip(), second = makeTrip();
  const event = expense(second);
  api.setState(stateFor([second], [event]));
  const remote = await api.encryptedBundle(second);
  api.setState(stateFor([first, second]));
  api.save();
  context.navigator.onLine = true;
  const requested = [];
  context.fetch = async (_url, options) => {
    const { tripId } = JSON.parse(options.body);
    requested.push(tripId);
    if (tripId === first.id) return { ok: false, status: 403 };
    return { ok: true, json: async () => ({ snapshots: [remote] }) };
  };

  await api.syncNow();
  assert.deepEqual(requested, [first.id, second.id]);
  assert.deepEqual(browser.stored().events, [event]);
  assert.equal(api.getState().events.length, 1);
  assert.equal(browser.badge().classList.waiting, true, 'the failed trip still needs a retry');
});
