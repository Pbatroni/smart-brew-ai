const POLL_INTERVAL_MS = 3000;
const TOAST_DURATION_MS = 6000;
const AGING_WARNING_MINUTES = 5;
const AGING_CRITICAL_MINUTES = 10;
const SOUND_PREF_KEY = 'smart-brew-sound-enabled';

let orders = [];
let refreshInFlight = false;
let editingOrderId = null;
let editingOrderVersion = null;
let soundEnabled = localStorage.getItem(SOUND_PREF_KEY) !== 'false';

// A mutation is only safe from a false "another station did this" toast once
// markKnown() has recorded its result — but the server commits (and a
// scheduled poll can observe) the change the moment the network call resolves,
// before that JS line runs. If a poll's diff lands in that gap, it misreads
// the station's own action as remote. This counter closes the gap: any
// refreshOrders() call — including the periodic timer — is deferred while a
// local mutation is between "server responded" and "markKnown ran".
let pendingLocalMutations = 0;

async function mutateAndMarkKnown(mutationPromise) {
  pendingLocalMutations++;
  try {
    const updated = await mutationPromise;
    markKnown(updated);
    return updated;
  } finally {
    pendingLocalMutations--;
  }
}

const formEl = document.getElementById('order-form');
const formErrorEl = document.getElementById('form-error');
const queueEl = document.getElementById('order-queue');
const emptyMessageEl = document.getElementById('empty-queue-message');
const connectionBannerEl = document.getElementById('connection-banner');
const submitBtn = formEl.querySelector('button[type="submit"]');
const presetListEl = document.getElementById('preset-list');
const drinkNameInput = document.getElementById('drink-name');
const sizeInput = document.getElementById('size');
const quantityInput = document.getElementById('quantity');
const prepTimeInput = document.getElementById('prep-time');
const loyaltyMemberInput = document.getElementById('loyalty-member');
const toastContainerEl = document.getElementById('toast-container');
const syncStatusEl = document.getElementById('sync-status');
const soundToggleBtn = document.getElementById('sound-toggle');

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function renderPresets() {
  presetListEl.innerHTML = DRINK_PRESETS.map(
    (preset, index) => `<button type="button" class="preset-btn" data-index="${index}">${escapeHtml(preset.drinkName)}</button>`
  ).join('');

  presetListEl.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = DRINK_PRESETS[Number(btn.dataset.index)];
      drinkNameInput.value = preset.drinkName;
      sizeInput.value = preset.size;
      prepTimeInput.value = preset.prepTimeMinutes;

      presetListEl.querySelectorAll('.preset-btn').forEach((b) => b.classList.remove('preset-btn--active'));
      btn.classList.add('preset-btn--active');

      quantityInput.focus();
      quantityInput.select();
    });
  });
}

function clearActivePreset() {
  presetListEl.querySelectorAll('.preset-btn--active').forEach((b) => b.classList.remove('preset-btn--active'));
}

// Setting .value from renderPresets()'s click handler doesn't fire these events,
// so this only reacts to the barista actually retyping/reselecting by hand —
// keeps the active highlight from lying about what's in the form.
[drinkNameInput, sizeInput, prepTimeInput].forEach((el) => {
  el.addEventListener('input', clearActivePreset);
  el.addEventListener('change', clearActivePreset);
});

function setConnected(connected) {
  connectionBannerEl.hidden = connected;
  syncStatusEl.hidden = !connected;
}

// Every toast (info or undo) owns its own timer/handler state via closure
// rather than one shared module-level slot, so several arriving close together
// — e.g. finishing one drink while a remote-change notice pops in — don't
// clobber each other's dismiss timers or, worse, an undo action.
function createToast(message, { undoHandler } = {}) {
  const toastEl = document.createElement('div');
  toastEl.className = 'toast';
  toastEl.innerHTML = undoHandler
    ? `<span>${message}</span><button type="button">Undo</button>`
    : `<span>${message}</span>`;
  toastContainerEl.appendChild(toastEl);

  const timer = setTimeout(() => toastEl.remove(), TOAST_DURATION_MS);

  if (undoHandler) {
    toastEl.querySelector('button').addEventListener('click', async () => {
      clearTimeout(timer);
      toastEl.remove();
      await undoHandler();
    });
  }
}

function showInfoToast(message) {
  createToast(message);
}

function showUndoToast(orderId, drinkName, revertStatus, expectedVersion, actionLabel) {
  createToast(`${actionLabel}: ${escapeHtml(drinkName || 'order')}`, {
    undoHandler: async () => {
      try {
        await mutateAndMarkKnown(updateOrderStatus(orderId, revertStatus, expectedVersion));
        await refreshOrders();
      } catch (err) {
        if (err instanceof ApiError) {
          formErrorEl.textContent = err.message;
          formErrorEl.hidden = false;
          await refreshOrders();
        } else {
          setConnected(false);
        }
      }
    },
  });
}

// Browsers block audio until a real user gesture unlocks it. Catch the very
// first tap/click/keypress anywhere on the page (a barista is going to touch
// something within seconds of opening this) so later chimes triggered purely
// by a background poll — no gesture of their own — are still allowed to play.
let audioCtx = null;
function unlockAudio() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    audioCtx = new AudioContextClass();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
}
document.addEventListener('click', unlockAudio, { once: true });
document.addEventListener('keydown', unlockAudio, { once: true });

function playChime(urgent) {
  if (!soundEnabled || !audioCtx) return;
  const now = audioCtx.currentTime;
  const frequencies = urgent ? [880, 1108] : [660];
  frequencies.forEach((freq, i) => {
    const start = now + i * 0.15;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.2, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(start);
    osc.stop(start + 0.2);
  });
}

function setSoundEnabled(enabled) {
  soundEnabled = enabled;
  localStorage.setItem(SOUND_PREF_KEY, String(enabled));
  soundToggleBtn.textContent = enabled ? '🔊' : '🔇';
  soundToggleBtn.setAttribute('aria-pressed', String(enabled));
}

soundToggleBtn.addEventListener('click', () => {
  unlockAudio();
  setSoundEnabled(!soundEnabled);
});

setSoundEnabled(soundEnabled);

// How far this device's clock is from the server's, recomputed each poll so it
// self-corrects for drift. Without this, a station with a skewed system clock
// would show wildly wrong (or permanently absent) aging warnings — the whole
// point of aging is a signal that reads the same across every shared station.
let clockOffsetMs = 0;

// The last state this station has already given the barista feedback about —
// either because it fetched it before, or because an action *this* station
// just took was recorded here immediately (see markKnown). Diffing against
// this on every poll is what surfaces "another station did something" without
// re-notifying this station about its own actions.
let knownOrders = new Map();
let isInitialLoad = true;

function markKnown(order) {
  knownOrders.set(order.id, { status: order.status, drinkName: order.drinkName });
}

function describeRemoteStatus(status) {
  switch (status) {
    case 'in-progress': return 'started';
    case 'completed': return 'completed';
    case 'cancelled': return 'canceled';
    case 'waiting': return 'back in the queue';
    default: return status;
  }
}

function diffAndNotify(fetchedOrders) {
  if (isInitialLoad) return; // don't flood toasts for every pre-existing order on first load
  fetchedOrders.forEach((order) => {
    const known = knownOrders.get(order.id);
    if (!known) {
      if (order.status === 'waiting') {
        showInfoToast(`New order: ${escapeHtml(order.drinkName)}`);
        playChime(order.priority === 'urgent');
      }
      return;
    }
    if (known.status !== order.status) {
      showInfoToast(`${escapeHtml(order.drinkName)} ${describeRemoteStatus(order.status)} (another station)`);
    }
  });
}

async function refreshOrders() {
  if (refreshInFlight || pendingLocalMutations > 0) return;
  refreshInFlight = true;
  try {
    const { orders: fetchedOrders, serverTime } = await fetchOrders();
    diffAndNotify(fetchedOrders);
    orders = fetchedOrders;
    knownOrders = new Map(fetchedOrders.map((o) => [o.id, { status: o.status, drinkName: o.drinkName }]));
    isInitialLoad = false;
    clockOffsetMs = serverTime - Date.now();
    setConnected(true);
    // Don't blow away an in-progress edit's unsaved keystrokes on a background poll.
    if (!editingOrderId) render();
  } catch (err) {
    setConnected(false);
  } finally {
    refreshInFlight = false;
  }
}

function getWaitMinutes(timeReceived) {
  return Math.max(0, Math.round((Date.now() + clockOffsetMs - timeReceived) / 60000));
}

function formatWaitTime(timeReceived) {
  const minutes = getWaitMinutes(timeReceived);
  return minutes <= 0 ? 'just now' : `${minutes} min ago`;
}

// Independent of priority: even a normal-priority order can sit long enough to
// need a barista's attention. Not color-only — paired with an icon + bold text
// in the card so it reads for colorblind users too.
function getAgingTier(timeReceived) {
  const minutes = getWaitMinutes(timeReceived);
  if (minutes >= AGING_CRITICAL_MINUTES) return 'critical';
  if (minutes >= AGING_WARNING_MINUTES) return 'warning';
  return 'none';
}

function render() {
  const active = sortOrders(orders);

  queueEl.innerHTML = '';
  emptyMessageEl.hidden = active.length !== 0;

  active.forEach((order, index) => {
    const li = document.createElement('li');
    li.innerHTML = order.id === editingOrderId
      ? renderEditForm(order)
      : renderOrderCard(order, { isRecommended: index === 0 });
    queueEl.appendChild(li);
  });

  wireCardButtons();
}

function renderOrderCard(order, { isRecommended = false } = {}) {
  const statusLabel = order.status === 'in-progress' ? 'In Progress' : 'Waiting';
  const nextStatus = order.status === 'waiting' ? 'in-progress' : 'completed';
  const nextLabel = order.status === 'waiting' ? 'Start' : 'Complete';
  const drinkName = escapeHtml(order.drinkName);
  const agingTier = getAgingTier(order.timeReceived);
  const agingClass = agingTier !== 'none' ? ` order-card--aging-${agingTier}` : '';
  const agingIcon = agingTier !== 'none' ? '⚠ ' : '';

  return `
    <div class="order-card priority-${order.priority}${isRecommended ? ' order-card--recommended' : ''}${agingClass}" data-id="${order.id}">
      ${isRecommended ? '<span class="badge">Make This Next</span>' : ''}
      <div class="order-card__title">${order.loyaltyMember ? '⭐ ' : ''}${order.quantity}x ${drinkName} (${order.size})</div>
      <div class="order-card__meta">
        <span>Priority: ${order.priority}</span>
        <span>Prep: ${order.prepTimeMinutes} min</span>
        <span>${statusLabel}</span>
        <span class="wait-time wait-time--${agingTier}">${agingIcon}${formatWaitTime(order.timeReceived)}</span>
      </div>
      <div class="order-card__actions">
        <button type="button" class="status-btn" data-id="${order.id}" data-next-status="${nextStatus}" data-drink-name="${drinkName}" data-version="${order.version}">${nextLabel}</button>
        <button type="button" class="edit-btn" data-id="${order.id}" data-version="${order.version}">Edit</button>
        <button type="button" class="cancel-btn" data-id="${order.id}" data-current-status="${order.status}" data-drink-name="${drinkName}" data-version="${order.version}">Cancel</button>
      </div>
    </div>
  `;
}

function renderEditForm(order) {
  const sizeOption = (value, label) => `<option value="${value}" ${order.size === value ? 'selected' : ''}>${label}</option>`;
  const priorityOption = (value, label) => `<option value="${value}" ${order.priority === value ? 'selected' : ''}>${label}</option>`;

  return `
    <div class="order-card order-card--editing" data-id="${order.id}">
      <div class="form-row">
        <label for="edit-drink-name-${order.id}">Drink Name</label>
        <input type="text" id="edit-drink-name-${order.id}" value="${escapeHtml(order.drinkName)}" />
      </div>
      <div class="form-row">
        <label for="edit-size-${order.id}">Size</label>
        <select id="edit-size-${order.id}">
          ${sizeOption('small', 'Small')}
          ${sizeOption('medium', 'Medium')}
          ${sizeOption('large', 'Large')}
        </select>
      </div>
      <div class="form-row">
        <label for="edit-quantity-${order.id}">Quantity</label>
        <input type="number" id="edit-quantity-${order.id}" min="1" value="${order.quantity}" />
      </div>
      <div class="form-row">
        <label for="edit-prep-time-${order.id}">Prep Time (minutes)</label>
        <input type="number" id="edit-prep-time-${order.id}" min="1" value="${order.prepTimeMinutes}" />
      </div>
      <div class="form-row">
        <label for="edit-priority-${order.id}">Priority</label>
        <select id="edit-priority-${order.id}">
          ${priorityOption('normal', 'Normal')}
          ${priorityOption('high', 'High')}
          ${priorityOption('urgent', 'Urgent')}
        </select>
      </div>
      <div class="form-row form-row--checkbox">
        <input type="checkbox" id="edit-loyalty-member-${order.id}" ${order.loyaltyMember ? 'checked' : ''} />
        <label for="edit-loyalty-member-${order.id}">⭐ Loyalty Member</label>
      </div>
      <p class="edit-error form-error" hidden></p>
      <div class="order-card__actions">
        <button type="button" class="save-edit-btn" data-id="${order.id}">Save</button>
        <button type="button" class="cancel-edit-btn" data-id="${order.id}">Cancel</button>
      </div>
    </div>
  `;
}

function wireCardButtons() {
  document.querySelectorAll('.status-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const { id, nextStatus, drinkName, version } = btn.dataset;
      btn.disabled = true;
      try {
        const updated = await mutateAndMarkKnown(updateOrderStatus(id, nextStatus, Number(version)));
        if (nextStatus === 'completed') {
          showUndoToast(id, drinkName, 'in-progress', updated.version, 'Order completed');
        }
        await refreshOrders();
      } catch (err) {
        if (err instanceof ApiError) {
          formErrorEl.textContent = err.message;
          formErrorEl.hidden = false;
          await refreshOrders();
        } else {
          setConnected(false);
        }
        btn.disabled = false;
      }
    });
  });

  document.querySelectorAll('.cancel-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const { id, currentStatus, drinkName, version } = btn.dataset;
      btn.disabled = true;
      try {
        const updated = await mutateAndMarkKnown(updateOrderStatus(id, 'cancelled', Number(version)));
        showUndoToast(id, drinkName, currentStatus, updated.version, 'Order canceled');
        await refreshOrders();
      } catch (err) {
        if (err instanceof ApiError) {
          formErrorEl.textContent = err.message;
          formErrorEl.hidden = false;
          await refreshOrders();
        } else {
          setConnected(false);
        }
        btn.disabled = false;
      }
    });
  });

  document.querySelectorAll('.edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      editingOrderId = btn.dataset.id;
      editingOrderVersion = Number(btn.dataset.version);
      render();
    });
  });

  document.querySelectorAll('.cancel-edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      editingOrderId = null;
      editingOrderVersion = null;
      render();
    });
  });

  document.querySelectorAll('.save-edit-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const errorEl = document.querySelector(`.order-card--editing[data-id="${id}"] .edit-error`);
      const drinkName = document.getElementById(`edit-drink-name-${id}`).value.trim();
      const size = document.getElementById(`edit-size-${id}`).value;
      const quantity = Number(document.getElementById(`edit-quantity-${id}`).value);
      const prepTimeMinutes = Number(document.getElementById(`edit-prep-time-${id}`).value);
      const priority = document.getElementById(`edit-priority-${id}`).value;
      const loyaltyMember = document.getElementById(`edit-loyalty-member-${id}`).checked;

      if (!drinkName || !Number.isFinite(quantity) || quantity < 1 || !Number.isFinite(prepTimeMinutes) || prepTimeMinutes < 1) {
        errorEl.textContent = 'Please enter a drink name, and quantity/prep time of at least 1.';
        errorEl.hidden = false;
        return;
      }

      btn.disabled = true;
      try {
        await mutateAndMarkKnown(patchOrder(id, { drinkName, size, quantity, prepTimeMinutes, priority, loyaltyMember, expectedVersion: editingOrderVersion }));
        editingOrderId = null;
        editingOrderVersion = null;
        await refreshOrders();
      } catch (err) {
        if (err instanceof ApiError) {
          errorEl.textContent = err.message;
          errorEl.hidden = false;
        } else {
          setConnected(false);
        }
      } finally {
        btn.disabled = false;
      }
    });
  });
}

formEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  formErrorEl.hidden = true;

  const formData = new FormData(formEl);
  const drinkName = formData.get('drinkName').trim();
  const quantity = Number(formData.get('quantity'));
  const prepTimeMinutes = Number(formData.get('prepTimeMinutes'));

  if (!drinkName || !Number.isFinite(quantity) || quantity < 1 || !Number.isFinite(prepTimeMinutes) || prepTimeMinutes < 1) {
    formErrorEl.textContent = 'Please enter a drink name, and quantity/prep time of at least 1.';
    formErrorEl.hidden = false;
    return;
  }

  submitBtn.disabled = true;
  try {
    const created = await mutateAndMarkKnown(createOrder({
      drinkName,
      size: formData.get('size'),
      quantity,
      prepTimeMinutes,
      priority: formData.get('priority'),
      loyaltyMember: loyaltyMemberInput.checked,
    }));
    showInfoToast(`Order added: ${escapeHtml(created.drinkName)}`);
    playChime(created.priority === 'urgent');
    await refreshOrders();
    formEl.reset();
    clearActivePreset();
    drinkNameInput.focus();
  } catch (err) {
    if (err instanceof ApiError) {
      formErrorEl.textContent = err.message;
      formErrorEl.hidden = false;
    } else {
      setConnected(false);
    }
  } finally {
    submitBtn.disabled = false;
  }
});

renderPresets();
refreshOrders();
setInterval(refreshOrders, POLL_INTERVAL_MS);
