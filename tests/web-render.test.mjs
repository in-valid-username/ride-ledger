import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

function settlementFor(payer, currency) {
  const trip = { id: webcrypto.randomUUID(), name: '旅行', personA: 'A', personB: 'B', localPerson: 'a' };
  const state = {
    trips: [trip], activeTripId: trip.id, quickPrefs: {}, deviceId: webcrypto.randomUUID(),
    events: [{
      id: webcrypto.randomUUID(), tripId: trip.id, kind: 'expense', at: 1700000000000,
      data: { payer, currency, amount: 1000, shareA: 5000, mode: 'shared' },
    }],
  };
  const element = {
    addEventListener() {}, querySelectorAll: () => [], classList: { toggle() {} },
  };
  const context = vm.createContext({
    TextEncoder, TextDecoder, crypto: webcrypto, btoa, atob,
    history: {}, navigator: { onLine: false },
    localStorage: { getItem: () => JSON.stringify(state), setItem() {} },
    document: {
      getElementById: () => element, querySelectorAll: () => [], addEventListener() {},
    },
    window: { addEventListener() {}, scrollTo() {} },
    requestAnimationFrame() {}, setInterval() {},
  });
  // Run the unchanged production script and render a real ledger summary.
  // The test has no browser DOM, network, or executable markup sink.
  vm.runInContext(source, context, { filename: 'web/app.js' });
  return vm.runInContext('debtText(activeTrip(), summary(activeTrip()).debt)', context);
}

const unsafeCurrency = 'CNY<svg onload="void 0">&\'';
const escapedCurrency = 'CNY&lt;svg onload=&quot;void 0&quot;&gt;&amp;&#39;';

test('imported currency is escaped when B owes A', () => {
  const html = settlementFor('a', unsafeCurrency);
  assert.equal(html, 'B 应还 A 5.00 ' + escapedCurrency);
  assert.doesNotMatch(html, /<svg/i);
});

test('imported currency is escaped when A owes B', () => {
  const html = settlementFor('b', unsafeCurrency);
  assert.equal(html, 'A 应还 B 5.00 ' + escapedCurrency);
  assert.doesNotMatch(html, /<svg/i);
});

test('ordinary currency amounts retain their settlement formatting', () => {
  assert.equal(settlementFor('a', 'CNY'), 'B 应还 A 5.00 CNY');
  assert.equal(settlementFor('b', 'CNY'), 'A 应还 B 5.00 CNY');
});
