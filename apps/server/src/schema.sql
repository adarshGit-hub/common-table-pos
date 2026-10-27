PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS outlets (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata', currency TEXT NOT NULL DEFAULT 'INR',
  tax_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK(tax_rate_bps BETWEEN 0 AND 10000),
  receipt_name TEXT, receipt_address TEXT, receipt_phone TEXT, gstin TEXT, receipt_footer TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS terminals (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, outlet_id TEXT NOT NULL, name TEXT NOT NULL,
  device_key_hash TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(tenant_id,outlet_id) REFERENCES outlets(tenant_id,id), UNIQUE(tenant_id,outlet_id,id)
);
CREATE TABLE IF NOT EXISTS menu_items (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, outlet_id TEXT NOT NULL, name TEXT NOT NULL,
  category TEXT NOT NULL, price_minor INTEGER NOT NULL CHECK(price_minor >= 0), emoji TEXT NOT NULL,
  color TEXT NOT NULL, tag TEXT, vegetarian INTEGER NOT NULL DEFAULT 0, available INTEGER NOT NULL DEFAULT 1,
  kitchen_station TEXT NOT NULL, tax_code TEXT, tax_rate_bps INTEGER CHECK(tax_rate_bps BETWEEN 0 AND 10000), version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(tenant_id,outlet_id) REFERENCES outlets(tenant_id,id), UNIQUE(tenant_id,outlet_id,id)
);
CREATE TABLE IF NOT EXISTS menu_modifiers (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, outlet_id TEXT NOT NULL, menu_item_id TEXT NOT NULL,
  group_name TEXT NOT NULL, name TEXT NOT NULL, price_delta_minor INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(tenant_id,outlet_id,menu_item_id) REFERENCES menu_items(tenant_id,outlet_id,id),
  UNIQUE(tenant_id,outlet_id,id)
);
CREATE INDEX IF NOT EXISTS modifiers_by_item ON menu_modifiers(tenant_id,outlet_id,menu_item_id,group_name,sort_order);
CREATE TABLE IF NOT EXISTS edge_inventory_items (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, outlet_id TEXT NOT NULL, name TEXT NOT NULL,
  unit TEXT NOT NULL, reorder_level REAL NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)),
  cloud_on_hand REAL NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY(tenant_id,outlet_id) REFERENCES outlets(tenant_id,id), UNIQUE(tenant_id,outlet_id,id)
);
CREATE TABLE IF NOT EXISTS edge_inventory_recipes (
  tenant_id TEXT NOT NULL, outlet_id TEXT NOT NULL, menu_item_id TEXT NOT NULL, inventory_item_id TEXT NOT NULL,
  quantity_per_sale REAL NOT NULL CHECK(quantity_per_sale > 0),
  PRIMARY KEY(tenant_id,outlet_id,menu_item_id,inventory_item_id),
  FOREIGN KEY(tenant_id,outlet_id,menu_item_id) REFERENCES menu_items(tenant_id,outlet_id,id),
  FOREIGN KEY(tenant_id,outlet_id,inventory_item_id) REFERENCES edge_inventory_items(tenant_id,outlet_id,id)
);
CREATE INDEX IF NOT EXISTS edge_inventory_recipes_by_item ON edge_inventory_recipes(tenant_id,outlet_id,inventory_item_id);
CREATE TABLE IF NOT EXISTS edge_inventory_movements (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, command_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL, outlet_id TEXT NOT NULL, inventory_item_id TEXT NOT NULL, order_id TEXT NOT NULL,
  actor_id TEXT NOT NULL, quantity REAL NOT NULL CHECK(quantity > 0), quantity_delta REAL NOT NULL CHECK(quantity_delta = -quantity),
  reason TEXT NOT NULL, occurred_at TEXT NOT NULL, synced INTEGER NOT NULL DEFAULT 0 CHECK(synced IN (0,1))
);
CREATE INDEX IF NOT EXISTS edge_inventory_movements_by_item ON edge_inventory_movements(tenant_id,outlet_id,inventory_item_id,occurred_at DESC);
CREATE TABLE IF NOT EXISTS edge_manual_inventory_movements (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, command_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL, outlet_id TEXT NOT NULL, inventory_item_id TEXT NOT NULL,
  movement_type TEXT NOT NULL CHECK(movement_type IN ('receipt','waste','count_adjustment')),
  quantity REAL NOT NULL CHECK(quantity >= 0), expected_balance REAL,
  quantity_delta REAL NOT NULL, reason TEXT NOT NULL, actor_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL, synced INTEGER NOT NULL DEFAULT 0 CHECK(synced IN (0,1)), superseded_at TEXT,
  CHECK((movement_type='receipt' AND quantity>0 AND expected_balance IS NULL AND quantity_delta=quantity)
    OR (movement_type='waste' AND quantity>0 AND expected_balance IS NULL AND quantity_delta=-quantity)
    OR (movement_type='count_adjustment' AND expected_balance IS NOT NULL AND quantity_delta=quantity-expected_balance))
);
CREATE INDEX IF NOT EXISTS edge_manual_inventory_movements_by_item
  ON edge_manual_inventory_movements(tenant_id,outlet_id,inventory_item_id,occurred_at DESC);
CREATE TABLE IF NOT EXISTS menu_sync_state (
  tenant_id TEXT NOT NULL, outlet_id TEXT NOT NULL, version TEXT NOT NULL,
  last_synced_at TEXT NOT NULL, last_error TEXT,
  PRIMARY KEY(tenant_id,outlet_id),
  FOREIGN KEY(tenant_id,outlet_id) REFERENCES outlets(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS dining_areas (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, outlet_id TEXT NOT NULL, name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  FOREIGN KEY(tenant_id,outlet_id) REFERENCES outlets(tenant_id,id), UNIQUE(tenant_id,outlet_id,id),
  UNIQUE(tenant_id,outlet_id,name)
);
CREATE TABLE IF NOT EXISTS dining_tables (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, outlet_id TEXT NOT NULL, area_id TEXT NOT NULL,
  name TEXT NOT NULL, capacity INTEGER NOT NULL CHECK(capacity BETWEEN 1 AND 50),
  sort_order INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  FOREIGN KEY(tenant_id,outlet_id,area_id) REFERENCES dining_areas(tenant_id,outlet_id,id) ON DELETE CASCADE,
  UNIQUE(tenant_id,outlet_id,id), UNIQUE(tenant_id,outlet_id,name)
);
CREATE TABLE IF NOT EXISTS kitchen_stations (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, outlet_id TEXT NOT NULL, name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  FOREIGN KEY(tenant_id,outlet_id) REFERENCES outlets(tenant_id,id), UNIQUE(tenant_id,outlet_id,id),
  UNIQUE(tenant_id,outlet_id,name)
);
CREATE INDEX IF NOT EXISTS dining_tables_by_area ON dining_tables(tenant_id,outlet_id,area_id,sort_order);
CREATE TABLE IF NOT EXISTS outlet_counters (
  tenant_id TEXT NOT NULL, outlet_id TEXT NOT NULL, counter_name TEXT NOT NULL, next_value INTEGER NOT NULL,
  PRIMARY KEY(tenant_id,outlet_id,counter_name),
  FOREIGN KEY(tenant_id,outlet_id) REFERENCES outlets(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, tenant_id TEXT NOT NULL, outlet_id TEXT NOT NULL,
  terminal_id TEXT NOT NULL, order_number TEXT NOT NULL, order_type TEXT NOT NULL CHECK(order_type IN ('dine_in','takeaway')),
  table_label TEXT, guest_count INTEGER NOT NULL DEFAULT 1 CHECK(guest_count > 0),
  status TEXT NOT NULL CHECK(status IN ('sent','preparing','ready','paid','cancelled')),
  note TEXT, currency TEXT NOT NULL DEFAULT 'INR', subtotal_minor INTEGER NOT NULL,
  tax_total_minor INTEGER NOT NULL, tax_rate_bps INTEGER NOT NULL DEFAULT 0,
  total_minor INTEGER NOT NULL, payment_method TEXT, invoice_number TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY(tenant_id,outlet_id) REFERENCES outlets(tenant_id,id),
  FOREIGN KEY(tenant_id,outlet_id,terminal_id) REFERENCES terminals(tenant_id,outlet_id,id),
  UNIQUE(tenant_id,outlet_id,order_number), UNIQUE(tenant_id,outlet_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS orders_invoice_number ON orders(tenant_id,outlet_id,invoice_number)
  WHERE invoice_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_kitchen_queue ON orders(tenant_id,outlet_id,status,created_at)
  WHERE status IN ('sent','preparing','ready');
CREATE INDEX IF NOT EXISTS orders_outlet_history ON orders(tenant_id,outlet_id,created_at DESC);
CREATE TABLE IF NOT EXISTS order_lines (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, outlet_id TEXT NOT NULL, order_id TEXT NOT NULL,
  menu_item_id TEXT NOT NULL, item_name_snapshot TEXT NOT NULL, category_snapshot TEXT NOT NULL,
  unit_price_minor INTEGER NOT NULL, modifiers_json TEXT NOT NULL DEFAULT '[]', quantity REAL NOT NULL CHECK(quantity > 0),
  line_total_minor INTEGER NOT NULL, kitchen_station TEXT NOT NULL, note TEXT, tax_code_snapshot TEXT, tax_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK(tax_rate_bps BETWEEN 0 AND 10000),
  FOREIGN KEY(tenant_id,outlet_id,order_id) REFERENCES orders(tenant_id,outlet_id,id),
  FOREIGN KEY(tenant_id,outlet_id,menu_item_id) REFERENCES menu_items(tenant_id,outlet_id,id)
);
CREATE INDEX IF NOT EXISTS order_lines_by_order ON order_lines(tenant_id,outlet_id,order_id);
CREATE TABLE IF NOT EXISTS order_line_voids (
  order_line_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, outlet_id TEXT NOT NULL, order_id TEXT NOT NULL,
  actor_id TEXT NOT NULL, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 120), voided_at TEXT NOT NULL,
  FOREIGN KEY(tenant_id,outlet_id,order_id) REFERENCES orders(tenant_id,outlet_id,id),
  FOREIGN KEY(order_line_id) REFERENCES order_lines(id)
);
CREATE INDEX IF NOT EXISTS order_line_voids_by_order ON order_line_voids(tenant_id,outlet_id,order_id);
CREATE TABLE IF NOT EXISTS order_edit_commands (
  command_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, outlet_id TEXT NOT NULL, order_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('lines_added','line_voided','order_voided')),
  request_json TEXT NOT NULL, occurred_at TEXT NOT NULL,
  FOREIGN KEY(tenant_id,outlet_id,order_id) REFERENCES orders(tenant_id,outlet_id,id)
);
CREATE TABLE IF NOT EXISTS kitchen_tickets (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, outlet_id TEXT NOT NULL, order_id TEXT NOT NULL,
  station TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('new','preparing','ready','voided')),
  created_at TEXT NOT NULL, ready_at TEXT,
  FOREIGN KEY(tenant_id,outlet_id,order_id) REFERENCES orders(tenant_id,outlet_id,id)
);
CREATE INDEX IF NOT EXISTS tickets_by_station ON kitchen_tickets(tenant_id,outlet_id,station,status,created_at);
CREATE TABLE IF NOT EXISTS shifts (
  id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, tenant_id TEXT NOT NULL, outlet_id TEXT NOT NULL,
  terminal_id TEXT NOT NULL, actor_id TEXT NOT NULL, shift_number TEXT NOT NULL,
  opening_float_minor INTEGER NOT NULL CHECK(opening_float_minor >= 0),
  status TEXT NOT NULL CHECK(status IN ('open','closed')), opened_at TEXT NOT NULL, closed_at TEXT,
  close_command_id TEXT UNIQUE, counted_cash_minor INTEGER, expected_cash_minor INTEGER, variance_minor INTEGER,
  FOREIGN KEY(tenant_id,outlet_id) REFERENCES outlets(tenant_id,id),
  FOREIGN KEY(tenant_id,outlet_id,terminal_id) REFERENCES terminals(tenant_id,outlet_id,id),
  UNIQUE(tenant_id,outlet_id,id), UNIQUE(tenant_id,outlet_id,shift_number)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_shift_per_outlet ON shifts(tenant_id,outlet_id) WHERE status='open';
CREATE TABLE IF NOT EXISTS cash_movements (
  id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, tenant_id TEXT NOT NULL, outlet_id TEXT NOT NULL,
  shift_id TEXT NOT NULL, terminal_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  movement_type TEXT NOT NULL CHECK(movement_type IN ('cash_in','cash_out')),
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0), reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 120),
  created_at TEXT NOT NULL,
  FOREIGN KEY(tenant_id,outlet_id,shift_id) REFERENCES shifts(tenant_id,outlet_id,id),
  FOREIGN KEY(tenant_id,outlet_id,terminal_id) REFERENCES terminals(tenant_id,outlet_id,id)
);
CREATE INDEX IF NOT EXISTS cash_movements_by_shift ON cash_movements(tenant_id,outlet_id,shift_id,created_at);
CREATE TABLE IF NOT EXISTS payment_events (
  id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, tenant_id TEXT NOT NULL, outlet_id TEXT NOT NULL,
  order_id TEXT NOT NULL, terminal_id TEXT NOT NULL, method TEXT NOT NULL CHECK(method IN ('cash','upi','card')),
  amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0), status TEXT NOT NULL CHECK(status IN ('succeeded','failed')),
  shift_id TEXT, entry_type TEXT NOT NULL DEFAULT 'tender' CHECK(entry_type IN ('tender','refund')),
  refund_of TEXT REFERENCES payment_events(id), refund_reason TEXT,
  provider_reference TEXT, created_at TEXT NOT NULL,
  FOREIGN KEY(tenant_id,outlet_id,order_id) REFERENCES orders(tenant_id,outlet_id,id),
  FOREIGN KEY(tenant_id,outlet_id,shift_id) REFERENCES shifts(tenant_id,outlet_id,id)
);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, outlet_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  terminal_id TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
  action TEXT NOT NULL, reason TEXT, payload_json TEXT NOT NULL DEFAULT '{}', occurred_at TEXT NOT NULL,
  FOREIGN KEY(tenant_id,outlet_id) REFERENCES outlets(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS sync_outbox (
  outbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('order','payment','shift','cash_movement','audit','inventory')),
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  next_attempt_at TEXT,
  blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1)),
  last_error TEXT,
  synced_at TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sync_outbox_pending
  ON sync_outbox(next_attempt_at,outbox_id) WHERE synced_at IS NULL;
CREATE TABLE IF NOT EXISTS edge_settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS local_commands (
  command_id TEXT PRIMARY KEY, action TEXT NOT NULL, request_json TEXT NOT NULL,
  result_json TEXT NOT NULL, occurred_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS order_discounts (
  id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, tenant_id TEXT NOT NULL, outlet_id TEXT NOT NULL,
  order_id TEXT NOT NULL, order_line_id TEXT, kind TEXT NOT NULL CHECK(kind IN ('percent','amount')),
  value INTEGER NOT NULL CHECK(value > 0), applied_minor INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 120), actor_id TEXT NOT NULL, created_at TEXT NOT NULL,
  voided_at TEXT, void_reason TEXT, voided_by TEXT,
  FOREIGN KEY(tenant_id,outlet_id,order_id) REFERENCES orders(tenant_id,outlet_id,id)
);
CREATE INDEX IF NOT EXISTS order_discounts_by_order ON order_discounts(tenant_id,outlet_id,order_id);
CREATE TABLE IF NOT EXISTS order_tax_lines (
  order_id TEXT NOT NULL, tax_rate_bps INTEGER NOT NULL, tax_code TEXT NOT NULL DEFAULT '',
  taxable_minor INTEGER NOT NULL, cgst_minor INTEGER NOT NULL, sgst_minor INTEGER NOT NULL,
  PRIMARY KEY(order_id,tax_rate_bps,tax_code)
);
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, outlet_id TEXT NOT NULL, phone TEXT NOT NULL, name TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY(tenant_id,outlet_id) REFERENCES outlets(tenant_id,id), UNIQUE(tenant_id,outlet_id,phone)
);
