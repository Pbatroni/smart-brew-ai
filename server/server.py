import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(__file__).resolve().parent / "data"
DATA_FILE = DATA_DIR / "orders.json"

# ---------------------------------------------------------------------------
# Dynamic coffee pricing (Alpha Vantage COFFEE commodity index)
#
# The API key lives in an environment variable, never in source — this file
# is public (pushed to GitHub, including a GitHub Pages deployment), so a
# hardcoded key would leak immediately. Set it before starting the server:
#   export ALPHA_VANTAGE_API_KEY=your_key_here
#   python3 server/server.py
# With no key set (or if the request fails/rate-limits/returns something we
# don't recognize), pricing quietly falls back to unadjusted base prices —
# the app must keep working either way.
# ---------------------------------------------------------------------------
ALPHA_VANTAGE_API_KEY = os.environ.get("ALPHA_VANTAGE_API_KEY")
ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query?function=COFFEE&interval=monthly&apikey={key}"

REFERENCE_COFFEE_PRICE = 5.0  # requirement: initial reference coffee price
MIN_PRICE_MULTIPLIER = 0.90  # menu prices can't fall more than 10%...
MAX_PRICE_MULTIPLIER = 1.15  # ...or rise more than 15%, regardless of how far the market moves

# Alpha Vantage's COFFEE series is published monthly, so re-fetching more
# often than this just burns API quota for data that hasn't changed. This is
# the "cache so we don't call the API on every menu click" requirement.
COFFEE_PRICE_CACHE_TTL_SECONDS = 60 * 60

# Base price per drink, keyed by the exact preset name. Must stay in sync
# with js/presets.js's DRINK_PRESETS — the server is what actually stamps a
# price onto an order, the client copy only drives the live menu preview.
PRESET_BASE_PRICES = {
    "Espresso": 2.50,
    "Americano": 3.00,
    "Drip Coffee": 2.25,
    "Latte": 4.25,
    "Cappuccino": 4.00,
    "Mocha": 4.75,
    "Cold Brew": 4.00,
    "Matcha Latte": 4.50,
}
DEFAULT_BASE_PRICE = 4.00  # used for a custom/typed-in drink that isn't a known preset

# In-memory cache: {"value": <float coffee price or None>, "fetched_at": <epoch seconds>}
_coffee_price_cache = {"value": None, "fetched_at": 0.0}


def fetch_coffee_price():
    """
    Calls the Alpha Vantage COFFEE endpoint and returns the most recent
    valid monthly price (data[0].value) as a float, or None if anything
    about the request or response isn't usable.

    This deliberately never raises for expected failure modes (missing key,
    network error, rate limit, malformed body) — every caller must be able
    to treat None as "fall back to base prices" without a try/except of
    their own.
    """
    if not ALPHA_VANTAGE_API_KEY:
        print("ALPHA_VANTAGE_API_KEY is not set; using base prices", file=sys.stderr)
        return None

    # This server is single-threaded (HTTPServer, not ThreadingHTTPServer —
    # see write_orders' comment for why), so a slow/hanging Alpha Vantage
    # response stalls every station's poll until this call returns. The
    # hourly cache means that's rare, but keep the timeout short so the
    # worst case is bounded rather than a multi-second freeze for everyone.
    url = ALPHA_VANTAGE_URL.format(key=ALPHA_VANTAGE_API_KEY)
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            raw = resp.read()
    except (urllib.error.URLError, TimeoutError, OSError) as err:
        print(f"coffee price request failed: {err}", file=sys.stderr)
        return None

    try:
        body = json.loads(raw)
    except json.JSONDecodeError as err:
        print(f"coffee price response was not valid JSON: {err}", file=sys.stderr)
        return None

    # Alpha Vantage answers HTTP 200 even when it's rejecting the request —
    # a bad/missing key or a hit rate limit comes back as a "Note" or
    # "Error Message" or "Information" key instead of "data". Any of those
    # (or a "data" that isn't a non-empty list) means: no usable price.
    data = body.get("data")
    if not isinstance(data, list) or not data:
        reason = body.get("Note") or body.get("Error Message") or body.get("Information") or body
        print(f"coffee price response had no usable data: {reason}", file=sys.stderr)
        return None

    try:
        value = float(data[0]["value"])
    except (KeyError, TypeError, ValueError) as err:
        print(f"coffee price data[0].value was invalid: {err}", file=sys.stderr)
        return None

    return value


def get_coffee_pricing():
    """
    Returns the current price-adjustment info, using a cached Alpha Vantage
    value when available (re-fetching at most once per
    COFFEE_PRICE_CACHE_TTL_SECONDS) and falling back to an unadjusted 1.0
    multiplier — i.e. base prices — whenever no valid value has ever been
    fetched. A failed refresh attempt does not clear a previously good
    cached value; it just tries again after the next TTL window.
    """
    now = time.time()
    if now - _coffee_price_cache["fetched_at"] > COFFEE_PRICE_CACHE_TTL_SECONDS:
        fetched = fetch_coffee_price()
        _coffee_price_cache["fetched_at"] = now
        if fetched is not None:
            _coffee_price_cache["value"] = fetched

    current_price = _coffee_price_cache["value"]
    if current_price is None:
        multiplier = 1.0
        source = "fallback"
    else:
        # requirement: adjustedPrice = basePrice * (currentCoffeePrice / referenceCoffeePrice),
        # clamped to [0.90, 1.15] so a wild commodity swing can't blow up the menu.
        raw_multiplier = current_price / REFERENCE_COFFEE_PRICE
        multiplier = max(MIN_PRICE_MULTIPLIER, min(MAX_PRICE_MULTIPLIER, raw_multiplier))
        source = "api"

    return {
        "multiplier": round(multiplier, 4),
        "source": source,
        "currentCoffeePrice": current_price,
        "referenceCoffeePrice": REFERENCE_COFFEE_PRICE,
    }


# Case-insensitive so a hand-typed "americano" prices the same as clicking
# the Americano preset — must match js/presets.js's getBasePriceForDrink,
# which already does a case-insensitive match; an earlier version of this
# function did an exact-case dict lookup and silently priced typed-in names
# at DEFAULT_BASE_PRICE instead of their real preset price whenever the
# barista's capitalization didn't exactly match.
_PRESET_BASE_PRICES_LOWER = {name.lower(): price for name, price in PRESET_BASE_PRICES.items()}


def price_for_drink(drink_name, quantity, pricing):
    """
    Computes the locked-in per-unit and line-total price for one order, given
    a specific coffeePricing snapshot (see get_coffee_pricing). Called once
    at order-creation time; the result is stored on the order and never
    recomputed from a live price afterward, so an order's price can't drift
    after the customer sees and agrees to it.
    """
    base_price = _PRESET_BASE_PRICES_LOWER.get(drink_name.strip().lower(), DEFAULT_BASE_PRICE)
    unit_price = round(base_price * pricing["multiplier"], 2)
    return {
        "basePrice": base_price,
        "unitPrice": unit_price,
        "lineTotal": round(unit_price * quantity, 2),
        "priceMultiplier": pricing["multiplier"],
        "priceSource": pricing["source"],
    }

VALID_SIZES = {"small", "medium", "large"}
VALID_PRIORITIES = {"normal", "high", "urgent"}
VALID_STATUSES = {"waiting", "in-progress", "completed", "cancelled"}
FINALIZED_STATUSES = {"completed", "cancelled"}
EDITABLE_FIELDS = {"drinkName", "size", "quantity", "prepTimeMinutes", "priority", "loyaltyMember"}

# Every transition the UI can produce, including the "undo" paths (completed ->
# in-progress, cancelled -> waiting/in-progress). Anything not listed here is
# rejected rather than silently accepted, so a stale client can't resurrect a
# finalized order (or otherwise skip states) just by sending a status the
# button-click logic happened to compute from outdated local state.
ALLOWED_STATUS_TRANSITIONS = {
    ("waiting", "in-progress"),
    ("waiting", "cancelled"),
    ("in-progress", "completed"),
    ("in-progress", "cancelled"),
    ("completed", "in-progress"),
    ("cancelled", "waiting"),
    ("cancelled", "in-progress"),
}

ORDER_ID_RE = re.compile(r"^/api/orders/([^/]+)$")


def read_orders():
    if not DATA_FILE.exists():
        return []
    with DATA_FILE.open("r") as f:
        try:
            return json.load(f)
        except json.JSONDecodeError:
            backup = DATA_FILE.with_suffix(".corrupt.json")
            DATA_FILE.replace(backup)
            print(f"orders.json was corrupt, backed up to {backup} and starting fresh", file=sys.stderr)
            return []


def write_orders(orders):
    # HTTPServer (not ThreadingHTTPServer) handles one request at a time, so the
    # read-modify-write in do_POST/do_PATCH below can't race across requests today.
    # If this server is ever switched to a threaded/multi-process server, this
    # needs a real lock (e.g. fcntl) around read+write, not just the atomic
    # rename below (which only protects against a corrupt file from a crash
    # mid-write, not lost updates from concurrent writers).
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp_file = DATA_FILE.with_suffix(".tmp")
    with tmp_file.open("w") as f:
        json.dump(orders, f, indent=2)
    os.replace(tmp_file, DATA_FILE)


def validate_new_order(fields):
    drink_name = str(fields.get("drinkName", "")).strip()
    size = fields.get("size")
    quantity = fields.get("quantity")
    prep_time = fields.get("prepTimeMinutes")
    priority = fields.get("priority")

    if not drink_name:
        return "drinkName is required"
    if size not in VALID_SIZES:
        return f"size must be one of {sorted(VALID_SIZES)}"
    if priority not in VALID_PRIORITIES:
        return f"priority must be one of {sorted(VALID_PRIORITIES)}"
    if not isinstance(quantity, (int, float)) or quantity < 1:
        return "quantity must be a number >= 1"
    if not isinstance(prep_time, (int, float)) or prep_time < 1:
        return "prepTimeMinutes must be a number >= 1"
    if "loyaltyMember" in fields and not isinstance(fields["loyaltyMember"], bool):
        return "loyaltyMember must be a boolean"
    return None


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT_DIR), **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw)

    def do_GET(self):
        if self.path == "/api/orders":
            # serverTime lets every client compute its own clock's offset from
            # this machine, so wait-time "aging" escalation (computed against
            # order.timeReceived, a server stamp) reads consistently across
            # stations even if a phone/tablet's local clock has drifted.
            # coffeePricing rides along on the same poll so the menu's live
            # price preview stays current without a separate endpoint/request.
            self._send_json(200, {
                "orders": read_orders(),
                "serverTime": int(time.time() * 1000),
                "coffeePricing": get_coffee_pricing(),
            })
            return
        super().do_GET()

    def do_POST(self):
        if self.path == "/api/orders":
            try:
                fields = self._read_json_body()
            except json.JSONDecodeError:
                self._send_json(400, {"error": "invalid JSON"})
                return

            error = validate_new_order(fields)
            if error:
                self._send_json(400, {"error": error})
                return

            drink_name = str(fields["drinkName"]).strip()
            quantity = fields["quantity"]
            # Price is computed and locked in right here, once, at creation —
            # never recalculated from a later/live coffee price. This is what
            # makes the price the customer saw on the menu the price they
            # actually pay, even if the market (or the cache) moves later.
            pricing = price_for_drink(drink_name, quantity, get_coffee_pricing())

            order = {
                "id": uuid.uuid4().hex,
                "drinkName": drink_name,
                "size": fields["size"],
                "quantity": quantity,
                "prepTimeMinutes": fields["prepTimeMinutes"],
                "priority": fields["priority"],
                "loyaltyMember": bool(fields.get("loyaltyMember", False)),
                **pricing,
                "timeReceived": int(time.time() * 1000),
                "status": "waiting",
                "version": 1,
            }

            orders = read_orders()
            orders.append(order)
            write_orders(orders)
            self._send_json(201, order)
            return

        self._send_json(404, {"error": "not found"})

    def do_PATCH(self):
        match = ORDER_ID_RE.match(self.path)
        if not match:
            self._send_json(404, {"error": "not found"})
            return

        order_id = match.group(1)
        try:
            fields = self._read_json_body()
        except json.JSONDecodeError:
            self._send_json(400, {"error": "invalid JSON"})
            return

        status = fields.get("status")
        edit_keys = EDITABLE_FIELDS & fields.keys()

        if "status" not in fields and not edit_keys:
            self._send_json(400, {"error": "no updatable fields provided"})
            return
        if "status" in fields and status not in VALID_STATUSES:
            self._send_json(400, {"error": f"status must be one of {sorted(VALID_STATUSES)}"})
            return
        if "expectedVersion" not in fields:
            self._send_json(400, {"error": "expectedVersion is required"})
            return

        orders = read_orders()
        target = next((order for order in orders if order["id"] == order_id), None)
        if target is None:
            self._send_json(404, {"error": "order not found"})
            return

        # Every device that fetched this order before making a change carries
        # the version it last saw. If another device mutated the order in the
        # meantime (e.g. someone else already canceled it, or an undo already
        # fired), this request is acting on stale state — reject it instead of
        # silently overwriting a change nobody on this screen has seen yet.
        if target.get("version") != fields["expectedVersion"]:
            self._send_json(409, {
                "error": "this order was changed by another device — refresh to see the latest",
            })
            return

        if "status" in fields and status != target["status"]:
            if (target["status"], status) not in ALLOWED_STATUS_TRANSITIONS:
                self._send_json(400, {"error": f"cannot change status from {target['status']} to {status}"})
                return

        if edit_keys:
            if target["status"] in FINALIZED_STATUSES:
                self._send_json(400, {"error": "cannot edit a completed or cancelled order"})
                return
            merged = {**target, **{k: fields[k] for k in edit_keys}}
            error = validate_new_order(merged)
            if error:
                self._send_json(400, {"error": error})
                return
            for key in edit_keys:
                if key == "drinkName":
                    target[key] = str(fields[key]).strip()
                elif key == "loyaltyMember":
                    target[key] = bool(fields[key])
                else:
                    target[key] = fields[key]

            # Editing the drink or quantity is a correction to what was
            # ordered, not a re-pricing event — recompute using the SAME
            # multiplier/source locked in at creation (never a fresh live
            # fetch), so the market-adjustment the customer saw never moves,
            # only the base price and/or line total it's applied to.
            if "drinkName" in edit_keys or "quantity" in edit_keys:
                locked_pricing = {"multiplier": target["priceMultiplier"], "source": target["priceSource"]}
                target.update(price_for_drink(target["drinkName"], target["quantity"], locked_pricing))

        if "status" in fields:
            target["status"] = status

        target["version"] = target.get("version", 1) + 1

        write_orders(orders)
        self._send_json(200, target)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
    server = HTTPServer(("0.0.0.0", port), Handler)
    print(f"Smart Brew AI server running at http://0.0.0.0:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
