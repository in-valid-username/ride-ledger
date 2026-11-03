const STORAGE_KEY = 'ride-ledger-web-v1';
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let state;
try { state = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
catch { state = {}; }
state.trips ||= [];
state.events ||= [];
state.quickPrefs ||= {};
state.deviceId ||= crypto.randomUUID();
if (!state.trips.some(trip => trip.id === state.activeTripId))
  state.activeTripId = state.trips[0]?.id || null;
let currentView = 'quick';
function normalizeEventCurrency(event) {
  if (!event?.data) return false;
  let changed = false;
  for (const field of ['currency', 'fromCurrency', 'toCurrency']) {
    if (String(event.data[field] || '').toUpperCase() === 'RMB') {
      event.data[field] = 'CNY';
      changed = true;
    }
  }
  return changed;
}
let migratedCurrency = false;
for (const event of state.events) migratedCurrency = normalizeEventCurrency(event) || migratedCurrency;
if (migratedCurrency) localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
let syncing = false;
let toastTimer;

function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
function activeTrip() { return state.trips.find(trip => trip.id === state.activeTripId); }
function eventsFor(id) { return state.events.filter(event => event.tripId === id); }
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}
function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromBase64url(value) {
  const clean = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(clean + '='.repeat((4 - clean.length % 4) % 4)), char => char.charCodeAt(0));
}
function currencyCode(raw) {
  const entered = String(raw).trim().toUpperCase();
  const code = entered === 'RMB' ? 'CNY' : entered;
  if (!/^[A-Z]{3}$/.test(code)) throw new Error('请输入三位货币代码，例如 CNY');
  return code;
}
function quickCurrency(prefs) {
  try { return currencyCode(prefs.currency || 'CNY'); }
  catch { return 'CNY'; }
}
function quickCurrencyHistory(prefs) {
  const current = quickCurrency(prefs);
  const legacy = Array.isArray(prefs.currencies) ? prefs.currencies : [];
  const stored = Array.isArray(prefs.currencyHistory) ? prefs.currencyHistory
    : [...legacy, ...(current === 'CNY' ? [] : ['CNY'])];
  const codes = [];
  for (const raw of stored) {
    try {
      const code = currencyCode(raw);
      if (code !== current && !codes.includes(code)) codes.push(code);
    } catch { /* Skip malformed historical values. */ }
  }
  return codes.slice(0, 5);
}
function rememberQuickCurrency(tripId, raw) {
  const currency = currencyCode(raw);
  const prefs = state.quickPrefs[tripId] ||= {};
  const previous = quickCurrency(prefs);
  if (currency !== previous) {
    prefs.currencyHistory = [previous, ...quickCurrencyHistory(prefs)]
      .filter((code, index, codes) => code !== currency && codes.indexOf(code) === index).slice(0, 5);
    prefs.currency = currency;
    delete prefs.currencies;
    save();
  }
  return currency;
}
function refreshQuickCurrencyHistory() {
  const form = document.getElementById('quick-expense-form');
  if (!form) return;
  const history = quickCurrencyHistory(state.quickPrefs[activeTrip().id] || {});
  const toggle = form.querySelector('.currency-history-toggle');
  const menu = form.querySelector('.currency-history-menu');
  toggle.hidden = history.length === 0;
  toggle.setAttribute('aria-expanded', 'false');
  menu.hidden = true;
  menu.innerHTML = history.map(code =>
    '<button type="button" data-currency-history="' + code + '">' + code + '</button>').join('');
}
function scale(code) {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: code })
      .resolvedOptions().maximumFractionDigits;
  } catch { return 2; }
}
function parseAmount(raw, code) {
  const match = String(raw).trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) throw new Error('请输入有效的正数金额');
  const digits = scale(code);
  const fraction = match[2] || '';
  if (fraction.length > digits) throw new Error(code + ' 最多保留 ' + digits + ' 位小数');
  const value = BigInt(match[1]) * 10n ** BigInt(digits) +
    BigInt(fraction.padEnd(digits, '0') || '0');
  if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('金额超出范围');
  return Number(value);
}
function formatAmount(minor, code) {
  const digits = scale(code);
  const sign = minor < 0n ? '-' : '';
  const absolute = minor < 0n ? -minor : minor;
  const base = 10n ** BigInt(digits);
  const fraction = digits ? '.' + String(absolute % base).padStart(digits, '0') : '';
  return sign + String(absolute / base) + fraction + ' ' + code;
}
function addEvent(kind, data) {
  const trip = activeTrip();
  if (!trip) throw new Error('请先选择旅行');
  state.events.push({ id: crypto.randomUUID(), tripId: trip.id, kind, at: Date.now(), data });
  save();
  render();
  syncNow();
}
function addTo(map, code, delta) { map.set(code, (map.get(code) || 0n) + delta); }
function summary(trip) {
  const result = { cashA: new Map(), cashB: new Map(), debt: new Map(), spent: new Map(), visible: [] };
  const all = eventsFor(trip.id).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const deleted = new Set(all.filter(event => event.kind === 'delete').map(event => event.data.target));
  const cash = (person, code, delta) => addTo(person === 'a' ? result.cashA : result.cashB, code, delta);
  for (const event of all) {
    if (event.kind === 'delete' || deleted.has(event.id)) continue;
    const d = event.data;
    try {
      if (event.kind === 'opening' || event.kind === 'topup') {
        cash(d.person, d.currency, BigInt(d.amount));
      } else if (event.kind === 'expense') {
        const amount = BigInt(d.amount);
        const shareA = (amount * BigInt(d.shareA) + 5000n) / 10000n;
        cash(d.payer, d.currency, -amount);
        addTo(result.spent, d.currency, amount);
        addTo(result.debt, d.currency, d.payer === 'a' ? amount - shareA : -shareA);
      } else if (event.kind === 'transfer') {
        const amount = BigInt(d.amount);
        cash(d.from, d.currency, -amount);
        cash(d.from === 'a' ? 'b' : 'a', d.currency, amount);
        addTo(result.debt, d.currency, d.from === 'b' ? -amount : amount);
      } else if (event.kind === 'exchange') {
        cash(d.person, d.fromCurrency, -BigInt(d.fromAmount));
        cash(d.person, d.toCurrency, BigInt(d.toAmount));
      }
      result.visible.push(event);
    } catch { /* Ignore a malformed imported event. */ }
  }
  result.visible.reverse();
  return result;
}
function balanceText(map, empty = '尚未填写') {
  return map.size ? [...map].sort(([a], [b]) => a.localeCompare(b))
    .map(([code, amount]) => formatAmount(amount, code)).join('、') : empty;
}
function debtText(trip, map) {
  const items = [...map].sort(([a], [b]) => a.localeCompare(b))
    .filter(([, amount]) => amount !== 0n).map(([code, amount]) =>
      amount > 0n
        ? escapeHtml(trip.personB) + ' 应还 ' + escapeHtml(trip.personA) + ' ' + escapeHtml(formatAmount(amount, code))
        : escapeHtml(trip.personA) + ' 应还 ' + escapeHtml(trip.personB) + ' ' + escapeHtml(formatAmount(-amount, code)));
  return items.length ? items.join('<br>') : '目前已结清';
}
function eventLabel(trip, event) {
  const d = event.data;
  const name = person => person === 'a' ? trip.personA : trip.personB;
  if (event.kind === 'opening') return name(d.person) + ' · 期初现金';
  if (event.kind === 'topup') return name(d.person) + ' · 补充现金';
  if (event.kind === 'expense') return name(d.payer) + ' · ' + (d.mode === 'personal' ? '个人支出' : '共同支出');
  if (event.kind === 'transfer') return name(d.from) + ' · 还款';
  if (event.kind === 'exchange') return name(d.person) + ' · 换汇';
  return '记录';
}
function eventAmount(event) {
  const d = event.data;
  if (event.kind === 'exchange') return formatAmount(BigInt(d.fromAmount), d.fromCurrency) +
    ' → ' + formatAmount(BigInt(d.toAmount), d.toCurrency);
  return formatAmount(BigInt(d.amount), d.currency);
}
function renderQuick(trip) {
  const prefs = state.quickPrefs[trip.id] || {};
  const selectedCurrency = quickCurrency(prefs);
  const history = quickCurrencyHistory(prefs);
  const payer = prefs.payer === 'a' || prefs.payer === 'b' ? prefs.payer : trip.localPerson;
  const mode = prefs.mode === 'personal' ? 'personal' : 'shared';
  const share = Number.isInteger(prefs.shareA) ? prefs.shareA : 50;
  document.getElementById('main').innerHTML =
    '<section class="quick-screen"><div class="quick-heading"><span class="eyebrow">当前旅行</span><h1>' +
    escapeHtml(trip.name) + '</h1><p>记下刚才的支出，其他数据稍后再看。</p></div>' +
    '<form id="quick-expense-form" class="quick-card">' +
    '<div class="amount-row"><label class="amount-field">支付金额' +
    '<input name="amount" inputmode="decimal" autocomplete="off" required placeholder="0.00" aria-label="支付金额"></label>' +
    '<div class="currency-field"><label for="quick-currency">货币</label><div class="currency-control">' +
    '<input id="quick-currency" name="currency" maxlength="3" required autocomplete="off" spellcheck="false"' +
    ' aria-label="货币代码" value="' + selectedCurrency + '">' +
    '<button type="button" class="currency-history-toggle" aria-label="选择曾用货币" aria-expanded="false"' +
    (history.length ? '' : ' hidden') + '>⌄</button>' +
    '<div class="currency-history-menu" role="group" aria-label="曾用货币" hidden>' +
    history.map(code => '<button type="button" data-currency-history="' + code + '">' + code + '</button>').join('') +
    '</div></div></div></div>' +
    '<div class="routing-card"><div class="payer-row" role="group" aria-label="谁付款">' +
    '<span class="routing-label">谁付款</span>' +
    '<div class="payer-chips">' +
    '<label><input type="radio" name="payer" value="a" ' + (payer === 'a' ? 'checked' : '') +
    '><span>' + escapeHtml(trip.personA) + '</span></label>' +
    '<label><input type="radio" name="payer" value="b" ' + (payer === 'b' ? 'checked' : '') +
    '><span>' + escapeHtml(trip.personB) + '</span></label></div></div>' +
    '<div class="split-row"><label for="quick-mode" class="routing-label">怎么分摊</label>' +
    '<div class="split-select"><select id="quick-mode" name="mode" aria-label="怎么分摊">' +
    '<option value="shared" ' + (mode === 'shared' ? 'selected' : '') + '>两人平摊</option>' +
    '<option value="personal" ' + (mode === 'personal' ? 'selected' : '') + '>仅付款人</option>' +
    '</select></div></div>' +
    '<details class="split-details" ' + (mode === 'personal' ? 'hidden ' : '') +
    (share !== 50 ? 'open' : '') +
    '><summary>改分摊比例</summary><label>' + escapeHtml(trip.personA) +
    ' 分摊 <span class="percent-input"><input name="shareA" type="number" min="0" max="100" value="' +
    share + '">%</span></label></details></div>' +
    '<label class="note-field">备注 <small>可选</small><input name="note" placeholder="例如：房费、饭费"></label>' +
    '<button class="button primary save-expense" type="submit">保存这笔支出</button></form>' +
    '<p class="quick-footnote">无网时先保存在本机；连接后自动同步。</p></section>';
}
function renderReview(trip) {
  const sum = summary(trip);
  const entries = sum.visible.length ? sum.visible.map(event => {
    const date = new Date(event.at).toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });
    return '<div class="entry"><div><div class="entry-name">' + escapeHtml(eventLabel(trip, event)) +
      '</div><div class="entry-meta">' + escapeHtml(date) +
      (event.data.note ? ' · ' + escapeHtml(event.data.note) : '') +
      '</div></div><div class="entry-right"><span class="entry-amount">' +
      escapeHtml(eventAmount(event)) + '</span><button class="delete" title="删除记录" data-action="delete" data-event-id="' +
      escapeHtml(event.id) + '">×</button></div></div>';
  }).join('') : '<div class="empty">还没有记录。旅途中记下支出，之后在这里复盘。</div>';
  document.getElementById('main').innerHTML =
    '<div class="page-heading"><span class="eyebrow">TRIP REVIEW</span><h1>旅行复盘</h1><p>' +
    escapeHtml(trip.name) + '</p></div>' +
    '<div class="cards"><div class="card"><h3>总支出</h3><strong class="stat-value">' +
    escapeHtml(balanceText(sum.spent, '暂无支出')) + '</strong></div>' +
    '<div class="card"><h3>各自携带现金余额</h3>' +
    '<div class="balance-row"><span>' + escapeHtml(trip.personA) + '</span><strong>' +
    escapeHtml(balanceText(sum.cashA)) + '</strong></div><div class="balance-row"><span>' +
    escapeHtml(trip.personB) + '</span><strong>' + escapeHtml(balanceText(sum.cashB)) +
    '</strong></div></div><div class="card"><h3>两人结算</h3><div class="settlement">' +
    debtText(trip, sum.debt) + '</div><p class="muted">不同货币分别结算，期初现金不产生欠款。</p></div></div>' +
    '<div class="section-title"><h2>现金与结算</h2></div><div class="action-row">' +
    '<button class="button" data-action="opening">填写期初现金</button>' +
    '<button class="button" data-action="topup">补充现金</button>' +
    '<button class="button" data-action="transfer">两人还款</button>' +
    '<button class="button" data-action="exchange">记录换汇</button></div>' +
    '<div class="section-title"><h2>旅行记录</h2><span class="muted">' + sum.visible.length +
    ' 笔</span></div><div class="entries">' + entries + '</div>' +
    '<p class="sync-note">网页记录保存在当前浏览器。服务可用时会自动同步；安卓应用可在无互联网热点下直连同步。</p>';
}
function renderTrips(trip) {
  const cards = state.trips.map(item =>
    '<button class="trip-item ' + (item.id === trip.id ? 'active' : '') +
    '" data-trip-id="' + escapeHtml(item.id) + '"><span><strong>' + escapeHtml(item.name) +
    '</strong><small>' + escapeHtml(item.personA) + ' · ' + escapeHtml(item.personB) +
    '</small></span><em>' + (item.id === trip.id ? '当前旅行' : '切换') + '</em></button>').join('');
  document.getElementById('main').innerHTML =
    '<div class="page-heading"><span class="eyebrow">YOUR TRIPS</span><h1>我的旅行</h1>' +
    '<p>选择一段旅行后，记账页会一直打开它。</p></div>' +
    '<div class="action-row trip-actions"><button class="button primary" data-action="new">新建旅行</button>' +
    '<button class="button" data-action="join">凭邀请码加入</button></div>' +
    '<div class="trip-list">' + cards + '</div>' +
    '<div class="section-title"><h2>同行与同步</h2></div>' +
    '<div class="action-row"><button class="button" data-action="invite">分享当前旅行邀请码</button></div>' +
    '<p class="sync-note">安卓应用在同一热点下可直连同步。网页版会保存在当前浏览器，连上服务后同步。</p>';
}
function render() {
  const main = document.getElementById('main');
  const nav = document.getElementById('bottom-nav');
  const trip = activeTrip();
  nav.hidden = !trip;
  nav.querySelectorAll('[data-view]').forEach(button => {
    if (button.dataset.view === currentView) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  if (!trip) {
    main.innerHTML = '<div class="welcome"><div class="symbol">↗</div><h1>下一段旅程，从这里开始</h1>' +
      '<p>建立旅行后，之后每次打开都会直接进入快速记账。</p>' +
      '<div class="action-row"><button class="button primary" data-action="new">新建旅行</button>' +
      '<button class="button" data-action="join">凭邀请码加入</button></div></div>';
    return;
  }
  if (currentView === 'review') renderReview(trip);
  else if (currentView === 'trips') renderTrips(trip);
  else renderQuick(trip);
}
function toast(message) {
  const element = document.getElementById('toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), 3200);
}
function openDialog(name) {
  const trip = activeTrip();
  if (trip) {
    document.querySelectorAll('.person-select').forEach(select => {
      select.innerHTML = '<option value="a">' + escapeHtml(trip.personA) +
        '</option><option value="b">' + escapeHtml(trip.personB) + '</option>';
      select.value = trip.localPerson;
    });
  }
  document.getElementById(name + '-dialog').showModal();
}
function closeDialog(form) { form.closest('dialog').close(); form.reset(); }
function inviteCode(trip) {
  return base64url(encoder.encode(JSON.stringify({
    id: trip.id, name: trip.name, personA: trip.personA, personB: trip.personB, secret: trip.secret
  })));
}
function setBadge(text, waiting = false) {
  const badge = document.getElementById('sync-badge');
  badge.textContent = text;
  badge.classList.toggle('waiting', waiting);
}
async function encryptedBundle(trip) {
  const key = await crypto.subtle.importKey('raw', fromBase64url(trip.secret), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = encoder.encode(JSON.stringify({ events: eventsFor(trip.id) }));
  const data = new Uint8Array(await crypto.subtle.encrypt({
    name: 'AES-GCM', iv, additionalData: encoder.encode(trip.id), tagLength: 128
  }, key, plain));
  return { tripId: trip.id, iv: base64url(iv), data: base64url(data) };
}
async function tripToken(trip) {
  const key = await crypto.subtle.importKey('raw', fromBase64url(trip.secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key,
    encoder.encode('ride-ledger-cloud-v1:' + trip.id))));
}
async function decryptBundle(trip, bundle) {
  if (bundle.tripId !== trip.id) return [];
  const key = await crypto.subtle.importKey('raw', fromBase64url(trip.secret), 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({
    name: 'AES-GCM', iv: fromBase64url(bundle.iv),
    additionalData: encoder.encode(trip.id), tagLength: 128
  }, key, fromBase64url(bundle.data));
  return JSON.parse(decoder.decode(plain)).events;
}
async function syncNow() {
  if (syncing || !state.trips.length) return;
  if (!navigator.onLine) {
    setBadge('离线保存 · 待同步', true);
    return;
  }
  syncing = true;
  setBadge('正在同步');
  let added = 0;
  try {
    for (const trip of state.trips) {
      const response = await fetch('/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Trip-Token': await tripToken(trip) },
        body: JSON.stringify({
          tripId: trip.id, deviceId: state.deviceId, bundle: await encryptedBundle(trip)
        })
      });
      if (!response.ok) throw new Error('服务返回 ' + response.status);
      const { snapshots } = await response.json();
      const known = new Set(state.events.map(event => event.id));
      for (const bundle of snapshots) {
        for (const event of await decryptBundle(trip, bundle)) {
          if (event.tripId !== trip.id || !event.id || known.has(event.id)) continue;
          normalizeEventCurrency(event);
          state.events.push(event);
          known.add(event.id);
          added++;
        }
      }
    }
    if (added) {
      save();
      if (currentView !== 'quick') render();
    }
    setBadge(added ? '已同步 · 新增 ' + added + ' 笔' : '已同步');
  } catch (error) { setBadge('离线保存 · 待同步', true); }
  finally { syncing = false; }
}

document.getElementById('main').addEventListener('click', event => {
  const historyOption = event.target.closest('[data-currency-history]');
  if (historyOption) {
    const input = document.getElementById('quick-currency');
    input.value = rememberQuickCurrency(activeTrip().id, historyOption.dataset.currencyHistory);
    refreshQuickCurrencyHistory();
    return;
  }
  const historyToggle = event.target.closest('.currency-history-toggle');
  if (historyToggle) {
    const menu = document.querySelector('#quick-expense-form .currency-history-menu');
    menu.hidden = !menu.hidden;
    historyToggle.setAttribute('aria-expanded', String(!menu.hidden));
    return;
  }
  const historyMenu = document.querySelector('#quick-expense-form .currency-history-menu');
  if (historyMenu && !event.target.closest('.currency-control')) {
    historyMenu.hidden = true;
    document.querySelector('.currency-history-toggle').setAttribute('aria-expanded', 'false');
  }
  const tripButton = event.target.closest('[data-trip-id]');
  if (tripButton) {
    state.activeTripId = tripButton.dataset.tripId;
    currentView = 'quick';
    save();
    render();
    window.scrollTo(0, 0);
    return;
  }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'new') return openDialog('trip');
  if (action === 'join') return openDialog('join');
  if (action === 'delete') {
    if (confirm('删除这笔记录？')) addEvent('delete', { target: button.dataset.eventId });
    return;
  }
  if (action === 'invite') {
    document.getElementById('invite-code').value = inviteCode(activeTrip());
    return openDialog('invite');
  }
  openDialog(action);
});
document.getElementById('bottom-nav').addEventListener('click', event => {
  const button = event.target.closest('[data-view]');
  if (!button) return;
  currentView = button.dataset.view;
  render();
  window.scrollTo(0, 0);
});
document.getElementById('main').addEventListener('submit', event => {
  if (event.target.id !== 'quick-expense-form') return;
  event.preventDefault();
  const trip = activeTrip();
  const data = new FormData(event.target);
  try {
    const currency = currencyCode(data.get('currency'));
    const amount = parseAmount(data.get('amount'), currency);
    const payer = data.get('payer');
    const mode = data.get('mode');
    const percentage = Number(data.get('shareA'));
    if (!['a', 'b'].includes(payer) || !['shared', 'personal'].includes(mode) ||
        !Number.isInteger(percentage) || percentage < 0 || percentage > 100)
      throw new Error('请检查付款人、类型和分摊比例');
    rememberQuickCurrency(trip.id, currency);
    Object.assign(state.quickPrefs[trip.id], { currency, payer, mode, shareA: percentage });
    addEvent('expense', {
      payer, currency, amount,
      shareA: mode === 'personal' ? (payer === 'a' ? 10000 : 0) : percentage * 100,
      mode, note: String(data.get('note') || '').trim()
    });
    toast('已记账');
  } catch (error) { toast(error.message || '记录失败'); }
});
document.getElementById('main').addEventListener('input', event => {
  if (event.target.id !== 'quick-currency') return;
  try {
    rememberQuickCurrency(activeTrip().id, event.target.value);
    refreshQuickCurrencyHistory();
  } catch { /* Keep partially entered codes editable. */ }
});
document.getElementById('main').addEventListener('change', event => {
  if (event.target.id === 'quick-currency') {
    try {
      event.target.value = rememberQuickCurrency(activeTrip().id, event.target.value);
      refreshQuickCurrencyHistory();
    } catch { /* Submit will show a validation message. */ }
    return;
  }
  if (event.target.name !== 'mode') return;
  const details = document.querySelector('#quick-expense-form .split-details');
  if (details) details.hidden = event.target.value === 'personal';
});
document.querySelectorAll('dialog .cancel').forEach(button =>
  button.addEventListener('click', () => button.closest('dialog').close()));
document.getElementById('copy-invite').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(document.getElementById('invite-code').value); toast('邀请码已复制'); }
  catch { document.getElementById('invite-code').select(); toast('已选中邀请码，请手动复制'); }
});
document.getElementById('trip-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget, data = new FormData(form);
  const secret = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const trip = { id: crypto.randomUUID(), name: data.get('name').trim(),
    personA: data.get('personA').trim(), personB: data.get('personB').trim(),
    secret, localPerson: 'a' };
  if (!trip.name || !trip.personA || !trip.personB) return toast('请填写完整信息');
  state.trips.unshift(trip);
  state.activeTripId = trip.id;
  currentView = 'quick';
  save(); closeDialog(form); render(); window.scrollTo(0, 0); syncNow();
});
document.getElementById('join-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const invite = JSON.parse(decoder.decode(fromBase64url(new FormData(form).get('code').trim())));
    if (!/^[a-f0-9-]{36}$/i.test(invite.id) || fromBase64url(invite.secret).length !== 32 ||
        !invite.name || !invite.personA || !invite.personB) throw new Error('邀请码无效');
    if (state.trips.some(trip => trip.id === invite.id)) throw new Error('这个旅行已加入');
    state.trips.unshift({ ...invite, localPerson: 'b' });
    state.activeTripId = invite.id;
    currentView = 'quick';
    save(); closeDialog(form); render(); window.scrollTo(0, 0); syncNow();
  } catch (error) { toast(error.message || '邀请码无效'); }
});
function registerEntryForm(id, kind, makeData) {
  document.getElementById(id).addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      addEvent(kind, makeData(new FormData(form)));
      closeDialog(form);
    } catch (error) { toast(error.message || '记录失败'); }
  });
}
registerEntryForm('opening-form', 'opening', d => {
  const currency = currencyCode(d.get('currency'));
  return { person: d.get('person'), currency, amount: parseAmount(d.get('amount'), currency) };
});
registerEntryForm('topup-form', 'topup', d => {
  const currency = currencyCode(d.get('currency'));
  return { person: d.get('person'), currency, amount: parseAmount(d.get('amount'), currency) };
});
registerEntryForm('transfer-form', 'transfer', d => {
  const currency = currencyCode(d.get('currency'));
  return { from: d.get('from'), currency, amount: parseAmount(d.get('amount'), currency) };
});
registerEntryForm('exchange-form', 'exchange', d => {
  const fromCurrency = currencyCode(d.get('fromCurrency'));
  const toCurrency = currencyCode(d.get('toCurrency'));
  if (fromCurrency === toCurrency) throw new Error('请选择两种不同货币');
  return { person: d.get('person'), fromCurrency, toCurrency,
    fromAmount: parseAmount(d.get('fromAmount'), fromCurrency),
    toAmount: parseAmount(d.get('toAmount'), toCurrency) };
});
render();
window.addEventListener('pageshow', event => {
  if (event.persisted) { currentView = 'quick'; render(); }
  window.scrollTo(0, 0);
});
requestAnimationFrame(() => window.scrollTo(0, 0));
syncNow();
setInterval(syncNow, 15000);
window.addEventListener('online', syncNow);
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncNow(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
