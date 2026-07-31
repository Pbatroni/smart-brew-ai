const STORAGE_KEY = 'smart-brew-orders';

function loadOrders() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function saveOrders(orders) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(orders));
}

function createOrder(fields) {
  return {
    id: `${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    drinkName: fields.drinkName,
    size: fields.size,
    quantity: fields.quantity,
    prepTimeMinutes: fields.prepTimeMinutes,
    priority: fields.priority,
    timeReceived: Date.now(),
    status: 'waiting',
  };
}

function updateOrderStatus(orders, id, status) {
  return orders.map((order) =>
    order.id === id ? { ...order, status } : order
  );
}

function removeCompleted(orders) {
  return orders.filter((order) => order.status !== 'completed');
}
