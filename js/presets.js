// basePrice here must stay in sync with server/server.py's PRESET_BASE_PRICES —
// the server is the source of truth for what an order actually gets charged
// (it stamps the final price at creation time), this copy only drives the
// live "menu" price preview shown before an order is submitted.
const DRINK_PRESETS = [
  { drinkName: 'Espresso', size: 'small', prepTimeMinutes: 2, basePrice: 2.50 },
  { drinkName: 'Americano', size: 'medium', prepTimeMinutes: 3, basePrice: 3.00 },
  { drinkName: 'Drip Coffee', size: 'medium', prepTimeMinutes: 1, basePrice: 2.25 },
  { drinkName: 'Latte', size: 'medium', prepTimeMinutes: 4, basePrice: 4.25 },
  { drinkName: 'Cappuccino', size: 'medium', prepTimeMinutes: 4, basePrice: 4.00 },
  { drinkName: 'Mocha', size: 'medium', prepTimeMinutes: 5, basePrice: 4.75 },
  { drinkName: 'Cold Brew', size: 'medium', prepTimeMinutes: 2, basePrice: 4.00 },
  { drinkName: 'Matcha Latte', size: 'medium', prepTimeMinutes: 4, basePrice: 4.50 },
];

// Base price for a custom/typed-in drink that doesn't match a preset name.
const DEFAULT_BASE_PRICE = 4.00;

function getBasePriceForDrink(drinkName) {
  const preset = DRINK_PRESETS.find((p) => p.drinkName.toLowerCase() === String(drinkName).trim().toLowerCase());
  return preset ? preset.basePrice : DEFAULT_BASE_PRICE;
}
