/**
 * lotFifo — หัก/เพิ่ม LOT แบบ FIFO ให้ทุก operation ที่กระทบ stock (V4 · P0)
 *
 * หลักการ: caller สร้าง batch + ลด stock_balances เอง แล้วเรียก util พวกนี้
 *   เพื่อ "ลด/เพิ่ม LOT" ลงใน batch เดียวกัน → atomic ไปพร้อม balance
 *
 * รองรับ LOT 2 schema:
 *   A) { warehouseId, inWarehouse, inShop, used }      (PO / transfer)
 *   B) { qty, locationQty: { [warehouseId]: n } }       (manual / split)
 */

import { db } from '../firebase'
import {
  collection, query, where, getDocs, doc, increment, serverTimestamp,
} from 'firebase/firestore'
import { COL } from '../constants/collections'
import { sortLotsFIFO } from './fifo'

/** ยอดคงเหลือของล็อตที่ "คลังนั้น" — รองรับทั้ง 2 schema */
export function getLotAvail(lot, warehouseId) {
  if (lot.locationQty && typeof lot.locationQty === 'object') {
    return Number(lot.locationQty[warehouseId]) || 0
  }
  if (lot.warehouseId === warehouseId) return Number(lot.inWarehouse) || 0
  return 0
}

/** โหลด LOT ของคลังที่ระบุ (fresh) — ตัด split ออก · คืน array พร้อม field _avail */
export async function fetchLotsForWarehouse(warehouseId) {
  const snap = await getDocs(query(
    collection(db, COL.LOT_TRACKING), where('warehouseId', '==', warehouseId)
  ))
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(l => l.status !== 'split')
    .map(l => ({ ...l, _avail: getLotAvail(l, warehouseId) }))
}

/**
 * วางแผนหัก FIFO จาก workingLots (mutate _avail สะสม — เรียกซ้ำหลาย item ได้)
 * @returns {{ allocations: Array<{lotId,take,lot}>, shortage: number }}
 */
export function planFifoConsume(workingLots, { itemId, warehouseId, qtyUse }) {
  const cand = sortLotsFIFO(workingLots.filter(l => l.itemId === itemId && (l._avail ?? getLotAvail(l, warehouseId)) > 0))
  let remain = qtyUse
  const allocations = []
  for (const lot of cand) {
    if (remain <= 1e-9) break
    const avail = lot._avail ?? getLotAvail(lot, warehouseId)
    const take = Math.min(avail, remain)
    if (take > 0) {
      allocations.push({ lotId: lot.id, take, lot })
      lot._avail = avail - take
      remain -= take
    }
  }
  return { allocations, shortage: Math.max(0, remain) }
}

/**
 * เขียนการหัก LOT ลง batch — รักษา "ทั้ง 2 schema" ให้สอดคล้องกัน (P1 unify)
 *   ถ้า lot มี locationQty → ลด map · ถ้ามี inWarehouse → ลด inWarehouse · เพิ่ม used
 *   (ลดทั้งคู่ถ้ามีทั้งคู่ → reader ฝั่งไหนก็เห็นยอดตรงกัน)
 */
export function applyFifoConsume(batch, allocations, warehouseId) {
  for (const a of allocations) {
    const lot = a.lot
    const upd = { used: increment(a.take), lastUpdated: serverTimestamp() }
    const hasLoc = lot.locationQty && typeof lot.locationQty === 'object'
    if (hasLoc) {
      const cur = Number(lot.locationQty[warehouseId]) || 0
      upd[`locationQty.${warehouseId}`] = Math.max(0, cur - a.take)
    }
    // ลด inWarehouse เมื่อมี field นี้ หรือเมื่อล็อตเป็น schema A ล้วน (ไม่มี locationQty)
    if (typeof lot.inWarehouse !== 'undefined' || !hasLoc) {
      const cur = Number(lot.inWarehouse) || 0
      upd.inWarehouse = Math.max(0, cur - a.take)
    }
    batch.update(doc(db, COL.LOT_TRACKING, a.lotId), upd)
  }
}

/**
 * สร้างล็อตใหม่ (ปรับยอด +) — เขียนทั้ง 2 schema เพื่อ compat (EXP alert อ่าน inWarehouse, Warehouse อ่าน locationQty)
 * @returns lotId
 */
export function addLot(batch, { itemId, itemName, warehouseId, qtyUse, receiveDate, expDate = '', source = '', extra = {} }) {
  const ref = doc(collection(db, COL.LOT_TRACKING))
  const rDate = receiveDate || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' })
  batch.set(ref, {
    itemId, itemName, warehouseId,
    receiveDate: rDate, expDate, pendingInfo: !expDate,
    qty: qtyUse, locationQty: { [warehouseId]: qtyUse },
    totalQty: qtyUse, inWarehouse: qtyUse, inShop: 0, used: 0,
    source, status: 'active', createdAt: serverTimestamp(),
    ...extra,
  })
  return ref.id
}

/**
 * คืน LOT ย้อนลำดับการกิน (reverse FIFO = คืนเข้า LOT ใหม่สุดที่มี used ก่อน)
 * ใช้ตอน "ยกเลิก" การตัด/ของเสีย — เพื่อให้สถานะ LOT กลับใกล้เคียงก่อนตัดที่สุด
 * ถ้าคืนได้ไม่ครบ (ไม่มี LOT ไหนมี used เหลือ) → เศษที่เหลือสร้างเป็น LOT ใหม่ กันยอดหาย
 * @returns {{ restored: number, leftover: number }}
 */
export function restoreLotFifo(batch, workingLots, { itemId, itemName = '', warehouseId, qtyUse, source = '' }) {
  const cand = sortLotsFIFO(
    workingLots.filter(l => l.itemId === itemId && (Number(l.used) || 0) > 0)
  ).reverse()
  let remain = qtyUse
  for (const lot of cand) {
    if (remain <= 1e-9) break
    const usedLeft = lot._usedLeft ?? (Number(lot.used) || 0)
    const give = Math.min(usedLeft, remain)
    if (give <= 0) continue
    lot._usedLeft = usedLeft - give
    remain -= give
    const upd = { used: increment(-give), lastUpdated: serverTimestamp() }
    const hasLoc = lot.locationQty && typeof lot.locationQty === 'object'
    if (hasLoc) {
      const cur = Number(lot.locationQty[warehouseId]) || 0
      upd[`locationQty.${warehouseId}`] = cur + give
      lot.locationQty[warehouseId] = cur + give   // mutate working copy เผื่อโดนคืนซ้ำใน batch เดียว
    }
    if (typeof lot.inWarehouse !== 'undefined' || !hasLoc) {
      const cur = Number(lot.inWarehouse) || 0
      upd.inWarehouse = cur + give
      lot.inWarehouse = cur + give
    }
    batch.update(doc(db, COL.LOT_TRACKING, lot.id), upd)
  }
  if (remain > 1e-9) {
    addLot(batch, { itemId, itemName, warehouseId, qtyUse: remain, source: source || 'คืน stock (ยกเลิก)' })
  }
  return { restored: qtyUse - Math.max(0, remain), leftover: Math.max(0, remain) }
}

/** helper: เขียน movement บันทึกว่า LOT มีไม่พอกับที่ตัด (debug — ไม่ block) */
export function writeLotShortage(batch, { itemId, itemName, warehouseId, shortage, unitUse = '', reasonType = '', note = '' }) {
  if (!(shortage > 0)) return
  batch.set(doc(collection(db, COL.STOCK_MOVEMENTS)), {
    type: 'lot_shortage', itemId, itemName, warehouseId,
    qty: -shortage, qtyUse: -shortage, unit: unitUse, unitUse,
    adjustReason: `LOT ไม่พอกับ ${reasonType || 'การตัด'} (ข้อมูลล็อตเก่าอาจเพี้ยน)`,
    note, timestamp: serverTimestamp(),
  })
}
