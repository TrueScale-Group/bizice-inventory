/**
 * cutStock — atomic batch ตัดสต็อก (V2 spec section 11)
 *
 * Storage model: qty ใน stock_balances เก็บเป็น unitUse เสมอ
 *   → ไม่ต้องแปลงหน่วยตอน increment
 *   → คำนวณ qtyBase เก็บใน log เพื่อ traceability
 */

import { db } from '../firebase'
import {
  writeBatch, doc, collection, increment, serverTimestamp,
  getDoc, setDoc,
} from 'firebase/firestore'
import { COL } from '../constants/collections'
import { convertToBase, balanceId } from './unit'
import { toDateKey } from './formatDate'

/**
 * @param {Object} params
 * @param {Array<{itemId, itemName, img, qtyUse, item, costPerUnit?}>} params.cuts
 * @param {string} params.staffPhone
 * @param {string} params.staffName
 * @param {string} params.shopName
 * @param {string} params.warehouseId
 * @param {string} [params.templateName]
 * @param {string} [params.note]
 */
export async function cutStock({
  cuts, staffPhone, staffName, shopName, warehouseId,
  templateName = null, note = '',
}) {
  if (!cuts?.length) throw new Error('ไม่มีรายการตัดสต็อก')
  if (!warehouseId)  throw new Error('ไม่ได้ระบุคลัง')

  const batch = writeBatch(db)
  const now   = serverTimestamp()

  const logItemsFinal = []

  for (const cut of cuts) {
    const { itemId, itemName, img, qtyUse, item, costPerUnit = 0 } = cut
    if (!itemId || !item) continue
    if (!(qtyUse > 0)) continue

    const unitUse  = item.unitUse  || ''
    const unitBase = item.unitBase || unitUse
    const qtyBase  = convertToBase(qtyUse, item.unitConversion)

    // 1. update stock_balances — doc id เป็น deterministic
    const balRef = doc(db, COL.STOCK_BALANCES, balanceId(warehouseId, itemId))
    batch.set(balRef, {
      warehouseId,
      itemId,
      qty:           increment(-qtyUse),    // เก็บใน unitUse
      unit:          unitUse,
      lastUpdated:   now,
      lastUpdatedBy: staffPhone,
    }, { merge: true })

    // 2. add stock_movements
    const movRef = doc(collection(db, COL.STOCK_MOVEMENTS))
    batch.set(movRef, {
      type:        'cut',
      itemId,
      itemName,
      warehouseId,
      qty:         -qtyBase,
      unit:        unitBase,
      qtyUse:      -qtyUse,
      unitUse,
      staffPhone,
      staffName,
      shopName,
      templateName: templateName || null,
      note:         note || '',
      timestamp:   now,
    })

    logItemsFinal.push({
      itemId, itemName, img: img || '📦',
      qtyUse, unitUse,
      qtyBase, unitBase,
      costTotal: qtyUse * (costPerUnit || 0),
    })
  }

  // 3. add cut_stock_logs (1 doc per confirm)
  const logRef = doc(collection(db, COL.CUT_STOCK_LOGS))
  batch.set(logRef, {
    date:        toDateKey(),
    warehouseId,
    shopName,
    staffPhone,
    staffName,
    templateName: templateName || null,
    items:       logItemsFinal,
    totalCost:   logItemsFinal.reduce((s, c) => s + (c.costTotal || 0), 0),
    note:        note || '',
    timestamp:   now,
  })

  // 4. audit
  const audRef = doc(collection(db, COL.AUDIT_LOGS))
  batch.set(audRef, {
    action:      'cut_stock',
    staffPhone, staffName, warehouseId,
    detail:      `ตัดสต็อก ${logItemsFinal.length} รายการ${templateName ? ` (${templateName})` : ''}`,
    timestamp:   now,
  })

  // 5. commit atomic
  await batch.commit()

  // 6. หลัง commit → เช็ค stock ต่ำ → push + คืนรายการ
  const lowItems = await checkLowStockAfterCut(logItemsFinal, warehouseId)
  return { lowItems }
}

/**
 * @returns Array<{itemName, qty, minQty, unit, status: 'low'|'out'}>
 */
async function checkLowStockAfterCut(cuts, warehouseId) {
  const now = serverTimestamp()
  const lowItems = []
  for (const cut of cuts) {
    const balRef = doc(db, COL.STOCK_BALANCES, balanceId(warehouseId, cut.itemId))
    const snap   = await getDoc(balRef)
    if (!snap.exists()) continue
    const { qty, minQty } = snap.data()
    if (qty <= (minQty || 0)) {
      const status = qty <= 0 ? 'out' : 'low'
      lowItems.push({
        itemId:   cut.itemId,
        itemName: cut.itemName,
        qty,
        minQty:   minQty || 0,
        unit:     cut.unitUse,
        status,
      })
      await setDoc(doc(db, COL.LOW_STOCK_ALERTS, balanceId(warehouseId, cut.itemId)), {
        itemId:      cut.itemId,
        itemName:    cut.itemName,
        warehouseId,
        currentQty:  qty,
        minQty:      minQty || 0,
        unit:        cut.unitUse,
        status,
        sentAt:      now,
        read:        false,
      })
      // push ให้ Owner
      const ownerPhone = window._bizSession?.phone || 'owner'
      await setDoc(doc(db, COL.PUSH_QUEUE, `${ownerPhone}_low_${cut.itemId}`), {
        title: status === 'out' ? `🔴 หมดสต็อก — ${cut.itemName}` : `🟡 Stock ต่ำ — ${cut.itemName}`,
        body:  `เหลือ ${qty} ${cut.unitUse} (min ${minQty || 0})`,
        read:  false,
        tag:   'low_stock',
        createdAt: now,
      })
    }
  }
  return lowItems
}
