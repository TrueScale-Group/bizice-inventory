import { useState, useMemo, useEffect } from 'react'
import { db } from '../firebase'
import { writeBatch, doc, collection, serverTimestamp } from 'firebase/firestore'
import { Modal } from './Modal'
import { COL } from '../constants/collections'
import { parseConvFactor, balanceId } from '../utils/unit'
import { beepSuccess } from '../utils/audio'

/**
 * SeedStockModal — Owner only · seed stock_balances ครั้งเดียว
 *
 * Props:
 *   open, onClose, items[], warehouses[], staffPhone, staffName, onSuccess
 *
 * Logic:
 *   1. ผู้ใช้เลือก warehouse + กรอก/แก้รายการ (1 ชื่อ + qty หรือสูตร "1 ลัง + 10")
 *   2. Parse → match name with items[]
 *   3. Preview matched/unmatched/parsed qty (in unitUse)
 *   4. Apply via writeBatch.set stock_balances
 */

// ── Default seed data (จากไฟล์ Excel 509.ods) ────────────────────────
const DEFAULT_509 = `แยมสตรอว์เบอร์รี | 20
แยมกีวี่ | 23
แยมพีชเหลือง | 23
แยมพีชชมพู | 9
แยมมะม่วง | 25
เจลลี่คริสตัล | 13
วุ้นมะพร้าว | 7
ไซรัปน้ำส้ม | 5
ไซรัปบราวน์ชูการ์ | 5
ไซรัปช็อคโกแลต | 10
ไซรับเฮเซนัท | 6
ไซรัปมินต์ | 7
กรวยไอศกรีม (โคนวาฟเฟิล) | 2 ลัง + 7
กรวยกระดาษ | 32
ผงไอติม (รสนม) | 13
ผงนม (ถุงสีส้ม) | 5
ผงพุดดิ้ง | 8
ผงบลูเล่ | 9
ผงไอติม (รสเผือก) | 10
กาแฟ | 11
โอริโอ้ | 17
กากน้ำตาล | 6
กากน้ำตาลผลไม้ | 7
ไข่มุก | 22
มะนาว | 196
ผลส้ม | 75
ชาเขียวมะลิ | 41
ชาดำ | 45
แก้ว 400 U | 1 ลัง + 10
แก้ว 500 M | 1 ลัง + 13
แก้ว 700 | 1 ลัง + 4
ฝาโดม | 1 ลัง + 3
หลอดใหญ่ | 19
หลอดเล็ก | 10
ช้อนซันเดย์ | 1 ลัง + 5
ช้อนไอศกรีมวาฟเฟิล | 4
ถุง 4 แก้ว | 4
ถุง 2 แก้ว | 8
ถุง 1 แก้ว | 11
ถุงเก็บอุณหภูมิ 2 แก้ว | 247
ถุงเก็บอุณหภูมิ 4 แก้ว | 358
แผ่นซีล | 3
แผ่นสติ๊กเกอร์ | 8 แพ็ค + 4 ม้วน
กระดาษพิมพ์ใบเสร็จ | 2 แพ็ค + 1 ม้วน
ตุ๊กตาล้มลุก | 1 ลัง + 3
ฟองน้ำ | 42
ถุงขยะไซส์ S | 3
ถุงขยะไซส์ XL | 4
ไส้กรอง เบอร์ 1 | 1 กล่อง + 2`

/**
 * Parse qty string → number (in unitUse)
 *   "20"               → 20
 *   "1 ลัง + 10"        → 1 * factor + 10
 *   "8 แพ็ค + 4 ม้วน"   → 8 * factorPack + 4 * factorRoll (smart)
 */
function parseQtyString(str, item) {
  if (!str) return { qty: 0, warning: 'empty' }
  const trimmed = String(str).trim()
  if (!trimmed || trimmed === '-') return { qty: 0, warning: 'unknown' }
  if (/^\d+(\.\d+)?$/.test(trimmed)) return { qty: parseFloat(trimmed), warning: null }

  // Split by "+"
  const parts = trimmed.split('+').map(p => p.trim())
  const factor = parseConvFactor(item?.unitConversion)
  let total = 0
  const warnings = []

  for (const part of parts) {
    // "1 ลัง" or "10" or "1 ลัง + 10"
    const m = part.match(/^([\d.]+)\s*(.*)$/)
    if (!m) { warnings.push(`parse-fail: "${part}"`); continue }
    const n = parseFloat(m[1])
    const unit = (m[2] || '').trim()

    if (!unit) {
      total += n  // ไม่ระบุหน่วย = unitUse
    } else if (item?.unitBase && unit === item.unitBase) {
      total += n * factor   // ใช้ factor unitBase → unitUse
    } else if (item?.unitUse && unit === item.unitUse) {
      total += n
    } else if (item?.unitSub && unit === item.unitSub) {
      const subConv = Number(item.convSub) || 0    // per-parent: 1 unitUse = subConv unitSub
      if (subConv > 0) {
        // qty_unitSub / convSub = qty_unitUse
        total += n / subConv
      } else {
        warnings.push(`no convSub for ${unit}`)
      }
    } else {
      // ไม่ตรง — ลองใช้ factor ถ้าน่าจะเป็นหน่วยใหญ่
      warnings.push(`unknown unit "${unit}"`)
      total += n * factor   // assume unitBase
    }
  }

  return { qty: total, warning: warnings.join(', ') || null }
}

function parseLines(text) {
  return text.split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(line => {
      const parts = line.split('|').map(s => s.trim())
      // รองรับ format: name | qtyStr | min
      const [name, qtyStr, minStr] = parts
      const minQty = parseFloat(minStr) || 0
      return { name, qtyStr, minQty }
    })
}

// ── CSV helpers ──────────────────────────────────────────────
function escapeCsv(s) {
  const t = String(s ?? '')
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
}

function buildTemplateCSV(items) {
  const header = ['ชื่อ','หน่วยซื้อ','หน่วยใช้','หน่วยชั่ง','อัตราแปลง','qty_หน่วยซื้อ','qty_หน่วยใช้','qty_หน่วยชั่ง','min_stock']
  const rows = items.map(i => [
    i.name || '',
    i.unitBase || '',
    i.unitUse || '',
    i.unitSub || '',
    i.unitConversion || '',
    '', '', '', '',
  ])
  const csv = [header, ...rows].map(r => r.map(escapeCsv).join(',')).join('\n')
  return '﻿' + csv   // BOM = UTF-8 ให้ Excel เปิดถูก
}

function parseCSVText(text) {
  const stripped = String(text).replace(/^﻿/, '')
  const lines = stripped.split(/\r?\n/).filter(l => l.trim())
  if (lines.length < 2) return []
  const parseLine = line => {
    const cells = []
    let cur = '', inQ = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"' && !inQ) { inQ = true; continue }
      if (ch === '"' && inQ) {
        if (line[i+1] === '"') { cur += '"'; i++; continue }
        inQ = false; continue
      }
      if (ch === ',' && !inQ) { cells.push(cur); cur = ''; continue }
      cur += ch
    }
    cells.push(cur)
    return cells
  }
  const header = parseLine(lines[0]).map(s => s.trim())
  return lines.slice(1).map(line => {
    const cells = parseLine(line)
    return Object.fromEntries(header.map((h, i) => [h, (cells[i] || '').trim()]))
  })
}

// แปลง CSV rows → text format (name | qty_str | min)
function csvRowsToText(rows) {
  return rows.map(r => {
    const name = r['ชื่อ'] || ''
    if (!name) return ''
    const parts = []
    const qB = r['qty_หน่วยซื้อ']
    const qU = r['qty_หน่วยใช้']
    const qS = r['qty_หน่วยชั่ง']
    const uB = r['หน่วยซื้อ']
    const uU = r['หน่วยใช้']
    const uS = r['หน่วยชั่ง']
    if (qB && parseFloat(qB) > 0) parts.push(`${qB} ${uB || ''}`.trim())
    if (qU && parseFloat(qU) > 0) parts.push(`${qU} ${uU || ''}`.trim())
    if (qS && parseFloat(qS) > 0) parts.push(`${qS} ${uS || ''}`.trim())
    const qtyStr = parts.length ? parts.join(' + ') : '0'
    const min = r['min_stock'] || ''
    return min ? `${name} | ${qtyStr} | ${min}` : `${name} | ${qtyStr}`
  }).filter(Boolean).join('\n')
}

function downloadFile(filename, content, mime = 'text/csv;charset=utf-8;') {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export default function SeedStockModal({ open, onClose, items = [], warehouses = [],
  staffPhone, staffName, onSuccess }) {
  const [text, setText] = useState(DEFAULT_509)
  const [warehouseId, setWarehouseId] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [phase, setPhase] = useState('input')  // input | preview | done

  useEffect(() => {
    if (open && !warehouseId) {
      // default = ร้านแรก (ไม่ใช่ main)
      const shop = warehouses.find(w => w.type === 'shop' || w.type === 'branch' || w.isShop === true)
        || warehouses.find(w => !(w.type === 'main' || w.isMain))
        || warehouses[0]
      if (shop) setWarehouseId(shop.id)
    }
  }, [open, warehouses])

  // ── Build matched preview ─────────────────────────────────
  const parsed = useMemo(() => {
    const lines = parseLines(text)
    return lines.map(({ name, qtyStr, minQty }) => {
      // Match by name (case-insensitive contains both ways)
      const item = items.find(i => i.name === name)
        || items.find(i => i.name?.replace(/\s/g,'') === name?.replace(/\s/g,''))
        || items.find(i => name && i.name?.includes(name))
        || items.find(i => name && name.includes(i.name))
      const { qty, warning } = parseQtyString(qtyStr, item)
      return { name, qtyStr, item, qty, minQty, warning }
    })
  }, [text, items])

  const matched   = parsed.filter(p => p.item && (p.qty > 0 || p.minQty > 0))
  const unmatched = parsed.filter(p => !p.item)
  const zero      = parsed.filter(p => p.item && p.qty <= 0 && !p.minQty)

  async function handleApply() {
    if (!warehouseId) { setErr('เลือก warehouse ก่อน'); return }
    if (matched.length === 0) { setErr('ไม่มีรายการ match'); return }
    setLoading(true); setErr('')
    try {
      const now = serverTimestamp()
      // ใช้ batch (≤ 500 ต่อรอบ)
      const BATCH_SIZE = 400
      for (let i = 0; i < matched.length; i += BATCH_SIZE) {
        const batch = writeBatch(db)
        const slice = matched.slice(i, i + BATCH_SIZE)
        slice.forEach(({ item, qty, minQty }) => {
          const ref = doc(db, COL.STOCK_BALANCES, balanceId(warehouseId, item.id))
          const payload = {
            warehouseId,
            itemId:        item.id,
            qty,
            unit:          item.unitUse || '',
            lastUpdated:   now,
            lastUpdatedBy: staffPhone || '',
          }
          if (minQty > 0) payload.minQty = minQty
          batch.set(ref, payload, { merge: true })

          // movement: opening / seed
          const movRef = doc(collection(db, COL.STOCK_MOVEMENTS))
          batch.set(movRef, {
            type:     'adjust',
            itemId:   item.id,
            itemName: item.name,
            warehouseId,
            qty:      qty,
            unit:     item.unitUse || '',
            qtyUse:   qty,
            unitUse:  item.unitUse || '',
            adjustReason: 'Seed Stock (Initial)',
            note:     'Bulk seed from Excel',
            staffPhone, staffName,
            timestamp: now,
          })
        })
        // audit (1 ต่อ batch)
        const audRef = doc(collection(db, COL.AUDIT_LOGS))
        batch.set(audRef, {
          action:      'seed_stock',
          staffPhone, staffName, warehouseId,
          detail:      `Seed ${slice.length} รายการ (${matched.length} total)`,
          timestamp:   now,
        })
        await batch.commit()
      }
      beepSuccess()
      setPhase('done')
      onSuccess?.(`✅ Seed ${matched.length} รายการเรียบร้อย`)
    } catch (e) {
      setErr(e.message || 'เกิดข้อผิดพลาด')
    } finally {
      setLoading(false)
    }
  }

  if (!open) return null

  return (
    <Modal open={open} onClose={() => { if (!loading) { setPhase('input'); onClose?.() } }}
      title="🌱 Seed Stock (Owner)">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '0 16px 16px' }}>
        {phase === 'done' && (
          <div style={{ background: '#F0FDF4', border: '1px solid #BBF7D0',
            borderRadius: 10, padding: '14px', fontSize: 13, color: '#15803D', textAlign: 'center' }}>
            ✅ Seed เรียบร้อย {matched.length} รายการ
          </div>
        )}

        {phase !== 'done' && (
          <>
            {/* Warehouse */}
            <div>
              <label style={{ fontSize: 11, color: 'var(--txt3)', fontWeight: 600 }}>คลังปลายทาง</label>
              <select value={warehouseId} onChange={e => setWarehouseId(e.target.value)}
                style={{ width: '100%', padding: '10px 12px', borderRadius: 10,
                  border: '1.5px solid var(--border2)', fontSize: 14, fontWeight: 600, marginTop: 4 }}>
                <option value="">-- เลือก --</option>
                {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </div>

            {/* CSV Template Buttons */}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => {
                downloadFile(`inventory_stock_template_${new Date().toISOString().slice(0,10)}.csv`,
                  buildTemplateCSV(items))
              }}
                style={{ flex: 1, padding: '10px 12px', border: '1.5px solid var(--border2)',
                  borderRadius: 10, background: '#fff', cursor: 'pointer',
                  fontSize: 12, fontWeight: 700, color: 'var(--txt2)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                📥 Download Template ({items.length})
              </button>
              <label style={{ flex: 1, padding: '10px 12px', border: '1.5px solid var(--red)',
                borderRadius: 10, background: 'var(--red-p)', cursor: 'pointer',
                fontSize: 12, fontWeight: 700, color: 'var(--red)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                📂 Upload CSV
                <input type="file" accept=".csv" style={{ display: 'none' }}
                  onChange={e => {
                    const f = e.target.files?.[0]
                    if (!f) return
                    const reader = new FileReader()
                    reader.onload = ev => {
                      try {
                        const rows = parseCSVText(ev.target.result)
                        const converted = csvRowsToText(rows)
                        if (!converted) { setErr('CSV ไม่มีข้อมูล หรือ format ไม่ถูกต้อง'); return }
                        setText(converted)
                        setErr('')
                      } catch (er) {
                        setErr('Parse CSV ผิด: ' + er.message)
                      }
                    }
                    reader.readAsText(f, 'utf-8')
                    e.target.value = ''  // reset เพื่อ upload ไฟล์เดิมได้
                  }}/>
              </label>
            </div>

            {/* Text area */}
            <div>
              <label style={{ fontSize: 11, color: 'var(--txt3)', fontWeight: 600 }}>
                รายการ (ชื่อ | จำนวน | min) — 1 บรรทัด/รายการ
              </label>
              <textarea value={text} onChange={e => setText(e.target.value)}
                rows={12}
                style={{ width: '100%', padding: '10px 12px', borderRadius: 10,
                  border: '1.5px solid var(--border2)', fontSize: 11, fontFamily: 'monospace',
                  marginTop: 4, resize: 'vertical' }}/>
              <div style={{ fontSize: 10, color: 'var(--txt3)', marginTop: 4 }}>
                💡 รูปแบบ: <code>ชื่อ | จำนวน</code> หรือ <code>ชื่อ | 1 ลัง + 10 + 50 กรัม | 5</code> (3 หน่วย + min)
              </div>
            </div>

            {/* Summary stats */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
              <div style={{ background: '#F0FDF4', borderRadius: 8, padding: '6px 8px', textAlign: 'center' }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#15803D' }}>{matched.length}</div>
                <div style={{ fontSize: 10, color: '#15803D' }}>✅ match</div>
              </div>
              <div style={{ background: '#FEE2E2', borderRadius: 8, padding: '6px 8px', textAlign: 'center' }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#DC2626' }}>{unmatched.length}</div>
                <div style={{ fontSize: 10, color: '#DC2626' }}>❌ ไม่เจอ</div>
              </div>
              <div style={{ background: '#FFFBEB', borderRadius: 8, padding: '6px 8px', textAlign: 'center' }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#D97706' }}>{zero.length}</div>
                <div style={{ fontSize: 10, color: '#D97706' }}>⚠️ qty=0</div>
              </div>
            </div>

            {/* Preview list */}
            <div style={{ maxHeight: 240, overflowY: 'auto', background: 'var(--bg)',
              borderRadius: 10, padding: '8px', display: 'flex', flexDirection: 'column', gap: 4 }}>
              {parsed.map((p, i) => {
                const tone = !p.item ? '#FEE2E2'
                  : (p.qty <= 0) ? '#FFFBEB'
                  : p.warning ? '#FEF3C7' : '#F0FDF4'
                const text2 = !p.item ? '❌ ไม่เจอ'
                  : (p.qty <= 0) ? `⚠️ qty=0 (${p.qtyStr})`
                  : `${p.qty} ${p.item.unitUse}${p.warning ? ` · ⚠️ ${p.warning}` : ''}`
                return (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between',
                    alignItems: 'center', gap: 8, padding: '6px 10px',
                    background: tone, borderRadius: 6, fontSize: 11 }}>
                    <span style={{ flex: 1, minWidth: 0, fontWeight: 600 }}>
                      {p.name}
                    </span>
                    <span style={{ fontSize: 10, color: 'var(--txt2)' }}>{text2}</span>
                  </div>
                )
              })}
            </div>

            {err && (
              <div style={{ background: '#FEE2E2', color: '#DC2626', padding: '8px 12px',
                borderRadius: 8, fontSize: 12, fontWeight: 600 }}>{err}</div>
            )}

            <button onClick={handleApply}
              disabled={loading || matched.length === 0 || !warehouseId}
              style={{ padding: '12px 16px', border: 'none', borderRadius: 12,
                background: (loading || matched.length === 0) ? 'var(--border2)' : 'var(--red)',
                color: '#fff', fontSize: 14, fontWeight: 700,
                cursor: (loading || matched.length === 0) ? 'wait' : 'pointer' }}>
              {loading ? 'กำลังบันทึก...' : `🌱 Apply ${matched.length} รายการ`}
            </button>
          </>
        )}
      </div>
    </Modal>
  )
}
