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

/**
 * แปลง qty ของ "หน่วยใดก็ได้" → unitUse (รองรับหน่วยหลายชั้น เช่น ลัง→มัด→ใบ)
 *   ใช้ item.unitLevels [{name, factorToUse}] เป็นหลัก (1 หน่วยนั้น = factorToUse unitUse)
 *   fallback: legacy 2-ชั้น (unitBase ×parseConvFactor, อื่น ๆ = unitUse)
 * @returns {number} qty ในหน่วย unitUse
 */
export function qtyToUse(qty, unitName, item) {
  const q = Number(qty) || 0
  const levels = item?.unitLevels
  if (Array.isArray(levels) && levels.length) {
    const lv = levels.find(l => l.name === unitName)
    if (lv) return q * (Number(lv.factorToUse) || 1)
    // หน่วยไม่อยู่ใน levels — ถ้าตรง unitUse ก็คือ 1:1
    if (unitName && unitName === item.unitUse) return q
  }
  // legacy fallback
  const factor = parseConvFactor(item?.unitConversion) || 1
  if (unitName && item?.unitBase && unitName === item.unitBase) return q * factor
  return q   // ถือว่าเป็น unitUse
}

/** แปลง qtyUse → จำนวนในหน่วย unitName (ผกผันของ qtyToUse) เช่น 200 ใบ → 8 มัด */
export function useToQty(qtyUse, unitName, item) {
  const q = Number(qtyUse) || 0
  const levels = item?.unitLevels
  if (Array.isArray(levels) && levels.length) {
    const lv = levels.find(l => l.name === unitName)
    if (lv) return q / (Number(lv.factorToUse) || 1)
    if (unitName && unitName === item.unitUse) return q
  }
  const factor = parseConvFactor(item?.unitConversion) || 1
  if (unitName && item?.unitBase && unitName === item.unitBase) return q / factor
  return q
}

/** มีหน่วยอะไรให้เลือกบ้าง (รองรับหลายชั้น) — คืน array ชื่อหน่วย เรียงจากใหญ่→เล็ก */
export function unitOptionsOf(item) {
  if (Array.isArray(item?.unitLevels) && item.unitLevels.length) {
    return item.unitLevels.map(l => l.name).filter(Boolean)
  }
  const out = []
  ;[item?.unitBuy || item?.unitBase, item?.unitUse, item?.unitSub].forEach(u => { if (u && !out.includes(u)) out.push(u) })
  return out
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
