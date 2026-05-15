/**
 * Firestore Collection Names — Inventory App
 * Prefix: Inv_  (เพื่อแยกจาก app อื่นใน BizICE ecosystem)
 *
 * Cross-app collections (อ่านอย่างเดียว — ไม่เปลี่ยนชื่อ):
 *   mixue_data      → ของ Cost Manager
 *   income_records  → ของ Daily Income
 */

export const COL = {
  // ─── Inventory-owned collections ───────────────────────────────────────────
  WAREHOUSES:       'Inv_warehouses',
  ITEMS:            'Inv_items',
  STOCK_BALANCES:   'Inv_stock_balances',
  STOCK_MOVEMENTS:  'Inv_stock_movements',
  TRANSFER_ORDERS:  'Inv_transfers',
  LOT_TRACKING:     'Inv_lots',
  CUT_STOCK_LOGS:   'Inv_cut_logs',
  WASTE_LOGS:       'Inv_waste_logs',
  AUDIT_LOGS:       'Inv_audit_logs',
  LOW_STOCK_ALERTS: 'Inv_alerts',
  QUICK_TEMPLATES:  'Inv_templates',
  APP_SETTINGS:     'Inv_settings',
  PUSH_QUEUE:       'Inv_push_queue',
  REFILL_REQUESTS:  'Inv_refill_requests',

  // ─── Cross-app (read-only, ไม่เปลี่ยน prefix) ──────────────────────────────
  MIXUE_DATA:       'mixue_data',       // Cost Manager owns this
  INCOME_RECORDS:   'income_records',   // Daily Income owns this
}
