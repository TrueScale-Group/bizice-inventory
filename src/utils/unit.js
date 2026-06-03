/**
 * Unit conversion + Smart Display Layer
 * ─────────────────────────────────────────────────────────────────
 * Storage model: stock_balances.qty เก็บใน unitUse (smallest unit) เสมอ ทุก warehouse
 * Display logic: สลับ "1 ลัง" ↔ "19 กระป๋อง" อัตโนมัติตามว่า qty หารลงตัวกับ factor
 *
 * unitConversion (V2 string format): "1 ลัง = 20 กระป๋อง"
 *                                    ─────  ──  ─────────
 *                                    unitBase factor unitUse
 */

/** Parse factor from unitConversion string. "1 ลัง = 20 กระป๋อง" → 20 */
export function parseConvFactor(conversion) {
  if (!conversion) return 1
  const m = String(conversion).match(/=\s*([\d.]+)/)
  const f = m ? parseFloat(m[1]) : 1
  return f > 0 ? f : 1
}

/** qty (unitUse) → qtyBase (unitBase). "20 กระป๋อง" → 1 (ลัง) */
export function convertToBase(qtyUse, conversion) {
  return qtyUse / parseConvFactor(conversion)
}

/** qty (unitBase) → qty (unitUse). 1 (ลัง) → 20 (กระป๋อง) */
export function convertToUse(qtyBase, conversion) {
  return qtyBase * parseConvFactor(conversion)
}

/** stock status สำหรับ badge สี */
export function getStockStatus(qty, minQty) {
  if (qty <= 0)         return 'out'   // 🔴 หมด
  if (qty <= (minQty || 0)) return 'low'   // 🟡 ใกล้หมด
  return 'ok'                          // ✅ ปกติ
}

/**
 * Smart Display — แสดงผสม 2 หน่วยอัตโนมัติ
 *   - factor = 1 หรือไม่มี → "19 กระป๋อง"
 *   - q < factor                       → "5 กระป๋อง"
 *   - q >= factor && remainder === 0   → "1 ลัง"
 *   - q >= factor && remainder > 0     → "1 ลัง + 5 กระป๋อง"   (compound display)
 */
export function formatStockQty(qty, item) {
  if (!item) return `${qty || 0}`
  const factor = parseConvFactor(item.unitConversion)
  const q = Number(qty || 0)
  const unitBase = item.unitBase || item.unitUse || ''
  const unitUse  = item.unitUse  || item.unitBase || ''
  const fmtNum = n => Number.isInteger(n) ? n : Number(n.toFixed(2).replace(/\.?0+$/,''))

  if (factor <= 1 || !unitBase || unitBase === unitUse) {
    return `${fmtNum(q)} ${unitUse}`
  }
  if (q < factor) {
    return `${fmtNum(q)} ${unitUse}`
  }
  const lots = Math.floor(q / factor)
  const remainder = q - (lots * factor)
  if (remainder === 0) return `${lots} ${unitBase}`
  return `${lots} ${unitBase} + ${fmtNum(remainder)} ${unitUse}`
}

/** Transfer display — "1 ลัง (= 20 กระป๋อง)" */
export function formatTransferQty(qtyBase, item) {
  if (!item) return `${qtyBase}`
  const factor = parseConvFactor(item.unitConversion)
  const unitBase = item.unitBase || item.unitUse || ''
  const unitUse  = item.unitUse  || item.unitBase || ''
  if (factor > 1 && unitBase !== unitUse) {
    return `${qtyBase} ${unitBase} (= ${qtyBase * factor} ${unitUse})`
  }
  return `${qtyBase} ${unitBase}`
}

/** Build doc id for stock_balances — deterministic */
export function balanceId(warehouseId, itemId) {
  return `${warehouseId}_${itemId}`
}
