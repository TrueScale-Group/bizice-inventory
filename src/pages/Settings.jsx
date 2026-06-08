import { useState, useEffect, useRef } from 'react'
import { db } from '../firebase'
import { collection, onSnapshot, doc, getDoc, setDoc, addDoc, updateDoc,
         deleteDoc, serverTimestamp, writeBatch, getDocs, query, where } from 'firebase/firestore'
import { ConnectionStatus } from '../components/ConnectionStatus'
import { Modal } from '../components/Modal'
import { useSession } from '../hooks/useSession'
import { Toast } from '../components/Toast'
import IntegrationModal from '../components/IntegrationModal'
import QuickTemplateModal from '../components/QuickTemplateModal'
import SeedStockModal from '../components/SeedStockModal'
import DataSheetModal from '../components/DataSheetModal'
import { COL } from '../constants/collections'
import { beepAdd, beepRemove } from '../utils/audio'

const CAT_EMOJI = {
  'แยม': '🍓', 'ผลไม้': '🍑', 'ไซรัป': '🍯',
  'ท็อปปิ้ง': '🍫', 'วัตถุดิบ': '🥛', 'บรรจุภัณฑ์': '📦', 'อื่นๆ': '🔖'
}

// ── เลือก level ที่ user ใน CM เลือกเป็น "หน่วยใช้" ──
//   CM มี item.unit = finalUnit ที่ user เลือกใน dropdown "หน่วยที่ใช้ตัดสต็อก"
//   หา index ของ level ที่ตรงกับ item.unit (default = level[1] ถ้าไม่เจอ)
function findUseLevelIdx(levels, finalUnit) {
  if (!Array.isArray(levels) || levels.length === 0) return -1
  if (finalUnit) {
    const i = levels.findIndex(l => l.name === finalUnit)
    if (i >= 1) return i        // เลือก level >= 1 (level 0 = base ห้ามเป็น unitUse)
  }
  return Math.min(1, levels.length - 1)   // default = level[1]
}

// ── คำนวณ cumulative factor จาก base ถึง level[idx] ──
//   levels เก็บแบบ per-parent: total = level[1].qty × level[2].qty × ...
function cumulativeFactor(levels, idx) {
  let f = 1
  for (let i = 1; i <= idx; i++) f *= Number(levels[i]?.qty || 1)
  return f
}

// ── Build unitLevels[] = ทุกระดับจาก CM พร้อม factorToUse ──
//   factorToUse: 1 ของ level นี้ = N ของ unitUse (ใช้แปลงตอนปรับยอด)
function buildUnitLevels(levels, useIdx) {
  if (!Array.isArray(levels) || levels.length === 0) return []
  const cumUse = cumulativeFactor(levels, useIdx) || 1
  // cumulativeFactor(idx) = จำนวน level[idx] ใน 1 level[0]
  //   → 1 level[i] = cum(useIdx) / cum(i) ของ level[useIdx]
  return levels.map((lv, i) => {
    const cumI = cumulativeFactor(levels, i) || 1
    return {
      name: lv?.name || '',
      factorToUse: cumUse / cumI,
    }
  }).filter(l => l.name)
}

// ── Build unitConversion string ──
//   ใช้ cumulative factor ตาม useLevel ที่เลือก
function buildUnitConversion(levels, useIdx) {
  if (!Array.isArray(levels) || levels.length < 2) return ''
  const base = levels[0]
  const use  = levels[useIdx]
  if (!base?.name || !use?.name) return ''
  const factor = cumulativeFactor(levels, useIdx)
  return `1 ${base.name} = ${factor} ${use.name}`
}

// ── คำนวณ diff ระหว่าง CM library กับ Inventory items ──
async function diffFromCostManager() {
  const snap = await getDoc(doc(db, 'mixue_data', 'mixue-cost-manager'))
  if (!snap.exists()) throw new Error('ไม่พบข้อมูล Cost Manager')
  const library = snap.data().library || []
  if (library.length === 0) throw new Error('ไม่มีวัตถุดิบใน Cost Manager')

  const existingSnap = await getDocs(collection(db, COL.ITEMS))
  const existingMap = {}
  existingSnap.docs.forEach(d => { existingMap[d.data().name] = { id: d.id, ...d.data() } })

  const toAdd = []
  const toUpdate = []

  library.forEach(item => {
    const cat = item.cat || 'อื่นๆ'
    const levels = item.levels || []
    const inv0 = existingMap[item.name]   // เพื่อตรวจ local cutLevel

    // ── เลือก level ที่ใช้ — เคารพ local cutLevel ของ Inventory ถ้ามี ──
    //   ถ้า user ตั้ง cutLevel ไว้แล้ว → ใช้ตัวนั้น
    //   ถ้าไม่มี แต่ inv.unitUse match level เดิม → infer cutLevel จาก unitUse
    //   ถ้าไม่มีอะไรเลย → ใช้ CM's dropdown (item.unit)
    const cmUseIdx = findUseLevelIdx(levels, item.unit)
    const cmCutLevel = cmUseIdx === 0 ? 'buy' : cmUseIdx === 1 ? 'use' : 'sub'

    let effectiveCutLevel
    if (inv0?.cutLevel) {
      effectiveCutLevel = inv0.cutLevel
    } else if (inv0?.unitUse) {
      // Legacy item — infer cutLevel จาก unitUse ที่ตรงกับ level name
      const inferredIdx = levels.findIndex(l => l.name === inv0.unitUse)
      if (inferredIdx === 0)      effectiveCutLevel = 'buy'
      else if (inferredIdx === 1) effectiveCutLevel = 'use'
      else if (inferredIdx >= 2)  effectiveCutLevel = 'sub'
      else                         effectiveCutLevel = cmCutLevel
    } else {
      effectiveCutLevel = cmCutLevel
    }

    const useIdx =
      effectiveCutLevel === 'buy' ? 0 :
      effectiveCutLevel === 'sub' ? Math.min(2, levels.length - 1) :
      Math.min(1, levels.length - 1)

    const unitBase = levels[0]?.name || item.unit || ''
    const unitUse  = levels[useIdx]?.name || levels[0]?.name || ''
    // Raw 3-level (เก็บไว้สำหรับ Master Data form — ไม่ขึ้นกับ cutLevel)
    const unitUseRaw = levels[1]?.name || ''       // middle (raw)
    const unitSubRawCm = levels[2]?.name || ''     // smallest (raw)

    // unitConversion = "1 unitBase = cumulative unitUse"
    const unitConversion = buildUnitConversion(levels, useIdx)

    // ── unitSub = level ที่เล็กกว่า unitUse (ถ้ามี) — ใช้สำหรับ Waste Logs ──
    let unitSub = ''
    let convSub = 0
    if (useIdx < levels.length - 1) {
      const subIdx = levels.length - 1   // เอา level เล็กสุด
      unitSub = levels[subIdx]?.name || ''
      // convSub (per-parent semantics): 1 unitUse = convSub unitSub
      //   = cumulative(base→subIdx) / cumulative(base→useIdx)
      const fSub = cumulativeFactor(levels, subIdx)
      const fUse = cumulativeFactor(levels, useIdx)
      convSub = fUse > 0 ? fSub / fUse : 0
    }

    // ── unitPrice = ฿/unitUse ──
    //   CM.unitPrice = ฿/smallest level (level สุดท้าย)
    //   ต้องแปลงเป็น ฿/unitUse ถ้า useIdx != smallest
    const cmPrice = Number(item.unitPrice) || 0
    const lastIdx = levels.length - 1
    const fUse    = cumulativeFactor(levels, useIdx)
    const fLast   = cumulativeFactor(levels, lastIdx)
    // ราคา/unitUse = CM.unitPrice × (fLast / fUse)
    const unitPrice = (fUse > 0 && fLast > 0)
      ? cmPrice * (fLast / fUse)
      : cmPrice
    // rawBasePrice = ฿/หน่วยที่ 1 (ฐาน) — invariant สำหรับเปลี่ยน cutLevel ในอนาคต
    //   = CM.unitPrice × fLast  (เพราะ smallest_count_per_base = fLast)
    const rawBasePrice = fLast > 0 ? cmPrice * fLast : 0

    // cmCutLevel แล้วถูกคำนวณไว้ด้านบน (อิงจาก CM.unit)
    // effectiveCutLevel = อะไรที่ใช้จริง (เคารพ local override)

    const unitLevels = buildUnitLevels(levels, useIdx)

    if (!existingMap[item.name]) {
      toAdd.push({ cmItem: item, cat, unitBase, unitUse, unitConversion, unitSub, convSub,
        unitPrice, rawBasePrice, cmCutLevel, unitUseRaw, unitSubRawCm, unitLevels })
    } else {
      const inv = existingMap[item.name]
      const changes = []
      if ((inv.unitBase || '')       !== unitBase)       changes.push({ field: 'หน่วยฐาน',  from: inv.unitBase || '', to: unitBase })
      if ((inv.unitUse  || '')       !== unitUse)        changes.push({ field: 'หน่วยใช้',  from: inv.unitUse  || '', to: unitUse })
      if ((inv.unitConversion || '') !== unitConversion) changes.push({ field: 'อัตราแปลง', from: inv.unitConversion || '', to: unitConversion })
      if ((inv.unitSub || '')        !== unitSub)        changes.push({ field: 'หน่วยชั่ง (Waste)', from: inv.unitSub || '', to: unitSub })
      if (Number(inv.convSub) || 0) {} // compare
      if ((Number(inv.convSub) || 0) !== convSub)        changes.push({ field: 'อัตราชั่ง',  from: String(inv.convSub || 0), to: String(convSub) })
      if (Math.abs((Number(inv.unitPrice) || 0) - unitPrice) > 0.001) {
        changes.push({
          field: 'ราคา/หน่วย',
          from: `฿${Number(inv.unitPrice || 0).toFixed(2)}`,
          to:   `฿${Number(unitPrice).toFixed(2)}`,
        })
      }
      // ── Force update ถ้า raw fields หาย หรือ unitLevels factor ผิด ──
      const invLv = Array.isArray(inv.unitLevels) ? inv.unitLevels : []
      const factorMismatch = invLv.length !== unitLevels.length ||
        unitLevels.some((lv, i) => {
          const a = invLv[i]
          if (!a || a.name !== lv.name) return true
          const ratio = Number(a.factorToUse) || 0
          return Math.abs(ratio - lv.factorToUse) > 0.0001
        })
      const needMigration =
        (inv.unitUseRaw == null && unitUseRaw) ||
        (inv.unitSubRaw == null && unitSubRawCm) ||
        (inv.cutLevel == null) ||
        (inv.rawBasePrice == null && rawBasePrice > 0) ||
        factorMismatch
      if (needMigration && changes.length === 0) {
        changes.push({ field: 'ระบบ', from: factorMismatch ? 'unitLevels เก่า/ผิด' : 'รุ่นเก่า', to: 'อัพเดท unitLevels + raw 3-level + cutLevel' })
      }
      if (changes.length > 0) {
        toUpdate.push({ inv, cmItem: item, changes, cat, unitBase, unitUse, unitConversion, unitSub, convSub,
          unitPrice, rawBasePrice, cmCutLevel, effectiveCutLevel, unitUseRaw, unitSubRawCm, unitLevels })
      }
    }
  })

  return { toAdd, toUpdate, total: library.length, lastSync: snap.data().updatedAt || '' }
}

// ── apply update: batch write (V2 schema + unitSub สำหรับ Waste Logs) ──
async function applyUpdateFromCM(toAdd, toUpdate, onProgress) {
  const BATCH_SIZE = 400
  let done = 0
  const total = toAdd.length + toUpdate.length

  // เพิ่มรายการใหม่
  for (let i = 0; i < toAdd.length; i += BATCH_SIZE) {
    const batch = writeBatch(db)
    toAdd.slice(i, i + BATCH_SIZE).forEach(({ cmItem, cat, unitBase, unitUse, unitConversion, unitSub, convSub,
      unitPrice, rawBasePrice, cmCutLevel, unitUseRaw, unitSubRawCm, unitLevels }) => {
      const ref = doc(collection(db, COL.ITEMS))
      // หน่วย 3 ระดับจาก CM levels[] (raw)
      const cmLevels = cmItem.levels || []
      const c1 = Number(cmLevels[1]?.qty) || 1
      const c2 = Number(cmLevels[2]?.qty) || 0
      batch.set(ref, {
        name: cmItem.name,
        category: cat,
        img: CAT_EMOJI[cat] || '📦',
        // Effective (computed for current cutLevel)
        unitBase, unitUse, unitConversion,
        unitSub, convSub,
        // Raw 3-level (preserved สำหรับ Master Data form)
        unitBuy:    cmLevels[0]?.name || unitBase,
        unitUseRaw: unitUseRaw,
        unitSubRaw: unitSubRawCm,
        convBuyToUse: c1,
        convUseToSub: c2,
        cutLevel:   cmCutLevel,           // ตาม CM dropdown
        wasteLevel: unitSubRawCm ? 'sub' : 'use',
        unitLevels: unitLevels || [],     // ทุก level จาก CM + factorToUse
        unitPrice, rawBasePrice,
        wasteMode: cat === 'ผลไม้',
        sourceId: cmItem.id,
        createdAt: serverTimestamp(),
      })
    })
    await batch.commit()
    done += Math.min(BATCH_SIZE, toAdd.length - i)
    onProgress(`เพิ่มใหม่ ${done}/${total}...`)
  }

  // อัพเดทรายการเดิม
  for (let i = 0; i < toUpdate.length; i += BATCH_SIZE) {
    const batch = writeBatch(db)
    toUpdate.slice(i, i + BATCH_SIZE).forEach(({ inv, cmItem, unitBase, unitUse, unitConversion, unitSub, convSub,
      unitPrice, rawBasePrice, cmCutLevel, effectiveCutLevel, unitUseRaw, unitSubRawCm, unitLevels }) => {
      const cmLevels = cmItem.levels || []
      const c1 = Number(cmLevels[1]?.qty) || 1
      const c2 = Number(cmLevels[2]?.qty) || 0
      batch.update(doc(db, COL.ITEMS, inv.id), {
        unitBase, unitUse, unitConversion,
        unitSub, convSub,
        unitBuy:    cmLevels[0]?.name || unitBase,
        unitUseRaw,
        unitSubRaw: unitSubRawCm,
        convBuyToUse: c1,
        convUseToSub: c2,
        // เก็บ cutLevel (inferred/local/cm) เพื่อให้ future sync stable
        cutLevel:   effectiveCutLevel || cmCutLevel,
        unitLevels: unitLevels || [],
        unitPrice, rawBasePrice,
      })
    })
    await batch.commit()
    done += Math.min(BATCH_SIZE, toUpdate.length - i)
    onProgress(`อัพเดท ${done}/${total}...`)
  }
}
/* ══════════════════════════════════════════════════════════
   POS-style Stepper + Unit Chips (shared helpers)
   ══════════════════════════════════════════════════════════ */
function PosQty({ value, onChange, min = 0 }) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 0, borderRadius: 12,
      border: '1.5px solid #F59E0B', overflow: 'hidden', background: '#FFF9EF', width: 'fit-content' }}>
      <button onClick={() => { beepRemove(); onChange(Math.max(min, (value||0) - 1)) }}
        style={{ width: 40, height: 40, border: 'none', background: 'transparent',
          fontSize: 22, fontWeight: 700, color: '#F59E0B', cursor: 'pointer', lineHeight: 1 }}>
        −
      </button>
      <span style={{ minWidth: 38, textAlign: 'center', fontFamily: 'Prompt',
        fontWeight: 700, fontSize: 17, color: '#1C1C1E' }}>
        {value || 0}
      </span>
      <button onClick={() => { beepAdd(); onChange((value||0) + 1) }}
        style={{ width: 40, height: 40, border: 'none', background: '#F59E0B',
          fontSize: 22, fontWeight: 700, color: '#fff', cursor: 'pointer', lineHeight: 1 }}>
        +
      </button>
    </div>
  )
}

function UnitChips({ opts, selected, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
      {opts.map(o => {
        const active = selected === o.value
        return (
          <button key={o.value} onClick={() => onChange(o.value)}
            style={{ padding: '5px 12px', borderRadius: 8, border: 'none', cursor: 'pointer',
              background: active ? '#F59E0B' : '#F3F4F6',
              color: active ? '#fff' : '#374151',
              fontWeight: active ? 700 : 500, fontSize: 13,
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
            <span>{o.label}</span>
            {o.sub && <span style={{ fontSize: 9, opacity: 0.8 }}>{o.sub}</span>}
          </button>
        )
      })}
    </div>
  )
}

/* ══════════════════════════════════════════════════════════
   MultiLevelStepper — [−] qty [+] ชื่อหน่วย  สำหรับทุก level
   ══════════════════════════════════════════════════════════ */
function MultiLevelStepper({ levels, values, onChange }) {
  // levels  : [{ name, factor, qty }, ...]   — index 0 = base unit (smallest)
  // values  : number[]                        — qty per level
  // onChange: (newValues: number[]) => void
  const [editIdx, setEditIdx] = useState(null)
  const [editVal, setEditVal] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    if (editIdx !== null && inputRef.current) inputRef.current.select()
  }, [editIdx])

  function setLvl(i, v) {
    const next = (values && values.length === levels.length)
      ? [...values]
      : levels.map(() => 0)
    next[i] = Math.max(0, Math.floor(v))
    onChange(next)
  }

  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      {levels.map((lv, i) => {
        // levels มาจาก Cost Manager เรียงใหญ่→เล็กอยู่แล้ว ไม่ต้อง reverse
        const qty = values?.[i] ?? 0
        const isEditing = editIdx === i
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 0,
            borderRadius: 10, border: '1.5px solid #F59E0B', overflow: 'hidden',
            background: '#FFF9EF', flexShrink: 0 }}>
            {/* − */}
            <button
              onClick={() => { beepRemove(); setLvl(i, qty - 1) }}
              style={{ width: 34, height: 38, border: 'none', background: 'transparent',
                fontSize: 20, fontWeight: 700, color: '#F59E0B', cursor: 'pointer', lineHeight: 1 }}>
              −
            </button>
            {/* qty display / tap-to-edit */}
            {isEditing ? (
              <input
                ref={inputRef}
                type="number" min="0" step="1"
                value={editVal}
                onChange={e => setEditVal(e.target.value)}
                onBlur={() => { setLvl(i, parseFloat(editVal) || 0); setEditIdx(null) }}
                onKeyDown={e => {
                  if (e.key === 'Enter') { setLvl(i, parseFloat(editVal) || 0); setEditIdx(null) }
                  if (e.key === 'Escape') setEditIdx(null)
                }}
                style={{ width: 44, textAlign: 'center', border: 'none', outline: 'none',
                  background: 'transparent', fontFamily: 'Prompt', fontWeight: 700,
                  fontSize: 15, color: '#1C1C1E', padding: 0 }}
              />
            ) : (
              <span
                onClick={() => { setEditIdx(i); setEditVal(String(qty)) }}
                title="แตะเพื่อพิมพ์ตัวเลข"
                style={{ minWidth: 38, textAlign: 'center', fontFamily: 'Prompt',
                  fontWeight: 700, fontSize: 15, color: qty > 0 ? '#1C1C1E' : '#C4B5A0',
                  cursor: 'text', padding: '0 2px', lineHeight: '38px' }}>
                {qty}
              </span>
            )}
            {/* + */}
            <button
              onClick={() => { beepAdd(); setLvl(i, qty + 1) }}
              style={{ width: 34, height: 38, border: 'none', background: '#F59E0B',
                fontSize: 20, fontWeight: 700, color: '#fff', cursor: 'pointer', lineHeight: 1 }}>
              +
            </button>
            {/* unit name label */}
            <span style={{ fontSize: 11.5, fontWeight: 700, color: '#92400E',
              padding: '0 8px', background: '#FEF3C7', lineHeight: '38px', whiteSpace: 'nowrap' }}>
              {lv.name}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/* helper — ตรวจว่าหน่วยเป็นหน่วยชั่ง/ตวง (ซ่อนอัตโนมัติจาก Inventory) */
const WEIGHT_VOL_UNITS = ['กรัม','กก.','กิโลกรัม','มล.','มิลลิลิตร','ลิตร','ซีซี','cc','ml','g','kg','l','oz','ออนซ์']
function isWeightVolUnit(name) {
  return WEIGHT_VOL_UNITS.some(u => (name||'').toLowerCase().trim() === u.toLowerCase())
}

/* helper — คำนวณ qty รวมในหน่วยฐาน (level 0) */
function calcBaseQty(lqArr, levels) {
  if (!lqArr || !levels || levels.length === 0) return 0
  return levels.reduce((sum, lv, i) => sum + ((lqArr[i] || 0) * lv.factor), 0)
}

/* ══════════════════════════════════════════════════════════
   Opening Stock Modal — กรอกสต็อกเริ่มต้นแยกตามคลัง
   ══════════════════════════════════════════════════════════ */
const DEFAULT_SOURCES = ['ตลาดไท', 'ซัพพลายเออร์', 'โอนจากคลัง', 'ซื้อเอง', 'อื่นๆ']

function SourcesModal({ open, onClose }) {
  const [sources, setSources]   = useState([])
  const [newSrc, setNewSrc]     = useState('')
  const [editIdx, setEditIdx]   = useState(null)   // index ที่กำลัง inline-edit
  const [editVal, setEditVal]   = useState('')
  const [saving, setSaving]     = useState(false)
  const [loaded, setLoaded]     = useState(false)
  const dragIdx = useRef(null)

  useEffect(() => {
    if (!open) { setEditIdx(null); setNewSrc(''); return }
    setLoaded(false)
    getDoc(doc(db, COL.APP_SETTINGS, 'sources')).then(snap => {
      setSources(snap.exists() ? (snap.data().list || DEFAULT_SOURCES) : DEFAULT_SOURCES)
      setLoaded(true)
    })
  }, [open])

  async function persist(list) {
    setSaving(true)
    await setDoc(doc(db, COL.APP_SETTINGS, 'sources'), { list })
    setSources(list)
    setSaving(false)
  }

  function addSource() {
    const v = newSrc.trim()
    if (!v || sources.includes(v)) return
    persist([...sources, v])
    setNewSrc('')
  }

  function remove(i) {
    if (editIdx === i) setEditIdx(null)
    persist(sources.filter((_, idx) => idx !== i))
  }

  function startEdit(i) { setEditIdx(i); setEditVal(sources[i]) }

  function commitEdit(i) {
    const v = editVal.trim()
    if (!v) { setEditIdx(null); return }
    const next = sources.map((s, idx) => idx === i ? v : s)
    persist(next)
    setEditIdx(null)
  }

  // drag-and-drop reorder
  function onDragStart(i) { dragIdx.current = i }
  function onDragOver(e, i) {
    e.preventDefault()
    if (dragIdx.current === null || dragIdx.current === i) return
    const next = [...sources]
    const [moved] = next.splice(dragIdx.current, 1)
    next.splice(i, 0, moved)
    dragIdx.current = i
    setSources(next)
  }
  function onDrop() { persist(sources); dragIdx.current = null }

  const rowStyle = {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '9px 10px', background: 'var(--bg)',
    borderRadius: 10, border: '1px solid var(--border)',
    transition: 'box-shadow .15s',
  }
  const iconBtn = (onClick, children, color = 'var(--txt3)') => (
    <button onClick={onClick} disabled={saving}
      style={{ border: 'none', background: 'none', padding: '4px 6px',
        fontSize: 15, cursor: 'pointer', color, lineHeight: 1, flexShrink: 0 }}>
      {children}
    </button>
  )

  return (
    <Modal open={open} onClose={onClose} title="🚚 แหล่งที่มาสินค้า">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

        {/* hint */}
        <div style={{ fontSize: 12, color: 'var(--txt3)', paddingBottom: 2 }}>
          รายการที่แสดงในเมนู "รับสินค้า" · ลากเพื่อเรียงลำดับ
        </div>

        {/* list */}
        {!loaded ? (
          <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--txt3)', fontSize: 13 }}>กำลังโหลด...</div>
        ) : sources.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--txt3)', fontSize: 13 }}>ยังไม่มีแหล่งที่มา</div>
        ) : sources.map((s, i) => (
          <div key={i}
            draggable onDragStart={() => onDragStart(i)} onDragOver={e => onDragOver(e, i)} onDrop={onDrop}
            style={rowStyle}>
            {/* drag handle */}
            <span style={{ fontSize: 14, color: 'var(--txt3)', cursor: 'grab', userSelect: 'none', flexShrink: 0 }}>☰</span>
            {/* number */}
            <span style={{ fontSize: 11, color: 'var(--txt3)', fontWeight: 700, width: 18, textAlign: 'center', flexShrink: 0 }}>
              {i + 1}
            </span>

            {editIdx === i ? (
              /* inline edit mode */
              <>
                <input autoFocus value={editVal} onChange={e => setEditVal(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') commitEdit(i); if (e.key === 'Escape') setEditIdx(null) }}
                  style={{ flex: 1, border: '1.5px solid var(--red)', borderRadius: 8,
                    padding: '5px 8px', fontSize: 13, outline: 'none', fontFamily: 'Sarabun' }} />
                {iconBtn(() => commitEdit(i), '✓', '#16A34A')}
                {iconBtn(() => setEditIdx(null), '✕')}
              </>
            ) : (
              /* display mode */
              <>
                <span style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>{s}</span>
                {iconBtn(() => startEdit(i), '✏️')}
                {iconBtn(() => remove(i), '🗑️', '#FF3B30')}
              </>
            )}
          </div>
        ))}

        {/* add new */}
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <input
            value={newSrc}
            onChange={e => setNewSrc(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addSource()}
            placeholder="ชื่อแหล่งที่มาใหม่..."
            style={{ flex: 1, border: '1.5px solid var(--border2)', borderRadius: 10,
              padding: '9px 12px', fontSize: 13, outline: 'none', fontFamily: 'Sarabun',
              background: 'var(--bg)' }}
          />
          <button onClick={addSource} disabled={saving || !newSrc.trim()}
            style={{ border: 'none', borderRadius: 10, padding: '9px 16px', fontWeight: 700,
              fontSize: 13, cursor: newSrc.trim() ? 'pointer' : 'default', fontFamily: 'Sarabun',
              background: newSrc.trim() ? 'var(--red)' : '#F2F2F7',
              color: newSrc.trim() ? '#fff' : '#C7C7CC', flexShrink: 0 }}>
            + เพิ่ม
          </button>
        </div>

      </div>
    </Modal>
  )
}

/* ══════════════════════════════════════════════════════════
   ExpColorModal — ตั้งค่าเกณฑ์สีอายุ Lot (EXP)
   ══════════════════════════════════════════════════════════ */
function ExpColorModal({ open, onClose, thresholds, onSave }) {
  const [yellow, setYellow] = useState(thresholds?.yellow ?? 30)
  const [red,    setRed]    = useState(thresholds?.red    ?? 7)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setYellow(thresholds?.yellow ?? 30)
      setRed(thresholds?.red ?? 7)
    }
  }, [open, thresholds])

  async function handleSave() {
    const y = parseInt(yellow) || 30
    const r = parseInt(red)    || 7
    if (r >= y) { alert('เกณฑ์สีแดงต้องน้อยกว่าสีเหลือง'); return }
    setSaving(true)
    await onSave({ yellow: y, red: r })
    setSaving(false)
  }

  const preview = [
    { color: '#1A7F37', bg: '#DCFCE7', label: `> ${yellow} วัน`, note: '🟢 ปกติ' },
    { color: '#92600A', bg: '#FEF3C7', label: `${Number(red)+1}–${yellow} วัน`, note: '🟡 ใกล้หมด' },
    { color: '#FF3B30', bg: '#FEE2E2', label: `≤ ${red} วัน`, note: '🔴 วิกฤต' },
    { color: '#FF3B30', bg: '#FEE2E2', label: 'หมดอายุแล้ว', note: '🔴 หมดอายุ' },
  ]

  return (
    <Modal open={open} onClose={onClose} title="🎨 เกณฑ์สีอายุ Lot"
      footer={<button className="btn-primary" onClick={handleSave} disabled={saving}>
        {saving ? 'กำลังบันทึก...' : 'บันทึก'}
      </button>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Yellow threshold */}
        <div style={{ background: '#FEF3C7', borderRadius: 12, padding: '12px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <span style={{ fontSize: 20 }}>🟡</span>
            <span style={{ fontWeight: 700, color: '#92600A', fontSize: 14 }}>เหลือน้อยกว่า (วัน) → สีเหลือง</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input type="number" min="1" max="365" value={yellow}
              onChange={e => setYellow(e.target.value)}
              style={{ width: 80, textAlign: 'center', padding: '8px 0', borderRadius: 10,
                border: '2px solid #F59E0B', fontSize: 20, fontWeight: 700,
                fontFamily: 'Prompt', outline: 'none', color: '#92600A', background: '#fff' }} />
            <span style={{ fontSize: 13, color: '#92600A', fontWeight: 600 }}>วันก่อนหมดอายุ</span>
          </div>
        </div>

        {/* Red threshold */}
        <div style={{ background: '#FEE2E2', borderRadius: 12, padding: '12px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <span style={{ fontSize: 20 }}>🔴</span>
            <span style={{ fontWeight: 700, color: '#DC2626', fontSize: 14 }}>เหลือน้อยกว่า (วัน) → สีแดง</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input type="number" min="0" max="365" value={red}
              onChange={e => setRed(e.target.value)}
              style={{ width: 80, textAlign: 'center', padding: '8px 0', borderRadius: 10,
                border: '2px solid #EF4444', fontSize: 20, fontWeight: 700,
                fontFamily: 'Prompt', outline: 'none', color: '#DC2626', background: '#fff' }} />
            <span style={{ fontSize: 13, color: '#DC2626', fontWeight: 600 }}>วันก่อนหมดอายุ</span>
          </div>
        </div>

        {/* Preview */}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--txt3)', fontWeight: 700, marginBottom: 8 }}>ตัวอย่างการแสดงผล</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {preview.map(p => (
              <div key={p.note} style={{ display: 'flex', alignItems: 'center', gap: 10,
                background: p.bg, borderRadius: 8, padding: '7px 12px' }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: p.color, minWidth: 90 }}>{p.note}</span>
                <span style={{ fontSize: 12, color: p.color }}>EXP {p.label}</span>
              </div>
            ))}
          </div>
        </div>

        <div style={{ background: 'var(--bg)', borderRadius: 10, padding: '10px 12px',
          fontSize: 11, color: 'var(--txt3)', lineHeight: 1.6 }}>
          💡 ค่าเริ่มต้น: 🟡 ≤ 30 วัน · 🔴 ≤ 7 วัน<br/>
          เกณฑ์สีแดงต้องน้อยกว่าสีเหลืองเสมอ
        </div>
      </div>
    </Modal>
  )
}

function OpeningStockModal({ open, onClose, warehouses, items, onSaved }) {
  const [whIdx, setWhIdx]           = useState(0)
  const [levelQtys, setLevelQtys]   = useState({})  // { key: number[] } — qty ต่อ level
  const [search, setSearch]         = useState('')
  const [saving, setSaving]         = useState(false)
  const [catFilter, setCatFilter]   = useState('all')
  const [sortMode, setSortMode]     = useState('az')
  const [existingBal, setExistingBal] = useState({})
  // ── Phase 1: LOT Step ──────────────────────────────────────────────────────
  const [step, setStep]             = useState('qty')  // 'qty' | 'lot'
  const [savedItems, setSavedItems] = useState([])     // items ที่ save ไปแล้วมี qty > 0
  const [savedLotMap, setSavedLotMap] = useState({})   // { itemId: lotDocId }
  const [lotDrafts, setLotDrafts]   = useState({})     // { itemId: { lotNo, mfgDate, expDate, supplier, batchNo } }
  const [savingLots, setSavingLots] = useState(false)

  // getLevels: สร้าง levels จากฟิลด์ที่ sync มาจาก Cost Manager บน item โดยตรง
  //   unitBuy  = หน่วยซื้อ (ใหญ่สุด)   convBuyToUse = จำนวน unitUse ต่อ 1 unitBuy
  //   unitUse  = หน่วยใช้ (กลาง/base)  convUseToSub = จำนวน unitSub ต่อ 1 unitUse
  //   unitSub  = หน่วยย่อย (เล็กสุด)   isWeightVolUnit = module-level helper
  //   เรียงผลลัพธ์ ใหญ่ → เล็ก  factor = จำนวน unitSub (base) ต่อ 1 หน่วยนี้
  function getLevels(item) {
    const convBTU = Number(item.convBuyToUse) || 0
    const convUTS = Number(item.convUseToSub) || 0
    const hasBuy  = item.unitBuy && item.unitBuy !== item.unitUse && convBTU > 0
    // Hybrid: ซ่อน unitSub อัตโนมัติถ้าเป็นหน่วยชั่ง/ตวง — เว้นแต่ Owner เปิด showSubInInventory
    const autoHide = isWeightVolUnit(item.unitSub)
    const showSub  = item.showSubInInventory === true ? true : !autoHide
    const hasSub   = item.unitSub && item.unitSub !== item.unitUse && convUTS > 0 && showSub
    const baseUnit = item.unitUse || item.unitBase || 'หน่วย'
    const lvs = []
    if (hasBuy) lvs.push({ name: item.unitBuy, factor: convBTU * (hasSub ? convUTS : 1), qty: convBTU })
    lvs.push({ name: baseUnit, factor: hasSub ? convUTS : 1, qty: hasSub ? convUTS : 1 })
    if (hasSub) lvs.push({ name: item.unitSub, factor: 1, qty: 1 })
    return lvs
  }

  // โหลด existing balances เมื่อ modal เปิด (ข้อมูลหน่วยอ่านจาก item โดยตรง ไม่ต้อง fetch เพิ่ม)
  useEffect(() => {
    if (!open) return
    ;(async () => {
      const snap = await getDocs(collection(db, COL.STOCK_BALANCES))
      const existMap = {}; const lvMap = {}
      snap.docs.forEach(d => {
        const dat = d.data()
        const k = `${dat.warehouseId}_${dat.itemId}`
        existMap[k] = true
        if ((dat.qty ?? 0) > 0) {
          // หา item เพื่อดู levels แล้วใส่ qty ตรง level ที่ unit ตรงกัน
          const invItem = items.find(it => it.id === dat.itemId)
          const lvs = invItem ? getLevels(invItem) : []
          const n = Math.max(lvs.length, 1)
          const arr = new Array(n).fill(0)
          const storedUnit = dat.unit || dat.unitBase || ''
          const matchIdx  = lvs.findIndex(lv => lv.name === storedUnit)
          arr[matchIdx >= 0 ? matchIdx : n - 1] = dat.qty
          lvMap[k] = arr
        }
      })
      setExistingBal(existMap)
      setLevelQtys(lvMap)
    })()
  }, [open])

  const activeWH = warehouses[whIdx]
  const CATS_FILTER = [
    { id: 'all',        name: 'ทั้งหมด',    emoji: '🔍' },
    { id: 'แยม',       name: 'แยม',        emoji: '🍓' },
    { id: 'ผลไม้',     name: 'ผลไม้',      emoji: '🍋' },
    { id: 'ไซรัป',     name: 'ไซรัป',      emoji: '🍯' },
    { id: 'ท็อปปิ้ง',  name: 'ท็อปปิ้ง',  emoji: '💎' },
    { id: 'วัตถุดิบ',  name: 'วัตถุดิบ',   emoji: '🥛' },
    { id: 'บรรจุภัณฑ์', name: 'บรรจุ',    emoji: '🥤' },
    { id: 'อื่นๆ',     name: 'อื่นๆ',      emoji: '🔖' },
  ]

  function key(whId, itemId) { return `${whId}_${itemId}` }
  function setLvQty(whId, itemId, vals) {
    setLevelQtys(p => ({ ...p, [key(whId, itemId)]: vals }))
  }

  // กรอง + เรียง
  const filteredItems = items.filter(i => {
    if (catFilter !== 'all' && i.category !== catFilter) return false
    if (search && !i.name.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })
  const activeCat = CATS_FILTER.find(c => c.id === catFilter) || CATS_FILTER[0]

  const visibleItems = [...filteredItems].sort((a, b) => {
    if (sortMode === 'az')       return a.name.localeCompare(b.name, 'th')
    if (sortMode === 'za')       return b.name.localeCompare(a.name, 'th')
    if (sortMode === 'qty-desc') {
      const qa = calcBaseQty(levelQtys[key(activeWH?.id, a.id)], getLevels(a))
      const qb = calcBaseQty(levelQtys[key(activeWH?.id, b.id)], getLevels(b))
      return qb - qa
    }
    if (sortMode === 'qty-asc') {
      const qa = calcBaseQty(levelQtys[key(activeWH?.id, a.id)], getLevels(a))
      const qb = calcBaseQty(levelQtys[key(activeWH?.id, b.id)], getLevels(b))
      return qa - qb
    }
    return 0
  })

  const SORT_OPTS = [
    { v: 'az',       label: 'ก → ฮ' },
    { v: 'za',       label: 'ฮ → ก' },
    { v: 'qty-desc', label: 'มาก → น้อย' },
    { v: 'qty-asc',  label: 'น้อย → มาก' },
  ]

  async function handleSave() {
    if (!activeWH) return
    setSaving(true)
    try {
      const batch = writeBatch(db)
      let count = 0
      const newLotMap = {}      // { itemId: lotDocId }
      const newSavedItems = []  // items ที่มี qty > 0

      const lotSnap = await getDocs(
        query(collection(db, COL.LOT_TRACKING),
          where('warehouseId', '==', activeWH.id),
          where('isOpening', '==', true))
      )
      const existingLotItems = new Set(lotSnap.docs.map(d => d.data().itemId))

      for (const item of items) {
        const k      = key(activeWH.id, item.id)
        const levels = getLevels(item)
        const lqArr  = levelQtys[k] || []
        const qty    = calcBaseQty(lqArr, levels)        // รวมเป็น base unit
        const baseUnit = levels[levels.length - 1]?.name || item.unitBase  // index สุดท้าย = หน่วยเล็กสุด

        // ข้ามรายการที่ qty = 0 และยังไม่มีใน Firestore
        if (qty === 0 && !existingBal[k]) continue

        const balRef = doc(db, COL.STOCK_BALANCES, k)
        batch.set(balRef, {
          warehouseId:   activeWH.id,
          warehouseName: activeWH.name,
          itemId:        item.id,
          itemName:      item.name,
          category:      item.category,
          unitBase:      item.unitBase,
          unit:          baseUnit,
          qty,
          minQty:        item.minQty || 0,
          maxQty:        item.maxQty || 0,
          updatedAt:     serverTimestamp(),
        }, { merge: true })

        // track lot ref id เพื่อใช้ใน step 2
        let lotDocId = null
        if (!existingLotItems.has(item.id) && qty > 0) {
          const lotRef = doc(collection(db, COL.LOT_TRACKING))
          lotDocId = lotRef.id
          batch.set(lotRef, {
            warehouseId: activeWH.id, warehouseName: activeWH.name,
            itemId: item.id, itemName: item.name,
            unitBase: item.unitBase, unit: baseUnit,
            qty, qtyRemaining: qty,
            lotNo: 'Start', isStartLot: true,
            receivedDate: new Date().toISOString().slice(0, 10),
            mfgDate: null, expDate: null,
            supplier: '', batchNo: '',
            source: 'Opening Stock', isOpening: true, status: 'active',
            createdAt: serverTimestamp(),
          })
        } else if (existingLotItems.has(item.id) && qty > 0) {
          const existLot = lotSnap.docs.find(d => d.data().itemId === item.id)
          if (existLot) {
            lotDocId = existLot.id
            batch.update(doc(db, COL.LOT_TRACKING, existLot.id), {
              qty, qtyRemaining: qty, unit: baseUnit, updatedAt: serverTimestamp()
            })
          }
        }
        if (qty > 0) {
          newLotMap[item.id] = lotDocId
          newSavedItems.push(item)
        }
        count++
      }

      await batch.commit()
      await addDoc(collection(db, COL.AUDIT_LOGS), {
        action: 'opening_stock', warehouseId: activeWH.id,
        warehouseName: activeWH.name, itemCount: count,
        by: window._bizSession?.name || 'system', createdAt: serverTimestamp(),
      })

      // เปลี่ยนไป Step 2: LOT info (ไม่ปิด modal)
      setSavedItems(newSavedItems)
      setSavedLotMap(newLotMap)
      setLotDrafts({})
      setStep('lot')
    } catch (e) {
      console.error(e)
      onSaved(`❌ เกิดข้อผิดพลาด: ${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  // ── handleSaveLots: บันทึก LOT info จาก step 2 ─────────────────────────────
  async function handleSaveLots() {
    setSavingLots(true)
    try {
      const updates = Object.entries(lotDrafts).filter(([, d]) =>
        d.lotNo || d.mfgDate || d.expDate || d.supplier || d.batchNo
      )
      if (updates.length > 0) {
        const batch = writeBatch(db)
        updates.forEach(([itemId, draft]) => {
          const lotId = savedLotMap[itemId]
          if (!lotId) return
          const isStillStart = !draft.lotNo || draft.lotNo === 'Start'
          batch.update(doc(db, COL.LOT_TRACKING, lotId), {
            lotNo:     draft.lotNo    || 'Start',
            mfgDate:   draft.mfgDate  || null,
            expDate:   draft.expDate  || null,
            supplier:  draft.supplier || '',
            batchNo:   draft.batchNo  || '',
            isStartLot: isStillStart,
            updatedAt: serverTimestamp(),
          })
        })
        await batch.commit()
      }
      onSaved(`✅ บันทึก Opening Stock + LOT สำเร็จ (${savedItems.length} รายการ)`)
      resetAndClose()
    } catch (e) {
      console.error(e)
      onSaved(`❌ บันทึก LOT ไม่สำเร็จ: ${e.message}`)
    } finally {
      setSavingLots(false)
    }
  }

  function handleSkipLots() {
    onSaved(`✅ บันทึก Opening Stock สำเร็จ (${savedItems.length} รายการ) — LOT ใช้ค่าเริ่มต้น "Start"`)
    resetAndClose()
  }

  function resetAndClose() {
    setLevelQtys({}); setExistingBal({}); setSearch('')
    setCatFilter('all'); setStep('qty')
    setSavedItems([]); setSavedLotMap({}); setLotDrafts({})
    onClose()
  }

  const filledCount = activeWH
    ? items.filter(i => {
        const levels = getLevels(i)
        return calcBaseQty(levelQtys[key(activeWH.id, i.id)], levels) > 0
      }).length
    : 0

  return (
    <Modal open={open} onClose={step === 'qty' ? onClose : handleSkipLots}
      title={step === 'qty' ? '📊 Opening Stock' : '📦 ระบุข้อมูล LOT'}
      footer={
        step === 'qty' ? (
          <div style={{ display: 'flex', gap: 10, width: '100%' }}>
            <button className="btn-secondary" style={{ flex: 1 }} onClick={onClose} disabled={saving}>ยกเลิก</button>
            <button className="btn-primary" style={{ flex: 2 }} onClick={handleSave} disabled={saving || !activeWH}>
              {saving ? 'กำลังบันทึก...' : `✓ บันทึก${filledCount > 0 ? ` (${filledCount} รายการ)` : ''}`}
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 10, width: '100%' }}>
            <button className="btn-secondary" style={{ flex: 1 }} onClick={handleSkipLots} disabled={savingLots}>
              ข้ามขั้นตอนนี้
            </button>
            <button className="btn-primary" style={{ flex: 2 }} onClick={handleSaveLots} disabled={savingLots}>
              {savingLots ? 'กำลังบันทึก...' : '✅ บันทึก LOT'}
            </button>
          </div>
        )
      }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

        {/* ── STEP 2: LOT Info ─────────────────────────────────────────────── */}
        {step === 'lot' && (
          <>
            {/* Banner */}
            <div style={{ background: '#F0FDF4', borderRadius: 10, padding: '10px 14px', fontSize: 12.5, color: '#166534', lineHeight: 1.6 }}>
              <strong>✅ บันทึก qty สำเร็จแล้ว!</strong><br />
              ระบุข้อมูล LOT เพิ่มเติมได้เลย (หรือ <strong>ข้ามขั้นตอนนี้</strong> — ระบบจะใช้ <strong>"LOT: Start"</strong> อัตโนมัติ)
            </div>

            {/* LOT cards */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {savedItems.length === 0 && (
                <div style={{ textAlign: 'center', color: 'var(--txt3)', fontSize: 13, padding: 20 }}>
                  ไม่มีรายการที่มีสต็อก
                </div>
              )}
              {savedItems.map(item => {
                const draft = lotDrafts[item.id] || {}
                const setDraft = (field, val) => setLotDrafts(f => ({
                  ...f, [item.id]: { ...(f[item.id] || {}), [field]: val }
                }))
                const hasInfo = draft.expDate || draft.mfgDate || draft.supplier || draft.batchNo
                return (
                  <div key={item.id} style={{ borderRadius: 12, border: `1.5px solid ${hasInfo ? '#16A34A' : 'var(--border)'}`,
                    overflow: 'hidden', transition: 'border-color .2s' }}>
                    {/* Item header */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
                      background: hasInfo ? '#F0FDF4' : 'var(--bg)' }}>
                      <span style={{ fontSize: 20 }}>{item.img || '📦'}</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 700, fontSize: 13 }}>{item.name}</div>
                        <div style={{ fontSize: 11, color: 'var(--txt3)' }}>
                          LOT: <strong style={{ color: draft.lotNo && draft.lotNo !== 'Start' ? '#16A34A' : '#D97706' }}>
                            {draft.lotNo || 'Start'}
                          </strong>
                          {draft.expDate && <span style={{ marginLeft: 8, color: '#DC2626' }}>· EXP {draft.expDate}</span>}
                        </div>
                      </div>
                      {hasInfo && <span style={{ fontSize: 16 }}>✅</span>}
                    </div>

                    {/* LOT form */}
                    <div style={{ padding: '12px 14px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8,
                      background: '#fff' }}>
                      {/* Lot No */}
                      <div style={{ gridColumn: '1/-1' }}>
                        <label style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>
                          🏷️ Lot No. (ปล่อยว่าง = Start)
                        </label>
                        <input className="fi" value={draft.lotNo || ''}
                          onChange={e => setDraft('lotNo', e.target.value)}
                          placeholder="Start"
                          style={{ padding: '7px 10px', fontSize: 13, fontWeight: 600 }} />
                      </div>
                      {/* MFG Date */}
                      <div>
                        <label style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>
                          🏭 วันผลิต (MFG)
                        </label>
                        <input type="date" className="fi" value={draft.mfgDate || ''}
                          onChange={e => setDraft('mfgDate', e.target.value)}
                          style={{ padding: '7px 8px', fontSize: 12 }} />
                      </div>
                      {/* EXP Date */}
                      <div>
                        <label style={{ fontSize: 10.5, fontWeight: 700, color: '#DC2626', display: 'block', marginBottom: 4 }}>
                          ⚠️ วันหมดอายุ (EXP)
                        </label>
                        <input type="date" className="fi" value={draft.expDate || ''}
                          onChange={e => setDraft('expDate', e.target.value)}
                          style={{ padding: '7px 8px', fontSize: 12,
                            borderColor: draft.expDate ? '#DC2626' : undefined }} />
                      </div>
                      {/* Supplier */}
                      <div style={{ gridColumn: '1/-1' }}>
                        <label style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>
                          🚚 แหล่งที่มา
                        </label>
                        <input className="fi" value={draft.supplier || ''}
                          onChange={e => setDraft('supplier', e.target.value)}
                          placeholder="ผู้จำหน่าย"
                          style={{ padding: '7px 8px', fontSize: 12 }} />
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}

        {/* ── STEP 1: qty input ────────────────────────────────────────────── */}
        {step === 'qty' && <>

        {/* Info banner */}
        <div style={{ background: '#EFF6FF', borderRadius: 10, padding: '10px 14px', fontSize: 12.5, color: '#1e40af', lineHeight: 1.6 }}>
          <strong>📌 Opening Stock</strong> คือยอดสต็อกเริ่มต้นก่อนเริ่มใช้ระบบ<br />
          กรอกเฉพาะรายการที่มีสต็อกจริง — กด <strong>บันทึก</strong> แต่ละคลังแยกกัน
        </div>

        {/* Warehouse tab selector */}
        {warehouses.length > 0 ? (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {warehouses.map((wh, idx) => {
              const filled = items.filter(i => {
                const levels = getLevels(i)
                return calcBaseQty(levelQtys[key(wh.id, i.id)], levels) > 0
              }).length
              return (
                <button key={wh.id} onClick={() => setWhIdx(idx)}
                  style={{
                    padding: '6px 14px', borderRadius: 20, border: 'none', cursor: 'pointer',
                    fontFamily: 'Sarabun', fontWeight: 700, fontSize: 13,
                    background: whIdx === idx ? wh.color || 'var(--red)' : 'var(--bg)',
                    color: whIdx === idx ? '#fff' : 'var(--txt2)',
                    display: 'flex', alignItems: 'center', gap: 6,
                  }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: whIdx === idx ? 'rgba(255,255,255,0.6)' : wh.color, display: 'inline-block', flexShrink: 0 }} />
                  {wh.name}
                  {filled > 0 && (
                    <span style={{ background: 'rgba(255,255,255,0.25)', borderRadius: 20, padding: '0 6px', fontSize: 11 }}>{filled}</span>
                  )}
                </button>
              )
            })}
          </div>
        ) : (
          <div style={{ fontSize: 13, color: 'var(--txt3)', textAlign: 'center', padding: '12px 0' }}>
            ⚠️ ยังไม่มีคลัง — ไปที่ จัดการคลังสินค้า เพื่อเพิ่มก่อน
          </div>
        )}

        {activeWH && (
          <>
            {/* Active WH header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
              background: activeWH.color + '18', borderRadius: 10, border: `1px solid ${activeWH.color}40` }}>
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: activeWH.color, flexShrink: 0 }} />
              <div>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{activeWH.name}</div>
                <div style={{ fontSize: 11, color: 'var(--txt3)' }}>
                  {activeWH.type === 'main' ? 'คลังหลัก' : 'สาขา'} · {filledCount}/{items.length} รายการ
                </div>
              </div>
            </div>

            {/* Search + Sort */}
            <div style={{ display: 'flex', gap: 8 }}>
              <div className="search-wrap" style={{ margin: 0, flex: 1 }}>
                <span className="search-icon">🔍</span>
                <input className="search-input" placeholder="ค้นหาวัตถุดิบ..."
                  value={search} onChange={e => setSearch(e.target.value)} />
                {search && (
                  <button onClick={() => setSearch('')}
                    style={{ border: 'none', background: 'none', cursor: 'pointer', padding: '0 6px', color: 'var(--txt3)', fontSize: 16 }}>✕</button>
                )}
              </div>
              <select value={sortMode} onChange={e => setSortMode(e.target.value)}
                style={{ padding: '0 8px', borderRadius: 10, border: '1.5px solid var(--border2)',
                  background: '#fff', fontFamily: 'Sarabun', fontSize: 12, fontWeight: 700,
                  color: 'var(--txt2)', cursor: 'pointer', flexShrink: 0 }}>
                {SORT_OPTS.map(o => <option key={o.v} value={o.v}>⇅ {o.label}</option>)}
              </select>
            </div>

            {/* Sidebar + Item list */}
            <div style={{ display: 'flex', gap: 0, borderRadius: 12, overflow: 'hidden',
              border: '1px solid var(--border)', height: 340 }}>

              {/* Left: category sidebar */}
              <div style={{ width: 68, flexShrink: 0, overflowY: 'auto', background: 'var(--bg)',
                borderRight: '1px solid var(--border)' }}>
                {CATS_FILTER.map(c => {
                  const active = catFilter === c.id
                  return (
                    <button key={c.id} onClick={() => setCatFilter(c.id)}
                      style={{ width: '100%', border: 'none', cursor: 'pointer', padding: '10px 4px',
                        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
                        background: active ? '#fff' : 'transparent',
                        borderLeft: active ? '3px solid var(--red)' : '3px solid transparent',
                        transition: 'all .15s' }}>
                      <span style={{ fontSize: 18, lineHeight: 1 }}>{c.emoji}</span>
                      <span style={{ fontSize: 9.5, fontWeight: active ? 700 : 500, lineHeight: 1.2,
                        color: active ? 'var(--red)' : 'var(--txt3)', textAlign: 'center', wordBreak: 'break-word', maxWidth: 60 }}>
                        {c.name}
                      </span>
                    </button>
                  )
                })}
              </div>

              {/* Right: item list */}
              <div style={{ flex: 1, overflowY: 'auto', background: '#fff' }}>
                {visibleItems.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: 24, fontSize: 13, color: 'var(--txt3)' }}>ไม่พบรายการ</div>
                ) : visibleItems.map((item, idx) => {
                  const k         = key(activeWH.id, item.id)
                  const levels    = getLevels(item)
                  const lqArr     = levelQtys[k] || levels.map(() => 0)
                  const totalBase = calcBaseQty(lqArr, levels)
                  const filled    = totalBase > 0
                  const isExist   = existingBal[k]

                  return (
                    <div key={item.id} style={{ padding: '10px 12px',
                      borderBottom: idx < visibleItems.length - 1 ? '1px solid #F2F2F7' : 'none',
                      borderLeft: filled ? '3px solid #F59E0B' : '3px solid transparent',
                      background: filled ? '#FFFBEB' : 'transparent' }}>
                      {/* Line 1: name + badge */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                        <span style={{ fontSize: 18 }}>{item.img || '📦'}</span>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 12, fontWeight: 600 }}>{item.name}</div>
                          <div style={{ fontSize: 10, color: 'var(--txt3)' }}>{item.category}</div>
                        </div>
                        {isExist && <span style={{ fontSize: 9, background: '#F0FDF4', color: '#15803D', borderRadius: 20, padding: '0 6px', fontWeight: 600 }}>✓ มีแล้ว</span>}
                      </div>
                      {/* Line 2: multi-level steppers — [−] n [+] ลัง  [−] m [+] กระป๋อง */}
                      <MultiLevelStepper
                        levels={levels}
                        values={lqArr}
                        onChange={vals => setLvQty(activeWH.id, item.id, vals)}
                      />
                      {/* Line 3: preview รวม base unit (levels[last] = หน่วยเล็กสุด) */}
                      {levels.length > 1 && totalBase > 0 && (
                        <div style={{ fontSize: 11, color: '#6B7280', marginTop: 5, paddingLeft: 2 }}>
                          รวม ≈ <strong style={{ color: '#D97706' }}>{totalBase}</strong> {levels[levels.length - 1].name}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Summary */}
            {filledCount > 0 && (
              <div style={{ background: 'var(--green-bg)', border: '1px solid var(--green-b)',
                borderRadius: 10, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 18 }}>✅</span>
                <div style={{ fontSize: 13, color: 'var(--green)', fontWeight: 700 }}>
                  กรอก {filledCount} รายการสำหรับ "{activeWH.name}"
                </div>
              </div>
            )}
          </>
        )}
        </>}
        {/* end step === 'qty' */}
      </div>
    </Modal>
  )
}

// default — จะถูกแทนที่จาก Firestore
const DEFAULT_CATS = [
  { id:'c1', name:'แยม',       emoji:'🍓' },
  { id:'c2', name:'ผลไม้',     emoji:'🍑' },
  { id:'c3', name:'ไซรัป',     emoji:'🍯' },
  { id:'c4', name:'ท็อปปิ้ง',  emoji:'💎' },
  { id:'c5', name:'วัตถุดิบ',  emoji:'🥛' },
  { id:'c6', name:'บรรจุภัณฑ์',emoji:'📦' },
  { id:'c7', name:'อื่นๆ',     emoji:'🔖' },
  { id:'c8', name:'สูตรผสม',   emoji:'🧪' },
]
const WH_COLORS = ['#E31E24', '#1D4ED8', '#16A34A', '#D97706', '#7C3AED', '#0284C7']
const EMOJI_GROUPS = [
  { label: '🍎 ผลไม้', emojis: ['🍎','🍏','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍈','🍑','🥭','🍍','🥥','🥝','🍅','🫒','🥑','🍆','🥦','🥬','🥒','🌽','🥕','🧅','🧄','🫛','🫑','🍄','🌰','🥔','🫚','🫜','🍒','🌶️'] },
  { label: '🍦 ไอศกรีม/นม', emojis: ['🍦','🍨','🍧','🥛','🧈','🧀','🍮','🍯','🫙','🥞','🧇','🍰','🎂','🧁','🥧','🍪','🍩','🍡','🍢'] },
  { label: '🍯 ของหวาน', emojis: ['🍯','🍫','🍬','🍭','🍮','🍰','🎂','🧁','🥧','🍩','🍪','🍡','🧆','🥐','🍞','🥨','🥯','🫓','🥞','🧇','🧈','🍿','🍘','🥮','🍥','🥠'] },
  { label: '🧃 เครื่องดื่ม', emojis: ['🧃','🥤','🧋','☕','🍵','🫖','🍺','🍻','🥂','🍷','🍸','🍹','🧉','🍶','🥛','💧','🫗','🧊','🍾','🫙','🥃'] },
  { label: '🍱 อาหาร', emojis: ['🍱','🍛','🍜','🍝','🍲','🥘','🫕','🍣','🍤','🥚','🍳','🥓','🌮','🌯','🥙','🫔','🥗','🍔','🍟','🌭','🍕','🥪','🧆','🍗','🍖','🥩','🫘','🍙','🍚','🍘','🥟','🥠','🥮','🍢','🍡','🍧','🍨','🍦'] },
  { label: '🧂 เครื่องปรุง', emojis: ['🧂','🫙','🥫','🧴','🧪','🫧','🧬','⚗️','🔬','💊','🩺','🧫','🌶️','🧄','🧅','🍋','🫚'] },
  { label: '📦 บรรจุภัณฑ์', emojis: ['📦','📫','📬','📭','📮','🧴','🪣','🛢️','🧹','🧺','🛍️','👜','🎁','🗃️','📂','📁','🪤','🔒','🔑','🗝️','🪪','📦','🧊','🥡','🥢','📦','🛒','🪦','💼'] },
  { label: '🌿 ธรรมชาติ', emojis: ['🌿','🍃','🌱','🪴','🌾','🎋','🎍','☘️','🍀','🌺','🌸','🌼','🌻','🌹','💐','🌷','🪷','🍁','🍂','🍄','🌴','🌵','🪸','🪨','🌊','🌳','🌲','🎄','🪵','🌽','🌶️','🫧','🫧'] },
  { label: '🐮 สัตว์', emojis: ['🐮','🐄','🐷','🐖','🐔','🐓','🐤','🦃','🐟','🐠','🦐','🦀','🦞','🦑','🐙','🦪','🥚','🐝','🦋','🐌','🐛','🐞'] },
  { label: '⭐ สัญลักษณ์', emojis: ['⭐','🌟','💫','✨','🔥','💥','🎯','🏆','🥇','🎖️','🏅','🎗️','🎀','🎊','🎉','🪅','🎈','❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','❤️‍🔥','💝','💖','💗','💓','💞','💕','💟','♥️','💯','✅','❌','⚠️','🆕','🆙','🔝','💎'] },
  { label: '🔵 สี/รูปทรง', emojis: ['🔴','🟠','🟡','🟢','🔵','🟣','🟤','⚫','⚪','🟥','🟧','🟨','🟩','🟦','🟪','🟫','⬛','⬜','🔶','🔷','🔸','🔹','🔺','🔻','💠','🔘','🔲','🔳','▪️','▫️','◼️','◻️','◾','◽'] },
  { label: '🥄 อุปกรณ์', emojis: ['🥄','🍴','🔪','🫙','🥢','🧂','⚖️','🪣','🧲','🔧','🪛','⚙️','🛒','🧺','🪤','💡','🔦','🕯️','🧯','🪒','🧽','🧼','🪥','🧻','🪞','🪟','🛏️','🪑','🚿','🛁','🚽'] },
  { label: '🏪 ร้านค้า', emojis: ['🏪','🏬','🏭','🏢','🏠','🏡','🏘️','🏚️','🏗️','🏛️','⛪','🕌','🛕','🕍','⛩️','💰','💵','💴','💶','💷','💸','💳','🧾','💹','💲','🏷️','📊','📈','📉'] },
  { label: '⏰ เวลา/วันที่', emojis: ['⏰','⏱️','⏲️','🕐','🕑','🕒','🕓','🕔','🕕','🕖','🕗','🕘','🕙','🕚','🕛','📅','📆','🗓️','📇','📌','📍','🗺️','🧭'] },
]
const EMOJIS = EMOJI_GROUPS.flatMap(g => g.emojis)
const TPL_ICONS = ['☀️', '🎉', '⚡', '🌙', '🏖️', '🔥']

/* ══════════════════════════════════════════════════════════
   CategoryModal — จัดการหมวดหมู่ + drag-and-drop reorder
   ══════════════════════════════════════════════════════════ */
function CategoryModal({ open, onClose, cats, setCats, items, cmCompounds = [] }) {
  const [list, setList] = useState([...cats])
  const [editId, setEditId] = useState(null)
  const [editName, setEditName] = useState('')
  const [editEmoji, setEditEmoji] = useState('')
  const [saving, setSaving] = useState(false)
  const [toast, setToastMsg] = useState('')
  const [selectedCat, setSelectedCat] = useState(null)  // { id, name, emoji }
  const [itemList, setItemList] = useState([])           // items ในหมวดที่เลือก
  const dragIdx = useRef(null)
  const itemDragIdx = useRef(null)

  // sync เมื่อ cats prop เปลี่ยน
  useEffect(() => { setList([...cats]) }, [cats, open])
  useEffect(() => { if (!open) setSelectedCat(null) }, [open])
  useEffect(() => { if (toast) { const t = setTimeout(() => setToastMsg(''), 2000); return () => clearTimeout(t) } }, [toast])

  // โหลด items เมื่อเลือกหมวด (รองรับ สูตรผสม จาก cmCompounds)
  useEffect(() => {
    if (!selectedCat) return
    if (selectedCat.name === 'สูตรผสม') {
      const sorted = [...cmCompounds].sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999))
      setItemList(sorted.map(cp => ({ id: cp.id || cp.name, name: cp.name, img: '🧪', unitBuy: cp.outputUnit || '', _isCompound: true })))
    } else {
      const catItems = items
        .filter(i => i.category === selectedCat.name)
        .sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999))
      setItemList(catItems)
    }
  }, [selectedCat, items, cmCompounds])

  // ─── Item drag-and-drop ──────────────────────────────────
  function onItemDragStart(i) { itemDragIdx.current = i }
  function onItemDragOver(e, i) {
    e.preventDefault()
    if (itemDragIdx.current === null || itemDragIdx.current === i) return
    const next = [...itemList]
    const [moved] = next.splice(itemDragIdx.current, 1)
    next.splice(i, 0, moved)
    itemDragIdx.current = i
    setItemList(next)
  }
  function onItemDrop() { itemDragIdx.current = null }
  async function saveItemOrder() {
    setSaving(true)
    if (selectedCat?.name === 'สูตรผสม') {
      // บันทึกลำดับ compound ลง app_settings
      const order = itemList.map(it => it.id)
      await setDoc(doc(db, COL.APP_SETTINGS, 'compound_order'), { order })
    } else {
      const batch = writeBatch(db)
      itemList.forEach((it, idx) => {
        batch.update(doc(db, COL.ITEMS, it.id), { sortOrder: idx })
      })
      await batch.commit()
    }
    setSaving(false)
    setToastMsg('✅ บันทึกลำดับแล้ว')
  }

  // ─── Drag-and-drop ───────────────────────────────────────
  function onDragStart(i) { dragIdx.current = i }
  function onDragOver(e, i) {
    e.preventDefault()
    if (dragIdx.current === null || dragIdx.current === i) return
    const next = [...list]
    const [moved] = next.splice(dragIdx.current, 1)
    next.splice(i, 0, moved)
    dragIdx.current = i
    setList(next)
  }
  function onDrop() { dragIdx.current = null }

  // ─── Save to Firestore ───────────────────────────────────
  async function save(newList) {
    setSaving(true)
    await setDoc(doc(db, COL.APP_SETTINGS, 'categories'), { list: newList, updatedAt: new Date().toISOString() })
    setCats(newList)
    setSaving(false)
  }

  // ─── Actions ─────────────────────────────────────────────
  function startEdit(c) { setEditId(c.id); setEditName(c.name); setEditEmoji(c.emoji) }
  function cancelEdit() { setEditId(null) }
  async function confirmEdit() {
    if (!editName.trim()) return
    const next = list.map(c => c.id === editId ? { ...c, name: editName.trim(), emoji: editEmoji } : c)
    setList(next); await save(next)
    setEditId(null); setToastMsg('✅ แก้ไขหมวดหมู่แล้ว')
  }
  async function deleteCat(id) {
    const cat = list.find(c => c.id === id)
    const inUse = items.filter(i => i.category === cat?.name).length
    if (inUse > 0) { setToastMsg(`⚠️ มีวัตถุดิบ ${inUse} รายการใช้หมวดนี้อยู่`); return }
    const next = list.filter(c => c.id !== id)
    setList(next); await save(next); setToastMsg('🗑️ ลบหมวดหมู่แล้ว')
  }
  async function saveOrder() { await save(list); setToastMsg('✅ บันทึกลำดับแล้ว') }

  const QUICK_EMOJIS = ['🍓','🍑','🍋','🍊','🍇','🍯','🥛','💧','🧊','🍫','💎','📦','🔖','🧪','🌿','🍃','⭐','🔴','🟡','🟢','🔵','🥄','🍵','🧋','🎋','🧂','🫙','🥤','🌸','🍄']

  return (
    <Modal open={open} onClose={selectedCat ? () => setSelectedCat(null) : onClose}
      title={selectedCat ? `${selectedCat.emoji} ${selectedCat.name}` : '🏷️ หมวดหมู่วัตถุดิบ'}
      footer={
        selectedCat ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-secondary" style={{ flex: 1 }} onClick={() => setSelectedCat(null)}>← กลับ</button>
            <button className="btn-primary" style={{ flex: 2 }} onClick={saveItemOrder} disabled={saving}>
              {saving ? 'กำลังบันทึก...' : '💾 บันทึกลำดับ'}
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-secondary" style={{ flex: 1 }} onClick={onClose}>ปิด</button>
            <button className="btn-primary" style={{ flex: 2 }} onClick={saveOrder} disabled={saving}>
              {saving ? 'กำลังบันทึก...' : '💾 บันทึกลำดับ'}
            </button>
          </div>
        )
      }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

        {toast && (
          <div style={{ background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 10,
            padding: '8px 12px', fontSize: 13, color: '#15803D', fontWeight: 600 }}>{toast}</div>
        )}

        {/* ── Sub-view: รายการวัตถุดิบในหมวด ── */}
        {selectedCat && (
          <div style={{ background: '#F2F2F7', borderRadius: 12, overflow: 'hidden', border: '1px solid #E5E5EA' }}>
            <div style={{ padding: '8px 14px 6px', fontSize: 11, color: '#8E8E93', fontWeight: 700,
              textTransform: 'uppercase', letterSpacing: 0.4 }}>ลากเพื่อเรียงลำดับวัตถุดิบ</div>
            {itemList.length === 0 && (
              <div style={{ padding: '20px 14px', textAlign: 'center', color: '#C7C7CC', fontSize: 13 }}>
                ไม่มีวัตถุดิบในหมวดนี้
              </div>
            )}
            {itemList.map((it, i) => (
              <div key={it.id}
                draggable
                onDragStart={() => onItemDragStart(i)}
                onDragOver={e => onItemDragOver(e, i)}
                onDrop={onItemDrop}
                style={{ background: '#fff', borderTop: i > 0 ? '1px solid #F3F4F6' : 'none' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', cursor: 'grab' }}>
                  {/* Drag handle */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0, padding: '0 2px' }}>
                    <div style={{ width: 16, height: 2, background: '#C7C7CC', borderRadius: 1 }} />
                    <div style={{ width: 16, height: 2, background: '#C7C7CC', borderRadius: 1 }} />
                    <div style={{ width: 16, height: 2, background: '#C7C7CC', borderRadius: 1 }} />
                  </div>
                  {/* Order */}
                  <div style={{ width: 20, fontSize: 11, color: '#C7C7CC', fontWeight: 700, textAlign: 'center', flexShrink: 0 }}>{i + 1}</div>
                  {/* Emoji */}
                  <div style={{ width: 30, height: 30, borderRadius: 8, background: '#F2F2F7',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0 }}>
                    {it.img || '📦'}
                  </div>
                  {/* Name */}
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#1C1C1E' }}>{it.name}</div>
                    <div style={{ fontSize: 11, color: '#8E8E93' }}>{it.unitBuy || it.unitBase || ''}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Main list: หมวดหมู่ ── */}
        {!selectedCat && <div style={{ background: '#F2F2F7', borderRadius: 12, overflow: 'hidden',
          border: '1px solid #E5E5EA' }}>
          <div style={{ padding: '8px 14px 6px', fontSize: 11, color: '#8E8E93', fontWeight: 700,
            textTransform: 'uppercase', letterSpacing: 0.4 }}>
            ลากเพื่อเรียงลำดับ
          </div>
          {list.map((c, i) => {
            const count = c.name === 'สูตรผสม'
              ? cmCompounds.length
              : items.filter(it => it.category === c.name).length
            const isEditing = editId === c.id
            return (
              <div key={c.id}
                draggable={!isEditing}
                onDragStart={() => onDragStart(i)}
                onDragOver={e => onDragOver(e, i)}
                onDrop={onDrop}
                style={{ background: '#fff', borderTop: i > 0 ? '1px solid #F3F4F6' : 'none',
                  padding: isEditing ? '10px 12px' : '0',
                  transition: 'background 0.1s' }}>
                {isEditing ? (
                  // ── Edit row ──
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <div style={{ fontSize: 22, width: 36, textAlign: 'center' }}>{editEmoji}</div>
                      <input value={editName} onChange={e => setEditName(e.target.value)}
                        style={{ flex: 1, border: '1.5px solid #FF3B30', borderRadius: 8,
                          padding: '6px 10px', fontSize: 13, fontWeight: 600, outline: 'none' }}
                        onKeyDown={e => e.key === 'Enter' && confirmEdit()} />
                      <button onClick={confirmEdit}
                        style={{ border: 'none', background: '#FF3B30', color: '#fff', borderRadius: 8,
                          padding: '7px 12px', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>บันทึก</button>
                      <button onClick={cancelEdit}
                        style={{ border: 'none', background: '#F2F2F7', color: '#636366', borderRadius: 8,
                          padding: '7px 10px', fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>ยกเลิก</button>
                    </div>
                    {/* Quick emoji picker */}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {QUICK_EMOJIS.map(em => (
                        <button key={em} onClick={() => setEditEmoji(em)}
                          style={{ border: 'none', borderRadius: 6, padding: '4px 6px', fontSize: 16,
                            cursor: 'pointer', background: editEmoji === em ? '#FF3B30' : '#F2F2F7',
                            transition: 'all 0.1s' }}>
                          {em}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  // ── Normal row ──
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', cursor: 'grab' }}
                    onMouseDown={e => e.currentTarget.style.cursor = 'grabbing'}
                    onMouseUp={e => e.currentTarget.style.cursor = 'grab'}>
                    {/* Drag handle */}
                    <div style={{ color: '#C7C7CC', fontSize: 16, flexShrink: 0,
                      display: 'flex', flexDirection: 'column', gap: 2, cursor: 'grab', padding: '0 2px' }}>
                      <div style={{ width: 16, height: 2, background: '#C7C7CC', borderRadius: 1 }} />
                      <div style={{ width: 16, height: 2, background: '#C7C7CC', borderRadius: 1 }} />
                      <div style={{ width: 16, height: 2, background: '#C7C7CC', borderRadius: 1 }} />
                    </div>
                    {/* Order number */}
                    <div style={{ width: 20, fontSize: 11, color: '#C7C7CC', fontWeight: 700, textAlign: 'center', flexShrink: 0 }}>{i + 1}</div>
                    {/* Emoji + Name */}
                    <div style={{ width: 32, height: 32, borderRadius: 8, background: '#FFF1F2',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 18, flexShrink: 0 }}>{c.emoji}</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#1C1C1E' }}>{c.name}</div>
                      <div style={{ fontSize: 11, color: '#8E8E93' }}>{count} วัตถุดิบ</div>
                    </div>
                    {/* Drill-in + Edit + Delete */}
                    <button onClick={() => setSelectedCat(c)}
                      style={{ border: 'none', background: '#EFF6FF', color: '#3B82F6', borderRadius: 8,
                        padding: '5px 10px', fontSize: 13, cursor: 'pointer', fontWeight: 700 }}>›</button>
                    <button onClick={() => startEdit(c)}
                      style={{ border: 'none', background: '#F2F2F7', color: '#636366', borderRadius: 8,
                        padding: '5px 10px', fontSize: 13, cursor: 'pointer' }}>✏️</button>
                    <button onClick={() => deleteCat(c.id)}
                      style={{ border: 'none', background: count > 0 ? '#F2F2F7' : '#FEF2F2',
                        color: count > 0 ? '#C7C7CC' : '#DC2626', borderRadius: 8,
                        padding: '5px 10px', fontSize: 13, cursor: count > 0 ? 'not-allowed' : 'pointer' }}>🗑️</button>
                  </div>
                )}
              </div>
            )
          })}
        </div>}

      </div>
    </Modal>
  )
}

export default function Settings() {
  const { name, phone, isOwner } = useSession()
  const [loading, setLoading] = useState(true)
  const [lastSync, setLastSync] = useState('')
  const [settings, setSettings] = useState({})
  // โปรไฟล์ย้ายไปจัดการที่ BizICE Hub แล้ว — ไม่ subscribe staff/{phone} ในแอพนี้
  const [warehouses, setWarehouses] = useState([])
  const [items, setItems] = useState([])
  const [balanceMap, setBalanceMap] = useState({})  // { `${wh}_${item}`: balance doc }
  const [templates, setTemplates] = useState([])
  const [toast, setToast] = useState('')

  // Modal states
  const [whModal, setWhModal] = useState(false)
  const [srcModal, setSrcModal] = useState(false)
  const [itemModal, setItemModal] = useState(false)
  const [tplModal, setTplModal] = useState(false)
  const [intModal, setIntModal] = useState(false)
  const [openingModal, setOpeningModal] = useState(false)
  // V2 additions
  const [integrationOpen, setIntegrationOpen] = useState(false)
  const [quickTplModalV2, setQuickTplModalV2] = useState(false)
  const [clearDataOpen, setClearDataOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [seedOpen, setSeedOpen] = useState(false)
  const [dataSheetOpen, setDataSheetOpen] = useState(false)
  const [pinModal, setPinModal] = useState(false)
  const [editItem, setEditItem] = useState(null)
  const [editWH, setEditWH] = useState(null)
  const [editTpl, setEditTpl] = useState(null)

  // Forms
  const [whForm, setWhForm] = useState({ name: '', type: 'branch', color: WH_COLORS[0] })
  const [itemForm, setItemForm] = useState({
    name: '', displayName: '', category: DEFAULT_CATS[0]?.name || 'แยม', img: '🍓',
    // หน่วยที่ 1 (ใหญ่สุด) / 2 (กลาง) / 3 (เล็กสุด) — generic slots
    unitBuy: '',   // = หน่วยที่ 1
    unitUse: '',   // = หน่วยที่ 2
    unitSub: '',   // = หน่วยที่ 3
    convBuyToUse: '', // 1 หน่วยที่ 1 = ? หน่วยที่ 2
    convUseToSub: '', // 1 หน่วยที่ 2 = ? หน่วยที่ 3
    cutLevel: 'use',   // 'buy' | 'use' | 'sub' — ใช้ตัดสต็อก (default = หน่วยที่ 2)
    wasteLevel: 'sub', // 'buy' | 'use' | 'sub' — ใช้คำนวณของเสีย (default = หน่วยที่ 3)
    stockLimits: {}, // { [warehouseId]: { minQty, minUnit, maxQty, maxUnit } }
    alertEnabled: true,   // false = ปิดแจ้งเตือนของหมด/ใกล้หมด + lock Min/Max
    wasteMode: false, wasteUnit: 'use',
    showSubInInventory: false,
    visibleIn: {}, // { [warehouseId]: false } = ซ่อนเฉพาะคลังนั้น; ค่าเริ่มต้น = แสดงทุกที่
  })
  const [tplForm, setTplForm] = useState({ name: '', icon: '☀️', items: [] })
  const [pinForm, setPinForm] = useState({ old: '', newPin: '', confirm: '' })
  const [importModal, setImportModal] = useState(false)
  const [importStatus, setImportStatus] = useState('')
  const [importLoading, setImportLoading] = useState(false)
  const [importResult, setImportResult] = useState(null)
  const [importDiff, setImportDiff] = useState(null)    // { toAdd, toUpdate, total, lastSync }
  const [importPhase, setImportPhase] = useState('idle') // idle | checking | preview | applying | done
  const [selectedAdd, setSelectedAdd] = useState(new Set())
  const [selectedUpdate, setSelectedUpdate] = useState(new Set())
  const [itemSearch, setItemSearch] = useState('')
  const [itemCatFilter, setItemCatFilter] = useState('all')
  const [viewItem, setViewItem] = useState(null)
  const [viewCutUnit, setViewCutUnit] = useState(null) // หน่วยตัดที่เลือกใน view panel
  const [showAddForm, setShowAddForm] = useState(false)
  const [emojiGroup, setEmojiGroup] = useState(null) // null = ซ่อน picker
  const [activeWhLimitTab, setActiveWhLimitTab] = useState(null) // tab ที่เปิดใน Min/Max section
  const [cmLibrary, setCmLibrary] = useState([])
  const [cmCompounds, setCmCompounds] = useState([])
  const [cats, setCats] = useState(DEFAULT_CATS)
  const [catModal, setCatModal] = useState(false)
  const [notifLow, setNotifLow] = useState(true)
  const [notifWaste, setNotifWaste] = useState(false)
  const [wastePct,   setWastePct]   = useState(5)
  const [expDays, setExpDays] = useState(7)
  const [expThresholds, setExpThresholds] = useState({ yellow: 30, red: 7 })
  const [expColorModal, setExpColorModal] = useState(false)
  const [compoundWaste, setCompoundWaste] = useState({}) // { [cpKey]: { wastePct, wasteUnit } }
  const [openCpKey, setOpenCpKey] = useState(null) // เปิด accordion สูตรผสมทีละ 1
  const [compoundWasteDraft, setCompoundWasteDraft] = useState({}) // local edits before save

  useEffect(() => {
    const u1 = onSnapshot(collection(db, COL.WAREHOUSES), snap => {
      setWarehouses(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    })
    const u2 = onSnapshot(collection(db, COL.ITEMS), snap => {
      setItems(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    })
    const u2b = onSnapshot(collection(db, COL.STOCK_BALANCES), snap => {
      const map = {}
      snap.docs.forEach(d => { map[d.id] = d.data() })
      setBalanceMap(map)
    })
    const u3 = onSnapshot(collection(db, COL.QUICK_TEMPLATES), snap => {
      setTemplates(snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0)))
    })
    const u4 = onSnapshot(doc(db, COL.APP_SETTINGS, 'inventory_settings'), snap => {
      if (snap.exists()) {
        const d = snap.data()
        setSettings(d)
        setNotifLow(d.notifLowStock !== false)
        setNotifWaste(d.notifWasteOverThreshold === true)
        setWastePct(d.wasteThresholdPct ?? 5)
        setExpDays(d.expWarningDays || 7)
        setLastSync(new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }))
      }
      setLoading(false)
    })
    getDoc(doc(db, 'mixue_data', 'mixue-cost-manager')).then(snap => {
      if (snap.exists()) {
        setCmLibrary(snap.data().library || [])
        setCmCompounds(snap.data().compounds || [])
      }
    })
    // โหลด categories จาก Firestore
    getDoc(doc(db, COL.APP_SETTINGS, 'categories')).then(snap => {
      if (snap.exists() && snap.data().list?.length > 0) setCats(snap.data().list)
    })
    // โหลด compound waste settings
    getDoc(doc(db, COL.APP_SETTINGS, 'compound_waste')).then(snap => {
      if (snap.exists()) { setCompoundWaste(snap.data()); setCompoundWasteDraft(snap.data()) }
    })
    // โหลด exp thresholds
    getDoc(doc(db, COL.APP_SETTINGS, 'exp_thresholds')).then(snap => {
      if (snap.exists()) setExpThresholds(snap.data())
    })
    return () => { u1(); u2(); u2b(); u3(); u4() }
  }, [])

  async function saveWH() {
    if (!whForm.name) return
    const data = { ...whForm, active: true, isMain: whForm.type === 'main', branchCode: '', createdAt: serverTimestamp() }
    if (editWH) await updateDoc(doc(db, COL.WAREHOUSES, editWH.id), data)
    else await addDoc(collection(db, COL.WAREHOUSES), data)
    setWhModal(false); setEditWH(null); setWhForm({ name: '', type: 'branch', color: WH_COLORS[0] })
    setToast('✅ บันทึกคลังสินค้าเรียบร้อย')
  }

  async function saveItem() {
    if (!itemForm.name) return
    // ── คำนวณ V2 schema จาก cutLevel ──
    //   cutLevel === 'buy' → tracking ที่ unitBuy (1 unit = 1 base)
    //   cutLevel === 'use' → tracking ที่ unitUse (default)
    //   cutLevel === 'sub' → tracking ที่ unitSub (smallest)
    const c1 = parseFloat(itemForm.convBuyToUse) || 1
    const c2 = parseFloat(itemForm.convUseToSub) || 0
    const cutLevel = itemForm.cutLevel || 'use'
    let effUnitUse, effUnitConversion, effUnitSub, effConvSub
    // cumulative factor จาก base ถึง level ที่เลือก (สำหรับแปลงราคา)
    let cumFromBase = 1
    if (cutLevel === 'buy') {
      effUnitUse        = itemForm.unitBuy || ''
      effUnitConversion = ''
      effUnitSub        = itemForm.unitUse || ''
      effConvSub        = c1     // 1 unitBuy = c1 unitUse (using "Use" as sub when tracking by Buy)
      cumFromBase       = 1      // base = 1 unit
    } else if (cutLevel === 'sub' && itemForm.unitSub && c2 > 0) {
      effUnitUse        = itemForm.unitSub || ''
      effUnitConversion = `1 ${itemForm.unitBuy} = ${c1 * c2} ${itemForm.unitSub}`
      effUnitSub        = ''      // smallest already — no sub level
      effConvSub        = 0
      cumFromBase       = c1 * c2  // 1 ลัง = c1×c2 หน่วย smallest
    } else {
      // default 'use'
      effUnitUse        = itemForm.unitUse || ''
      effUnitConversion = `1 ${itemForm.unitBuy} = ${c1} ${itemForm.unitUse}`
      effUnitSub        = itemForm.unitSub || ''
      effConvSub        = c2 || 0
      cumFromBase       = c1
    }

    // ── คำนวณ unitPrice ใหม่ ตาม cutLevel ใหม่ ──
    //   เก็บ "rawBasePrice" (฿/หน่วยที่ 1) เป็น invariant — ราคาฐานที่ไม่ขึ้นกับ level
    //   ถ้ามี rawBasePrice อยู่แล้ว ใช้ตัวนั้น; ไม่งั้น derive จาก unitPrice เก่า × oldCumFromBase
    const prevCutLevel = editItem?.cutLevel || 'use'
    const prevC1 = Number(editItem?.convBuyToUse) || 1
    const prevC2 = Number(editItem?.convUseToSub) || 0
    let prevCum = 1
    if (prevCutLevel === 'sub' && prevC2 > 0) prevCum = prevC1 * prevC2
    else if (prevCutLevel === 'use') prevCum = prevC1

    const prevUnitPrice = Number(editItem?.unitPrice) || Number(itemForm.unitPrice) || 0
    // rawBasePrice = ฿/หน่วยที่ 1 (ลัง) — เก็บไว้เป็น invariant
    const rawBasePrice = editItem?.rawBasePrice
      ? Number(editItem.rawBasePrice)
      : prevUnitPrice * prevCum
    // unitPrice ใหม่ = rawBasePrice / cumFromBase (ฐาน ÷ จำนวนหน่วย-เล็ก-ต่อ-ฐาน)
    const newUnitPrice = cumFromBase > 0 ? rawBasePrice / cumFromBase : prevUnitPrice

    // ── Normalize stockLimits: บันทึกหน่วย min/max ให้ชัดเจนเสมอ ──
    //   default = หน่วยใหญ่สุด (buy/ลัง) ตรงกับที่ฟอร์มโชว์เป็นค่าเริ่มต้น (unitOpts[0])
    //   กัน bug: user ไม่กดเปลี่ยน dropdown → unit undefined → การ์ดเดาผิดเป็น use
    const defLimUnit = itemForm.unitBuy ? 'buy' : (itemForm.unitUse ? 'use' : 'sub')
    const normLimits = {}
    Object.entries(itemForm.stockLimits || {}).forEach(([whId, lim]) => {
      if (!lim) return
      normLimits[whId] = {
        ...lim,
        minUnit: lim.minUnit || defLimUnit,
        maxUnit: lim.maxUnit || defLimUnit,
      }
    })

    // backward compat: keep unitBase = unitBuy
    const data = {
      ...itemForm,
      stockLimits:   normLimits,
      unitBase:      itemForm.unitBuy || '',
      // Effective fields — ใช้ในระบบ (stock_balances, formatStockQty)
      unitUse:       effUnitUse,
      unitConversion: effUnitConversion,
      convBuyToUse:  c1,
      convUseToSub:  c2,
      convSub:       effConvSub,
      unitSub:       effUnitSub,
      // Raw 3-level fields — preserved สำหรับ form edit reload
      unitUseRaw:    itemForm.unitUse || '',      // ⭐ raw middle (ไม่เคยถูก overwrite)
      unitSubRaw:    itemForm.unitSub || '',      // ⭐ raw smallest
      cutLevel,
      wasteLevel:    itemForm.wasteLevel || 'sub',
      unitPrice:     newUnitPrice,
      rawBasePrice,                 // เก็บ ฿/หน่วย-1 ไว้เป็น invariant
    }
    let itemId
    if (editItem) {
      await updateDoc(doc(db, COL.ITEMS, editItem.id), data)
      itemId = editItem.id
    } else {
      const ref = await addDoc(collection(db, COL.ITEMS), { ...data, createdAt: serverTimestamp() })
      itemId = ref.id
    }

    // ── V2: Mirror stockLimits → stock_balances.minQty (per warehouse, in effective unitUse) ──
    try {
      const factor  = parseFloat(itemForm.convBuyToUse) || 1   // Lv1 → Lv2 (ปกติ)
      const subFact = parseFloat(itemForm.convUseToSub) || 0   // Lv2 → Lv3
      const cutLevel = itemForm.cutLevel || 'use'              // 'buy' | 'use' | 'sub'
      const limits  = itemForm.stockLimits || {}
      const whIds   = Object.keys(limits).filter(whId => limits[whId])

      // ── แปลง qty ในหน่วย dropdown (raw L1/L2/L3) → effective unitUse ตาม cutLevel ──
      //   minUnit value: 'buy'=Lv1(unitBuy), 'use'=Lv2(unitUseRaw), 'sub'=Lv3(unitSub)
      const rawToEffFactor = (minUnit) => {
        // กรณี cutLevel === 'buy' (effective = Lv1)
        if (cutLevel === 'buy') {
          if (minUnit === 'buy') return 1
          if (minUnit === 'use') return factor > 0 ? 1 / factor : 1
          if (minUnit === 'sub') return (factor > 0 && subFact > 0) ? 1 / (factor * subFact) : 1
        }
        // กรณี cutLevel === 'use' (effective = Lv2)
        if (cutLevel === 'use') {
          if (minUnit === 'buy') return factor
          if (minUnit === 'use') return 1
          if (minUnit === 'sub') return subFact > 0 ? 1 / subFact : 1
        }
        // กรณี cutLevel === 'sub' (effective = Lv3)
        if (cutLevel === 'sub') {
          if (minUnit === 'buy') return factor * (subFact || 1)
          if (minUnit === 'use') return subFact || 1
          if (minUnit === 'sub') return 1
        }
        return 1
      }

      if (whIds.length > 0) {
        const batch = writeBatch(db)
        const now = serverTimestamp()
        whIds.forEach(whId => {
          const lim = limits[whId] || {}
          const minUnitEff = lim.minUnit || defLimUnit
          const rawMin = parseFloat(lim.minQty) || 0
          const minInUse = rawMin > 0 ? rawMin * rawToEffFactor(minUnitEff) : 0
          const balRef = doc(db, COL.STOCK_BALANCES, `${whId}_${itemId}`)
          batch.set(balRef, {
            warehouseId: whId,
            itemId,
            minQty:      minInUse,
            minUnit:     minUnitEff,               // จำหน่วยที่ user เลือก ('buy'|'use'|'sub')
            minQtyRaw:   rawMin,                   // ค่าที่ user กรอกตามหน่วย minUnit
            unit:        itemForm.unitUse || '',
            lastUpdated: now,
          }, { merge: true })
        })
        await batch.commit()
      }
    } catch (e) {
      console.error('[saveItem] mirror min →stock_balances failed:', e)
    }

    // ย้อนกลับแค่ขั้นเดียว — ปิด form แต่คงอยู่ใน modal
    setEditItem(null); setShowAddForm(false); setViewItem(null)
    setItemForm({
      name: '', displayName: '', category: cats[0]?.name || 'แยม', img: '🍓',
      unitBuy: '', unitUse: '', unitSub: '',
      convBuyToUse: '', convUseToSub: '',
      cutLevel: 'use', wasteLevel: 'sub',
      stockLimits: {},
      alertEnabled: true,
      wasteMode: false, wasteUnit: 'use',
      showSubInInventory: false,
      visibleIn: {},
    })
    setToast('✅ บันทึกวัตถุดิบ + sync min stock ทุกคลังเรียบร้อย')
  }

  async function saveTpl() {
    if (!tplForm.name) return
    const data = { ...tplForm, createdBy: phone, order: templates.length }
    if (editTpl) await updateDoc(doc(db, COL.QUICK_TEMPLATES, editTpl.id), data)
    else await addDoc(collection(db, COL.QUICK_TEMPLATES), data)
    setTplModal(false); setEditTpl(null); setTplForm({ name: '', icon: '☀️', items: [] })
    setToast('✅ บันทึก Quick Template เรียบร้อย')
  }

  async function saveSettings(updates) {
    await setDoc(doc(db, COL.APP_SETTINGS, 'inventory_settings'), updates, { merge: true })
  }

  // (รีเฟรชข้อมูล + โปรไฟล์ + กลับหน้าหลัก ย้ายไปจัดการที่อื่นแล้ว — ลบ dead code ออก)

  // ── ซ่อมข้อมูล Stock ย้อนหลัง ──────────────────────────────────────────
  async function retroFixStock() {
    if (!window.confirm('ระบบจะลด stock_balances ตามรายการตัดสต็อกทั้งหมดที่ยังไม่ถูกยกเลิก\n\nดำเนินการต่อ?')) return
    setToast('⏳ กำลังซ่อมข้อมูล...')
    try {
      // 1. ดึง cut_stock_logs ทั้งหมดที่ยังไม่ยกเลิก
      const logsSnap = await getDocs(collection(db, COL.CUT_STOCK_LOGS))
      const logs = logsSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(l => !l.cancelled && !l.deletedAt)

      let fixed = 0
      // 2. สำหรับแต่ละ log ลด stock ตามรายการ
      for (const log of logs) {
        const items = log.items || []
        for (const it of items) {
          const qty = it.qtyUse ?? it.qty ?? 0
          if (!qty || !it.itemId || !log.warehouseId) continue
          const q = query(
            collection(db, COL.STOCK_BALANCES),
            where('itemId', '==', it.itemId),
            where('warehouseId', '==', log.warehouseId)
          )
          const snap = await getDocs(q)
          for (const balDoc of snap.docs) {
            const current = balDoc.data().qty || 0
            await updateDoc(balDoc.ref, {
              qty: Math.max(0, current - qty),
              lastUpdated: serverTimestamp()
            })
            fixed++
          }
        }
      }
      setToast(`✅ ซ่อมสำเร็จ ${fixed} รายการ`)
    } catch (e) {
      console.error(e)
      setToast('❌ เกิดข้อผิดพลาด: ' + e.message)
    }
  }

  const SettingRow = ({ icon, title, desc, right, onClick, danger }) => (
    <div className="setting-row" onClick={onClick}
      style={danger ? { color: '#DC2626' } : {}}>
      <div className="setting-left">
        <span className="setting-icon">{icon}</span>
        <span className="setting-title" style={danger ? { color: '#DC2626' } : {}}>{title}</span>
        {/* รายละเอียดซ่อนเป็น tooltip — เอาเมาส์ชี้ (หรือแตะ ⓘ) เพื่อแสดง */}
        {desc && (
          <span className="setting-info" tabIndex={0}
            onClick={e => e.stopPropagation()}>ⓘ
            <span className="setting-tip">{desc}</span>
          </span>
        )}
      </div>
      {right !== undefined ? right : <span className="setting-arrow">›</span>}
    </div>
  )

  return (
    <div className="page-pad">
      {toast && <Toast message={toast} onDone={() => setToast('')} />}

      {loading && (
        <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:'48px 0',gap:12}}>
          <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          <div style={{width:40,height:40,borderRadius:'50%',border:'3px solid #F3F4F6',borderTopColor:'#E31E24',animation:'spin .7s linear infinite'}}/>
          <div style={{fontSize:13,fontWeight:700,color:'#9CA3AF'}}>กำลังโหลด...</div>
        </div>
      )}

      {/* Sub-header */}
      <div className="page-subbar" style={{ flexDirection: 'column', alignItems: 'stretch', height: 'auto', paddingBottom: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="subbar-title">ตั้งค่า</span>
        </div>
        {lastSync && (
          <div style={{ fontSize: 11, color: 'var(--txt3)', marginTop: 2 }}>อัปเดตล่าสุด {lastSync} น.</div>
        )}
      </div>

      {/* (การ์ดโปรไฟล์ถูกย้ายไปจัดการที่ BizICE Hub แล้ว) */}

      {/* ══ กลุ่ม 1 — คลัง + วัตถุดิบ (Editor + Owner) ══ */}
      <div>
        <div className="section-label">คลัง + วัตถุดิบ</div>
        <div className="card" style={{ margin: '0 1rem', overflow: 'visible' }}>
          <SettingRow icon="🏪" title="จัดการคลังสินค้า" onClick={() => setWhModal(true)} />
          <SettingRow icon="🚚" title="แหล่งที่มาสินค้า" desc="แก้ไขรายการแหล่งที่มา" onClick={() => setSrcModal(true)} />
          <SettingRow icon="🏷️" title="หมวดหมู่วัตถุดิบ" desc={`${cats.length} หมวด`} onClick={() => setCatModal(true)} />
          <SettingRow icon="📦" title="วัตถุดิบ (Master Data)" onClick={() => setItemModal(true)} />
          <SettingRow icon="🔄" title="Update จาก Cost Manager" onClick={async () => {
            setImportModal(true); setImportResult(null); setImportStatus(''); setImportDiff(null); setImportPhase('checking')
            try {
              const diff = await diffFromCostManager()
              setImportDiff(diff)
              setSelectedAdd(new Set(diff.toAdd.map((_, i) => i)))
              setSelectedUpdate(new Set(diff.toUpdate.map((_, i) => i)))
              setImportPhase('preview')
            } catch(e) { setImportStatus(`❌ ${e.message}`); setImportPhase('idle') }
          }} />
        </div>
      </div>

      {/* ══ ส่วนที่เหลือ: Owner เท่านั้น ══ */}
      {isOwner() && (<>

        {/* กลุ่ม 2 — การแจ้งเตือน */}
        <div>
          <div className="section-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            การแจ้งเตือน
            <span style={{ fontSize: 10, background: '#FEF3C7', color: '#B45309',
              borderRadius: 20, padding: '1px 8px', fontWeight: 700 }}>👑 Owner</span>
          </div>
          <div className="card" style={{ margin: '0 1rem', overflow: 'visible' }}>
            <SettingRow icon="📉" title="Stock ต่ำกว่า min"
              right={<button className={`toggle${notifLow ? ' on' : ''}`} onClick={async () => {
                const next = !notifLow; setNotifLow(next)
                await saveSettings({ notifLowStock: next })
              }} />} onClick={() => {}} />
            <SettingRow icon="📅" title={`แจ้งเตือนก่อน EXP ${expDays} วัน`}
              onClick={() => {
                const opts = [7, 14, 30]
                const next = opts[(opts.indexOf(expDays) + 1) % opts.length]
                setExpDays(next); saveSettings({ expWarningDays: next })
              }} />
            <SettingRow icon="🎨" title="เกณฑ์สีอายุ Lot (EXP)"
              desc={`🟡 ≤ ${expThresholds.yellow} วัน · 🔴 ≤ ${expThresholds.red} วัน`}
              onClick={() => setExpColorModal(true)} />
            {/* ของเสียเกิน threshold — toggle + inline % input */}
            <div style={{ padding: '6px 14px', display: 'flex', flexDirection: 'column', gap: 8,
              borderTop: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <span style={{ fontSize: 16 }}>🗑️</span>
                <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>ของเสียเกิน threshold</span>
                <button className={`toggle${notifWaste ? ' on' : ''}`} onClick={async () => {
                  const next = !notifWaste; setNotifWaste(next)
                  await saveSettings({ notifWasteOverThreshold: next })
                }} />
              </div>
              {notifWaste && (
                <div style={{ background: '#F9FAFB', borderRadius: 10, padding: '8px 12px',
                  display: 'flex', alignItems: 'center', gap: 10, marginLeft: 25 }}>
                  <span style={{ fontSize: 13, color: '#6B7280', flex: 1 }}>แจ้งเมื่อของเสีย ≥</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <button onClick={() => {
                      const v = Math.max(1, wastePct - 1); setWastePct(v)
                      saveSettings({ wasteThresholdPct: v })
                    }} style={{ width: 32, height: 32, border: 'none', borderRadius: 8,
                      background: '#E5E7EB', fontSize: 18, fontWeight: 700, cursor: 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center' }}>−</button>
                    <div style={{ minWidth: 48, textAlign: 'center',
                      fontFamily: 'Prompt', fontWeight: 700, fontSize: 20, color: '#DC2626' }}>
                      {wastePct}%
                    </div>
                    <button onClick={() => {
                      const v = Math.min(50, wastePct + 1); setWastePct(v)
                      saveSettings({ wasteThresholdPct: v })
                    }} style={{ width: 32, height: 32, border: 'none', borderRadius: 8,
                      background: '#E5E7EB', fontSize: 18, fontWeight: 700, cursor: 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center' }}>+</button>
                  </div>
                  <span style={{ fontSize: 12, color: '#9CA3AF' }}>ของรายรับ</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* กลุ่ม 3 — เครื่องมือ Owner */}
        <div>
          <div className="section-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            เครื่องมือ
            <span style={{ fontSize: 10, background: '#FEF3C7', color: '#B45309',
              borderRadius: 20, padding: '1px 8px', fontWeight: 700 }}>👑 Owner</span>
          </div>
          <div className="card" style={{ margin: '0 1rem', overflow: 'visible' }}>
            <SettingRow icon="⚡" title="Quick Template" onClick={() => setQuickTplModalV2(true)} />
            <SettingRow icon="🔗" title="เชื่อมต่อระบบ"
              desc="Cost Manager / Daily Income / น้องมี่"
              onClick={() => setIntegrationOpen(true)} />
            <SettingRow icon="📤" title="Export ข้อมูล"
              desc="CSV — cut/waste/transfer/movements ตามช่วงวัน"
              onClick={() => setExportOpen(true)} />
            <SettingRow icon="🌱" title="Seed Stock"
              desc="กรอกยอดสต็อกเริ่มต้น (paste จาก Excel)"
              onClick={() => setSeedOpen(true)} />
            <SettingRow icon="📊" title="Data Sheet"
              desc="แก้ items + stock ทุกคลังในไฟล์ CSV เดียว"
              onClick={() => setDataSheetOpen(true)} />
          </div>
        </div>

        {/* Danger Zone */}
        <div>
          <div className="section-label" style={{ color: '#DC2626' }}>Danger Zone</div>
          <div className="card" style={{ margin: '0 1rem', overflow: 'visible' }}>
            <SettingRow icon="🔧" title="ซ่อมข้อมูล Stock ย้อนหลัง"
              desc="ลด stock_balances ตาม cut_stock_logs ที่มีอยู่ (ใช้ครั้งเดียว)"
              onClick={retroFixStock} />
            <SettingRow icon="🗑️" title="Clear All Data"
              desc="ลบ stock + log + lot + transfer ทั้งหมด (ใส่ PIN ยืนยัน)"
              danger onClick={() => setClearDataOpen(true)} />
          </div>
        </div>

      </>)}

      {/* ── Version Footer ── */}
      <div style={{
        padding: '24px 1rem 8px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
      }}>
        <div style={{ fontSize: 12, color: 'var(--txt3)', fontWeight: 600 }}>
          Mixue Inventory · BizICE
        </div>
        <div style={{ fontSize: 11, color: 'var(--txt3)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            background: 'var(--bg)', border: '1px solid var(--border2)',
            borderRadius: 20, padding: '1px 8px', fontWeight: 700, fontSize: 10.5,
            color: 'var(--txt2)'
          }}>v2.0.87</span>
          <span>·</span>
          <span>อัพเดท 2 มิ.ย. 2569</span>
        </div>
      </div>

      {/* ── Modal: คลังสินค้า ── */}
      {/* Modal: แหล่งที่มาสินค้า */}
      <SourcesModal open={srcModal} onClose={() => setSrcModal(false)} />

      {/* Modal: เกณฑ์สีอายุ Lot */}
      <ExpColorModal
        open={expColorModal}
        onClose={() => setExpColorModal(false)}
        thresholds={expThresholds}
        onSave={async (next) => {
          await setDoc(doc(db, COL.APP_SETTINGS, 'exp_thresholds'), next)
          setExpThresholds(next)
          setExpColorModal(false)
          setToast('✅ บันทึกเกณฑ์สีอายุแล้ว')
        }}
      />

      <Modal open={whModal} onClose={() => { setWhModal(false); setEditWH(null) }} title="จัดการคลังสินค้า"
        footer={isOwner() && <button className="btn-primary" onClick={saveWH}>บันทึก</button>}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* List */}
          {warehouses.map(w => (
            <div key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 10,
              padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: w.color, flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{w.name}</div>
                <div style={{ fontSize: 11, color: 'var(--txt3)' }}>{w.type === 'main' ? 'คลังหลัก' : 'สาขา'}</div>
              </div>
              {isOwner() && (
                <button style={{ border: 'none', background: 'none', fontSize: 14, cursor: 'pointer' }}
                  onClick={() => { setEditWH(w); setWhForm({ name: w.name, type: w.type, color: w.color }) }}>
                  ✏️
                </button>
              )}
            </div>
          ))}
          {isOwner() && (
            <>
              <div style={{ fontWeight: 700, fontSize: 13, marginTop: 8 }}>
                {editWH ? `แก้ไข: ${editWH.name}` : '+ เพิ่มคลัง'}
              </div>
              <div>
                <label className="fi-label">ชื่อคลัง</label>
                <input className="fi" value={whForm.name} onChange={e => setWhForm(f => ({ ...f, name: e.target.value }))} placeholder="เช่น ร้าน ITU" />
              </div>
              <div>
                <label className="fi-label">ประเภท</label>
                <select className="fi" value={whForm.type} onChange={e => setWhForm(f => ({ ...f, type: e.target.value }))}>
                  <option value="main">คลังหลัก</option>
                  <option value="branch">สาขา</option>
                </select>
              </div>
              <div>
                <label className="fi-label">สี</label>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {WH_COLORS.map(c => (
                    <button key={c} onClick={() => setWhForm(f => ({ ...f, color: c }))}
                      style={{ width: 32, height: 32, borderRadius: '50%', background: c, border: whForm.color === c ? '3px solid var(--txt)' : '2px solid transparent', cursor: 'pointer' }} />
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </Modal>

      {/* ── Modal: วัตถุดิบ (Master Data) ── */}
      <Modal open={itemModal} onClose={() => { setItemModal(false); setEditItem(null); setViewItem(null); setShowAddForm(false) }} title="📦 วัตถุดิบ (Master Data)"
        footer={
          (editItem || showAddForm) && isOwner()
            ? <div style={{ display: 'flex', gap: 8 }}>
                {editItem && (
                  <button onClick={async () => {
                    if (!confirm(`ลบ "${editItem.name}" ออกจากระบบ?`)) return
                    await deleteDoc(doc(db, COL.ITEMS, editItem.id))
                    setEditItem(null); setShowAddForm(false)
                  }}
                    style={{ border: 'none', background: '#FEF2F2', color: '#DC2626', borderRadius: 10,
                      padding: '0 16px', fontSize: 18, cursor: 'pointer', flexShrink: 0 }}>🗑️</button>
                )}
                <button className="btn-primary" style={{ flex: 1 }} onClick={saveItem}>💾 บันทึกวัตถุดิบ</button>
              </div>
            : null
        }>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* Search bar */}
          <div className="search-wrap" style={{ margin: 0 }}>
            <span className="search-icon">🔍</span>
            <input className="search-input" placeholder="ค้นหาวัตถุดิบ..."
              value={itemSearch || ''} onChange={e => setItemSearch(e.target.value)} />
            {itemSearch && (
              <button onClick={() => setItemSearch('')}
                style={{ border: 'none', background: 'none', color: '#8E8E93',
                  fontSize: 15, cursor: 'pointer', padding: '0 8px', lineHeight: 1 }}>✕</button>
            )}
          </div>

          {/* Sidebar layout */}
          <div style={{ display: 'flex', gap: 0, borderRadius: 12, overflow: 'hidden',
            border: '1px solid #E5E5EA', height: 320 }}>

            {/* Left: category list */}
            <div style={{ width: 76, flexShrink: 0, overflowY: 'auto', background: '#F2F2F7',
              borderRight: '1px solid #E5E5EA' }}>
              {[{ id:'all', name:'ทั้งหมด', emoji:'🔍' }, ...cats].map(c => {
                const val = c.id === 'all' ? 'all' : c.name
                const active = itemCatFilter === val
                return (
                  <button key={c.id} onClick={() => setItemCatFilter(val)}
                    style={{ width: '100%', border: 'none', cursor: 'pointer', padding: '10px 4px',
                      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
                      background: active ? '#fff' : 'transparent',
                      borderLeft: active ? '3px solid var(--red)' : '3px solid transparent',
                      transition: 'all .15s' }}>
                    <span style={{ fontSize: 18, lineHeight: 1 }}>
                      {c.id === 'all' ? '🔍' : c.emoji}
                    </span>
                    <span style={{ fontSize: 9.5, fontWeight: active ? 700 : 500, lineHeight: 1.2,
                      color: active ? 'var(--red)' : 'var(--txt3)', textAlign: 'center',
                      wordBreak: 'break-word', maxWidth: 64 }}>
                      {c.name}
                    </span>
                  </button>
                )
              })}
            </div>

            {/* Right: item list OR compound list */}
            <div style={{ flex: 1, overflowY: 'auto', background: '#fff' }}>
              {itemCatFilter === 'สูตรผสม' ? (
                /* ── สูตรผสม accordion ── */
                cmCompounds.length === 0 ? (
                  <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: 'var(--txt3)' }}>
                    ยังไม่มีสูตรผสม<br />ไปที่ Cost Manager → สูตรผสม
                  </div>
                ) : cmCompounds
                  .filter(cp => !itemSearch || cp.name.toLowerCase().includes((itemSearch||'').toLowerCase()))
                  .map((cp, idx, arr) => {
                    const cpKey = cp.id || cp.name
                    const isOpen = openCpKey === cpKey
                    const wDraft = compoundWasteDraft[cpKey] || { wastePct: '', wasteUnit: cp.outputUnit || '' }
                    const unitOptions = [...new Set([cp.outputUnit, cp.servingUnit?.name].filter(Boolean))]
                    const hasSaved = compoundWaste[cpKey]?.wastePct > 0
                    const cpu = cp.costPerOutputUnit || 0

                    async function saveCompoundWaste() {
                      const updated = { ...compoundWaste, [cpKey]: { wastePct: parseFloat(wDraft.wastePct) || 0, wasteUnit: wDraft.wasteUnit } }
                      await setDoc(doc(db, COL.APP_SETTINGS, 'compound_waste'), updated)
                      setCompoundWaste(updated)
                      setToast('✅ บันทึกแล้ว: ' + cp.name)
                    }

                    return (
                      <div key={cpKey} style={{ borderBottom: idx < arr.length - 1 ? '1px solid #F2F2F7' : 'none' }}>
                        {/* Row */}
                        <div onClick={() => setOpenCpKey(isOpen ? null : cpKey)}
                          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
                            cursor: 'pointer',
                            background: isOpen ? '#F5F3FF' : 'transparent',
                            borderLeft: isOpen ? '3px solid #7C3AED' : '3px solid transparent',
                            transition: 'all .15s' }}>
                          <div style={{ width: 32, height: 32, borderRadius: 8, flexShrink: 0,
                            background: isOpen ? '#EDE9FE' : '#F5F3FF',
                            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}>🧪</div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 600,
                              color: isOpen ? '#5B21B6' : '#1C1C1E',
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cp.name}</div>
                            <div style={{ fontSize: 10, color: '#8E8E93', marginTop: 1 }}>
                              {cp.outputQty} {cp.outputUnit}
                              {hasSaved && <span style={{ marginLeft: 5, color: '#D97706' }}>· 🗑️{compoundWaste[cpKey].wastePct}%</span>}
                            </div>
                          </div>
                          <div style={{ textAlign: 'right', flexShrink: 0 }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: isOpen ? '#7C3AED' : 'var(--red)', fontFamily: 'Prompt' }}>{cpu.toFixed(2)} ฿</div>
                            <div style={{ fontSize: 9, color: '#8E8E93' }}>/{cp.outputUnit}</div>
                          </div>
                          <span style={{ fontSize: 10, color: 'var(--txt3)', marginLeft: 2 }}>{isOpen ? '▲' : '▼'}</span>
                        </div>

                        {/* Detail panel */}
                        {isOpen && (
                          <div style={{ background: '#FAFAFA', padding: '10px 12px 14px', borderTop: '1px solid #EDE9FE' }}>
                            {/* Ingredients */}
                            <div style={{ marginBottom: 10 }}>
                              <div style={{ fontSize: 10, fontWeight: 700, color: '#5B21B6', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>ส่วนผสม</div>
                              {(cp.ingredients || []).map((ing, i) => (
                                <div key={i} style={{ display: 'flex', justifyContent: 'space-between',
                                  fontSize: 11, color: 'var(--txt2)', padding: '3px 0',
                                  borderBottom: i < cp.ingredients.length - 1 ? '1px solid #F0F0F0' : 'none' }}>
                                  <span>{ing.name}</span>
                                  <span style={{ color: 'var(--txt3)' }}>{ing.qty} {ing.unit} · <strong style={{ color: 'var(--txt)' }}>{(ing.qty*(ing.unitPrice||0)).toFixed(2)} ฿</strong></span>
                                </div>
                              ))}
                            </div>

                            {/* Cost summary row */}
                            <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
                              <div style={{ flex: 1, background: '#F5F3FF', borderRadius: 8, padding: '6px 8px', textAlign: 'center' }}>
                                <div style={{ fontSize: 9, color: '#7C3AED', fontWeight: 600 }}>ต้นทุน/หน่วย</div>
                                <div style={{ fontSize: 15, fontWeight: 700, color: '#5B21B6', fontFamily: 'Prompt' }}>{cpu.toFixed(2)} ฿</div>
                                <div style={{ fontSize: 9, color: '#8E8E93' }}>/{cp.outputUnit}</div>
                              </div>
                              {cp.servingUnit && (
                                <div style={{ flex: 1, background: '#F5F3FF', borderRadius: 8, padding: '6px 8px', textAlign: 'center' }}>
                                  <div style={{ fontSize: 9, color: '#7C3AED', fontWeight: 600 }}>ต่อ {cp.servingUnit.name}</div>
                                  <div style={{ fontSize: 15, fontWeight: 700, color: '#5B21B6', fontFamily: 'Prompt' }}>{(cp.servingUnit.costPerServe||0).toFixed(2)} ฿</div>
                                  <div style={{ fontSize: 9, color: '#8E8E93' }}>/{cp.servingUnit.name}</div>
                                </div>
                              )}
                            </div>

                            {/* Waste Mode toggle */}
                            {(() => {
                              const isWaste = compoundWaste[cpKey]?.wasteMode || false
                              async function toggleWasteMode() {
                                const updated = { ...compoundWaste, [cpKey]: { ...compoundWaste[cpKey], wasteMode: !isWaste } }
                                await setDoc(doc(db, COL.APP_SETTINGS, 'compound_waste'), updated)
                                setCompoundWaste(updated)
                              }
                              return (
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                  background: '#FEFCE8', borderRadius: 10, padding: '10px 12px' }}>
                                  <span style={{ fontSize: 12, fontWeight: 600, color: '#92400E' }}>🗑️ ติดตามของเสีย (Waste Mode)</span>
                                  <button className={`toggle${isWaste ? ' on' : ''}`} onClick={toggleWasteMode} />
                                </div>
                              )
                            })()}
                          </div>
                        )}
                      </div>
                    )
                  })
              ) : (
              items
                .filter(i => {
                  if (itemCatFilter !== 'all' && i.category !== itemCatFilter) return false
                  if (itemSearch && !i.name.toLowerCase().includes((itemSearch||'').toLowerCase())
                    && !(i.displayName||'').toLowerCase().includes((itemSearch||'').toLowerCase())) return false
                  return true
                })
                .sort((a, b) => {
                  // เรียงตาม sortOrder ที่ตั้งใน "ลากเพื่อเรียงลำดับ"
                  const oa = a.sortOrder ?? 999
                  const ob = b.sortOrder ?? 999
                  if (oa !== ob) return oa - ob
                  return (a.name || '').localeCompare(b.name || '', 'th')
                })
                .map((i, idx, arr) => {
                  const isEditing = editItem?.id === i.id
                  const isViewing = viewItem?.id === i.id
                  return (
                    <div key={i.id}
                      onClick={() => { if (!isEditing) { setViewItem(isViewing ? null : i); setEditItem(null); setShowAddForm(false) } }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
                        cursor: isEditing ? 'default' : 'pointer',
                        background: isEditing ? '#FFF0F0' : isViewing ? '#FFF8F8' : 'transparent',
                        borderBottom: idx < arr.length - 1 ? '1px solid #F2F2F7' : 'none',
                        borderLeft: isEditing || isViewing ? '3px solid var(--red)' : '3px solid transparent',
                        transition: 'background 0.12s',
                      }}>
                      <div style={{ width: 32, height: 32, borderRadius: 8, flexShrink: 0,
                        background: isViewing || isEditing ? '#FFF1F2' : '#F2F2F7',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}>
                        {i.img || '📦'}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        {(() => {
                          const hiddenCount = Object.values(i.visibleIn || {}).filter(v => v === false).length
                          return (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                              <div style={{ fontSize: 13, fontWeight: isViewing ? 700 : 600,
                                color: isViewing || isEditing ? 'var(--red)' : '#1C1C1E',
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.displayName || i.name}</div>
                              {hiddenCount > 0 && (
                                <span style={{ fontSize: 9, background: '#FEF2F2', color: '#DC2626',
                                  borderRadius: 4, padding: '1px 5px', fontWeight: 700, flexShrink: 0 }}>
                                  ซ่อน {hiddenCount} คลัง
                                </span>
                              )}
                            </div>
                          )
                        })()}
                        <div style={{ fontSize: 10, color: '#8E8E93', marginTop: 1 }}>
                          {[i.unitBuy||i.unitBase, i.unitUse, i.unitSub].filter(Boolean).join(' › ')}
                        </div>
                      </div>
                      {isOwner() && (
                        <button title="แก้ไข"
                          onClick={e => {
                            e.stopPropagation()
                            setEditItem(i); setViewItem(null); setShowAddForm(false)
                            // ── V2: merge minQty จาก stock_balances → stockLimits (per warehouse) ──
                            const mergedLimits = { ...(i.stockLimits || {}) }
                            warehouses.forEach(w => {
                              const bal = balanceMap[`${w.id}_${i.id}`]
                              if (bal?.minQty != null && bal.minQty > 0) {
                                // ใช้ minUnit + minQtyRaw ที่ save ไว้ (ถ้ามี) — เพื่อแสดงในหน่วยที่ user เลือก
                                // ถ้าเป็น item เก่าที่ไม่มี → fallback 'use' (กระป๋อง)
                                mergedLimits[w.id] = {
                                  ...(mergedLimits[w.id] || {}),
                                  minQty:  bal.minQtyRaw != null ? bal.minQtyRaw : bal.minQty,
                                  minUnit: bal.minUnit || 'use',
                                }
                              }
                            })
                            setItemForm({
                              name: i.name, displayName: i.displayName || '',
                              category: i.category, img: i.img || '📦',
                              unitBuy: i.unitBuy || i.unitBase || '',
                              // ใช้ raw fields ก่อน — preserve user input ผ่าน cutLevel change
                              unitUse: i.unitUseRaw ?? i.unitUse ?? '',
                              unitSub: i.unitSubRaw ?? i.unitSub ?? '',
                              convBuyToUse: i.convBuyToUse || '',
                              convUseToSub: i.convUseToSub || '',
                              cutLevel: i.cutLevel || 'use',
                              wasteLevel: i.wasteLevel || ((i.unitSubRaw || i.unitSub) ? 'sub' : 'use'),
                              stockLimits: mergedLimits,
                              alertEnabled: i.alertEnabled !== false,   // default true
                              wasteMode: i.wasteMode || false,
                              wasteUnit: i.wasteUnit || 'use',
                              showSubInInventory: i.showSubInInventory || false,
                              visibleIn: i.visibleIn || {},
                            })
                          }}
                          style={{ border: 'none', cursor: 'pointer', borderRadius: 7, flexShrink: 0,
                            width: 28, height: 28, fontSize: 13, transition: 'all 0.15s',
                            background: isEditing ? 'var(--red)' : '#F2F2F7',
                            color: isEditing ? '#fff' : '#8E8E93' }}>✏️</button>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </div>

          {/* View panel */}
          {viewItem && !editItem && (() => {
            // ── Inventory values ──
            const cmItem     = cmLibrary.find(ci => ci.name === viewItem.name)
            const invUnitBuy = viewItem.unitBuy || viewItem.unitBase || ''
            // ใช้ RAW middle/sub ใน comparison (3-level definition) — ไม่ขึ้นกับ cutLevel
            const invUnitUseDef = viewItem.unitUseRaw || viewItem.unitUse || ''
            const invUnitSubDef = viewItem.unitSubRaw || viewItem.unitSub || ''
            const convBU     = parseFloat(viewItem.convBuyToUse) || 0
            const convUS     = parseFloat(viewItem.convUseToSub) || 0
            // อัตราแปลงเต็มสาย: 1 ลัง = X (เล็กสุด)
            const invTotalQty  = convUS > 0 ? convBU * convUS : convBU
            const invSmallUnit = convUS > 0 ? invUnitSubDef : invUnitUseDef
            const invConvLabel = invTotalQty > 0
              ? `1 ${invUnitBuy} = ${invTotalQty.toLocaleString()} ${invSmallUnit}`
              : '—'

            // ── CM values ──
            const lvs        = cmItem?.levels || []
            const cmUnitBuy  = lvs[0]?.name || ''
            const cmUnitUseDef = lvs[1]?.name || ''   // RAW middle
            const cmUnitSubDef = lvs[2]?.name || ''   // RAW sub
            const cmSmallUnit  = cmUnitSubDef || cmUnitUseDef
            // total qty = product ของทุก level ตั้งแต่ level[1]
            const cmTotalQty = cmItem?.qty ||
              (lvs.length > 1 ? lvs.slice(1).reduce((acc, l) => acc * (l.qty || 1), 1) : 0)
            const cmConvLabel = cmTotalQty > 0
              ? `1 ${cmUnitBuy} = ${Number(cmTotalQty).toLocaleString()} ${cmSmallUnit}`
              : '—'

            // ── cut-unit choices (ไม่ใช่ mismatch — เป็น user choice) ──
            const invCutLevel = viewItem.cutLevel || 'use'
            const invCutUnit =
              invCutLevel === 'buy' ? invUnitBuy :
              invCutLevel === 'sub' ? invUnitSubDef : invUnitUseDef
            const cmCutUnit = cmItem?.unit || cmSmallUnit

            // ── badge helper ──
            function matchBadge(a, b) {
              if (!a || !b || a === '—' || b === '—') return null
              return a.trim() === b.trim()
                ? <span style={{ fontSize: 10, background: '#F0FDF4', color: '#15803D',
                    border: '1px solid #BBF7D0', borderRadius: 20, padding: '2px 8px', fontWeight: 700,
                    whiteSpace: 'nowrap' }}>✓ ตรงกัน</span>
                : <span style={{ fontSize: 10, background: '#FEF2F2', color: '#DC2626',
                    border: '1px solid #FECACA', borderRadius: 20, padding: '2px 8px', fontWeight: 700,
                    whiteSpace: 'nowrap' }}>⚠ ต่างกัน</span>
            }

            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

                {/* ── ส่วนที่ 1: ข้อมูล Inventory ── */}
                <div style={{ background: '#fff', borderRadius: 14, overflow: 'hidden',
                  boxShadow: '0 1px 4px rgba(0,0,0,0.07)', border: '1px solid #F3F4F6' }}>
                  {/* Header row */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px',
                    borderBottom: '1px solid #F3F4F6' }}>
                    <div style={{ width: 42, height: 42, borderRadius: 12, background: '#FFF1F2',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22,
                      flexShrink: 0, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                      {viewItem.img || '📦'}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 15, color: '#1C1C1E' }}>{viewItem.displayName || viewItem.name}</div>
                      {viewItem.displayName && (
                        <div style={{ fontSize: 10, color: '#8E8E93', marginBottom: 2 }}>
                          🔗 CM: {viewItem.name}
                        </div>
                      )}
                      <span style={{ fontSize: 11, background: '#FFF1F2', color: '#FF3B30', borderRadius: 6,
                        padding: '1px 7px', fontWeight: 600, display: 'inline-block', marginTop: 2 }}>
                        {viewItem.category}
                      </span>
                    </div>
                    <span style={{ fontSize: 10, background: '#F2F2F7', color: '#8E8E93', borderRadius: 20,
                      padding: '3px 9px', fontWeight: 600 }}>📦 Inventory</span>
                  </div>
                  {/* Info grid */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
                    {[
                      ['หน่วยซื้อ', invUnitBuy || '—'],
                      ['หน่วยที่ 2', invUnitUseDef || '—'],
                      ['หน่วยที่ 3', invUnitSubDef || '—'],
                      ['อัตราแปลง (เต็มสาย)', invConvLabel, 'full'],
                      ['Min Stock', viewItem.minQty ? `${viewItem.minQty} ${viewItem.minUnit === 'use' ? invUnitUseDef : viewItem.minUnit === 'sub' ? invUnitSubDef : invUnitBuy}` : '0'],
                      ['Max Stock', viewItem.maxQty ? `${viewItem.maxQty} ${viewItem.maxUnit === 'use' ? invUnitUseDef : viewItem.maxUnit === 'sub' ? invUnitSubDef : invUnitBuy}` : '0'],
                      ['ติดตามของเสีย', viewItem.wasteMode ? '✅ เปิด' : '❌ ปิด', 'full'],
                    ].map(([label, val, span], ri) => (
                      <div key={label} style={{
                        gridColumn: span === 'full' ? 'span 2' : 'span 1',
                        padding: '9px 14px',
                        borderTop: '1px solid #F3F4F6',
                        borderRight: (ri % 2 === 0 && span !== 'full') ? '1px solid #F3F4F6' : 'none',
                      }}>
                        <div style={{ fontSize: 10, color: '#8E8E93', fontWeight: 600, marginBottom: 3, textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
                        <div style={{ fontWeight: 600, color: '#1C1C1E', fontSize: 13 }}>{val}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* ── ส่วนที่ 2: ข้อมูลจาก Cost Manager (CM-style card) ── */}
                {(() => {
                  if (!cmItem) return (
                    <div style={{ background: '#F9FAFB', borderRadius: 12, border: '1.5px dashed var(--border2)',
                      padding: 14, textAlign: 'center', fontSize: 12, color: 'var(--txt3)' }}>
                      <div style={{ fontSize: 16, marginBottom: 4 }}>🧮</div>
                      ไม่พบวัตถุดิบ <strong>"{viewItem.name}"</strong> ใน Cost Manager<br />
                      <span style={{ fontSize: 11 }}>ชื่อต้องตรงกันทุกตัวอักษร</span>
                    </div>
                  )

                  // คำนวณราคาต่อหน่วยแต่ละ level
                  const lvs = cmItem.levels || []
                  const baseTotal = (cmItem.basePrice || cmItem.total || 0) + (cmItem.freight || 0)
                  // cumulativeQty[i] = จำนวน level[i] ต่อ 1 ลัง
                  const cumQty = lvs.map((_, i) => {
                    if (i === 0) return 1
                    return lvs.slice(1, i + 1).reduce((acc, l) => acc * (l.qty || 1), 1)
                  })
                  // pricePerUnit[i] = ราคาต่อ 1 หน่วย level[i]
                  const pricePerUnit = lvs.map((_, i) => {
                    if (i === lvs.length - 1 && cmItem.unitPrice) return cmItem.unitPrice
                    return cumQty[i] > 0 ? baseTotal / cumQty[i] : 0
                  })

                  // หน่วยที่เลือก (default = last level = หน่วยใช้)
                  const selIdx = (() => {
                    if (viewCutUnit === null) return lvs.length > 1 ? lvs.length - 1 : 0
                    const found = lvs.findIndex(l => l.name === viewCutUnit)
                    return found >= 0 ? found : lvs.length - 1
                  })()
                  const selLv = lvs[selIdx] || { name: cmItem.unit || '', qty: 1 }
                  const selPrice = pricePerUnit[selIdx] || 0
                  const selCumQty = cumQty[selIdx] || 1

                  // White-Red minimal palette
                  const IOS = {
                    bg: '#FFF5F5',           // light red tint bg
                    card: '#FFFFFF',          // card bg
                    sep: '#FFE4E6',           // rose separator
                    label: '#9F6E71',         // muted rose label
                    title: '#1C1C1E',         // primary label
                    blue: '#FF3B30',          // use red as accent (brand)
                    red: '#FF3B30',           // system red
                    green: '#34C759',         // system green
                    orange: '#FF9500',        // system orange
                    fill: '#FFF1F2',          // rose fill
                    accent: '#FF3B30',        // main accent
                    accentBg: '#FFF1F2',      // accent bg tint
                    accentBorder: '#FECDD3',  // accent border
                  }

                  return (
                    <div style={{ background: IOS.bg, borderRadius: 16, overflow: 'hidden',
                      border: `1px solid ${IOS.accentBorder}`,
                      boxShadow: '0 1px 4px rgba(255,59,48,0.08), 0 2px 8px rgba(0,0,0,0.04)' }}>

                      {/* Header */}
                      <div style={{ background: IOS.card, padding: '12px 16px',
                        borderBottom: `1px solid ${IOS.sep}`,
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ width: 28, height: 28, borderRadius: 8,
                            background: 'linear-gradient(135deg,#FF3B30,#FF6B6B)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14 }}>
                            🧮
                          </div>
                          <span style={{ fontFamily: 'Prompt', fontWeight: 600, fontSize: 13, color: IOS.title }}>
                            Cost Manager
                          </span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          {cmItem.updatedAt && (
                            <span style={{ fontSize: 11, color: IOS.label }}>{cmItem.updatedAt}</span>
                          )}
                          <span style={{ fontSize: 11, background: IOS.accentBg, color: IOS.accent,
                            border: `1px solid ${IOS.accentBorder}`, borderRadius: 20,
                            padding: '2px 8px', fontWeight: 600 }}>อ่านอย่างเดียว</span>
                        </div>
                      </div>

                      <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>

                        {/* Unit chain — iOS grouped row style */}
                        {lvs.length > 1 && (
                          <div style={{ background: IOS.card, borderRadius: 12,
                            boxShadow: '0 1px 3px rgba(0,0,0,0.06)', overflow: 'hidden' }}>
                            <div style={{ padding: '8px 14px 4px', fontSize: 11, color: IOS.label,
                              fontWeight: 600, letterSpacing: 0.3, textTransform: 'uppercase' }}>
                              หน่วยบรรจุ
                            </div>
                            {lvs.slice(1).map((lv, i) => {
                              const prev = lvs[i]
                              return (
                                <div key={i} style={{ display: 'flex', alignItems: 'center',
                                  padding: '9px 14px', gap: 10,
                                  borderTop: i > 0 ? `1px solid ${IOS.sep}` : 'none' }}>
                                  {/* left pill */}
                                  <div style={{ background: IOS.fill, borderRadius: 8,
                                    padding: '4px 10px', fontSize: 13, fontWeight: 600, color: IOS.title }}>
                                    1 {prev.name}
                                  </div>
                                  {/* arrow */}
                                  <span style={{ color: IOS.label, fontSize: 12, fontWeight: 300 }}>→</span>
                                  {/* right pill */}
                                  <div style={{ background: IOS.accentBg, borderRadius: 8,
                                    padding: '4px 12px', fontSize: 13, fontWeight: 700, color: IOS.accent,
                                    border: `1px solid ${IOS.accentBorder}` }}>
                                    {lv.qty?.toLocaleString()} {lv.name}
                                  </div>
                                </div>
                              )
                            })}
                            {/* Freight / Waste footer */}
                            {(cmItem.freight > 0 || cmItem.waste > 0) && (
                              <div style={{ padding: '6px 14px 8px', borderTop: `1px solid ${IOS.sep}`,
                                display: 'flex', gap: 14, fontSize: 11, color: IOS.label }}>
                                {cmItem.freight > 0 && <span>🚚 ขนส่ง ฿{cmItem.freight}</span>}
                                {cmItem.waste > 0 && <span>♻️ Waste {cmItem.waste}%</span>}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Unit selector — iOS segmented-like */}
                        {lvs.length > 1 && (
                          <div style={{ background: IOS.card, borderRadius: 12,
                            boxShadow: '0 1px 3px rgba(0,0,0,0.06)', padding: '10px 14px' }}>
                            <div style={{ fontSize: 11, color: IOS.label, fontWeight: 600,
                              letterSpacing: 0.3, textTransform: 'uppercase', marginBottom: 8 }}>
                              หน่วยที่ใช้ตัดสต็อก
                            </div>
                            <div style={{ display: 'flex', background: IOS.fill, borderRadius: 9, padding: 3, gap: 2 }}>
                              {lvs.map((lv, i) => (
                                <button key={i} onClick={() => setViewCutUnit(lv.name)}
                                  style={{
                                    flex: 1, padding: '6px 4px', borderRadius: 7, fontSize: 12, fontWeight: 600,
                                    cursor: 'pointer', border: 'none', transition: 'all 0.18s',
                                    background: selIdx === i ? IOS.card : 'transparent',
                                    color: selIdx === i ? IOS.title : IOS.label,
                                    boxShadow: selIdx === i ? '0 1px 4px rgba(0,0,0,0.12)' : 'none',
                                  }}>
                                  {lv.name}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Price cards — 2 columns */}
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                          {/* ราคาต่อหน่วย */}
                          <div style={{ background: IOS.card, borderRadius: 12, padding: '12px 14px',
                            boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                            <div style={{ fontSize: 11, color: IOS.label, fontWeight: 600, marginBottom: 6 }}>
                              ราคาต่อหน่วย
                            </div>
                            <div style={{ fontFamily: 'Prompt', fontWeight: 700,
                              color: IOS.red, fontSize: 24, lineHeight: 1, letterSpacing: -0.5 }}>
                              {Number(selPrice.toFixed(2)).toLocaleString('th-TH', { minimumFractionDigits: 2 })}
                            </div>
                            <div style={{ fontSize: 12, color: IOS.label, marginTop: 4 }}>
                              ฿ / {selLv.name}
                            </div>
                          </div>
                          {/* ราคาซื้อ */}
                          <div style={{ background: IOS.card, borderRadius: 12, padding: '12px 14px',
                            boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                            <div style={{ fontSize: 11, color: IOS.label, fontWeight: 600, marginBottom: 6 }}>
                              ราคาซื้อ
                            </div>
                            <div style={{ fontFamily: 'Prompt', fontWeight: 700,
                              color: IOS.title, fontSize: 17, lineHeight: 1.2 }}>
                              {(cmItem.basePrice || cmItem.total || 0).toLocaleString('th-TH', { minimumFractionDigits: 2 })} ฿
                            </div>
                            <div style={{ fontSize: 11, color: IOS.label, marginTop: 4 }}>
                              ต่อ 1 {lvs[0]?.name || ''}
                              {selCumQty > 1 && <div>= {selCumQty.toLocaleString()} {selLv.name}</div>}
                            </div>
                          </div>
                        </div>

                        {/* Serving unit */}
                        {cmItem.servingUnit && (
                          <div style={{ background: IOS.card, borderRadius: 12, padding: '10px 14px',
                            boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
                            display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontSize: 16 }}>🥄</span>
                            <span style={{ fontSize: 12, color: IOS.label, flex: 1 }}>
                              1 {cmItem.servingUnit.name} = {cmItem.servingUnit.qty} {selLv.name}
                            </span>
                            <span style={{ fontFamily: 'Prompt', fontWeight: 700, color: IOS.orange, fontSize: 14 }}>
                              ฿{Number((cmItem.servingUnit.costPerServe || 0).toFixed(2)).toLocaleString('th-TH', { minimumFractionDigits: 2 })}
                            </span>
                          </div>
                        )}

                        {/* Verification — iOS list rows */}
                        <div style={{ background: IOS.card, borderRadius: 12,
                          boxShadow: '0 1px 3px rgba(0,0,0,0.06)', overflow: 'hidden' }}>
                          {/* Header row */}
                          <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr 1fr auto',
                            padding: '7px 14px', background: IOS.fill,
                            borderBottom: `1px solid ${IOS.sep}` }}>
                            <span style={{ fontSize: 10, color: IOS.label, fontWeight: 700, textTransform: 'uppercase' }}></span>
                            <span style={{ fontSize: 10, color: '#1C1C1E', fontWeight: 700, textAlign: 'center' }}>Inventory</span>
                            <span style={{ fontSize: 10, color: IOS.accent, fontWeight: 700, textAlign: 'center' }}>Cost Manager</span>
                            <span></span>
                          </div>
                          {[
                            { label: 'หน่วยที่ 1', inv: invUnitBuy,    cm: cmUnitBuy,    badge: true },
                            { label: 'หน่วยที่ 2', inv: invUnitUseDef, cm: cmUnitUseDef, badge: true },
                            { label: 'หน่วยที่ 3', inv: invUnitSubDef, cm: cmUnitSubDef, badge: true },
                            { label: 'อัตราแปลง',  inv: invConvLabel,  cm: cmConvLabel,  badge: true },
                            // ── cut unit (info — เลือกเองได้ ไม่ใช่ mismatch) ──
                            { label: '🎯 ตัดสต็อก', inv: invCutUnit, cm: cmCutUnit, badge: false,
                              info: 'เลือกได้ใน Inventory · CM = default' },
                          ].map(({ label, inv, cm, badge, info }) => (
                            <div key={label} style={{ display: 'grid', gridTemplateColumns: '90px 1fr 1fr auto',
                              alignItems: 'center', gap: 4,
                              padding: '10px 14px', borderTop: `1px solid ${IOS.sep}` }}>
                              <span style={{ fontSize: 11, color: IOS.label, fontWeight: 600 }}>{label}</span>
                              <span style={{ fontSize: 12, fontWeight: 600, color: '#1C1C1E', textAlign: 'center' }}>{inv || '—'}</span>
                              <span style={{ fontSize: 12, fontWeight: 600, color: IOS.accent, textAlign: 'center' }}>{cm || '—'}</span>
                              <span style={{ textAlign: 'right' }}>
                                {badge
                                  ? matchBadge(inv, cm)
                                  : (
                                    <span title={info || ''} style={{ fontSize: 10, background: '#EFF6FF',
                                      color: '#1D4ED8', border: '1px solid #BFDBFE', borderRadius: 20,
                                      padding: '2px 8px', fontWeight: 700, whiteSpace: 'nowrap' }}>
                                      ℹ เลือกได้
                                    </span>
                                  )
                                }
                              </span>
                            </div>
                          ))}
                        </div>

                        {/* Footer note */}
                        <div style={{ fontSize: 11, color: IOS.label, textAlign: 'center', paddingBottom: 2 }}>
                          ต้องการแก้ไข → <span style={{ color: IOS.accent, fontWeight: 600 }}>Cost Manager → คลังวัตถุดิบ</span>
                        </div>

                      </div>
                    </div>
                  )
                })()}
              </div>
            )
          })()}

          {/* Info: เพิ่ม / แก้ items ทำที่ Cost Manager → Sync */}
          {isOwner() && !editItem && !showAddForm && (
            <div style={{ background: '#EFF6FF', border: '1px solid #BFDBFE',
              borderRadius: 10, padding: '10px 14px', fontSize: 11, color: '#1D4ED8',
              display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 14 }}>💡</span>
              <span>
                ต้องการเพิ่ม/แก้วัตถุดิบ → ไปที่ <strong>Cost Manager → คลังวัตถุดิบ</strong> แล้วกด
                <strong> 🔄 Update จาก Cost Manager </strong>ในหน้านี้
              </span>
            </div>
          )}

          {/* Edit/Add Form (collapsible) */}
          {(editItem || showAddForm) && isOwner() && (() => {
            // ดึงราคาต่อหน่วยจาก CM สำหรับ waste
            const cmItem = cmLibrary.find(ci => ci.name === itemForm.name)
            const cmPrice = cmItem?.price || 0
            const convBU = parseFloat(itemForm.convBuyToUse) || 1
            const convUS = parseFloat(itemForm.convUseToSub) || 1
            const pricePerUse = convBU > 0 ? cmPrice / convBU : 0
            const pricePerSub = convBU > 0 && convUS > 0 ? cmPrice / convBU / convUS : 0

            return (
              <div style={{ background: '#fff', borderRadius: 12, border: '1.5px solid var(--border2)', padding: 14,
                display: 'flex', flexDirection: 'column', gap: 12 }}>

                <div style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 14, color: editItem ? 'var(--red)' : 'var(--txt)' }}>
                  {editItem ? `✏️ แก้ไข: ${editItem.displayName || editItem.name}` : '➕ เพิ่มวัตถุดิบใหม่'}
                </div>

                {/* Name */}
                <div>
                  <label className="fi-label">ชื่อ (ตรงกับ Cost Manager) <span style={{ color: '#8E8E93', fontWeight: 400 }}>— ใช้ link ข้อมูล</span></label>
                  <input className="fi" value={itemForm.name} onChange={e => setItemForm(f => ({ ...f, name: e.target.value }))} placeholder="เช่น แยมสตรอว์เบอร์รี" />
                </div>

                {/* Display Name */}
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                    <label className="fi-label" style={{ marginBottom: 0 }}>ชื่อที่แสดง (ชื่อเล่น) <span style={{ color: '#8E8E93', fontWeight: 400 }}>— ไม่บังคับ</span></label>
                    {itemForm.displayName && (
                      <button onClick={() => setItemForm(f => ({ ...f, displayName: '' }))}
                        style={{ fontSize: 11, color: '#8E8E93', background: '#F2F2F7', border: 'none',
                          borderRadius: 6, padding: '2px 8px', cursor: 'pointer', fontFamily: 'Sarabun' }}>
                        ✕ ใช้ชื่อเดียวกับ CM
                      </button>
                    )}
                  </div>
                  <input className="fi" value={itemForm.displayName}
                    onChange={e => setItemForm(f => ({ ...f, displayName: e.target.value }))}
                    placeholder={`ค่าเริ่มต้น: ${itemForm.name || 'ชื่อ CM'} (เว้นว่างเพื่อใช้ชื่อ CM)`} />
                  {itemForm.displayName && (
                    <div style={{ fontSize: 11, color: '#8E8E93', marginTop: 4 }}>
                      แสดงเป็น: <strong style={{ color: '#1C1C1E' }}>{itemForm.displayName}</strong> · link ข้อมูลจาก: <strong>{itemForm.name || '—'}</strong>
                    </div>
                  )}
                </div>

                {/* Category + Emoji */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10 }}>
                  <div>
                    <label className="fi-label">หมวดหมู่</label>
                    <select className="fi" value={itemForm.category} onChange={e => setItemForm(f => ({ ...f, category: e.target.value }))}>
                      {cats.map(c => <option key={c.id} value={c.name}>{c.emoji} {c.name}</option>)}
                    </select>
                  </div>
                  <div style={{ gridColumn: 'span 2' }}>
                    <label className="fi-label">Emoji</label>
                    {/* Preview — กดเพื่อเปิด/ปิด picker */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: emojiGroup !== null ? 8 : 0 }}>
                      <button onClick={() => setEmojiGroup(g => g === null ? 0 : null)}
                        style={{ width: 52, height: 52, borderRadius: 14, background: '#FFF1F2',
                          border: emojiGroup !== null ? '2px solid var(--red)' : '2px dashed #FECDD3',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 30, cursor: 'pointer', flexShrink: 0, transition: 'all .15s' }}>
                        {itemForm.img}
                      </button>
                      <span style={{ fontSize: 11, color: '#8E8E93' }}>
                        {emojiGroup !== null ? 'กดที่ emoji เพื่อเลือก · กดกล่องซ้ายเพื่อปิด' : 'กดกล่องซ้ายเพื่อเลือก Emoji'}
                      </span>
                    </div>
                    {/* Picker — แสดงเมื่อ emojiGroup !== null */}
                    {emojiGroup !== null && (
                      <>
                        <div style={{ display: 'flex', gap: 4, overflowX: 'auto', scrollbarWidth: 'none',
                          marginBottom: 6, paddingBottom: 2 }}>
                          {EMOJI_GROUPS.map((g, gi) => (
                            <button key={gi} onClick={() => setEmojiGroup(gi)}
                              style={{ flexShrink: 0, border: 'none', borderRadius: 8, padding: '4px 10px',
                                fontSize: 12, fontWeight: 600, cursor: 'pointer', transition: 'all 0.12s',
                                background: emojiGroup === gi ? '#FF3B30' : '#F2F2F7',
                                color: emojiGroup === gi ? '#fff' : '#636366' }}>
                              {g.label}
                            </button>
                          ))}
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 4,
                          background: '#F9FAFB', borderRadius: 12, padding: 8,
                          border: '1px solid #E5E5EA', maxHeight: 160, overflowY: 'auto' }}>
                          {EMOJI_GROUPS[emojiGroup].emojis.map(em => (
                            <button key={em} onClick={() => { setItemForm(f => ({ ...f, img: em })); setEmojiGroup(null) }}
                              title={em}
                              style={{ border: 'none', borderRadius: 8, padding: '6px 2px',
                                fontSize: 20, cursor: 'pointer', lineHeight: 1, transition: 'all 0.1s',
                                background: itemForm.img === em ? '#FF3B30' : 'transparent',
                                transform: itemForm.img === em ? 'scale(1.15)' : 'scale(1)' }}>
                              {em}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                </div>

                {/* 3 Units — datalist จากข้อมูลที่มีอยู่ */}
                {(() => {
                  const allUnits = [...new Set(
                    items.flatMap(i => [i.unitBuy||i.unitBase, i.unitUse, i.unitSub].filter(Boolean))
                  )].sort()
                  const unitFields = [
                    { key: 'unitBuy', label: 'หน่วยที่ 1', sub: 'ใหญ่สุด', ph: 'ลัง' },
                    { key: 'unitUse', label: 'หน่วยที่ 2', sub: 'กลาง', ph: 'กระป๋อง / ใบ' },
                    { key: 'unitSub', label: 'หน่วยที่ 3', sub: 'เล็กสุด · ของเสีย', ph: 'กรัม / มล. (ถ้ามี)' },
                  ]
                  return (
                    <div>
                      <label className="fi-label">หน่วย (สูงสุด 3 ระดับ)</label>
                      <datalist id="unit-list">
                        {allUnits.map(u => <option key={u} value={u} />)}
                      </datalist>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                        {unitFields.map(({ key, label, sub, ph }) => (
                          <div key={key}>
                            <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, marginBottom: 3 }}>
                              <span style={{ fontSize: 11, color: 'var(--txt2)', fontWeight: 700 }}>{label}</span>
                              <span style={{ fontSize: 9, color: 'var(--txt3)' }}>{sub}</span>
                            </div>
                            <input list="unit-list" className="fi"
                              value={itemForm[key]}
                              onChange={e => setItemForm(f => ({ ...f, [key]: e.target.value }))}
                              placeholder={ph} style={{ padding: '7px 10px' }} />
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })()}

                {/* Conversion */}
                <div>
                  <label className="fi-label">อัตราส่วนการแปลงหน่วย</label>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {/* Buy → Use */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg)', borderRadius: 9, padding: '8px 12px' }}>
                      <span style={{ fontSize: 12, color: 'var(--txt2)', whiteSpace: 'nowrap', minWidth: 30 }}>1 {itemForm.unitBuy || 'หน่วยซื้อ'} =</span>
                      <input type="number" className="fi" value={itemForm.convBuyToUse}
                        onChange={e => setItemForm(f => ({ ...f, convBuyToUse: e.target.value }))}
                        placeholder="0" style={{ width: 70, padding: '5px 8px', textAlign: 'right' }} />
                      <span style={{ fontSize: 12, color: 'var(--txt2)' }}>{itemForm.unitUse || 'หน่วยใช้'}</span>
                    </div>
                    {/* Use → Sub */}
                    {itemForm.unitSub && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg)', borderRadius: 9, padding: '8px 12px' }}>
                        <span style={{ fontSize: 12, color: 'var(--txt2)', whiteSpace: 'nowrap', minWidth: 30 }}>1 {itemForm.unitUse || 'หน่วยใช้'} =</span>
                        <input type="number" className="fi" value={itemForm.convUseToSub}
                          onChange={e => setItemForm(f => ({ ...f, convUseToSub: e.target.value }))}
                          placeholder="0" style={{ width: 70, padding: '5px 8px', textAlign: 'right' }} />
                        <span style={{ fontSize: 12, color: 'var(--txt2)' }}>{itemForm.unitSub}</span>
                      </div>
                    )}
                    {/* Summary */}
                    {itemForm.convBuyToUse && itemForm.unitBuy && itemForm.unitUse && (
                      <div style={{ fontSize: 11, color: 'var(--txt3)', paddingLeft: 4 }}>
                        📝 1 {itemForm.unitBuy} = {itemForm.convBuyToUse} {itemForm.unitUse}
                        {itemForm.unitSub && itemForm.convUseToSub ? ` = ${(parseFloat(itemForm.convBuyToUse||0)*parseFloat(itemForm.convUseToSub||0)).toFixed(0)} ${itemForm.unitSub}` : ''}
                      </div>
                    )}
                  </div>
                </div>

                {/* ── 🎯 Role Selector: ตัดสต็อก + ของเสีย ── */}
                {(() => {
                  const opts = [
                    { val: 'buy', label: itemForm.unitBuy, slot: 'หน่วยที่ 1', disabled: !itemForm.unitBuy },
                    { val: 'use', label: itemForm.unitUse, slot: 'หน่วยที่ 2', disabled: !itemForm.unitUse },
                    { val: 'sub', label: itemForm.unitSub, slot: 'หน่วยที่ 3',
                      disabled: !itemForm.unitSub || !itemForm.convUseToSub },
                  ]
                  const renderRow = (icon, label, field, defaultVal, themeColor) => (
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                        <span style={{ fontSize: 13 }}>{icon}</span>
                        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--txt2)' }}>{label}</span>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
                        {opts.map(opt => {
                          const active = (itemForm[field] || defaultVal) === opt.val
                          return (
                            <button key={opt.val} disabled={opt.disabled}
                              onClick={() => !opt.disabled && setItemForm(f => ({ ...f, [field]: opt.val }))}
                              style={{
                                padding: '8px 4px', borderRadius: 9,
                                border: `2px solid ${active ? themeColor : 'var(--border)'}`,
                                background: active ? themeColor + '15' : (opt.disabled ? '#F9FAFB' : '#fff'),
                                cursor: opt.disabled ? 'not-allowed' : 'pointer',
                                opacity: opt.disabled ? 0.5 : 1,
                                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1,
                              }}>
                              <span style={{ fontSize: 12, fontWeight: 700,
                                color: active ? themeColor : 'var(--txt)' }}>
                                {opt.label || '—'}
                              </span>
                              <span style={{ fontSize: 9, color: active ? themeColor : 'var(--txt3)' }}>
                                {opt.slot}
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10,
                      background: 'var(--bg)', borderRadius: 10, padding: 10 }}>
                      {renderRow('✂️', 'ใช้ตัดสต็อก', 'cutLevel',   'use', '#E31E24')}
                      {renderRow('🗑️', 'ใช้คำนวณของเสีย', 'wasteLevel', 'sub', '#D97706')}
                      <div style={{ fontSize: 10, color: 'var(--txt3)', lineHeight: 1.4, paddingTop: 4,
                        borderTop: '1px dashed var(--border)' }}>
                        💡 <strong>ตัดสต็อก</strong>: หน่วยที่เก็บ qty ใน stock_balances · <strong>ของเสีย</strong>: หน่วย default ในฟอร์มบันทึกของเสีย
                      </div>
                    </div>
                  )
                })()}

                {/* 🔔 Alert toggle — ปิดได้กรณีของหมดซีซั่น/เลิกใช้ */}
                <div style={{
                  background: itemForm.alertEnabled ? '#F0FDF4' : '#F3F4F6',
                  border: `1.5px solid ${itemForm.alertEnabled ? '#86EFAC' : '#D1D5DB'}`,
                  borderRadius: 12, padding: '12px 14px',
                  display: 'flex', alignItems: 'center', gap: 10 }}>
                  <button className={`toggle${itemForm.alertEnabled ? ' on' : ''}`}
                    onClick={() => setItemForm(f => ({ ...f, alertEnabled: !f.alertEnabled }))} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 700,
                      color: itemForm.alertEnabled ? '#15803D' : '#6B7280' }}>
                      🔔 แจ้งเตือนของหมด/เหลือน้อย
                    </div>
                    <div style={{ fontSize: 11, color: itemForm.alertEnabled ? '#15803D' : '#9CA3AF', marginTop: 2 }}>
                      {itemForm.alertEnabled
                        ? 'เปิดอยู่ — มีการตั้ง Min/Max'
                        : '🔒 ปิดอยู่ — Min/Max ถูก lock (เช่น ของหมดซีซั่น)'}
                    </div>
                  </div>
                </div>

                {/* Min / Max Stock — Tab Sheet per warehouse */}
                {(() => {
                  const activeWhs = warehouses.filter(wh => wh.active !== false)
                  if (activeWhs.length === 0) return null
                  const tabId = activeWhLimitTab || activeWhs[0]?.id
                  const activeWh = activeWhs.find(w => w.id === tabId) || activeWhs[0]
                  const lim = itemForm.stockLimits?.[activeWh?.id] || {}
                  const locked = !itemForm.alertEnabled
                  const setLim = (field, val) => setItemForm(f => ({
                    ...f,
                    stockLimits: { ...f.stockLimits, [activeWh.id]: { ...(f.stockLimits?.[activeWh.id] || {}), [field]: val } }
                  }))
                  const unitOpts = [
                    itemForm.unitBuy ? { val: 'buy', label: itemForm.unitBuy } : null,
                    itemForm.unitUse && itemForm.unitUse !== itemForm.unitBuy ? { val: 'use', label: itemForm.unitUse } : null,
                    itemForm.unitSub && !isWeightVolUnit(itemForm.unitSub) ? { val: 'sub', label: itemForm.unitSub } : null,
                  ].filter(Boolean)
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 0,
                      border: '1.5px solid var(--border)', borderRadius: 12, overflow: 'hidden',
                      opacity: locked ? 0.55 : 1,
                      pointerEvents: locked ? 'none' : 'auto',
                      filter: locked ? 'grayscale(0.6)' : 'none',
                      transition: 'opacity .15s, filter .15s' }}>
                      {/* Tab bar */}
                      <div style={{ display: 'flex', borderBottom: '1.5px solid var(--border)', background: 'var(--bg)' }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--txt2)', padding: '8px 10px', whiteSpace: 'nowrap', borderRight: '1.5px solid var(--border)', display: 'flex', alignItems: 'center' }}>
                          {locked ? '🔒' : '📉📈'}
                        </div>
                        {activeWhs.map(wh => {
                          const isActive = wh.id === (activeWhLimitTab || activeWhs[0]?.id)
                          const hasVal = (itemForm.stockLimits?.[wh.id]?.minQty || itemForm.stockLimits?.[wh.id]?.maxQty)
                          return (
                            <button key={wh.id} onClick={() => setActiveWhLimitTab(wh.id)}
                              style={{ flex: 1, border: 'none', cursor: 'pointer', padding: '8px 6px',
                                background: isActive ? '#fff' : 'transparent',
                                borderBottom: isActive ? '2px solid ' + (wh.color || 'var(--red)') : '2px solid transparent',
                                marginBottom: -1,
                                fontFamily: 'Sarabun', fontSize: 11, fontWeight: isActive ? 700 : 500,
                                color: isActive ? (wh.color || 'var(--red)') : 'var(--txt3)',
                                transition: 'all .15s', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                              {wh.name}
                              {hasVal ? <span style={{ width: 6, height: 6, borderRadius: '50%', background: wh.color || 'var(--red)', display: 'inline-block' }} /> : null}
                            </button>
                          )
                        })}
                      </div>
                      {/* Tab content */}
                      <div style={{ padding: '12px 12px', background: '#fff', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                        {[['minQty','minUnit','📉 Min','#FFF7ED','#C2410C'], ['maxQty','maxUnit','📈 Max','#F0FDF4','#15803D']].map(([qf,uf,lab,bg,col]) => (
                          <div key={qf} style={{ background: bg, borderRadius: 9, padding: '8px 10px' }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color: col, marginBottom: 5 }}>{lab}</div>
                            <input type="number" value={lim[qf] ?? ''}
                              onChange={e => setLim(qf, e.target.value)}
                              placeholder="0"
                              style={{ width: '100%', border: '1.5px solid ' + col + '55', borderRadius: 7,
                                padding: '6px 8px', fontSize: 16, fontFamily: 'Prompt', fontWeight: 700,
                                color: col, background: '#fff', outline: 'none', marginBottom: 5,
                                boxSizing: 'border-box', textAlign: 'center' }} />
                            <select value={lim[uf] || (unitOpts[0]?.val || 'buy')}
                              onChange={e => setLim(uf, e.target.value)}
                              style={{ width: '100%', border: '1.5px solid ' + col + '55', borderRadius: 7,
                                padding: '5px 8px', fontSize: 12, fontFamily: 'Sarabun', fontWeight: 600,
                                color: col, background: '#fff', outline: 'none' }}>
                              {unitOpts.map(o => <option key={o.val} value={o.val}>{o.label}</option>)}
                            </select>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })()}

                {/* Inventory Sub-Unit Toggle */}
                {itemForm.unitSub && (
                  <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                    {isWeightVolUnit(itemForm.unitSub) ? (
                      <div style={{ background: '#F0F9FF', borderRadius: 10, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: 16 }}>⚖️</span>
                          <span style={{ fontSize: 12, color: '#0369A1', fontWeight: 600 }}>
                            ระบบตรวจพบ "{itemForm.unitSub}" เป็นหน่วยชั่ง/ตวง
                          </span>
                        </div>
                        <div style={{ fontSize: 11.5, color: '#0284C7', lineHeight: 1.5 }}>
                          Inventory จะใช้ <strong>{itemForm.unitUse || 'หน่วยใช้'}</strong> เป็นหน่วยฐาน (ซ่อน {itemForm.unitSub} อัตโนมัติ)
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 2 }}>
                          <button className={`toggle${itemForm.showSubInInventory ? ' on' : ''}`}
                            onClick={() => setItemForm(f => ({ ...f, showSubInInventory: !f.showSubInInventory }))} />
                          <span style={{ fontSize: 12, color: '#0369A1' }}>
                            {itemForm.showSubInInventory
                              ? `✅ แสดง "${itemForm.unitSub}" ใน Inventory (override)`
                              : `แสดง "${itemForm.unitSub}" ใน Inventory (ปิดอยู่)`}
                          </span>
                        </div>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ fontSize: 16 }}>📦</span>
                        <span style={{ fontSize: 12, color: 'var(--txt2)' }}>
                          "{itemForm.unitSub}" เป็นหน่วยนับ — แสดงใน Inventory อัตโนมัติ
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {/* Per-warehouse visibility */}
                <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>👁️ แสดงในคลัง/สาขา</span>
                    <span style={{ fontSize: 10, color: '#8E8E93', fontWeight: 400 }}>เลือกว่าจะแสดงที่ไหนบ้าง</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 0, borderRadius: 10,
                    border: '1px solid var(--border)', overflow: 'hidden' }}>
                    {warehouses.filter(wh => wh.active !== false).map((wh, wi, arr) => {
                      const isVisible = itemForm.visibleIn?.[wh.id] !== false
                      return (
                        <div key={wh.id} style={{
                          display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
                          borderBottom: wi < arr.length - 1 ? '1px solid var(--border)' : 'none',
                          background: isVisible ? '#fff' : '#FAFAFA',
                        }}>
                          <div style={{ width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
                            background: wh.color || '#8E8E93', opacity: isVisible ? 1 : 0.35 }} />
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 13, fontWeight: 600,
                              color: isVisible ? '#1C1C1E' : '#9CA3AF' }}>{wh.name}</div>
                            <div style={{ fontSize: 10, color: isVisible ? '#15803D' : '#DC2626' }}>
                              {isVisible ? 'แสดงใน คลัง + ตัดสต็อก' : 'ซ่อน (ข้อมูลยังอยู่)'}
                            </div>
                          </div>
                          <button className={`toggle${isVisible ? ' on' : ''}`}
                            onClick={() => setItemForm(f => ({
                              ...f,
                              visibleIn: { ...(f.visibleIn || {}), [wh.id]: !isVisible }
                            }))} />
                        </div>
                      )
                    })}
                    {warehouses.filter(wh => wh.active !== false).length === 0 && (
                      <div style={{ padding: 12, fontSize: 12, color: '#9CA3AF', textAlign: 'center' }}>
                        ไม่มีคลัง/สาขาที่เปิดใช้งาน
                      </div>
                    )}
                  </div>
                  {/* Summary badge */}
                  {(() => {
                    const activeWhs = warehouses.filter(wh => wh.active !== false)
                    const hiddenCount = activeWhs.filter(wh => itemForm.visibleIn?.[wh.id] === false).length
                    if (hiddenCount === 0) return null
                    return (
                      <div style={{ fontSize: 11, color: '#DC2626', marginTop: 6, paddingLeft: 2 }}>
                        ⚠️ ซ่อนจาก {hiddenCount} คลัง/สาขา
                      </div>
                    )
                  })()}
                </div>

                {/* Waste Mode */}
                <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: itemForm.wasteMode ? 10 : 0 }}>
                    <button className={`toggle${itemForm.wasteMode ? ' on' : ''}`}
                      onClick={() => setItemForm(f => ({ ...f, wasteMode: !f.wasteMode }))} />
                    <span style={{ fontSize: 13, fontWeight: 600 }}>🗑️ ติดตามของเสีย (Waste Mode)</span>
                  </div>
                  {itemForm.wasteMode && (
                    <div style={{ background: '#FFF7ED', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div>
                        <label className="fi-label">หน่วยบันทึกของเสีย</label>
                        <select className="fi" value={itemForm.wasteUnit}
                          onChange={e => setItemForm(f => ({ ...f, wasteUnit: e.target.value }))}>
                          {itemForm.unitBuy && <option value="buy">{itemForm.unitBuy}</option>}
                          {itemForm.unitUse && <option value="use">{itemForm.unitUse}</option>}
                          {itemForm.unitSub && <option value="sub">{itemForm.unitSub}</option>}
                        </select>
                      </div>
                      {cmPrice > 0 && (
                        <div style={{ fontSize: 12, color: '#C2410C' }}>
                          <div style={{ fontWeight: 700, marginBottom: 4 }}>💰 ราคาต่อหน่วย (จาก Cost Manager)</div>
                          {itemForm.unitBuy && <div>1 {itemForm.unitBuy} = ฿{cmPrice.toFixed(2)}</div>}
                          {itemForm.unitUse && convBU > 0 && <div>1 {itemForm.unitUse} = ฿{pricePerUse.toFixed(2)}</div>}
                          {itemForm.unitSub && convBU > 0 && convUS > 0 && <div>1 {itemForm.unitSub} = ฿{pricePerSub.toFixed(2)}</div>}
                        </div>
                      )}
                      {!cmItem && itemForm.name && (
                        <div style={{ fontSize: 11, color: '#9A3412' }}>⚠️ ไม่พบราคาใน Cost Manager</div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          })()}

        </div>
      </Modal>

      {/* ── Modal: Quick Template ── */}
      <Modal open={tplModal}
        onClose={() => { setTplModal(false); setEditTpl(null); setTplForm({ name: '', icon: '☀️', items: [] }) }}
        title={editTpl ? `✏️ แก้ไข: ${editTpl.name}` : '⚡ Quick Template'}
        footer={
          editTpl ? (
            <div style={{ display: 'flex', gap: 8, width: '100%' }}>
              <button onClick={async () => {
                if (!confirm(`ลบ Template "${editTpl.name}"?`)) return
                await deleteDoc(doc(db, COL.QUICK_TEMPLATES, editTpl.id))
                setEditTpl(null); setTplForm({ name: '', icon: '☀️', items: [] })
                setToast('🗑️ ลบ Template แล้ว')
              }} style={{ background: '#FEF2F2', color: '#DC2626', border: 'none', borderRadius: 10,
                padding: '0 14px', fontSize: 18, cursor: 'pointer', flexShrink: 0 }}>🗑️</button>
              <button className="btn-secondary" style={{ flex: 1 }}
                onClick={() => { setEditTpl(null); setTplForm({ name: '', icon: '☀️', items: [] }) }}>← กลับ</button>
              <button className="btn-primary" style={{ flex: 2 }} onClick={saveTpl}>💾 บันทึก</button>
            </div>
          ) : (
            <button className="btn-primary" style={{ width: '100%' }} onClick={saveTpl} disabled={!tplForm.name}>
              ➕ สร้าง Template
            </button>
          )
        }>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

          {/* Template list (when not editing) */}
          {!editTpl && (
            <>
              {templates.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '12px 0', fontSize: 13, color: 'var(--txt3)' }}>
                  ยังไม่มี Template — สร้างด้านล่าง
                </div>
              ) : (
                <div style={{ borderRadius: 12, border: '1px solid var(--border)', overflow: 'hidden' }}>
                  {templates.map((t, idx) => (
                    <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
                      background: '#fff', borderBottom: idx < templates.length - 1 ? '1px solid var(--border)' : 'none' }}>
                      <span style={{ fontSize: 22, flexShrink: 0 }}>{t.icon}</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 700, fontSize: 13 }}>{t.name}</div>
                        <div style={{ fontSize: 11, color: 'var(--txt3)' }}>
                          {(t.items || []).map(it => {
                            const found = items.find(i => i.id === it.itemId)
                            return found ? `${found.name} ×${it.qty}` : null
                          }).filter(Boolean).join(' · ') || 'ยังไม่มีรายการ'}
                        </div>
                      </div>
                      <button onClick={() => {
                        setEditTpl(t)
                        setTplForm({ name: t.name, icon: t.icon, items: t.items || [] })
                      }} style={{ border: 'none', background: '#F2F2F7', borderRadius: 8,
                        width: 32, height: 32, fontSize: 14, cursor: 'pointer' }}>✏️</button>
                    </div>
                  ))}
                </div>
              )}

              <div style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 13, color: 'var(--txt2)',
                paddingTop: 4, borderTop: '1px solid var(--border)' }}>+ สร้าง Template ใหม่</div>
            </>
          )}

          {/* Form: ชื่อ + Icon */}
          <div>
            <label className="fi-label">ชื่อ Template</label>
            <input className="fi" value={tplForm.name}
              onChange={e => setTplForm(f => ({ ...f, name: e.target.value }))}
              placeholder="เช่น เปิดร้านเช้า" />
          </div>
          <div>
            <label className="fi-label">Icon</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {TPL_ICONS.map(ic => (
                <button key={ic} onClick={() => setTplForm(f => ({ ...f, icon: ic }))}
                  style={{ width: 40, height: 40, fontSize: 22,
                    border: tplForm.icon === ic ? '2.5px solid var(--red)' : '1.5px solid var(--border2)',
                    borderRadius: 10, background: tplForm.icon === ic ? '#FFF1F2' : 'var(--bg)', cursor: 'pointer',
                    transform: tplForm.icon === ic ? 'scale(1.1)' : 'scale(1)', transition: 'all .12s' }}>
                  {ic}
                </button>
              ))}
            </div>
          </div>

          {/* รายการวัตถุดิบ */}
          <div>
            <label className="fi-label">รายการวัตถุดิบ ({tplForm.items.length} รายการ)</label>

            {/* existing items in template */}
            {tplForm.items.length > 0 && (
              <div style={{ borderRadius: 10, border: '1px solid var(--border)', overflow: 'hidden', marginBottom: 8 }}>
                {tplForm.items.map((ti, idx) => {
                  const found = items.find(i => i.id === ti.itemId)
                  if (!found) return null
                  return (
                    <div key={ti.itemId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px',
                      background: '#fff', borderBottom: idx < tplForm.items.length - 1 ? '1px solid var(--border)' : 'none' }}>
                      <span style={{ fontSize: 16, flexShrink: 0 }}>{found.img || '📦'}</span>
                      <div style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{found.name}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <button onClick={() => setTplForm(f => ({ ...f, items: f.items.map(x => x.itemId === ti.itemId ? { ...x, qty: Math.max(1, x.qty - 1) } : x) }))}
                          style={{ width: 26, height: 26, border: 'none', borderRadius: 6, background: 'var(--bg)', fontSize: 16, cursor: 'pointer', fontWeight: 700 }}>−</button>
                        <span style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 14, minWidth: 24, textAlign: 'center' }}>{ti.qty}</span>
                        <button onClick={() => setTplForm(f => ({ ...f, items: f.items.map(x => x.itemId === ti.itemId ? { ...x, qty: x.qty + 1 } : x) }))}
                          style={{ width: 26, height: 26, border: 'none', borderRadius: 6, background: 'var(--bg)', fontSize: 16, cursor: 'pointer', fontWeight: 700 }}>+</button>
                        <span style={{ fontSize: 11, color: 'var(--txt3)', marginLeft: 2 }}>{found.unitUse}</span>
                      </div>
                      <button onClick={() => setTplForm(f => ({ ...f, items: f.items.filter(x => x.itemId !== ti.itemId) }))}
                        style={{ border: 'none', background: 'none', fontSize: 16, cursor: 'pointer', color: '#FF3B30', padding: '0 4px' }}>✕</button>
                    </div>
                  )
                })}
              </div>
            )}

            {/* add item picker */}
            <select onChange={e => {
              const id = e.target.value; if (!id) return
              setTplForm(f => ({
                ...f,
                items: f.items.find(x => x.itemId === id)
                  ? f.items
                  : [...f.items, { itemId: id, qty: 1 }]
              }))
              e.target.value = ''
            }} defaultValue=""
              style={{ width: '100%', padding: '8px 12px', borderRadius: 10, border: '1.5px dashed var(--border2)',
                fontFamily: 'Sarabun', fontSize: 13, background: 'var(--bg)', color: 'var(--txt2)', cursor: 'pointer' }}>
              <option value="">+ เพิ่มวัตถุดิบเข้า Template...</option>
              {items.filter(i => !tplForm.items.find(x => x.itemId === i.id))
                .map(i => <option key={i.id} value={i.id}>{i.img} {i.name} ({i.unitUse})</option>)}
            </select>
          </div>
        </div>
      </Modal>

      {/* ── Modal: Update จาก Cost Manager ── */}
      <Modal open={importModal} onClose={() => !importLoading && (setImportModal(false), setImportPhase('idle'))} title="🔄 Update จาก Cost Manager">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

          {/* กำลัง checking */}
          {importPhase === 'checking' && (
            <div style={{ textAlign: 'center', padding: '24px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
              <span style={{ display: 'inline-block', width: 28, height: 28, border: '3px solid #FF3B30',
                borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
              <div style={{ fontSize: 13, color: '#8E8E93' }}>กำลังตรวจสอบข้อมูลจาก Cost Manager...</div>
            </div>
          )}

          {/* error */}
          {importPhase === 'idle' && importStatus && (
            <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, padding: 12,
              fontSize: 13, color: '#DC2626' }}>{importStatus}</div>
          )}

          {/* Preview diff */}
          {(importPhase === 'preview' || importPhase === 'done') && importDiff && (() => {
            const { toAdd, toUpdate, total, lastSync } = importDiff
            const hasChanges = toAdd.length > 0 || toUpdate.length > 0
            return (
              <>
                {/* Summary header */}
                <div style={{ background: '#F2F2F7', borderRadius: 12, padding: '12px 14px',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ fontSize: 12, color: '#8E8E93', marginBottom: 2 }}>ข้อมูลจาก Cost Manager</div>
                    <div style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 15, color: '#1C1C1E' }}>
                      {total} รายการทั้งหมด
                    </div>
                  </div>
                  {lastSync && (
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 10, color: '#8E8E93' }}>อัพเดทล่าสุดใน CM</div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: '#1C1C1E' }}>{lastSync}</div>
                    </div>
                  )}
                </div>

                {/* ไม่มีอะไรอัพเดท */}
                {!hasChanges && (
                  <div style={{ background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 12,
                    padding: '20px 14px', textAlign: 'center' }}>
                    <div style={{ fontSize: 28, marginBottom: 8 }}>✅</div>
                    <div style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 15, color: '#15803D' }}>
                      ข้อมูลครบถ้วนแล้ว
                    </div>
                    <div style={{ fontSize: 12, color: '#166534', marginTop: 4 }}>
                      ไม่มีรายการใหม่หรือข้อมูลที่เปลี่ยนแปลง
                    </div>
                  </div>
                )}

                {/* เพิ่มใหม่ */}
                {toAdd.length > 0 && (
                  <div style={{ background: '#fff', border: '1px solid #E5E5EA', borderRadius: 12, overflow: 'hidden' }}>
                    <div style={{ padding: '9px 14px', background: '#F0FDF4', borderBottom: '1px solid #BBF7D0',
                      display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 16 }}>🆕</span>
                      <span style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 13, color: '#15803D', flex: 1 }}>
                        เพิ่มใหม่ ({selectedAdd.size}/{toAdd.length})
                      </span>
                      <button onClick={() => setSelectedAdd(selectedAdd.size === toAdd.length ? new Set() : new Set(toAdd.map((_, i) => i)))}
                        style={{ fontSize: 11, color: '#15803D', border: 'none', cursor: 'pointer',
                          fontFamily: 'Sarabun', fontWeight: 700, padding: '2px 6px', borderRadius: 6, background: '#D1FAE5' }}>
                        {selectedAdd.size === toAdd.length ? 'ยกเลิกทั้งหมด' : 'เลือกทั้งหมด'}
                      </button>
                    </div>
                    <div style={{ maxHeight: 160, overflowY: 'auto' }}>
                      {toAdd.map(({ cmItem, cat, unitBuy, unitUse }, ri) => (
                        <div key={ri} onClick={() => setSelectedAdd(s => {
                          const n = new Set(s); n.has(ri) ? n.delete(ri) : n.add(ri); return n
                        })} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px',
                          borderBottom: ri < toAdd.length - 1 ? '1px solid #F3F4F6' : 'none',
                          cursor: 'pointer', opacity: selectedAdd.has(ri) ? 1 : 0.4,
                          background: selectedAdd.has(ri) ? '#fff' : '#F9FAFB' }}>
                          <input type="checkbox" readOnly checked={selectedAdd.has(ri)}
                            style={{ width: 16, height: 16, accentColor: '#15803D', flexShrink: 0, cursor: 'pointer' }} />
                          <span style={{ fontSize: 16 }}>{CAT_EMOJI[cat] || '📦'}</span>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: '#1C1C1E' }}>{cmItem.name}</div>
                            <div style={{ fontSize: 11, color: '#8E8E93' }}>{cat} · {[unitBuy, unitUse].filter(Boolean).join(' › ')}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* อัพเดทหน่วย */}
                {toUpdate.length > 0 && (
                  <div style={{ background: '#fff', border: '1px solid #E5E5EA', borderRadius: 12, overflow: 'hidden' }}>
                    <div style={{ padding: '9px 14px', background: '#FFFBEB', borderBottom: '1px solid #FDE68A',
                      display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 16 }}>📝</span>
                      <span style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 13, color: '#92400E', flex: 1 }}>
                        อัพเดทข้อมูล ({selectedUpdate.size}/{toUpdate.length})
                      </span>
                      <button onClick={() => setSelectedUpdate(selectedUpdate.size === toUpdate.length ? new Set() : new Set(toUpdate.map((_, i) => i)))}
                        style={{ fontSize: 11, color: '#92400E', background: '#FDE68A', border: 'none', cursor: 'pointer',
                          fontFamily: 'Sarabun', fontWeight: 700, padding: '2px 6px', borderRadius: 6 }}>
                        {selectedUpdate.size === toUpdate.length ? 'ยกเลิกทั้งหมด' : 'เลือกทั้งหมด'}
                      </button>
                    </div>
                    <div style={{ maxHeight: 180, overflowY: 'auto' }}>
                      {toUpdate.map(({ inv, changes }, ri) => (
                        <div key={ri} onClick={() => setSelectedUpdate(s => {
                          const n = new Set(s); n.has(ri) ? n.delete(ri) : n.add(ri); return n
                        })} style={{ padding: '8px 14px',
                          borderBottom: ri < toUpdate.length - 1 ? '1px solid #F3F4F6' : 'none',
                          cursor: 'pointer', opacity: selectedUpdate.has(ri) ? 1 : 0.4,
                          background: selectedUpdate.has(ri) ? '#fff' : '#F9FAFB' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                            <input type="checkbox" readOnly checked={selectedUpdate.has(ri)}
                              style={{ width: 16, height: 16, accentColor: '#92400E', flexShrink: 0, cursor: 'pointer' }} />
                            <div style={{ fontSize: 13, fontWeight: 600, color: '#1C1C1E' }}>{inv.name}</div>
                          </div>
                          {changes.map(({ field, from, to }) => (
                            <div key={field} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, paddingLeft: 24 }}>
                              <span style={{ color: '#8E8E93', width: 72, flexShrink: 0 }}>{field}</span>
                              <span style={{ color: '#DC2626', textDecoration: 'line-through' }}>{from || '—'}</span>
                              <span style={{ color: '#8E8E93' }}>→</span>
                              <span style={{ color: '#15803D', fontWeight: 700 }}>{to || '—'}</span>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Status applying */}
                {importStatus && importPhase === 'applying' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#8E8E93' }}>
                    <span style={{ display: 'inline-block', width: 14, height: 14, border: '2px solid #FF3B30',
                      borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                    {importStatus}
                  </div>
                )}

                {/* Done */}
                {importPhase === 'done' && importResult && (
                  <div style={{ background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 10, padding: 12 }}>
                    <div style={{ fontWeight: 700, color: '#15803D', marginBottom: 2 }}>✅ อัพเดทเรียบร้อย</div>
                    <div style={{ fontSize: 12, color: '#166534' }}>
                      {importResult.added > 0 && `เพิ่มใหม่ ${importResult.added} รายการ`}
                      {importResult.added > 0 && importResult.updated > 0 && ' · '}
                      {importResult.updated > 0 && `อัพเดท ${importResult.updated} รายการ`}
                    </div>
                  </div>
                )}

                {/* Buttons */}
                <div style={{ display: 'flex', gap: 10, marginTop: 2 }}>
                  <button className="btn-secondary" style={{ flex: 1 }}
                    onClick={() => { setImportModal(false); setImportPhase('idle') }}
                    disabled={importPhase === 'applying'}>
                    {importPhase === 'done' ? 'ปิด' : 'ยกเลิก'}
                  </button>
                  {hasChanges && importPhase !== 'done' && (
                    <button className="btn-primary" style={{ flex: 2 }}
                      disabled={importPhase === 'applying' || (selectedAdd.size + selectedUpdate.size === 0)}
                      onClick={async () => {
                        const filteredAdd = toAdd.filter((_, i) => selectedAdd.has(i))
                        const filteredUpdate = toUpdate.filter((_, i) => selectedUpdate.has(i))
                        setImportPhase('applying'); setImportLoading(true)
                        try {
                          await applyUpdateFromCM(filteredAdd, filteredUpdate, setImportStatus)
                          setImportResult({ added: filteredAdd.length, updated: filteredUpdate.length })
                          setImportPhase('done'); setImportStatus('')
                          setToast(`✅ อัพเดท ${filteredAdd.length + filteredUpdate.length} รายการเรียบร้อย`)
                        } catch(e) {
                          setImportStatus(`❌ ${e.message}`); setImportPhase('preview')
                        } finally { setImportLoading(false) }
                      }}>
                      {importPhase === 'applying' ? 'กำลังอัพเดท...' : `✅ ยืนยันอัพเดท ${selectedAdd.size + selectedUpdate.size} รายการ`}
                    </button>
                  )}
                  {!hasChanges && (
                    <button className="btn-secondary" style={{ flex: 2 }}
                      onClick={() => { setImportModal(false); setImportPhase('idle') }}>
                      รับทราบ
                    </button>
                  )}
                </div>
              </>
            )
          })()}
        </div>
      </Modal>

      {/* ── Modal: หมวดหมู่วัตถุดิบ ── */}
      <CategoryModal open={catModal} onClose={() => setCatModal(false)}
        cats={cats} setCats={setCats} items={items} cmCompounds={cmCompounds} />

      {/* ── Modal: Integration ── */}
      <Modal open={intModal} onClose={() => setIntModal(false)} title="เชื่อมต่อระบบ">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {[
            { name: '🧮 Cost Manager', desc: 'ราคา/หน่วยวัตถุดิบ', ok: true },
            { name: '💵 Daily Income', desc: 'income_records · Food Cost %', ok: true },
            { name: '🤖 น้องมี่ LINE Bot', desc: 'push_queue · reporter mode', ok: true },
          ].map(sys => (
            <div key={sys.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '12px 14px', background: 'var(--bg)', borderRadius: 10 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{sys.name}</div>
                <div style={{ fontSize: 12, color: 'var(--txt3)' }}>{sys.desc}</div>
              </div>
              <span className={`badge badge-${sys.ok ? 'ok' : 'out'}`}>
                {sys.ok ? '✓ เชื่อมต่อ' : '✕ ไม่ได้เชื่อม'}
              </span>
            </div>
          ))}
          <div style={{ fontSize: 12, color: 'var(--txt3)', marginTop: 4 }}>
            Firebase: mixue-cost-manager · Last sync: {lastSync || '—'}
          </div>
        </div>
      </Modal>

      {/* ── Modal: Opening Stock (legacy — กำลังจะลบ) ── */}
      <OpeningStockModal
        open={openingModal}
        onClose={() => setOpeningModal(false)}
        warehouses={warehouses}
        items={items}
        onSaved={msg => setToast(msg)}
      />

      {/* ── V2: Integration Modal ── */}
      <IntegrationModal open={integrationOpen} onClose={() => setIntegrationOpen(false)} />

      {/* ── V2: Quick Template Modal (Owner only) ── */}
      {isOwner() && (
        <QuickTemplateModal
          open={quickTplModalV2}
          onClose={() => setQuickTplModalV2(false)}
          items={items}
          staffPhone={phone}
          onSuccess={msg => setToast(msg)}
        />
      )}

      {/* ── V2: Clear All Data (PIN-protected) ── */}
      <ClearDataModalV2
        open={clearDataOpen}
        onClose={() => setClearDataOpen(false)}
        pin={settings.analyzePin || '1234'}
        onSuccess={msg => setToast(msg)}
      />

      {/* ── V2: Export CSV ── */}
      <ExportModalV2
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        onSuccess={msg => setToast(msg)}
      />

      {/* ── V2: Seed Stock (Owner) ── */}
      {isOwner() && (
        <SeedStockModal
          open={seedOpen}
          onClose={() => setSeedOpen(false)}
          items={items}
          warehouses={warehouses}
          staffPhone={phone}
          staffName={name}
          onSuccess={msg => setToast(msg)}
        />
      )}

      {/* ── V2: Data Sheet (Owner) ── */}
      {isOwner() && (
        <DataSheetModal
          open={dataSheetOpen}
          onClose={() => setDataSheetOpen(false)}
          items={items}
          warehouses={warehouses}
          staffPhone={phone}
          staffName={name}
          onSuccess={msg => setToast(msg)}
        />
      )}
    </div>
  )
}

/* ────────────────────────────────────────────────────────────
   ClearDataModalV2 — ลบข้อมูลทั้งหมด (PIN ยืนยัน)
──────────────────────────────────────────────────────────── */
function ClearDataModalV2({ open, onClose, pin, onSuccess }) {
  const [enteredPin, setEnteredPin] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [progress, setProgress] = useState('')

  function reset() {
    setEnteredPin(''); setConfirming(false); setErr(''); setProgress('')
  }

  async function handleClear() {
    if (enteredPin !== pin) { setErr('PIN ไม่ถูกต้อง'); return }
    if (!confirming) { setConfirming(true); return }
    setLoading(true); setErr('')
    try {
      const TARGETS = [
        COL.STOCK_BALANCES,
        COL.CUT_STOCK_LOGS,
        COL.STOCK_MOVEMENTS,
        COL.LOT_TRACKING,
        COL.TRANSFER_ORDERS,
        COL.LOW_STOCK_ALERTS,
        COL.WASTE_LOGS,
      ]
      for (const col of TARGETS) {
        setProgress(`กำลังลบ ${col}...`)
        const snap = await getDocs(collection(db, col))
        const docs = snap.docs
        for (let i = 0; i < docs.length; i += 400) {
          const batch = writeBatch(db)
          docs.slice(i, i + 400).forEach(d => batch.delete(d.ref))
          await batch.commit()
        }
      }
      setProgress('')
      onSuccess?.('✅ ลบข้อมูลเรียบร้อย')
      reset()
      onClose?.()
    } catch (e) {
      setErr(e.message || 'เกิดข้อผิดพลาด')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal open={open} onClose={() => { if (!loading) { reset(); onClose?.() } }}
      title="🗑️ Clear All Data">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '0 16px 16px' }}>
        <div style={{ background: '#FEE2E2', border: '1px solid #FECACA',
          borderRadius: 10, padding: '12px 14px', fontSize: 12, color: '#991B1B' }}>
          ⚠️ <strong>ระวัง!</strong> การลบจะรวม:
          <ul style={{ margin: '6px 0 0 16px', padding: 0 }}>
            <li>ยอด stock ทุกคลัง (stock_balances)</li>
            <li>ประวัติตัดสต็อก (cut_stock_logs)</li>
            <li>ประวัติเคลื่อนไหวสต็อก (stock_movements)</li>
            <li>LOT ทั้งหมด</li>
            <li>ใบโอนทั้งหมด</li>
            <li>ของเสีย / แจ้งเตือนทั้งหมด</li>
          </ul>
          <div style={{ marginTop: 8 }}>
            <strong>คงเหลือ:</strong> items / warehouses / app_settings / quick_templates
          </div>
        </div>

        <div>
          <label style={{ fontSize: 11, color: 'var(--txt3)', fontWeight: 600 }}>
            ใส่ PIN วิเคราะห์ 4 หลักเพื่อยืนยัน
          </label>
          <input type="password" value={enteredPin}
            onChange={e => { setEnteredPin(e.target.value); setErr('') }}
            maxLength={4} inputMode="numeric"
            placeholder="• • • •"
            style={{ width: '100%', padding: '12px 14px', borderRadius: 10,
              border: '1.5px solid var(--border2)', fontSize: 22, fontWeight: 700,
              textAlign: 'center', letterSpacing: 8, marginTop: 4 }}/>
        </div>

        {err && (
          <div style={{ background: '#FEE2E2', color: '#DC2626', padding: '8px 12px',
            borderRadius: 8, fontSize: 12, fontWeight: 600 }}>{err}</div>
        )}

        {progress && (
          <div style={{ background: '#EFF6FF', color: '#1D4ED8', padding: '8px 12px',
            borderRadius: 8, fontSize: 12, fontWeight: 600 }}>{progress}</div>
        )}

        <button onClick={handleClear} disabled={loading || enteredPin.length !== 4}
          style={{ padding: '12px 16px', border: 'none', borderRadius: 12,
            background: loading ? 'var(--border2)' : (confirming ? '#DC2626' : 'var(--orange)'),
            color: '#fff', fontSize: 14, fontWeight: 700,
            cursor: loading ? 'wait' : (enteredPin.length === 4 ? 'pointer' : 'not-allowed'),
            opacity: enteredPin.length === 4 ? 1 : 0.5 }}>
          {loading ? 'กำลังลบ...' : confirming ? '⚠️ กดอีกครั้งเพื่อลบจริง' : '🗑️ ลบข้อมูล'}
        </button>
      </div>
    </Modal>
  )
}

/* ────────────────────────────────────────────────────────────
   ExportModalV2 — Export CSV ตามช่วงวัน
──────────────────────────────────────────────────────────── */
function ExportModalV2({ open, onClose, onSuccess }) {
  const today = new Date().toISOString().slice(0, 10)
  const [start, setStart] = useState(today)
  const [end, setEnd] = useState(today)
  const [types, setTypes] = useState({
    cut: true, waste: true, transfer: true, movement: false,
  })
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  function toggle(k) {
    setTypes(t => ({ ...t, [k]: !t[k] }))
  }

  function downloadCSV(filename, rows) {
    if (!rows.length) return
    const headers = Object.keys(rows[0])
    const csv = [
      headers.join(','),
      ...rows.map(r => headers.map(h => {
        const v = r[h]
        const s = v == null ? '' : String(v)
        return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g,'""')}"` : s
      }).join(',')),
    ].join('\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  async function handleExport() {
    setErr(''); setLoading(true)
    try {
      const exports = []
      if (types.cut) {
        const q = query(collection(db, COL.CUT_STOCK_LOGS),
          where('date', '>=', start), where('date', '<=', end))
        const snap = await getDocs(q)
        const rows = []
        snap.docs.forEach(d => {
          const log = d.data()
          ;(log.items || []).forEach(it => {
            rows.push({
              date: log.date, shop: log.shopName || '', staff: log.staffName || '',
              item: it.itemName || '', qty: it.qtyUse || it.qty || 0, unit: it.unitUse || it.unit || '',
              cost: it.costTotal || 0,
            })
          })
        })
        exports.push({ name: 'cut_stock', rows })
      }
      if (types.waste) {
        const q = query(collection(db, COL.WASTE_LOGS),
          where('date', '>=', start), where('date', '<=', end))
        const snap = await getDocs(q)
        const rows = snap.docs.map(d => {
          const w = d.data()
          return {
            date: w.date, type: w.type || '', item: w.itemName || '',
            qty: w.qty || 0, unit: w.unit || '', cost: w.totalCost || 0,
            staff: w.staffName || '',
          }
        })
        exports.push({ name: 'waste', rows })
      }
      if (types.transfer) {
        const snap = await getDocs(collection(db, COL.TRANSFER_ORDERS))
        const rows = []
        snap.docs.forEach(d => {
          const t = d.data()
          const ts = t.createdAt?.seconds
            ? new Date(t.createdAt.seconds * 1000).toISOString().slice(0,10) : ''
          if (ts < start || ts > end) return
          ;(t.items || []).forEach(it => {
            rows.push({
              date: ts, from: t.fromWarehouseName || '', to: t.toWarehouseName || '',
              status: t.status || '', driver: t.driver || '',
              item: it.itemName || '', qty: it.qty || 0, unit: it.unit || '',
            })
          })
        })
        exports.push({ name: 'transfer', rows })
      }
      if (types.movement) {
        const q = query(collection(db, COL.STOCK_MOVEMENTS))
        const snap = await getDocs(q)
        const rows = []
        snap.docs.forEach(d => {
          const m = d.data()
          const ts = m.timestamp?.seconds
            ? new Date(m.timestamp.seconds * 1000).toISOString().slice(0,10) : ''
          if (ts < start || ts > end) return
          rows.push({
            date: ts, type: m.type || '', item: m.itemName || '',
            warehouse: m.warehouseId || '', qty: m.qty || 0, unit: m.unit || '',
            qtyUse: m.qtyUse || 0, unitUse: m.unitUse || '',
            staff: m.staffName || '', reason: m.adjustReason || '',
          })
        })
        exports.push({ name: 'movement', rows })
      }

      let total = 0
      exports.forEach(({ name, rows }) => {
        if (rows.length) {
          downloadCSV(`inventory_${name}_${start}_${end}.csv`, rows)
          total += rows.length
        }
      })

      if (total === 0) setErr('ไม่มีข้อมูลในช่วงวันที่เลือก')
      else {
        onSuccess?.(`✅ Export ${total} แถวเรียบร้อย`)
        onClose?.()
      }
    } catch (e) {
      setErr(e.message || 'เกิดข้อผิดพลาด')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal open={open} onClose={() => { if (!loading) onClose?.() }} title="📤 Export ข้อมูล (CSV)">
      <div style={{ padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 11, color: 'var(--txt3)', fontWeight: 600 }}>วันที่เริ่ม</label>
            <input type="date" value={start} onChange={e => setStart(e.target.value)}
              style={{ width: '100%', padding: '8px 10px', borderRadius: 10,
                border: '1.5px solid var(--border2)', fontSize: 13, marginTop: 4 }}/>
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 11, color: 'var(--txt3)', fontWeight: 600 }}>วันที่สิ้นสุด</label>
            <input type="date" value={end} onChange={e => setEnd(e.target.value)}
              style={{ width: '100%', padding: '8px 10px', borderRadius: 10,
                border: '1.5px solid var(--border2)', fontSize: 13, marginTop: 4 }}/>
          </div>
        </div>

        <div>
          <label style={{ fontSize: 11, color: 'var(--txt3)', fontWeight: 600, marginBottom: 6, display: 'block' }}>
            ประเภทข้อมูล (1 ไฟล์ต่อประเภท)
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {[
              { k: 'cut', label: '✂️ ตัดสต็อก (cut_stock_logs)' },
              { k: 'waste', label: '🗑️ ของเสีย (waste_logs)' },
              { k: 'transfer', label: '🚚 ใบโอน (transfer_orders)' },
              { k: 'movement', label: '📊 เคลื่อนไหวสต็อก (stock_movements)' },
            ].map(o => (
              <label key={o.k} style={{ display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 10px', background: 'var(--bg)', borderRadius: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={types[o.k]} onChange={() => toggle(o.k)}/>
                <span style={{ fontSize: 13, color: 'var(--txt)' }}>{o.label}</span>
              </label>
            ))}
          </div>
        </div>

        {err && (
          <div style={{ background: '#FEE2E2', color: '#DC2626', padding: '8px 12px',
            borderRadius: 8, fontSize: 12, fontWeight: 600 }}>{err}</div>
        )}

        <button onClick={handleExport} disabled={loading || !Object.values(types).some(v => v)}
          style={{ padding: '12px 16px', border: 'none', borderRadius: 12,
            background: loading ? 'var(--border2)' : 'var(--red)', color: '#fff',
            fontSize: 14, fontWeight: 700, cursor: loading ? 'wait' : 'pointer' }}>
          {loading ? 'กำลัง export...' : '📤 ดาวน์โหลด CSV'}
        </button>
      </div>
    </Modal>
  )
}
