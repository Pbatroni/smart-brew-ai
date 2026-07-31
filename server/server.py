import json
import os
import re
import sys
import time
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(__file__).resolve().parent / "data"
DATA_FILE = DATA_DIR / "orders.json"

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
            self._send_json(200, {"orders": read_orders(), "serverTime": int(time.time() * 1000)})
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

            order = {
                "id": uuid.uuid4().hex,
                "drinkName": str(fields["drinkName"]).strip(),
                "size": fields["size"],
                "quantity": fields["quantity"],
                "prepTimeMinutes": fields["prepTimeMinutes"],
                "priority": fields["priority"],
                "loyaltyMember": bool(fields.get("loyaltyMember", False)),
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
