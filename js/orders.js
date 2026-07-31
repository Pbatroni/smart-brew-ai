const API_BASE = '/api/orders';

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function fetchOrders() {
  const res = await fetch(API_BASE);
  if (!res.ok) throw new ApiError(`Failed to fetch orders: ${res.status}`, res.status);
  return res.json();
}

async function createOrder(fields) {
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

async function patchOrder(id, fields) {
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

function updateOrderStatus(id, status, expectedVersion) {
  return patchOrder(id, { status, expectedVersion });
}
