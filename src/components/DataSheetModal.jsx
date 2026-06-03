import { useState, useMemo, useEffect } from 'react'
import { db } from '../firebase'
import { collection, query, where, getDocs, writeBatch, doc, serverTimestamp } from 'firebase/firestore'
import * as XLSX from 'xlsx-js-style'
import { Modal } from './Modal'
import { COL } from '../constants/collections'
import { parseConvFactor, balanceId } from '../utils/unit'
import { beepSuccess } from '../utils/audio'

/**
 * DataSheetModal — Owner only · "Master + Stock ทุก warehouse" 1 ไฟล์
 *
 * Flow:
 *   1. Download Master CSV — รวม items ทั้งหมด + qty/min ของทุก warehouse
 *   2. แก้ใน Excel: ชื่อ, หน่วย, factor, qty per warehouse
 *   3. Upload → preview diff (items + stock) → Apply
 *
 * Apply:
 *   - update items (ถ้ามี diff)
 *   - update stock_balances per warehouse (ถ้ากรอก qty)
 *   - stock_movements + audit
 */

// ── File helpers (XLSX with styling + CSV fallback for parsing) ──

/**
 * อ่านไฟล์ Excel หรือ CSV → คืน { header, rows }
 *   - .xlsx / .xls → ใช้ XLSX.read
 *   - .csv → parse text แล้วใช้ XLSX.read in CSV mode
 */
async function readSpreadsheet(file) {
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array' })
  const ws = wb.Sheets[wb.SheetNames[0]]
  // sheet_to_json with defval='' to keep empty cells, raw:false to coerce to string
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false })
  if (aoa.length < 2) return { header: [], rows: [] }
  const header = aoa[0].map(h => String(h ?? '').trim())
  const rows = aoa.slice(1)
    .filter(r => r.some(c => String(c ?? '').trim() !== ''))
    .map(r => Object.fromEntries(header.map((h, i) => [h, String(r[i] ?? '').trim()])))
  return { header, rows }
}

/**
 * Build XLSX workbook พร้อม styling:
 *   - Header: ตัวหนา + พื้นแดง + ขาว + freeze row
 *   - Column widths ตามประเภท column
 *   - AutoFilter ที่ header
 *   - Wrap text ทุก cell
 */
function buildStyledWorkbook(header, rows, warehouses) {
  const ws = {}
  const range = { s: { c: 0, r: 0 }, e: { c: header.length - 1, r: rows.length } }

  // ── Cell styles ──
  const headerStyle = {
    font:      { bold: true, color: { rgb: 'FFFFFF' }, sz: 11 },
    fill:      { fgColor: { rgb: 'E31E24' } },             // BizICE red
    alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
    border:    {
      top:    { style: 'thin', color: { rgb: 'B01519' } },
      bottom: { style: 'thin', color: { rgb: 'B01519' } },
      left:   { style: 'thin', color: { rgb: 'B01519' } },
      right:  { style: 'thin', color: { rgb: 'B01519' } },
    },
  }
  const cellStyle = {
    alignment: { vertical: 'center', wrapText: true },
    border: {
      top:    { style: 'thin', color: { rgb: 'E5E5EA' } },
      bottom: { style: 'thin', color: { rgb: 'E5E5EA' } },
      left:   { style: 'thin', color: { rgb: 'E5E5EA' } },
      right:  { style: 'thin', color: { rgb: 'E5E5EA' } },
    },
  }
  const nameCellStyle = { ...cellStyle, font: { bold: true } }
  const idCellStyle = {
    ...cellStyle,
    font: { color: { rgb: '9CA3AF' }, sz: 9 },
    fill: { fgColor: { rgb: 'F9FAFB' } },
  }
  const qtyCellStyle = {
    ...cellStyle,
    alignment: { vertical: 'center', horizontal: 'right' },
    font: { color: { rgb: '15803D' } },
  }
  const minCellStyle = {
    ...cellStyle,
    alignment: { vertical: 'center', horizontal: 'right' },
    font: { color: { rgb: 'D97706' } },
  }
  const unitCellStyle = {
    ...cellStyle,
    font: { color: { rgb: '6B7280' }, sz: 10 },
    fill: { fgColor: { rgb: 'F2F2F7' } },
  }

  // ── เขียน header row ──
  header.forEach((h, c) => {
    const addr = XLSX.utils.encode_cell({ c, r: 0 })
    ws[addr] = { v: h, t: 's', s: headerStyle }
  })

  // ── เขียน data rows ──
  rows.forEach((row, ri) => {
    row.forEach((val, c) => {
      const addr = XLSX.utils.encode_cell({ c, r: ri + 1 })
      const colName = header[c]
      const isNum = val !== '' && val !== null && !isNaN(val) && typeof val !== 'string'
      const cellVal = isNum ? Number(val) : (val == null ? '' : String(val))
      const t = isNum ? 'n' : 's'

      // เลือก style ตาม column
      let s = cellStyle
      if (colName === 'id') s = idCellStyle
      else if (colName === 'ชื่อ') s = nameCellStyle
      else if (['หน่วยซื้อ','หน่วยใช้','หน่วยชั่ง','หมวด','emoji'].includes(colName)) s = unitCellStyle
      else if (colName.includes('มี_')) s = qtyCellStyle
      else if (colName.includes('เตือน_')) s = minCellStyle

      ws[addr] = { v: cellVal, t, s }
    })
  })

  // ── Column widths (ปรับตามชนิด column) ──
  const cols = header.map(h => {
    if (h === 'id') return { wch: 22 }
    if (h === 'ชื่อ') return { wch: 28 }
    if (h === 'หมวด') return { wch: 12 }
    if (h === 'emoji') return { wch: 6 }
    if (h === 'wasteMode') return { wch: 10 }
    if (h === 'หน่วยซื้อ' || h === 'หน่วยใช้' || h === 'หน่วยชั่ง') return { wch: 10 }
    if (h.startsWith('อัตราแปลง')) return { wch: 22 }
    if (h.startsWith('convSub')) return { wch: 18 }
    if (h === 'ราคา/หน่วยใช้') return { wch: 13 }
    if (h === 'ราคา/หน่วยชั่ง') return { wch: 13 }
    if (h.includes('__มี_')) return { wch: 14 }
    if (h.includes('__เตือน_')) return { wch: 14 }
    return { wch: 14 }
  })
  ws['!cols'] = cols

  // ── Freeze panes (header row + 2 column แรก = id, ชื่อ) ──
  ws['!freeze'] = { xSplit: 2, ySplit: 1 }
  ws['!views'] = [{ state: 'frozen', xSplit: 2, ySplit: 1 }]

  // ── AutoFilter ──
  ws['!autofilter'] = { ref: XLSX.utils.encode_range(range) }

  // ── Row heights (header สูงขึ้นเพื่อ wrap text ได้) ──
  ws['!rows'] = [{ hpx: 42 }, ...rows.map(() => ({ hpx: 22 }))]

  // ── Range ──
  ws['!ref'] = XLSX.utils.encode_range(range)

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Data Sheet')
  return wb
}

function downloadXLSX(filename, wb) {
  XLSX.writeFile(wb, filename, { bookType: 'xlsx', cellStyles: true })
}

/**
 * รวม qty 3 หน่วย → unitUse
 *   qB (หน่วยซื้อ) × factor + qU (หน่วยใช้) + qS (หน่วยชั่ง) / convSub
 *   convSub = per-parent: 1 unitUse = convSub unitSub
 */
function sumQty(qB, qU, qS, factor, convSub) {
  const a = parseFloat(qB) || 0
  const b = parseFloat(qU) || 0
  const c = parseFloat(qS) || 0
  let total = a * factor + b
  if (c > 0 && convSub > 0) total += c / convSub
  return total
}

const CAT_EMOJI = {
  'แยม': '🍓', 'ผลไม้': '🍑', 'ไซรัป': '🍯',
  'ท็อปปิ้ง': '🍫', 'วัตถุดิบ': '🥛', 'บรรจุภัณฑ์': '📦', 'อื่นๆ': '🔖'
}

const CAT_ORDER = ['แยม','ผลไม้','ไซรัป','ท็อปปิ้ง','วัตถุดิบ','บรรจุภัณฑ์','อื่นๆ']

function sortItemsByCategory(items) {
  return [...items].sort((a, b) => {
    const ai = CAT_ORDER.indexOf(a.category || 'อื่นๆ')
    const bi = CAT_ORDER.indexOf(b.category || 'อื่นๆ')
    const aOrder = ai === -1 ? 999 : ai
    const bOrder = bi === -1 ? 999 : bi
    if (aOrder !== bOrder) return aOrder - bOrder
    // ภายในหมวด → เรียงตาม sortOrder (จาก "ลากเพื่อเรียงลำดับ" ใน Settings)
    const sa = a.sortOrder ?? 999
    const sb = b.sortOrder ?? 999
    if (sa !== sb) return sa - sb
    return (a.name || '').localeCompare(b.name || '', 'th')
  })
}

// ── Build Master (max detail) — คืน { header, rows } สำหรับ XLSX ──
//   Per warehouse: 6 columns (มี: 3 หน่วย + แจ้งเตือน: 3 หน่วย)
//   ตัวอย่าง 2 คลัง = 12 column stock + ~11 column master = 23 column
function buildMasterRows(items, warehouses, balanceMap) {
  const baseHeader = ['id','ชื่อ','หมวด','emoji','wasteMode',
    'หน่วยซื้อ','หน่วยใช้','หน่วยชั่ง',
    'อัตราแปลง (ซื้อ→ใช้)',
    'convSub (ใช้→ชั่ง)',   // per-parent (ค่าจริงใน DB)
    'convSub (ซื้อ→ชั่ง)',  // cumulative (display-only)
    'ราคา/หน่วยใช้',
    'ราคา/หน่วยชั่ง']        // = ราคา/หน่วยใช้ ÷ convSub
  const whHeader = []
  warehouses.forEach(w => {
    whHeader.push(`${w.name}__ปัจจุบัน (อ่านอย่างเดียว)`)   // อ้างอิงเฉย ๆ
    whHeader.push(`${w.name}__ขั้นต่ำปัจจุบัน (อ่านอย่างเดียว)`)
    whHeader.push(`${w.name}__มี_หน่วยซื้อ`)
    whHeader.push(`${w.name}__มี_หน่วยใช้`)
    whHeader.push(`${w.name}__มี_หน่วยชั่ง`)
    whHeader.push(`${w.name}__เตือน_หน่วยซื้อ`)
    whHeader.push(`${w.name}__เตือน_หน่วยใช้`)
    whHeader.push(`${w.name}__เตือน_หน่วยชั่ง`)
  })
  const header = [...baseHeader, ...whHeader]

  const rows = sortItemsByCategory(items).map(i => {
    const factor = parseConvFactor(i.unitConversion) || 1
    const convSub = Number(i.convSub) || 0
    const unitPrice = Number(i.unitPrice) || 0
    // ราคา/หน่วยชั่ง = unitPrice ÷ convSub (เช่น 72÷900 = 0.08)
    const pricePerSub = (convSub > 0 && unitPrice > 0)
      ? Number((unitPrice / convSub).toFixed(6))
      : ''
    // convSub ซื้อ→ชั่ง (cumulative) = factor × convSub (เช่น 20×900 = 18,000) — display only
    const convSubCum = (convSub > 0 && factor > 0)
      ? factor * convSub
      : ''
    const base = [
      i.id || '',
      i.name || '',
      i.category || '',
      i.img || '',
      i.wasteMode ? 'YES' : '',
      i.unitBase || '',
      i.unitUse || '',
      i.unitSub || '',
      i.unitConversion || '',
      convSub || '',         // ใช้→ชั่ง (per-parent, ค่าจริง)
      convSubCum,            // ซื้อ→ชั่ง (cumulative, computed)
      unitPrice || '',       // ราคา/หน่วยใช้
      pricePerSub,           // ราคา/หน่วยชั่ง
    ]
    const whCells = []
    warehouses.forEach(w => {
      const b = balanceMap[balanceId(w.id, i.id)]
      const qtyU = b?.qty ?? null
      const minU = b?.minQty ?? null
      // 2 columns แรก = อ้างอิง (อ่านอย่างเดียว) — ระบบจะไม่อ่าน column นี้ตอน import
      whCells.push(qtyU != null ? qtyU : '')
      whCells.push(minU != null ? minU : '')
      // ⚠️ 6 column ที่เหลือ = ว่าง — ใส่เฉพาะค่าที่จะแก้ (ว่าง = ไม่เปลี่ยน)
      whCells.push('')                          // มี_หน่วยซื้อ
      whCells.push('')                          // มี_หน่วยใช้
      whCells.push('')                          // มี_หน่วยชั่ง
      whCells.push('')                          // เตือน_หน่วยซื้อ
      whCells.push('')                          // เตือน_หน่วยใช้
      whCells.push('')                          // เตือน_หน่วยชั่ง
    })
    return [...base, ...whCells]
  })

  return { header, rows }
}

// ── Compute diff for preview ─────────────────────────────────
function computeDiff(csvRows, items, warehouses, balanceMap) {
  const itemDiffs = []   // [{action:'update', id, old:{...}, new:{...}, fields:[]}]
  const stockOps  = []   // [{warehouseId, itemId, qty, min, prevQty}]
  const skipped   = []

  csvRows.forEach(row => {
    const id = row['id']
    if (!id) { skipped.push({ name: row['ชื่อ'], reason: 'no id' }); return }
    const item = items.find(i => i.id === id)
    if (!item) { skipped.push({ name: row['ชื่อ'], reason: 'item not found' }); return }

    // ── Item field diff ───────────────────────────
    const next = {
      name:          row['ชื่อ'] || item.name,
      category:      row['หมวด'] || item.category,
      img:           row['emoji'] || item.img || CAT_EMOJI[row['หมวด']] || '📦',
      wasteMode:     row['wasteMode']?.toUpperCase() === 'YES',
      unitBase:      row['หน่วยซื้อ'] || item.unitBase || '',
      unitUse:       row['หน่วยใช้']  || item.unitUse  || '',
      unitSub:       row['หน่วยชั่ง'] || item.unitSub  || '',
      unitConversion: row['อัตราแปลง (ซื้อ→ใช้)'] || item.unitConversion || '',
      // convSub priority: ใช้→ชั่ง (per-parent ที่กรอก) → ซื้อ→ชั่ง÷factor → ของเดิม
      convSub:       (() => {
        const v1 = row['convSub (ใช้→ชั่ง)']
        const v2 = row['convSub (ซื้อ→ชั่ง)']
        const factorNext = parseConvFactor(row['อัตราแปลง (ซื้อ→ใช้)'] || item.unitConversion || '') || 1
        if (v1 != null && v1 !== '') return Number(v1)
        if (v2 != null && v2 !== '' && factorNext > 0) return Number(v2) / factorNext
        return Number(item.convSub) || 0
      })(),
      // unitPrice priority: หน่วยใช้ → หน่วยชั่ง × convSub → ของเดิม
      unitPrice:     (() => {
        const p1 = row['ราคา/หน่วยใช้']
        const p2 = row['ราคา/หน่วยชั่ง']
        const cs = (() => {
          const v1 = row['convSub (ใช้→ชั่ง)']
          const v2 = row['convSub (ซื้อ→ชั่ง)']
          const factorNext = parseConvFactor(row['อัตราแปลง (ซื้อ→ใช้)'] || item.unitConversion || '') || 1
          if (v1 != null && v1 !== '') return Number(v1)
          if (v2 != null && v2 !== '' && factorNext > 0) return Number(v2) / factorNext
          return Number(item.convSub) || 0
        })()
        if (p1 != null && p1 !== '') return Number(p1)
        if (p2 != null && p2 !== '' && cs > 0) return Number(p2) * cs
        return Number(item.unitPrice) || 0
      })(),
    }
    const fields = []
    Object.keys(next).forEach(k => {
      const a = item[k] ?? (typeof next[k] === 'number' ? 0 : '')
      const b = next[k]
      if (String(a) !== String(b)) fields.push(k)
    })
    if (fields.length > 0) itemDiffs.push({ action: 'update', id, old: item, new: next, fields })

    // ── Stock diff per warehouse (3 หน่วย × qty + 3 หน่วย × min) ──
    const factor  = parseConvFactor(next.unitConversion) || 1
    const convSub = Number(next.convSub) || 0
    warehouses.forEach(w => {
      const qB = row[`${w.name}__มี_หน่วยซื้อ`]
      const qU = row[`${w.name}__มี_หน่วยใช้`]
      const qS = row[`${w.name}__มี_หน่วยชั่ง`]
      const mB = row[`${w.name}__เตือน_หน่วยซื้อ`]
      const mU = row[`${w.name}__เตือน_หน่วยใช้`]
      const mS = row[`${w.name}__เตือน_หน่วยชั่ง`]

      const hasQty = [qB, qU, qS].some(v => v != null && v !== '')
      const hasMin = [mB, mU, mS].some(v => v != null && v !== '')
      if (!hasQty && !hasMin) return

      const qty = hasQty ? sumQty(qB, qU, qS, factor, convSub) : null
      const min = hasMin ? sumQty(mB, mU, mS, factor, convSub) : null
      const prev = balanceMap[balanceId(w.id, item.id)]

      stockOps.push({
        warehouseId: w.id,
        warehouseName: w.name,
        itemId: item.id,
        itemName: next.name,
        unitUse: next.unitUse,
        qty:   qty != null ? qty : (prev?.qty || 0),
        min:   min != null ? min : (prev?.minQty || 0),
        prevQty: prev?.qty ?? null,
        prevMin: prev?.minQty ?? null,
        qtyChanged: qty != null && qty !== (prev?.qty || 0),
        minChanged: min != null && min !== (prev?.minQty || 0),
        // เก็บ breakdown ไว้แสดง preview
        breakdown: {
          qB: parseFloat(qB) || 0,
          qU: parseFloat(qU) || 0,
          qS: parseFloat(qS) || 0,
          mB: parseFloat(mB) || 0,
          mU: parseFloat(mU) || 0,
          mS: parseFloat(mS) || 0,
        },
      })
    })
  })

  return { itemDiffs, stockOps, skipped }
}

export default function DataSheetModal({ open, onClose, items = [], warehouses = [],
  staffPhone, staffName, onSuccess }) {
  const [balanceMap, setBalanceMap] = useState({})
  const [uploaded, setUploaded] = useState(null)   // { rows, fileName }
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState('')
  const [err, setErr] = useState('')
  const [phase, setPhase] = useState('idle')       // idle | preview | applying | done

  // Load balances
  useEffect(() => {
    if (!open) return
    setLoading(true)
    getDocs(collection(db, COL.STOCK_BALANCES)).then(snap => {
      const map = {}
      snap.docs.forEach(d => { map[d.id] = d.data() })
      setBalanceMap(map)
      setLoading(false)
    })
  }, [open])

  async function handleDownload() {
    // ดึงสต็อกล่าสุดสดๆ ก่อน export (กันค่าเก่าค้างถ้าเปิด modal ทิ้งไว้นาน)
    setLoading(true)
    setProgress('กำลังดึงสต็อกล่าสุด...')
    try {
      const snap = await getDocs(collection(db, COL.STOCK_BALANCES))
      const freshMap = {}
      snap.docs.forEach(d => { freshMap[d.id] = d.data() })
      setBalanceMap(freshMap)
      const { header, rows } = buildMasterRows(items, warehouses, freshMap)
      const wb = buildStyledWorkbook(header, rows, warehouses)
      downloadXLSX(`inventory_datasheet_${new Date().toISOString().slice(0,10)}.xlsx`, wb)
    } finally {
      setLoading(false)
      setProgress('')
    }
    return
  }

  async function handleUpload(e) {
    const f = e.target.files?.[0]
    if (!f) return
    try {
      const { rows } = await readSpreadsheet(f)
      if (!rows.length) { setErr('ไฟล์ว่าง / ไม่มีข้อมูล'); return }
      setUploaded({ rows, fileName: f.name })
      setPhase('preview')
      setErr('')
    } catch (er) {
      setErr('Parse ไฟล์ผิด: ' + er.message)
    } finally {
      e.target.value = ''
    }
  }

  const diff = useMemo(() => {
    if (!uploaded) return { itemDiffs: [], stockOps: [], skipped: [] }
    return computeDiff(uploaded.rows, items, warehouses, balanceMap)
  }, [uploaded, items, warehouses, balanceMap])

  async function handleApply() {
    if (!uploaded || phase === 'applying') return
    setPhase('applying'); setLoading(true); setErr('')
    try {
      const now = serverTimestamp()
      const BATCH = 400

      // Step 1: items update
      const itemUpdates = diff.itemDiffs
      let done = 0
      for (let i = 0; i < itemUpdates.length; i += BATCH) {
        const batch = writeBatch(db)
        const slice = itemUpdates.slice(i, i + BATCH)
        slice.forEach(d => {
          batch.update(doc(db, COL.ITEMS, d.id), d.new)
        })
        await batch.commit()
        done += slice.length
        setProgress(`Items ${done}/${itemUpdates.length}`)
      }

      // Step 2: stock_balances + movements
      const stockOps = diff.stockOps.filter(o => o.qtyChanged || o.minChanged)
      done = 0
      for (let i = 0; i < stockOps.length; i += BATCH) {
        const batch = writeBatch(db)
        const slice = stockOps.slice(i, i + BATCH)
        slice.forEach(op => {
          const balRef = doc(db, COL.STOCK_BALANCES, balanceId(op.warehouseId, op.itemId))
          batch.set(balRef, {
            warehouseId:   op.warehouseId,
            itemId:        op.itemId,
            qty:           op.qty,
            minQty:        op.min,
            unit:          op.unitUse,
            lastUpdated:   now,
            lastUpdatedBy: staffPhone || '',
          }, { merge: true })

          if (op.qtyChanged) {
            const movRef = doc(collection(db, COL.STOCK_MOVEMENTS))
            const delta  = op.qty - (op.prevQty || 0)
            batch.set(movRef, {
              type:         'adjust',
              itemId:       op.itemId,
              itemName:     op.itemName,
              warehouseId:  op.warehouseId,
              qty:          delta,
              unit:         op.unitUse,
              qtyUse:       delta,
              unitUse:      op.unitUse,
              adjustReason: 'Data Sheet Import',
              note:         'Bulk import',
              staffPhone, staffName,
              timestamp:    now,
            })
          }
        })
        // audit per batch
        const audRef = doc(collection(db, COL.AUDIT_LOGS))
        batch.set(audRef, {
          action:    'super_excel_import',
          staffPhone, staffName,
          detail:    `Stock update ${slice.length} ops`,
          timestamp: now,
        })
        await batch.commit()
        done += slice.length
        setProgress(`Stock ${done}/${stockOps.length}`)
      }

      // Final audit
      const finalBatch = writeBatch(db)
      finalBatch.set(doc(collection(db, COL.AUDIT_LOGS)), {
        action:    'super_excel_complete',
        staffPhone, staffName,
        detail:    `Items updated: ${itemUpdates.length} · Stock ops: ${stockOps.length}`,
        timestamp: now,
      })
      await finalBatch.commit()

      beepSuccess()
      onSuccess?.(`✅ Data Sheet: ${itemUpdates.length} items · ${stockOps.length} stock ops`)
      setPhase('done')
      setProgress('')
    } catch (e) {
      console.error('[DataSheet]', e)
      setErr(e.message || 'เกิดข้อผิดพลาด')
      setPhase('preview')
    } finally {
      setLoading(false)
    }
  }

  function reset() {
    setUploaded(null); setPhase('idle'); setErr(''); setProgress('')
  }

  if (!open) return null

  const totalStockChanges = diff.stockOps.filter(o => o.qtyChanged || o.minChanged).length

  return (
    <Modal open={open} onClose={() => { if (!loading) { reset(); onClose?.() } }}
      title="📊 Data Sheet (Master + Stock)">
      <div style={{ padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>

        {phase === 'done' && (
          <div style={{ background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 12,
            padding: 14, color: '#15803D', fontSize: 13, fontWeight: 700, textAlign: 'center' }}>
            ✅ Apply เรียบร้อยทั้งหมด
          </div>
        )}

        {phase !== 'done' && (
          <>
            {/* Info box */}
            <div style={{ background: '#EFF6FF', border: '1px solid #BFDBFE',
              borderRadius: 10, padding: '10px 14px', fontSize: 12, color: '#1D4ED8' }}>
              <strong>📋 ไฟล์มี {11 + 6 * warehouses.length} columns · {items.length} แถว</strong>
              <div style={{ marginTop: 6, fontSize: 11 }}>
                <strong>Master (11 col):</strong> id · ชื่อ · หมวด · emoji · wasteMode · 3 หน่วย · อัตราแปลง · convSub · ราคา
              </div>
              <div style={{ marginTop: 4, fontSize: 11 }}>
                <strong>คลัง (6 col/คลัง × {warehouses.length}):</strong>
                <br/>· <em>มี:</em> qty หน่วยซื้อ + qty หน่วยใช้ + qty หน่วยชั่ง
                <br/>· <em>เตือน:</em> min หน่วยซื้อ + min หน่วยใช้ + min หน่วยชั่ง
              </div>
              <div style={{ marginTop: 6, fontSize: 10, fontStyle: 'italic', opacity: 0.85 }}>
                💡 กรอกตัวเลขช่องไหนก็ได้ — ระบบรวมเป็น unitUse อัตโนมัติ. ปล่อยว่างทั้ง 3 ช่อง = ไม่อัพเดต
              </div>
            </div>

            {/* Action buttons */}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={handleDownload} disabled={loading}
                style={{ flex: 1, padding: '12px', border: '1.5px solid var(--border2)',
                  borderRadius: 12, background: '#fff', cursor: 'pointer',
                  fontSize: 13, fontWeight: 700, color: 'var(--txt2)' }}>
                📥 Download .xlsx ({items.length} × {warehouses.length})
              </button>
              <label style={{ flex: 1, padding: '12px', border: '1.5px solid var(--red)',
                borderRadius: 12, background: 'var(--red-p)', cursor: 'pointer',
                fontSize: 13, fontWeight: 700, color: 'var(--red)',
                display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                📂 Upload (.xlsx / .csv)
                <input type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
                  onChange={handleUpload} disabled={loading}/>
              </label>
            </div>

            {phase === 'preview' && uploaded && (
              <>
                <div style={{ background: 'var(--bg)', borderRadius: 10, padding: '10px 12px',
                  fontSize: 12 }}>
                  📄 <strong>{uploaded.fileName}</strong> · {uploaded.rows.length} แถว
                </div>

                {/* Summary */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                  <div style={{ background: '#EFF6FF', borderRadius: 10, padding: 10, textAlign: 'center' }}>
                    <div style={{ fontSize: 20, fontWeight: 700, color: '#1D4ED8' }}>{diff.itemDiffs.length}</div>
                    <div style={{ fontSize: 10, color: '#1D4ED8' }}>✏️ items แก้ไข</div>
                  </div>
                  <div style={{ background: '#F0FDF4', borderRadius: 10, padding: 10, textAlign: 'center' }}>
                    <div style={{ fontSize: 20, fontWeight: 700, color: '#15803D' }}>{totalStockChanges}</div>
                    <div style={{ fontSize: 10, color: '#15803D' }}>📦 stock อัพเดต</div>
                  </div>
                  <div style={{ background: diff.skipped.length ? '#FEE2E2' : '#F2F2F7',
                    borderRadius: 10, padding: 10, textAlign: 'center' }}>
                    <div style={{ fontSize: 20, fontWeight: 700,
                      color: diff.skipped.length ? '#DC2626' : '#6B7280' }}>{diff.skipped.length}</div>
                    <div style={{ fontSize: 10, color: diff.skipped.length ? '#DC2626' : '#6B7280' }}>⚠️ ข้าม</div>
                  </div>
                </div>

                {/* Item diffs preview */}
                {diff.itemDiffs.length > 0 && (
                  <div style={{ background: '#fff', border: '1px solid #BFDBFE',
                    borderRadius: 10, padding: 10 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#1D4ED8', marginBottom: 6 }}>
                      ✏️ Items ที่จะแก้ไข ({diff.itemDiffs.length})
                    </div>
                    <div style={{ maxHeight: 120, overflowY: 'auto', display: 'flex',
                      flexDirection: 'column', gap: 4 }}>
                      {diff.itemDiffs.slice(0, 50).map(d => (
                        <div key={d.id} style={{ fontSize: 10, color: 'var(--txt2)',
                          background: 'var(--bg)', borderRadius: 6, padding: '4px 8px' }}>
                          <strong>{d.new.name}</strong> · {d.fields.join(', ')}
                        </div>
                      ))}
                      {diff.itemDiffs.length > 50 && (
                        <div style={{ fontSize: 10, color: 'var(--txt3)', textAlign: 'center' }}>
                          + {diff.itemDiffs.length - 50} อันอื่น ๆ
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Stock ops preview */}
                {totalStockChanges > 0 && (
                  <div style={{ background: '#fff', border: '1px solid #BBF7D0',
                    borderRadius: 10, padding: 10 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#15803D', marginBottom: 6 }}>
                      📦 Stock changes ({totalStockChanges})
                    </div>
                    <div style={{ maxHeight: 140, overflowY: 'auto', display: 'flex',
                      flexDirection: 'column', gap: 3 }}>
                      {diff.stockOps.filter(o => o.qtyChanged || o.minChanged).slice(0, 50).map((op, i) => (
                        <div key={i} style={{ fontSize: 10, color: 'var(--txt2)',
                          background: 'var(--bg)', borderRadius: 6, padding: '4px 8px',
                          display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                          <span><strong>{op.itemName}</strong></span>
                          <span style={{ color: 'var(--txt3)' }}>
                            {op.warehouseName} ·
                            {op.qtyChanged && ` ${op.prevQty ?? 0}→${op.qty} ${op.unitUse}`}
                            {op.minChanged && ` (min:${op.prevMin ?? 0}→${op.min})`}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Skipped */}
                {diff.skipped.length > 0 && (
                  <div style={{ background: '#FEF3C7', border: '1px solid #FDE68A',
                    borderRadius: 10, padding: '8px 12px', fontSize: 10, color: '#92400E' }}>
                    ⚠️ ข้าม {diff.skipped.length} แถว: {diff.skipped.slice(0,5).map(s => s.name).join(', ')}
                    {diff.skipped.length > 5 && '...'}
                  </div>
                )}

                {progress && (
                  <div style={{ background: '#EFF6FF', color: '#1D4ED8', padding: '8px 12px',
                    borderRadius: 8, fontSize: 12, fontWeight: 600, textAlign: 'center' }}>
                    {progress}
                  </div>
                )}
              </>
            )}

            {err && (
              <div style={{ background: '#FEE2E2', color: '#DC2626', padding: '8px 12px',
                borderRadius: 8, fontSize: 12, fontWeight: 600 }}>{err}</div>
            )}

            {phase === 'preview' && uploaded && (
              <button onClick={handleApply} disabled={loading}
                style={{ padding: '14px', border: 'none', borderRadius: 12,
                  background: loading ? 'var(--border2)' : 'var(--red)',
                  color: '#fff', fontSize: 14, fontWeight: 700,
                  cursor: loading ? 'wait' : 'pointer' }}>
                {loading
                  ? 'กำลังอัพเดต...'
                  : `🚀 Apply (${diff.itemDiffs.length} items + ${totalStockChanges} stock)`}
              </button>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
