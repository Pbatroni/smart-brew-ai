let orders = loadOrders();

const formEl = document.getElementById('order-form');
const formErrorEl = document.getElementById('form-error');
const queueEl = document.getElementById('order-queue');
const emptyMessageEl = document.getElementById('empty-queue-message');

function formatWaitTime(timeReceived) {
  const minutes = Math.max(0, Math.round((Date.now() - timeReceived) / 60000));
  return minutes <= 0 ? 'just now' : `${minutes} min ago`;
}

function persistAndRender() {
  saveOrders(orders);
  render();
}

function render() {
  const active = sortOrders(orders);

  queueEl.innerHTML = '';
  emptyMessageEl.hidden = active.length !== 0;

  active.forEach((order, index) => {
    const li = document.createElement('li');
    li.innerHTML = renderOrderCard(order, { isRecommended: index === 0 });
    queueEl.appendChild(li);
  });

  wireCardButtons();
}

function renderOrderCard(order, { isRecommended = false } = {}) {
  const statusLabel = order.status === 'in-progress' ? 'In Progress' : 'Waiting';
  const nextStatus = order.status === 'waiting' ? 'in-progress' : 'completed';
  const nextLabel = order.status === 'waiting' ? 'Start' : 'Complete';

  return `
    <div class="order-card priority-${order.priority}${isRecommended ? ' order-card--recommended' : ''}" data-id="${order.id}">
      ${isRecommended ? '<span class="badge">Make This Next</span>' : ''}
      <div class="order-card__title">${order.quantity}x ${order.drinkName} (${order.size})</div>
      <div class="order-card__meta">
        <span>Priority: ${order.priority}</span>
        <span>Prep: ${order.prepTimeMinutes} min</span>
        <span>${statusLabel}</span>
        <span>${formatWaitTime(order.timeReceived)}</span>
      </div>
      <div class="order-card__actions">
        <button type="button" class="status-btn" data-id="${order.id}" data-next-status="${nextStatus}">${nextLabel}</button>
      </div>
    </div>
  `;
}

function wireCardButtons() {
  document.querySelectorAll('.status-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const { id, nextStatus } = btn.dataset;
      orders = updateOrderStatus(orders, id, nextStatus);
      if (nextStatus === 'completed') {
        orders = removeCompleted(orders);
      }
      persistAndRender();
    });
  });
}

formEl.addEventListener('submit', (event) => {
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

  const order = createOrder({
    drinkName,
    size: formData.get('size'),
    quantity,
    prepTimeMinutes,
    priority: formData.get('priority'),
  });

  orders.push(order);
  persistAndRender();
  formEl.reset();
  document.getElementById('drink-name').focus();
});

render();
setInterval(render, 30000);
