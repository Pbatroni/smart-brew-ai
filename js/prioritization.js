const PRIORITY_WEIGHT = { urgent: 0, high: 1, normal: 2 };

function sortOrders(orders) {
  return orders
    .filter((order) => order.status !== 'completed')
    .slice()
    .sort((a, b) => {
      const priorityDiff = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority];
      if (priorityDiff !== 0) return priorityDiff;

      const waitDiff = a.timeReceived - b.timeReceived;
      if (waitDiff !== 0) return waitDiff;

      return a.prepTimeMinutes - b.prepTimeMinutes;
    });
}
