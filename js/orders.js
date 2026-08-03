const API_BASE = '/api/orders';
const DEMO_STORAGE_KEY = 'smart-brew-demo-orders';

// GitHub Pages (or any other purely static host) can't run the Python
// backend this app normally talks to. Rather than shipping a permanently
// "Reconnecting…" page there, fall back to an in-browser, localStorage-backed
// implementation of the exact same functions below, so every interactive
// feature still genuinely works for a visitor — just scoped to their own
// browser instead of syncing across devices, which a static host can't do
// regardless of what we build.
//
// Deliberately capability-based (probe the real API once, fall back only if
// that fails) rather than sniffing the hostname or a URL param: a hostname
// check breaks for a custom domain mapped onto Pages via CNAME (falls
// through to a dead backend), and a URL-param override is a footgun on a
// real deployment — a bookmarked or copy-pasted link with the param would
// silently strand that one device on an isolated local queue with no error.
// The decision is made once and cached for the session, so a real
// deployment that has a brief hiccup still shows the normal "Reconnecting…"
// banner and keeps retrying the real backend, instead of quietly switching
// this device to a demo queue no other station can see.
let demoModePromise = null;

function probeSignal() {
  return typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(2500) : undefined;
}

async function isDemoMode() {
  if (demoModePromise) return demoModePromise;
  demoModePromise = (async () => {
    try {
      const signal = probeSignal();
      const res = await fetch(API_BASE, signal ? { signal } : undefined);
      if (res.ok) {
        const body = await res.json();
        if (body && Array.isArray(body.orders)) return false;
      }
    } catch (err) {
      // network error, timeout, non-JSON 404 page (e.g. GitHub's own 404) — no real backend here
    }
    return true;
  })();
  return demoModePromise;
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// ---- Demo-mode (localStorage) backend — mirrors server/server.py's rules ----

const DEMO_VALID_SIZES = new Set(['small', 'medium', 'large']);
const DEMO_VALID_PRIORITIES = new Set(['normal', 'high', 'urgent']);
const DEMO_VALID_STATUSES = new Set(['waiting', 'in-progress', 'completed', 'cancelled']);
const DEMO_FINALIZED_STATUSES = new Set(['completed', 'cancelled']);
const DEMO_EDITABLE_FIELDS = new Set(['drinkName', 'size', 'quantity', 'prepTimeMinutes', 'priority', 'loyaltyMember']);
const DEMO_ALLOWED_TRANSITIONS = new Set([
  'waiting>in-progress',
  'waiting>cancelled',
  'in-progress>completed',
  'in-progress>cancelled',
  'completed>in-progress',
  'cancelled>waiting',
  'cancelled>in-progress',
]);

function demoReadOrders() {
  try {
    const raw = localStorage.getItem(DEMO_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn(`${DEMO_STORAGE_KEY} was corrupt in localStorage; starting fresh`, err);
    return [];
  }
}

function generateDemoId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return `demo-${crypto.randomUUID()}`;
  return `demo-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

function demoWriteOrders(orders) {
  localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(orders));
}

// Demo mode never has a real backend (or a safe place to keep an API key —
// anything shipped to the browser in a static deploy is public), so it
// always prices at the unadjusted base rate. This is exactly the same
// "fall back to base prices" behavior the real server uses when Alpha
// Vantage is unreachable, just permanent here rather than conditional.
const DEMO_REFERENCE_COFFEE_PRICE = 5.0;

// Note: this rounds with Math.round(x*100)/100 (half-up), while
// server.py's price_for_drink uses Python's round() (banker's rounding) —
// they can disagree by a cent at an exact .xx5 boundary. Currently
// unobservable here since demo mode always uses multiplier 1 (so unitPrice
// reduces to the already-2-decimal basePrice, never hitting a .xx5 case),
// but worth fixing for real parity if demo mode ever gets a non-1 multiplier.
function demoPriceForDrink(drinkName, quantity, pricing) {
  const basePrice = getBasePriceForDrink(drinkName);
  const unitPrice = Math.round(basePrice * pricing.multiplier * 100) / 100;
  return {
    basePrice,
    unitPrice,
    lineTotal: Math.round(unitPrice * quantity * 100) / 100,
    priceMultiplier: pricing.multiplier,
    priceSource: pricing.source,
  };
}

function demoValidateFields(fields) {
  const drinkName = String(fields.drinkName || '').trim();
  if (!drinkName) return 'drinkName is required';
  if (!DEMO_VALID_SIZES.has(fields.size)) return `size must be one of ${[...DEMO_VALID_SIZES].sort().join(', ')}`;
  if (!DEMO_VALID_PRIORITIES.has(fields.priority)) return `priority must be one of ${[...DEMO_VALID_PRIORITIES].sort().join(', ')}`;
  if (typeof fields.quantity !== 'number' || fields.quantity < 1) return 'quantity must be a number >= 1';
  if (typeof fields.prepTimeMinutes !== 'number' || fields.prepTimeMinutes < 1) return 'prepTimeMinutes must be a number >= 1';
  if ('loyaltyMember' in fields && typeof fields.loyaltyMember !== 'boolean') return 'loyaltyMember must be a boolean';
  return null;
}

async function demoFetchOrders() {
  return {
    orders: demoReadOrders(),
    serverTime: Date.now(),
    coffeePricing: {
      multiplier: 1,
      source: 'fallback',
      currentCoffeePrice: null,
      referenceCoffeePrice: DEMO_REFERENCE_COFFEE_PRICE,
    },
  };
}

async function demoCreateOrder(fields) {
  const error = demoValidateFields(fields);
  if (error) throw new ApiError(error, 400);

  const drinkName = String(fields.drinkName).trim();
  const order = {
    id: generateDemoId(),
    drinkName,
    size: fields.size,
    quantity: fields.quantity,
    prepTimeMinutes: fields.prepTimeMinutes,
    priority: fields.priority,
    loyaltyMember: Boolean(fields.loyaltyMember),
    ...demoPriceForDrink(drinkName, fields.quantity, { multiplier: 1, source: 'fallback' }),
    timeReceived: Date.now(),
    status: 'waiting',
    version: 1,
  };

  const orders = demoReadOrders();
  orders.push(order);
  demoWriteOrders(orders);
  return order;
}

// Check order deliberately mirrors server/server.py's do_PATCH exactly (shape
// of the request, then existence/version, then transition legality, then
// field edits) so the two stay behaviorally identical — a request that's
// invalid for more than one reason should fail with the same error either
// backend answers it.
async function demoPatchOrder(id, fields) {
  const editKeys = Object.keys(fields).filter((k) => DEMO_EDITABLE_FIELDS.has(k));

  if (!('status' in fields) && !editKeys.length) {
    throw new ApiError('no updatable fields provided', 400);
  }
  if ('status' in fields && !DEMO_VALID_STATUSES.has(fields.status)) {
    throw new ApiError(`status must be one of ${[...DEMO_VALID_STATUSES].sort().join(', ')}`, 400);
  }
  if (fields.expectedVersion === undefined) throw new ApiError('expectedVersion is required', 400);

  const orders = demoReadOrders();
  const target = orders.find((o) => o.id === id);
  if (!target) throw new ApiError('order not found', 404);

  if (target.version !== fields.expectedVersion) {
    throw new ApiError('this order was changed by another device — refresh to see the latest', 409);
  }

  if ('status' in fields && fields.status !== target.status) {
    if (!DEMO_ALLOWED_TRANSITIONS.has(`${target.status}>${fields.status}`)) {
      throw new ApiError(`cannot change status from ${target.status} to ${fields.status}`, 400);
    }
  }

  if (editKeys.length) {
    if (DEMO_FINALIZED_STATUSES.has(target.status)) {
      throw new ApiError('cannot edit a completed or cancelled order', 400);
    }
    const merged = { ...target };
    editKeys.forEach((k) => { merged[k] = fields[k]; });
    const error = demoValidateFields(merged);
    if (error) throw new ApiError(error, 400);
    editKeys.forEach((k) => {
      if (k === 'drinkName') target[k] = String(fields[k]).trim();
      else if (k === 'loyaltyMember') target[k] = Boolean(fields[k]);
      else target[k] = fields[k];
    });

    // Same rule as the real server: editing the drink or quantity re-prices
    // using the multiplier/source already locked onto this order, never a
    // fresh one — the market adjustment the customer saw doesn't move.
    if (editKeys.includes('drinkName') || editKeys.includes('quantity')) {
      Object.assign(target, demoPriceForDrink(target.drinkName, target.quantity, {
        multiplier: target.priceMultiplier,
        source: target.priceSource,
      }));
    }
  }

  if ('status' in fields) target.status = fields.status;
  target.version += 1;

  demoWriteOrders(orders);
  return target;
}

// ---- Real backend (fetch-based) — used for local/self-hosted deployments ----

async function realFetchOrders() {
  const res = await fetch(API_BASE);
  if (!res.ok) throw new ApiError(`Failed to fetch orders: ${res.status}`, res.status);
  return res.json();
}

async function realCreateOrder(fields) {
  const res = await fetch(API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error || `Failed to create order: ${res.status}`, res.status);
  }
  return res.json();
}

async function realPatchOrder(id, fields) {
  const res = await fetch(`${API_BASE}/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error || `Failed to update order: ${res.status}`, res.status);
  }
  return res.json();
}

// ---- Public API used by app.js — identical surface either way ----
// The mode probe (see isDemoMode above) only resolves once and is cached, so
// this await only adds a real wait on the very first call of the session.

async function fetchOrders() {
  return (await isDemoMode()) ? demoFetchOrders() : realFetchOrders();
}

async function createOrder(fields) {
  return (await isDemoMode()) ? demoCreateOrder(fields) : realCreateOrder(fields);
}

async function patchOrder(id, fields) {
  return (await isDemoMode()) ? demoPatchOrder(id, fields) : realPatchOrder(id, fields);
}

function updateOrderStatus(id, status, expectedVersion) {
  return patchOrder(id, { status, expectedVersion });
}
