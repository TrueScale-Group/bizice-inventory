/**
 * adjustStock — Owner-only ปรับยอดคงคลัง (V2 spec section 12)
 *
 * @param {Object} p
 * @param {string} p.itemId
 * @param {string} p.itemName
 * @param {string} p.warehouseId
 * @param {number} p.qtyUse     จำนวนปรับ (หน่วย unitUse)
 * @param {'add'|'sub'} p.direction
 * @param {string} p.reason
 * @param {Object} p.item       full item object (สำหรับ unit info)
 * @param {string} [p.note]
 * @param {string} p.staffPhone
 * @param {string} p.staffName
 */

import { db } from '../firebase'
import {
  writeBatch, doc, collection, increment, serverTimestamp,
} from 'firebase/firestore'
import { COL } from '../constants/collections'
import { convertToBase, balanceId } from './unit'

export async function adjustStock({
  itemId, itemName, warehouseId, qtyUse, direction, reason, item,
  note = '', staffPhone, staffName,
}) {
  if (!itemId || !warehouseId) throw new Error('ข้อมูลไม่ครบ')
  if (!(qtyUse > 0))           throw new Error('จำนวนต้องมากกว่า 0')
  if (!reason)                  throw new Error('กรุณาเลือกสาเหตุ')

  const batch = writeBatch(db)
  const now   = serverTimestamp()
  const delta = direction === 'add' ? qtyUse : -qtyUse
  const unitUse  = item?.unitUse  || ''
  const unitBase = item?.unitBase || unitUse
  const qtyBase  = convertToBase(qtyUse, item?.unitConversion)

  // 1. update stock_balances (เก็บใน unitUse)
  const balRef = doc(db, COL.STOCK_BALANCES, balanceId(warehouseId, itemId))
  batch.set(balRef, {
    warehouseId,
    itemId,
    qty:           increment(delta),
    unit:          unitUse,
    lastUpdated:   now,
    lastUpdatedBy: staffPhone,
  }, { merge: true })

  // 2. stock_movements type='adjust'
  const movRef = doc(collection(db, COL.STOCK_MOVEMENTS))
  batch.set(movRef, {
    type:         'adjust',
    itemId, itemName, warehouseId,
    qty:          direction === 'add' ? qtyBase : -qtyBase,
    unit:         unitBase,
    qtyUse:       delta,
    unitUse,
    adjustReason: reason,
    note:         note || '',
    staffPhone, staffName,
    timestamp:    now,
  })

  // 3. audit
  const audRef = doc(collection(db, COL.AUDIT_LOGS))
  batch.set(audRef, {
    action:      'adjust_stock',
    staffPhone, staffName, warehouseId,
    detail:      `ปรับยอด ${itemName} ${direction === 'add' ? '+' : '-'}${qtyUse} ${unitUse} · ${reason}`,
    timestamp:   now,
  })

  await batch.commit()
}

export const ADJUST_REASONS = {
  add: [
    'รับโอนสำเร็จรูป',
    'ปรับจากนับสินค้า',
    'อื่นๆ',
  ],
  sub: [
    'ตัดวัตถุดิบใช้ไป',
    'ปรับจากนับสินค้า',
    'สินค้าสูญหาย',
    'ทำลายสินค้า',
    'สินค้าชำรุด/เสื่อมสภาพ',
    'ภัยพิบัติ/อัคคีภัย',
    'อื่นๆ',
  ],
}
