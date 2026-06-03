import { useState, useEffect } from 'react'
import { db } from '../firebase'
import { collection, query, where, onSnapshot, orderBy, limit,
         doc, getDoc, addDoc, updateDoc, serverTimestamp, Timestamp, writeBatch, increment } from 'firebase/firestore'
import { ConnectionStatus } from '../components/ConnectionStatus'
import { Modal } from '../components/Modal'
import { Toast } from '../components/Toast'
import { useSession } from '../hooks/useSession'
import { toThaiDate, toThaiTime, lotDateStr, toDateKey } from '../utils/formatDate'
import { COL } from '../constants/collections'
import { sortLotsFIFO } from '../utils/fifo'
import { beepAdd, beepRemove } from '../utils/audio'
import { formatStockQty, balanceId, getStockStatus, parseConvFactor } from '../utils/unit'

const DEFAULT_SOURCES = ['ตลาดไท', 'ซัพพลายเออร์', 'โอนจากคลัง', 'ซื้อเอง', 'อื่นๆ']

const CAT_ORDER = ['แยม','ผลไม้','ไซรัป','ท็อปปิ้ง','วัตถุดิบ','บรรจุภัณฑ์','อื่นๆ']
const CAT_EMOJI = { แยม:'🍓', ผลไม้:'🍋', ไซรัป:'🍯', ท็อปปิ้ง:'💎', วัตถุดิบ:'🥛', บรรจุภัณฑ์:'🥤', อื่นๆ:'🔖' }
const AV_COLORS = ['#6366F1','#E31E24','#0EA5E9','#16A34A','#F59E0B','#8B5CF6']

const CATS = [
  { id: 'all', name: 'ทั้งหมด', emoji: '🔍' },
  { id: 'แยม', name: 'แยม', emoji: '🍓' },
  { id: 'ผลไม้', name: 'ผลไม้', emoji: '🍋' },
  { id: 'ไซรัป', name: 'ไซรัป', emoji: '🍯' },
  { id: 'ท็อปปิ้ง', name: 'ท็อปปิ้ง', emoji: '💎' },
  { id: 'วัตถุดิบ', name: 'วัตถุดิบ', emoji: '🥛' },
  { id: 'บรรจุภัณฑ์', name: 'บรรจุ', emoji: '🥤' },
  { id: 'อื่นๆ', name: 'อื่นๆ', emoji: '🔖' },
]

function ItemPickerGrid({ items, balances, warehouseId, selectedId, selectedIds, onSelect, filterFn,
  hideSidebar = false, hideStock = false, metaText = null }) {
  const [cat, setCat] = useState('all')
  const [search, setSearch] = useState('')

  function getStock(itemId) {
    const bals = warehouseId
      ? balances.filter(b => b.itemId === itemId && b.warehouseId === warehouseId)
      : balances.filter(b => b.itemId === itemId)
    return bals.reduce((s, b) => s + (b.qty || 0), 0)
  }

  const filtered = items
    .filter(i => !filterFn || filterFn(i, getStock(i.id)))
    .filter(i => cat === 'all' || i.category === cat)
    .filter(i => !search || i.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999) || (a.name || '').localeCompare(b.name || '', 'th'))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* Search */}
      <div className="search-wrap" style={{ margin: 0 }}>
        <span className="search-icon">🔍</span>
        <input className="search-input" placeholder="ค้นหา..." value={search}
          onChange={e => setSearch(e.target.value)} />
        {search && <button onClick={() => setSearch('')}
          style={{ border: 'none', background: 'none', color: '#8E8E93', fontSize: 15, cursor: 'pointer', padding: '0 8px' }}>✕</button>}
      </div>
      {/* Sidebar + Grid */}
      <div style={{ display: 'flex', gap: 0, borderRadius: 12, border: '1px solid var(--border)', overflow: 'hidden' }}>
        {/* Sidebar */}
        {!hideSidebar && (
        <div style={{ width: 60, flexShrink: 0, overflowY: 'auto', background: 'var(--bg)', borderRight: '1px solid var(--border)', maxHeight: 320 }}>
          {CATS.map(c => {
            const active = cat === c.id
            return (
              <button key={c.id} onClick={() => setCat(c.id)}
                style={{ width: '100%', border: 'none', cursor: 'pointer', padding: '8px 2px',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
                  background: active ? 'var(--surf)' : 'transparent',
                  borderLeft: active ? '3px solid var(--red)' : '3px solid transparent' }}>
                <span style={{ fontSize: 16 }}>{c.emoji}</span>
                <span style={{ fontSize: 8.5, fontWeight: active ? 700 : 500,
                  color: active ? 'var(--red)' : 'var(--txt3)', textAlign: 'center', wordBreak: 'break-word', maxWidth: 52 }}>
                  {c.name}
                </span>
              </button>
            )
          })}
        </div>
        )}
        {/* Grid */}
        <div style={{ flex: 1, overflowY: 'auto', maxHeight: 320, padding: 8 }}>
          {filtered.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--txt3)', fontSize: 12 }}>ไม่มีรายการ</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {filtered.map(item => {
                const stock = getStock(item.id)
                const sel = selectedId === item.id || (selectedIds && selectedIds.has(item.id))
                const isOut = stock <= 0
                // Smart Display แบบ compound (1 ลัง + 5 ถุง)
                const dispStock = formatStockQty(stock, item)
                const unitUse  = item.unitUse || ''
                return (
                  <div key={item.id} onClick={() => onSelect(item)}
                    style={{ borderRadius: 10, padding: '10px 8px', textAlign: 'center', cursor: 'pointer',
                      border: `2px solid ${sel ? 'var(--red)' : 'var(--border)'}`,
                      background: sel ? 'var(--red-p)' : 'var(--surf)',
                      opacity: hideStock ? 1 : (isOut ? 0.55 : 1),
                      transition: 'all .15s', position: 'relative' }}>
                    {sel && <span style={{ position: 'absolute', top: 4, right: 6, fontSize: 12 }}>✅</span>}
                    {/* Stock badge — มุมซ้ายบน (ซ่อนถ้า hideStock) */}
                    {!hideStock && (
                      <span style={{ position: 'absolute', top: 4, left: 4,
                        background: isOut ? '#FEE2E2' : stock < (item.minQty || 0) ? '#FEF3C7' : '#F0FDF4',
                        color:      isOut ? '#DC2626' : stock < (item.minQty || 0) ? '#B45309' : '#15803D',
                        fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 6,
                        border: `1px solid ${isOut ? '#FECACA' : stock < (item.minQty || 0) ? '#FDE68A' : '#BBF7D0'}` }}>
                        {isOut ? '❌ หมด' : dispStock}
                      </span>
                    )}
                    <div style={{ fontSize: 24, marginTop: hideStock ? 0 : 14 }}>{item.img || '📦'}</div>
                    <div style={{ fontSize: 11, fontWeight: 700, marginTop: 4, lineHeight: 1.3 }}>{item.name}</div>
                    {metaText ? (
                      <div style={{ fontSize: 9.5, color: '#92600A', marginTop: 3,
                        fontWeight: 600, lineHeight: 1.3 }}>
                        {metaText(item)}
                      </div>
                    ) : (!hideStock && !isOut && (
                      <div style={{ fontSize: 9, color: 'var(--txt3)', marginTop: 2 }}>
                        ตัด: {unitUse}{item.unitConversion ? ` · ${item.unitConversion}` : ''}
                      </div>
                    ))}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

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

export default function Dashboard() {
  const { name, isEditor, isOwner } = useSession()
  const [loading, setLoading] = useState(true)
  const [wh, setWh] = useState('')   // จะ default เป็น "สาขา" หลัง warehouses โหลด
  const [warehouses, setWarehouses] = useState([])
  const [kpi, setKpi] = useState({ cost: 0, cuts: 0, low: 0, out: 0, wasteCost: 0, wasteCount: 0 })
  const [todayCutLogs, setTodayCutLogs] = useState([])
  const [cutSummaryOpen, setCutSummaryOpen] = useState(false)
  const [cutFlash, setCutFlash] = useState(false)
  const prevCutsRef = useState(0)
  const [alerts, setAlerts] = useState([])
  const [transfers, setTransfers] = useState([])
  const [items, setItems] = useState([])
  const [balances, setBalances] = useState([])
  const [sources, setSources] = useState(DEFAULT_SOURCES)
  const [toast, setToast] = useState('')
  const [expAlerts, setExpAlerts] = useState([]) // lots expiring within 7 days with qty > 0
  const [lots, setLots] = useState([])           // all LOT docs (for transfer FIFO breakdown)
  const [catOrder, setCatOrder] = useState([])   // ลำดับหมวดหมู่จาก Settings (sortOrder)
  const [staffFilter, setStaffFilter] = useState(new Set())   // filter ใน cutSummary popup (ว่าง = ทั้งหมด)
  const [kpiPop, setKpiPop] = useState(null)                  // 'low' | 'out' | null — popover รายการ KPI

  // Modals
  const [receiveOpen, setReceiveOpen] = useState(false)
  const [transferOpen, setTransferOpen] = useState(false)
  const [refillOpen, setRefillOpen]   = useState(false)
  const [refillStep, setRefillStep]   = useState('branch') // 'branch' | 'item'
  const [refillBranch, setRefillBranch] = useState('')
  const [wasteOpen, setWasteOpen] = useState(false)
  const [bellOpen, setBellOpen] = useState(false)

  // Receive form
  const [receiveSaving, setReceiveSaving] = useState(false)
  const [rcv, setRcv] = useState({
    itemId: '', qty: '', unit: '', receiveDate: '', mfgDate: '', expDate: '', source: DEFAULT_SOURCES[0]
  })

  // Transfer form — multi-item
  const [tfr, setTfr] = useState({ fromWH: '', toWH: '', driver: '' })
  const [transferItems, setTransferItems] = useState([])
  const [tfAddMode, setTfAddMode]         = useState(false)
  const [tfStep, setTfStep]               = useState('pick')   // 'pick' | 'qty' | 'confirm'
  const [transferSaving, setTransferSaving] = useState(false)

  // Refill request
  const [refillSelected, setRefillSelected] = useState(new Set())
  const [refillQtys, setRefillQtys]         = useState({}) // itemId → number
  const [refillUnits, setRefillUnits]       = useState({}) // itemId → unit string
  const [refillCat, setRefillCat]           = useState('low') // 'low' | category name
  const [refillRequests, setRefillRequests] = useState([]) // RF pending docs
  const [refillSaving, setRefillSaving]     = useState(false)
  const [rfSelectedIds, setRfSelectedIds]   = useState(new Set()) // RF ids ที่เลือกรวม (dashboard section)
  const [rfDeleteId, setRfDeleteId]         = useState(null)
  const [rfDeleteReason, setRfDeleteReason] = useState('')
  const [rfDeleting, setRfDeleting]         = useState(false)
  // RF import inside transfer modal
  const [tfrRFImport, setTfrRFImport]       = useState(new Set()) // RF ids ที่จะ import เข้า modal
  const [tfrRFExpand, setTfrRFExpand]       = useState(false)     // แสดง/ซ่อน RF picker

  // Receive transfer modal
  const [receiveTransferOpen, setReceiveTransferOpen] = useState(false)
  const [receivingTF, setReceivingTF]                 = useState(null)  // TF doc being received
  const [receivingChecked, setReceivingChecked]       = useState(new Set()) // indices ticked
  const [receiveConfirmOpen, setReceiveConfirmOpen]   = useState(false)     // popup สรุปก่อน commit
  const [receivingSaving, setReceivingSaving]         = useState(false)

  // Waste form
  const [waste, setWaste] = useState({ itemId: '', qty: '', unit: '', type: 'fruit_daily', wh: '' })
  const [wasteCart, setWasteCart] = useState({})    // { [itemId]: { qty, unit } } — สำหรับ closing multi-select
  const [wasteStep, setWasteStep] = useState('pick') // 'pick' | 'qty' (closing only)
  const [wasteSaving, setWasteSaving] = useState(false)
  const [cmCosts, setCmCosts] = useState({}) // itemName → { costPerUse }
  const [cmCompounds, setCmCompounds] = useState([]) // CM compounds รวมใช้เป็น waste item

  // โหลด Cost Manager library + compounds สำหรับคำนวณมูลค่า + waste picker
  useEffect(() => {
    getDoc(doc(db, 'mixue_data', 'mixue-cost-manager')).then(snap => {
      if (!snap.exists()) return
      const lib = snap.data().library || []
      const compounds = snap.data().compounds || []
      const map = {}
      lib.forEach(it => {
        const levels = it.levels || []
        // CM fields: basePrice = ราคาซื้อ/ลัง, unitPrice = ฿/หน่วยย่อยสุด, qty = จำนวนหน่วยย่อย/ลัง
        const rawPrice   = it.basePrice || it.price || it.total || 0
        const convBuyToUse = levels[1]?.qty || 1   // unitUse ต่อ 1 unitBuy
        const convUseToSub = levels[2]?.qty || 1   // unitSub ต่อ 1 unitUse
        // costPerUse = ต้นทุน ต่อ 1 unitUse (levels[1].name)
        const costPerUse = rawPrice > 0
          ? rawPrice / convBuyToUse
          : (it.unitPrice || 0) * convUseToSub
        map[it.name] = { costPerUse, unitPrice: it.unitPrice || 0 }
      })

      // ── Compounds (สูตรผสม) — เพิ่มเข้า cmCosts + แยกเก็บ ──
      const compoundList = []
      compounds.forEach(cp => {
        const outUnit = cp.outputUnit || cp.unitOut || ''
        const outQty  = Number(cp.outputQty || cp.qtyOut) || 0
        const cpu     = Number(cp.costPerOutputUnit || cp.cpu) || 0
        if (!cp.name || !outUnit) return
        map[cp.name] = { costPerUse: cpu, unitPrice: cpu, isCompound: true }
        compoundList.push({
          id:         `cp_${cp.id || cp.name}`,
          name:       cp.name,
          category:   'สูตรผสม',
          img:        '🧪',
          unitBase:   outUnit,
          unitUse:    outUnit,
          unitSub:    cp.servingUnit?.name || '',
          unitConversion: '',
          convSub:    cp.servingUnit?.qty || 0,
          unitPrice:  cpu,
          wasteMode:  true,                   // เปิด waste mode สำหรับสูตรผสมทุกตัว
          isCompound: true,
          _batchSize: outQty,                 // 1 batch = outQty outUnit
        })
      })
      setCmCompounds(compoundList)
      setCmCosts(map)
    })
  }, [])

  // คำนวณ cost จาก cut logs + cmCosts — รันเมื่อทั้งสอง ready
  useEffect(() => {
    if (Object.keys(cmCosts).length === 0) return
    const cost = todayCutLogs.reduce((s, l) => {
      if (l.totalCost > 0) return s + l.totalCost
      const itemSum = (l.items || []).reduce((ss, it) => {
        const q = it.qtyUse ?? it.qty ?? 0
        const cm = cmCosts[it.itemName]
        return ss + (cm ? q * (cm.costPerUse || 0) : 0)
      }, 0)
      return s + itemSum
    }, 0)
    setKpi(k => ({ ...k, cost }))
  }, [todayCutLogs, cmCosts])

  /** คำนวณมูลค่าของเสียตาม unit ที่เลือก (V2 schema + compound) */
  function calcWasteCost(item, unit, qty) {
    const q = parseFloat(qty) || 0
    if (!q || !item) return 0
    // ราคา/unitUse — ใช้ unitPrice ถ้ามี, fallback cmCosts.costPerUse
    const cpu = Number(item.unitPrice) || cmCosts[item.name]?.costPerUse || 0

    // ── Compound (สูตรผสม) — ไม่มี convSub ก็คิดตรง ๆ ─────
    if (item.isCompound) {
      // unit ที่เลือก = outputUnit (มล./กรัม)
      return q * cpu
    }

    const factor  = parseConvFactor(item.unitConversion)         // unitBase → unitUse (e.g. 20)
    const subConv = Number(item.convSub) || 0                     // 1 unitUse = subConv unitSub (per-parent, e.g. 900)
    if (unit === item.unitBase && factor > 0) return q * factor * cpu
    if (unit === item.unitSub  && subConv > 0) {
      // q (unitSub) → unitUse = q / subConv
      return q * (1 / subConv) * cpu
    }
    return q * cpu  // unitUse (default)
  }

  /** สร้าง options หน่วยจาก item fields (V2) */
  function getUnitOptions(item) {
    if (!item) return []
    const opts = []
    const factor = parseConvFactor(item.unitConversion)
    if (item.unitBase && factor > 1) {
      opts.push({ label: item.unitBase, value: item.unitBase,
        sub: `= ${factor} ${item.unitUse}` })
    }
    if (item.unitUse) opts.push({ label: item.unitUse, value: item.unitUse, sub: 'หน่วยตัด' })
    if (item.unitSub && item.convSub) {
      opts.push({ label: item.unitSub, value: item.unitSub,
        sub: `${item.convSub}/${item.unitBase}` })
    }
    if (opts.length === 0 && item.unitBase) opts.push({ label: item.unitBase, value: item.unitBase, sub: '' })
    return opts
  }

  async function saveWaste() {
    if (!waste.itemId || !waste.qty) {
      setToast('⚠️ กรุณาเลือกวัตถุดิบและระบุจำนวน')
      return
    }
    const phone = window._bizSession?.phone || ''
    const name  = window._bizSession?.name  || ''
    setWasteSaving(true)
    try {
      // หา item จากทั้ง raw items + compounds
      const item = items.find(i => i.id === waste.itemId)
        || cmCompounds.find(c => c.id === waste.itemId)
      const unit = waste.unit || item?.unitUse || item?.unitBase || ''
      const qtyVal = parseFloat(waste.qty) || 0
      const totalCost = calcWasteCost(item, unit, qtyVal)
      const costPerUnit = qtyVal > 0 ? totalCost / qtyVal : 0

      // ── ผลไม้ระหว่างวัน (ส้ม/มะนาว) → ลด stock จริง ──
      const isFruitDaily = waste.type === 'fruit_daily'
      const needDeductStock = isFruitDaily && !item?.isCompound && item?.id
      // ใช้ waste.wh (ที่เลือกใน modal) ก่อน → fallback ไปที่ dashboard wh
      const targetWh = waste.wh || wh

      if (needDeductStock && (!targetWh || targetWh === 'all')) {
        setToast('⚠️ เลือกคลัง/สาขาก่อนบันทึกของเสียผลไม้')
        setWasteSaving(false)
        return
      }

      // คำนวณ qty in unitUse สำหรับ deduct stock
      let qtyInUse = qtyVal
      if (item) {
        const factor  = parseConvFactor(item.unitConversion) || 1
        const subConv = Number(item.convSub) || 0
        if (unit === item.unitBase)      qtyInUse = qtyVal * factor
        else if (unit === item.unitSub && subConv > 0) qtyInUse = qtyVal / subConv
        // else: unit === unitUse → qtyInUse = qtyVal (ตามที่กรอก)
      }

      const batch = writeBatch(db)
      const now = serverTimestamp()

      // 1. add waste_logs
      const wasteRef = doc(collection(db, COL.WASTE_LOGS))
      batch.set(wasteRef, {
        date: toDateKey(),
        warehouseId: !targetWh || targetWh === 'all' ? '' : targetWh,
        type: waste.type,
        itemId: waste.itemId,
        itemName: item?.name || '',
        img: item?.img || '📦',
        isCompound: !!item?.isCompound,
        qty: qtyVal,
        unit,
        qtyUse: qtyInUse,
        unitUse: item?.unitUse || '',
        costPerUnit,
        totalCost,
        deductedStock: !!needDeductStock,
        staffPhone: phone,
        staffName: name,
        timestamp: now,
      })

      // 2. ถ้า fruit_daily → ลด stock_balances + stock_movements
      if (needDeductStock) {
        const balRef = doc(db, COL.STOCK_BALANCES, `${targetWh}_${item.id}`)
        batch.set(balRef, {
          warehouseId:   targetWh,
          itemId:        item.id,
          qty:           increment(-qtyInUse),
          unit:          item.unitUse || '',
          lastUpdated:   now,
          lastUpdatedBy: phone,
        }, { merge: true })

        const movRef = doc(collection(db, COL.STOCK_MOVEMENTS))
        batch.set(movRef, {
          type:         'waste',
          itemId:       item.id,
          itemName:     item.name,
          warehouseId:  targetWh,
          qty:          -qtyInUse,
          unit:         item.unitUse || '',
          qtyUse:       -qtyInUse,
          unitUse:      item.unitUse || '',
          adjustReason: '🍋 ผลไม้เสียระหว่างวัน',
          note:         `auto-deduct จาก waste log · ${qtyVal} ${unit}`,
          staffPhone:   phone,
          staffName:    name,
          timestamp:    now,
        })
      }

      // 3. audit
      const audRef = doc(collection(db, COL.AUDIT_LOGS))
      batch.set(audRef, {
        action:      needDeductStock ? 'waste_with_deduct' : 'waste',
        staffPhone:  phone,
        staffName:   name,
        warehouseId: !targetWh || targetWh === 'all' ? '' : targetWh,
        detail:      `บันทึกของเสีย ${item?.name} ${qtyVal} ${unit}${needDeductStock ? ` (− stock ${qtyInUse} ${item?.unitUse} @ ${warehouses.find(w => w.id === targetWh)?.name || targetWh})` : ''}`,
        timestamp:   now,
      })

      await batch.commit()
      setToast(`✅ บันทึกของเสีย: ${item?.name} ${waste.qty} ${unit}${totalCost ? ` (฿${totalCost.toFixed(2)})` : ''}`)
      setWaste({ itemId: '', qty: '', unit: '', type: 'fruit_daily', wh: '' })
      setWasteOpen(false)
    } catch (e) {
      setToast('❌ เกิดข้อผิดพลาด: ' + (e.message || 'ลองใหม่อีกครั้ง'))
    } finally {
      setWasteSaving(false)
    }
  }

  // Batch save: ปิดร้าน multi-item — บันทึกพร้อมกันทุกรายการใน wasteCart
  async function saveWasteCart() {
    const entries = Object.entries(wasteCart).filter(([, v]) => parseFloat(v.qty) > 0)
    if (entries.length === 0) { setToast('⚠️ กรุณากรอกจำนวนอย่างน้อย 1 รายการ'); return }
    const phone = window._bizSession?.phone || ''
    const name  = window._bizSession?.name  || ''
    setWasteSaving(true)
    try {
      const batch = writeBatch(db)
      const now = serverTimestamp()
      let totalCostAll = 0
      for (const [itemId, v] of entries) {
        const item = items.find(i => i.id === itemId) || cmCompounds.find(c => c.id === itemId)
        const qtyVal = parseFloat(v.qty) || 0
        const unit = v.unit || item?.unitUse || item?.unitBase || ''
        const totalCost = calcWasteCost(item, unit, qtyVal)
        totalCostAll += totalCost
        const costPerUnit = qtyVal > 0 ? totalCost / qtyVal : 0
        const wasteRef = doc(collection(db, COL.WASTE_LOGS))
        batch.set(wasteRef, {
          date: toDateKey(),
          warehouseId: '',
          type: 'closing',
          itemId,
          itemName: item?.name || '',
          img: item?.img || '📦',
          isCompound: !!item?.isCompound,
          qty: qtyVal,
          unit,
          qtyUse: qtyVal,
          unitUse: item?.unitUse || unit,
          costPerUnit,
          totalCost,
          deductedStock: false,
          staffPhone: phone,
          staffName: name,
          timestamp: now,
        })
      }
      batch.set(doc(collection(db, COL.AUDIT_LOGS)), {
        action: 'waste_batch',
        staffPhone: phone, staffName: name,
        detail: `บันทึกของเสียปิดร้าน ${entries.length} รายการ · รวม ฿${totalCostAll.toFixed(2)}`,
        timestamp: now,
      })
      await batch.commit()
      setToast(`✅ บันทึกของเสีย ${entries.length} รายการ · รวม ฿${totalCostAll.toFixed(2)}`)
      setWaste({ itemId: '', qty: '', unit: '', type: 'fruit_daily', wh: '' })
      setWasteCart({}); setWasteStep('pick'); setWasteOpen(false)
    } catch (e) {
      setToast('❌ ' + (e.message || 'เกิดข้อผิดพลาด'))
    } finally {
      setWasteSaving(false)
    }
  }

  // Load warehouses + default scope = สาขาแรก (ไม่ใช่ "ทุกร้าน")
  useEffect(() => {
    const unsub = onSnapshot(collection(db, COL.WAREHOUSES), snap => {
      const wList = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(w => w.active !== false)
      setWarehouses(wList)
      setWh(prev => {
        if (prev) return prev   // เคยเลือกไว้แล้ว
        const shop = wList.find(w => w.type === 'shop' || w.type === 'branch' || w.isShop === true)
          || wList.find(w => !(w.type === 'main' || w.isMain))
          || wList[0]
        return shop?.id || 'all'
      })
    })
    return () => unsub()
  }, [])

  // Load items
  useEffect(() => {
    const unsub = onSnapshot(collection(db, COL.ITEMS), snap => {
      setItems(snap.docs.map(d => ({ id: d.id, ...d.data() })))
      setLoading(false)
    })
    return () => unsub()
  }, [])

  // balances โหลดจาก listener ด้านล่าง (Load low/out stock) ที่มี wh filter อยู่แล้ว

  // Load sources from settings
  useEffect(() => {
    getDoc(doc(db, COL.APP_SETTINGS, 'sources')).then(snap => {
      if (snap.exists() && snap.data().list?.length) setSources(snap.data().list)
    })
  }, [])

  // Load KPI (today cut logs) — เก็บ logs ไว้คำนวณ cost กับ cmCosts
  useEffect(() => {
    const today = toDateKey()
    const q = wh === 'all'
      ? query(collection(db, COL.CUT_STOCK_LOGS), where('date', '==', today))
      : query(collection(db, COL.CUT_STOCK_LOGS), where('date', '==', today), where('warehouseId', '==', wh))
    const unsub = onSnapshot(q, snap => {
      const logs = snap.docs.map(d => d.data()).filter(d => !d.deletedAt)
      setTodayCutLogs(logs)
      setKpi(k => ({ ...k, cuts: logs.length }))
    })
    return () => unsub()
  }, [wh])

  // Load Waste KPI (today)
  useEffect(() => {
    const today = toDateKey()
    const q = wh === 'all'
      ? query(collection(db, COL.WASTE_LOGS), where('date', '==', today))
      : query(collection(db, COL.WASTE_LOGS), where('date', '==', today), where('warehouseId', '==', wh))
    const unsub = onSnapshot(q, snap => {
      const wlogs = snap.docs.map(d => d.data()).filter(d => !d.deletedAt)
      const wasteCost = wlogs.reduce((s, l) => s + (Number(l.totalCost) || 0), 0)
      setKpi(k => ({ ...k, wasteCost, wasteCount: wlogs.length }))
    })
    return () => unsub()
  }, [wh])

  // Load alerts
  useEffect(() => {
    const q = query(collection(db, COL.LOW_STOCK_ALERTS), where('read', '==', false), limit(10))
    const unsub = onSnapshot(q, snap => {
      setAlerts(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    })
    return () => unsub()
  }, [])

  // Load EXP alerts (lots expiring within 7 days with qty > 0) + เก็บ lots ทั้งหมด
  useEffect(() => {
    const unsub = onSnapshot(collection(db, COL.LOT_TRACKING), snap => {
      const allLots = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      setLots(allLots)
      const now = new Date()
      const in7 = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
      const expiring = allLots
        .map(d => d)
        .filter(lot => {
          const qty = (lot.inWarehouse || 0) + (lot.inShop || 0)
          if (qty <= 0) return false
          if (!lot.expDate) return false
          const exp = new Date(lot.expDate)
          return exp <= in7
        })
        .map(lot => {
          const exp = new Date(lot.expDate)
          const daysLeft = Math.ceil((exp - new Date()) / (1000 * 60 * 60 * 24))
          return { ...lot, daysLeft }
        })
      setExpAlerts(expiring)
    })
    // โหลด category order จาก Settings (live sync)
    const unsubCats = onSnapshot(doc(db, COL.APP_SETTINGS, 'categories'), snap => {
      if (snap.exists() && Array.isArray(snap.data().list)) {
        setCatOrder(snap.data().list.map(c => c.name))
      }
    })
    return () => { unsub(); unsubCats() }
  }, [])

  // Load active transfers (pending + in_transit)
  useEffect(() => {
    const q = query(collection(db, COL.TRANSFER_ORDERS),
      where('status', 'in', ['pending', 'in_transit']), limit(10))
    const unsub = onSnapshot(q, snap => {
      setTransfers(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    })
    return () => unsub()
  }, [])

  // Load pending refill requests
  // ไม่ใช้ orderBy ใน query เพื่อหลีกเลี่ยง Composite Index requirement
  // — sort ใน client แทน
  useEffect(() => {
    const q = query(collection(db, COL.REFILL_REQUESTS),
      where('status', 'in', ['pending', 'processing']), limit(30))
    const unsub = onSnapshot(q, snap => {
      const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      // เรียงเก่าสุดขึ้นก่อน (pending เก่าสุดควรดำเนินการก่อน)
      docs.sort((a, b) => (a.requestedAt?.seconds || 0) - (b.requestedAt?.seconds || 0))
      setRefillRequests(docs)
    }, err => {
      console.error('RF snapshot error:', err)
    })
    return () => unsub()
  }, [])

  // Load balances ทุก warehouse (transfer modal + other features ต้องการข้าม-warehouse)
  useEffect(() => {
    const q = query(collection(db, COL.STOCK_BALANCES))
    const unsub = onSnapshot(q, snap => {
      const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      setBalances(docs)
      // KPI low/out — กรองเฉพาะ wh ที่ scope ปัจจุบัน (ถ้า all = ทุก wh)
      const scoped = wh === 'all' ? docs : docs.filter(b => b.warehouseId === wh)
      let low = 0, out = 0
      scoped.forEach(b => {
        const item = items.find(i => i.id === b.itemId)
        if (!item) return
        if (b.qty <= 0) out++
        else if (b.qty <= (b.minQty || item.minQty || 0)) low++
      })
      setKpi(k => ({ ...k, low, out }))
    })
    return () => unsub()
  }, [wh, items])

  const whName = wh === 'all' ? 'ทุกร้าน' : (warehouses.find(w => w.id === wh)?.name || wh)

  async function submitReceive() {
    if (!rcv.itemId || !rcv.qty) { setToast('⚠️ กรุณาเลือกวัตถุดิบและระบุจำนวน'); return }
    if (!rcv.receiveDate) { setToast('⚠️ กรุณาระบุวันที่รับสินค้า'); return }
    const item = items.find(i => i.id === rcv.itemId)
    if (!item) return
    setReceiveSaving(true)
    try {
      const batch = writeBatch(db)
      const lotId = `${rcv.itemId}_${rcv.receiveDate.replace(/\//g, '')}`
      const balId = `${rcv.itemId}_${rcv.itemId}`
      const qty = parseFloat(rcv.qty)

      batch.set(doc(db, COL.LOT_TRACKING, lotId), {
        itemId: rcv.itemId, itemName: item.name,
        warehouseId: rcv.fromWH || warehouses[0]?.id || '',
        receiveDate: rcv.receiveDate, mfgDate: rcv.mfgDate, expDate: rcv.expDate,
        totalQty: qty, inWarehouse: qty, inShop: 0, used: 0,
        source: rcv.source, createdAt: serverTimestamp()
      }, { merge: true })

      const balRef = doc(db, COL.STOCK_BALANCES, balId)
      const balSnap = await getDoc(balRef)
      if (balSnap.exists()) {
        batch.update(balRef, { qty: (balSnap.data().qty || 0) + qty, lastUpdated: serverTimestamp() })
      } else {
        batch.set(balRef, { itemId: rcv.itemId, warehouseId: rcv.fromWH || warehouses[0]?.id || '',
          qty, unit: item.unitBase, lastUpdated: serverTimestamp(), lastUpdatedBy: window._bizSession?.phone || '' })
      }

      await batch.commit()
      await addDoc(collection(db, COL.STOCK_MOVEMENTS), {
        type: 'receive', itemId: rcv.itemId, itemName: item.name,
        warehouseId: rcv.fromWH || warehouses[0]?.id || '',
        qty, unit: item.unitBase, unitUse: item.unitUse, qtyUse: qty,
        staffPhone: window._bizSession?.phone || '', staffName: window._bizSession?.name || '',
        shopName: whName, timestamp: serverTimestamp(), note: `รับจาก ${rcv.source}`
      })
      await addDoc(collection(db, COL.AUDIT_LOGS), {
        action: 'receive', staffPhone: window._bizSession?.phone || '',
        staffName: window._bizSession?.name || '', warehouseId: rcv.fromWH || '',
        detail: `รับ ${item.name} ${qty} ${item.unitBase}`, timestamp: serverTimestamp()
      })
      setReceiveOpen(false)
      setRcv({ itemId: '', qty: '', unit: '', receiveDate: '', mfgDate: '', expDate: '', source: sources[0] || DEFAULT_SOURCES[0] })
      setToast(`✅ รับสินค้า ${item.name} ${qty} ${item.unitBase} เรียบร้อย`)
    } catch (e) {
      console.error(e)
      setToast('❌ เกิดข้อผิดพลาด กรุณาลองใหม่')
    } finally {
      setReceiveSaving(false)
    }
  }

  async function receiveTransfer(tf) {
    try {
      const batch = writeBatch(db)
      const tfLabel = `#TF-${tf.id.slice(-6).toUpperCase()}`
      const fromName = warehouses.find(w => w.id === tf.fromWarehouseId)?.name || tf.fromWarehouseName || 'คลังต้นทาง'
      const toName = warehouses.find(w => w.id === tf.toWarehouseId)?.name || tf.toWarehouseName || 'คลังปลายทาง'

      // Update each item's stock balance at destination warehouse — แปลง unit ก่อน
      for (const item of (tf.items || [])) {
        const itemMeta = items.find(i => i.id === item.itemId)
        const factor   = parseConvFactor(itemMeta?.unitConversion) || 1
        const unitUse  = itemMeta?.unitUse || item.unit || ''
        const qtyIn    = parseFloat(item.qty) || 0
        const addQty   = (item.unit && itemMeta?.unitBase && item.unit === itemMeta.unitBase)
          ? qtyIn * factor
          : qtyIn

        const toBalRef  = doc(db, COL.STOCK_BALANCES, balanceId(tf.toWarehouseId, item.itemId))
        const toBalSnap = await getDoc(toBalRef)
        if (toBalSnap.exists()) {
          batch.update(toBalRef, {
            qty: (toBalSnap.data().qty || 0) + addQty,
            lastUpdated: serverTimestamp(),
            lastUpdatedBy: name || ''
          })
        } else {
          batch.set(toBalRef, {
            itemId: item.itemId,
            warehouseId: tf.toWarehouseId,
            qty: addQty,
            unit: unitUse,
            lastUpdated: serverTimestamp(),
            lastUpdatedBy: name || ''
          })
        }

        // Reduce from source warehouse
        const fromBalRef  = doc(db, COL.STOCK_BALANCES, balanceId(tf.fromWarehouseId, item.itemId))
        const fromBalSnap = await getDoc(fromBalRef)
        if (fromBalSnap.exists()) {
          const newQty = Math.max(0, (fromBalSnap.data().qty || 0) - addQty)
          batch.update(fromBalRef, { qty: newQty, lastUpdated: serverTimestamp() })
        }
      }

      // Mark transfer as received
      batch.update(doc(db, COL.TRANSFER_ORDERS, tf.id), {
        status: 'received',
        receivedBy: name || '',
        receivedAt: serverTimestamp()
      })

      await batch.commit()

      // Add audit log
      await addDoc(collection(db, COL.AUDIT_LOGS), {
        action: 'transfer_received',
        staffName: name || '',
        detail: `รับโอน ${tfLabel} จาก ${fromName} ไปยัง ${toName}`,
        timestamp: serverTimestamp()
      })

      setToast(`✅ รับสินค้าเรียบร้อย`)
    } catch (e) {
      console.error(e)
      setToast('❌ เกิดข้อผิดพลาด กรุณาลองใหม่')
    }
  }

  /** บันทึกใบแจ้งเติมของ (staff กดแจ้ง → จบ) */
  async function submitRefill() {
    if (refillSelected.size === 0) { setToast('⚠️ กรุณาเลือกรายการที่ต้องการเติม'); return }
    setRefillSaving(true)
    try {
      const _now = new Date()
      const _mm  = String(_now.getMonth() + 1).padStart(2, '0')
      const _yy  = String(_now.getFullYear()).slice(-2)
      const _seq = String(Date.now()).slice(-2)
      const rfId = `RF-${_mm}.${_yy}-${_seq}`
      const rfItems = [...refillSelected].map(id => {
        const item = items.find(i => i.id === id)
        if (!item) return null
        return {
          itemId: id, itemName: item.name, img: item.img || '📦',
          category: item.category || 'อื่นๆ',
          unit: refillUnits[id] || item.unitUse || item.unitBase || '',
          qty: refillQtys[id] || 0,
        }
      }).filter(Boolean)
      await addDoc(collection(db, COL.REFILL_REQUESTS), {
        rfRef: rfId, status: 'pending',
        items: rfItems,
        requestedBy: name || window._bizSession?.name || '',
        requestedAt: serverTimestamp(),
      })
      await addDoc(collection(db, COL.AUDIT_LOGS), {
        action: 'refill_request', staffName: name,
        detail: `แจ้งเติมของ ${rfId} — ${rfItems.length} รายการ`,
        timestamp: serverTimestamp()
      })
      setRefillOpen(false)
      setRefillSelected(new Set())
      setRefillQtys({})
      setRefillUnits({})
      setRefillCat('low')
      setToast(`✅ แจ้งเติมของ ${rfId} เรียบร้อย — รอคลังดำเนินการ`)
    } catch(e) {
      setToast('❌ เกิดข้อผิดพลาด')
    } finally {
      setRefillSaving(false)
    }
  }

  /** เปิด transfer modal พร้อม pre-fill จาก RF doc */
  /** merge items จาก RF array เข้า transferItems (รวม qty ถ้า itemId ซ้ำ) */
  function mergeRFsIntoItems(rfs) {
    const merged = {}
    // เอา existing items ก่อน
    transferItems.forEach(it => { merged[it.itemId] = { ...it } })
    // merge จาก RF ที่เลือก
    rfs.forEach(rf => {
      ;(rf.items || []).forEach(it => {
        const itemMaster = items.find(i => i.id === it.itemId)
        // unitOpts รวมทุก level: unitBuy/unitBase + unitUseRaw + unitUse + unitSub + it.unit (raw 3 + effective)
        const unitOpts = []
        const addUnit = u => { if (u && !unitOpts.includes(u)) unitOpts.push(u) }
        addUnit(itemMaster?.unitBuy || itemMaster?.unitBase)
        addUnit(itemMaster?.unitUseRaw)
        addUnit(itemMaster?.unitUse)
        addUnit(itemMaster?.unitSubRaw || itemMaster?.unitSub)
        addUnit(it.unit)   // หน่วยที่ staff เลือกตอนสร้าง RF — ใส่เผื่อ master ไม่มี

        if (merged[it.itemId]) {
          // ถ้าหน่วยเดียวกัน → รวม qty; ถ้าต่างหน่วย → ใช้ unit ของ RF ใหม่ + รวม qty (ไม่เป๊ะ)
          if (merged[it.itemId].unit === (it.unit || merged[it.itemId].unit)) {
            merged[it.itemId].qty = String(parseFloat(merged[it.itemId].qty || 0) + parseFloat(it.qty || 0))
          } else {
            merged[it.itemId].qty = String(parseFloat(merged[it.itemId].qty || 0) + parseFloat(it.qty || 0))
            console.warn(`[transfer] หน่วยต่างกัน รวม qty อาจไม่เป๊ะ:`, it.itemName)
          }
        } else {
          merged[it.itemId] = {
            itemId: it.itemId, itemName: it.itemName, img: it.img || '📦',
            category: it.category || 'อื่นๆ',
            qty: it.qty ? String(it.qty) : '',
            unit: it.unit || unitOpts[0] || '',   // ⚠️ ใช้หน่วยที่ staff เลือก (it.unit) เป็นหลัก
            unitOpts,
          }
        }
      })
    })
    setTransferItems(Object.values(merged))
  }

  /** เปิด modal สร้างใบโอน (เปล่า — ให้ user เลือก RF เอง) */
  function openTransferFromRFs(rfs) {
    setTransferItems([])
    setTfr({ fromWH: '', toWH: '', driver: '', _rfIds: [], _rfRefs: [] })
    setTfAddMode(false); setTfStep('pick')
    setTfrRFExpand(true)  // เปิด RF picker อัตโนมัติ
    // pre-select ถ้า user กดมาจาก sticky bar
    setTfrRFImport(new Set(rfs.map(r => r.id)))
    setRfSelectedIds(new Set())
    setTransferOpen(true)
  }

  // backward-compat: เปิดจาก RF เดี่ยว (ยังใช้ใน FlowCard)
  function openTransferFromRF(rf) { openTransferFromRFs([rf]) }

  /** เปิด modal เปล่า (จากปุ่ม "โอนสินค้า") */
  function openTransferBlank() {
    setTransferItems([])
    setTfr({ fromWH: '', toWH: '', driver: '', _rfIds: [], _rfRefs: [] })
    setTfAddMode(false); setTfStep('pick')
    setTfrRFExpand(refillRequests.filter(r => r.status === 'pending').length > 0)
    setTfrRFImport(new Set())
    setTransferOpen(true)
  }

  /** ยกเลิก/ลบ RF พร้อมบันทึกเหตุผลลง audit_log */
  async function deleteRF(rfId, rfRef, reason) {
    if (!reason || reason.trim().length < 3) {
      setToast('⚠️ กรุณาระบุเหตุผลอย่างน้อย 3 ตัวอักษร'); return
    }
    setRfDeleting(true)
    try {
      await updateDoc(doc(db, COL.REFILL_REQUESTS, rfId), {
        status: 'cancelled',
        cancelledBy: name,
        cancelReason: reason.trim(),
        cancelledAt: serverTimestamp(),
      })
      await addDoc(collection(db, COL.AUDIT_LOGS), {
        action: 'refill_cancel',
        staffName: name,
        detail: `ยกเลิกคำร้อง ${rfRef || rfId.slice(-8)} | เหตุผล: ${reason.trim()}`,
        timestamp: serverTimestamp(),
      })
      setRfDeleteId(null)
      setRfDeleteReason('')
      setToast(`🗑️ ยกเลิกคำร้อง ${rfRef || ''} แล้ว`)
    } catch(e) {
      console.error(e); setToast('❌ เกิดข้อผิดพลาด')
    } finally {
      setRfDeleting(false)
    }
  }

  /** สร้างใบโอนสินค้า + เริ่มนำส่งทันที (status = in_transit) */
  async function submitTransfer() {
    if (!tfr.fromWH || !tfr.toWH || transferItems.length === 0) {
      setToast('⚠️ กรุณาเลือกคลังและเพิ่มวัตถุดิบอย่างน้อย 1 รายการ'); return
    }
    if (tfr.fromWH === tfr.toWH) { setToast('⚠️ คลังต้นทางและปลายทางต้องไม่เหมือนกัน'); return }
    const hasQty = transferItems.every(it => parseFloat(it.qty) > 0)
    if (!hasQty) { setToast('⚠️ กรุณาระบุจำนวนทุกรายการ'); return }
    setTransferSaving(true)
    try {
      const fromName = warehouses.find(w => w.id === tfr.fromWH)?.name || tfr.fromWH
      const toName   = warehouses.find(w => w.id === tfr.toWH)?.name  || tfr.toWH
      const _tn  = new Date()
      const _tmm = String(_tn.getMonth() + 1).padStart(2, '0')
      const _tyy = String(_tn.getFullYear()).slice(-2)
      const _tseq = String(Date.now()).slice(-2)
      const tfId = `TF-${_tmm}.${_tyy}-${_tseq}`
      const itemsPayload = transferItems.map(it => ({
        itemId: it.itemId, itemName: it.itemName, img: it.img,
        category: it.category || 'อื่นๆ',
        qty: parseFloat(it.qty), unit: it.unit,
      }))
      // เก็บ RF list ทั้งหมดบน TF เพื่อให้ confirmReceive update done ครบทุกใบ
      const allRfIds  = tfr._rfIds?.length ? tfr._rfIds : (tfr._rfId ? [tfr._rfId] : [])
      const allRfRefs = tfr._rfRefs?.length ? tfr._rfRefs : (tfr._rfRef ? [tfr._rfRef] : [])
      const tfDoc = await addDoc(collection(db, COL.TRANSFER_ORDERS), {
        tfRef: tfId, status: 'in_transit',
        fromWarehouseId: tfr.fromWH, fromWarehouseName: fromName,
        toWarehouseId:   tfr.toWH,   toWarehouseName:   toName,
        driver: tfr.driver,
        items: itemsPayload,
        refillRequestId: allRfIds[0] || null, refillRef: allRfRefs[0] || null,   // legacy single
        refillRequestIds: allRfIds, refillRefs: allRfRefs,                       // ใหม่: array รองรับ multi-RF
        createdBy: name, createdAt: serverTimestamp(),
        departedBy: name, departedAt: serverTimestamp(),
      })
      // อัปเดต RF status → processing (รองรับทั้ง _rfIds array และ _rfId เดี่ยว legacy)
      const rfIds = tfr._rfIds?.length ? tfr._rfIds : (tfr._rfId ? [tfr._rfId] : [])
      for (const rfId of rfIds) {
        await updateDoc(doc(db, COL.REFILL_REQUESTS, rfId), {
          status: 'processing', transferOrderId: tfDoc.id, tfRef: tfId
        })
      }
      const rfRefs = tfr._rfRefs?.join(', ') || tfr._rfRef || ''
      await addDoc(collection(db, COL.AUDIT_LOGS), {
        action: 'transfer_dispatch', staffName: name,
        detail: `สร้าง+นำส่ง ${tfId} จาก ${fromName} → ${toName} (${itemsPayload.length} รายการ) | คนนำส่ง: ${tfr.driver || '-'}${rfRefs ? ' | RF: ' + rfRefs : ''}`,
        timestamp: serverTimestamp()
      })
      setTransferOpen(false)
      setTransferItems([])
      setTfr({ fromWH: '', toWH: '', driver: '' })
      setToast(`✅ นำส่งใบโอน ${tfId} แล้ว — รอหน้าร้านยืนยันรับ`)
    } catch(e) {
      console.error(e); setToast('❌ เกิดข้อผิดพลาด')
    } finally {
      setTransferSaving(false)
    }
  }

  /** เปิด modal รับสินค้า */
  function openReceiveTransfer(tf) {
    setReceivingTF(tf)
    setReceivingChecked(new Set())
    setReceiveTransferOpen(true)
  }

  /** ยืนยันรับสินค้า — ปรับ stock ทั้ง 2 ฝั่ง */
  async function confirmReceiveTransfer() {
    if (!receivingTF) return
    const tf = receivingTF
    const allIndices = new Set((tf.items || []).map((_, i) => i))
    const allChecked = [...allIndices].every(i => receivingChecked.has(i))
    if (!allChecked) { setToast('⚠️ กรุณาติ๊กถูกทุกรายการก่อนยืนยัน'); return }
    setReceivingSaving(true)
    try {
      const batch = writeBatch(db)
      const fromName = tf.fromWarehouseName || tf.fromWarehouseId
      const toName   = tf.toWarehouseName   || tf.toWarehouseId
      // ปรับ stock + LOT ทั้ง 2 ฝั่ง — แปลงเป็น unitUse ก่อน (stock_balances + LOT เก็บใน unitUse)
      const lotTransfers = []   // เก็บ FIFO breakdown สำหรับ audit log
      for (const it of (tf.items || [])) {
        const itemMeta = items.find(i => i.id === it.itemId)
        const factor   = parseConvFactor(itemMeta?.unitConversion) || 1
        const unitUse  = itemMeta?.unitUse || it.unit || ''
        // ถ้าหน่วยที่โอนเป็น unitBase → คูณ factor; ถ้าเป็น unitUse → ใช้ตรงๆ
        const qtyIn    = parseFloat(it.qty) || 0
        const addQtyUse = (it.unit && itemMeta?.unitBase && it.unit === itemMeta.unitBase)
          ? qtyIn * factor
          : qtyIn

        // ── 1. STOCK_BALANCES ─────────────────────────────────────
        // เพิ่มที่ปลายทาง
        const toRef  = doc(db, COL.STOCK_BALANCES, balanceId(tf.toWarehouseId, it.itemId))
        const toSnap = await getDoc(toRef)
        if (toSnap.exists()) {
          batch.update(toRef, { qty: (toSnap.data().qty || 0) + addQtyUse, lastUpdated: serverTimestamp() })
        } else {
          batch.set(toRef, { itemId: it.itemId, warehouseId: tf.toWarehouseId,
            qty: addQtyUse, unit: unitUse, lastUpdated: serverTimestamp(), lastUpdatedBy: name })
        }
        // ลดที่ต้นทาง
        const frRef  = doc(db, COL.STOCK_BALANCES, balanceId(tf.fromWarehouseId, it.itemId))
        const frSnap = await getDoc(frRef)
        if (frSnap.exists()) {
          batch.update(frRef, { qty: Math.max(0, (frSnap.data().qty || 0) - addQtyUse), lastUpdated: serverTimestamp() })
        }

        // ── 1b. STOCK_MOVEMENTS — บันทึก ledger ทั้ง 2 ฝั่ง (เพื่อให้ประวัติเห็น) ──
        const noteBase = `ใบโอน ${tf.tfRef || tf.id}`
        // ต้นทาง: ลด
        batch.set(doc(collection(db, COL.STOCK_MOVEMENTS)), {
          type: 'transfer_send', itemId: it.itemId, itemName: it.itemName,
          warehouseId: tf.fromWarehouseId,
          qty: -addQtyUse, qtyUse: -addQtyUse,
          unit: unitUse, unitUse,
          staffPhone: window._bizSession?.phone || '', staffName: name,
          note: `${noteBase} → ${toName}`,
          transferTfId: tf.id, transferRef: tf.tfRef || '',
          timestamp: serverTimestamp(),
        })
        // ปลายทาง: เพิ่ม
        batch.set(doc(collection(db, COL.STOCK_MOVEMENTS)), {
          type: 'transfer_recv', itemId: it.itemId, itemName: it.itemName,
          warehouseId: tf.toWarehouseId,
          qty: addQtyUse, qtyUse: addQtyUse,
          unit: unitUse, unitUse,
          staffPhone: window._bizSession?.phone || '', staffName: name,
          note: `${noteBase} ← ${fromName}`,
          transferTfId: tf.id, transferRef: tf.tfRef || '',
          timestamp: serverTimestamp(),
        })

        // ── 2. LOT TRACKING (FIFO) — sync ทั้ง 2 ฝั่ง ─────────────
        //   ต้นทาง: หัก LOT ตาม FIFO (รับก่อนใช้ก่อน)
        //   ปลายทาง: สร้าง/เพิ่ม LOT ใหม่ ผูกกับ parentLotId เพื่อ traceability
        const srcLots = sortLotsFIFO(
          lots.filter(l => l.itemId === it.itemId
            && l.warehouseId === tf.fromWarehouseId
            && (Number(l.inWarehouse) || 0) > 0
            && l.status !== 'split')
        )
        let remain = addQtyUse
        const allocations = []
        for (const lot of srcLots) {
          if (remain <= 0) break
          const avail = Number(lot.inWarehouse) || 0
          const take  = Math.min(avail, remain)
          if (take > 0) {
            allocations.push({ srcLot: lot, take })
            remain -= take
          }
        }
        // ถ้า LOT มีไม่พอ → log แต่ก็โอนตามที่กรอก (stock_balances ถูก deduct ไปแล้ว)
        if (remain > 0) {
          console.warn('[transfer] LOT ไม่พอ — โอนต่อ', { itemName: it.itemName, shortage: remain })
        }
        // Apply allocations
        for (const a of allocations) {
          // หัก src LOT
          const srcRef = doc(db, COL.LOT_TRACKING, a.srcLot.id)
          batch.update(srcRef, {
            inWarehouse: Math.max(0, (Number(a.srcLot.inWarehouse) || 0) - a.take),
            lastUpdated: serverTimestamp(),
          })
          // สร้าง/upsert dest LOT (id = srcLotId__to__destWH เพื่อกัน collision)
          const destLotId = `${a.srcLot.id}__to__${tf.toWarehouseId}`
          const destRef   = doc(db, COL.LOT_TRACKING, destLotId)
          const destSnap  = await getDoc(destRef)
          if (destSnap.exists()) {
            batch.update(destRef, {
              inWarehouse: (Number(destSnap.data().inWarehouse) || 0) + a.take,
              totalQty:    (Number(destSnap.data().totalQty) || 0) + a.take,
              lastUpdated: serverTimestamp(),
            })
          } else {
            batch.set(destRef, {
              itemId:      it.itemId,
              itemName:    it.itemName,
              warehouseId: tf.toWarehouseId,
              receiveDate: a.srcLot.receiveDate || '',
              mfgDate:     a.srcLot.mfgDate || '',
              expDate:     a.srcLot.expDate || '',
              totalQty:    a.take,
              inWarehouse: a.take,
              inShop:      0,
              used:        0,
              source:      a.srcLot.source || '',
              parentLotId: a.srcLot.id,            // ลิงก์กลับไป LOT แม่ที่คลังกลาง
              transferTfId: tf.id,
              transferRef: tf.tfRef || '',
              createdAt:   serverTimestamp(),
            })
          }
          lotTransfers.push({
            itemName: it.itemName,
            from: `#${a.srcLot.id.slice(-5)}`,
            to:   `#${destLotId.slice(-12)}`,
            take: a.take,
            unit: unitUse,
          })
        }
      }
      // อัปเดต TF
      batch.update(doc(db, COL.TRANSFER_ORDERS, tf.id), {
        status: 'received', receivedBy: name, receivedAt: serverTimestamp()
      })
      // อัปเดต RF → done
      // อัพเดท RF ทั้งหมดที่ link กับ TF นี้ → done (รองรับทั้ง array ใหม่ + legacy)
      const rfIdsToFinish = Array.isArray(tf.refillRequestIds) && tf.refillRequestIds.length
        ? tf.refillRequestIds
        : (tf.refillRequestId ? [tf.refillRequestId] : [])
      rfIdsToFinish.forEach(rfId => {
        if (rfId) batch.update(doc(db, COL.REFILL_REQUESTS, rfId), { status: 'done', completedAt: serverTimestamp() })
      })
      await batch.commit()
      const lotSummary = lotTransfers.length
        ? ` · LOT: ${lotTransfers.map(t => `${t.itemName} ${t.from}→${t.to.slice(-5)} -${t.take}${t.unit}`).join(', ').slice(0, 200)}`
        : ''
      await addDoc(collection(db, COL.AUDIT_LOGS), {
        action: 'transfer_received', staffName: name,
        detail: `รับสินค้า ${tf.tfRef || tf.id} จาก ${fromName} · คนนำส่ง: ${tf.driver || '-'} · รับโดย: ${name}${lotSummary}`,
        timestamp: serverTimestamp()
      })
      setReceiveTransferOpen(false)
      setReceivingTF(null)
      setToast(`✅ รับสินค้า ${tf.tfRef || ''} ครบถ้วน — stock + LOT อัปเดตทั้ง 2 คลัง`)
    } catch(e) {
      console.error(e); setToast('❌ เกิดข้อผิดพลาด')
    } finally {
      setReceivingSaving(false)
    }
  }

  const todayStr = toThaiDate()

  // Bell alert count: unresolved low_stock_alerts + expiring lots
  const unresolvedAlerts = alerts.filter(a => a.resolved !== true)
  // live count: นับจาก balances (item × wh ที่ qty ≤ minQty) — รวมทุกคลัง
  const liveAlertCount = balances.filter(b => {
    const wh = warehouses.find(w => w.id === b.warehouseId)
    if (!wh || wh.active === false) return false
    return (b.minQty || 0) > 0 && (b.qty || 0) <= (b.minQty || 0)
  }).length
  const alertCount = liveAlertCount + expAlerts.length

  async function dismissAlert(alertId) {
    await updateDoc(doc(db, COL.LOW_STOCK_ALERTS, alertId), { resolved: true })
  }

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

      {/* Date bar (bell ย้ายไป topbar แล้ว) */}
      <div style={{ padding: '10px 1rem 0' }}>
        <div style={{ fontSize: 12, color: 'var(--txt3)', fontWeight: 500 }}>{todayStr}</div>
      </div>

      {/* Warehouse segment — สาขา ก่อน, แล้วคลังกลาง, ทุกร้านท้ายสุด */}
      <div style={{ padding: '0 1rem' }}>
        <div className="segment">
          {[...warehouses]
            .sort((a, b) => {
              const ra = (a.type === 'main' || a.isMain) ? 1 : 0  // main → ทีหลัง
              const rb = (b.type === 'main' || b.isMain) ? 1 : 0
              return ra - rb
            })
            .map(w => (
              <button key={w.id} className={`seg-btn${wh === w.id ? ' active' : ''}`} onClick={() => setWh(w.id)}>
                {w.name}
              </button>
            ))}
          <button className={`seg-btn${wh === 'all' ? ' active' : ''}`} onClick={() => setWh('all')}>ทุกร้าน</button>
        </div>
      </div>

      {/* ⚡ Action grid (ย้ายมาบนสุดให้กดได้ทันที ไม่ต้องเลื่อนลง) */}
      <div>
        <div className="section-label">⚡ ทำรายการ</div>
        <div style={{ padding: '0 1rem' }}>
          <div className="action-grid">
            <button className="action-btn" onClick={() => isEditor() && setReceiveOpen(true)}>
              <span className="action-icon">📥</span>
              <span className="action-label">รับสินค้า</span>
            </button>
            <button className="action-btn" onClick={() => isEditor() && openTransferBlank()}>
              <span className="action-icon">🚚</span>
              <span className="action-label">โอนสินค้า</span>
            </button>
            <button className="action-btn" onClick={() => { setRefillStep('branch'); setRefillBranch(''); setRefillOpen(true) }}>
              <span className="action-icon" style={{ position: 'relative' }}>
                🧾
                {(() => {
                  const lowList = balances.filter(b => {
                    const wh = warehouses.find(w => w.id === b.warehouseId)
                    if (!wh || wh.active === false) return false
                    if (wh.type === 'main' || wh.isMain) return false
                    return (b.minQty || 0) > 0 && (b.qty || 0) <= (b.minQty || 0)
                  })
                  const lowCount = lowList.length
                  if (lowCount === 0) return null
                  const byBranch = {}
                  lowList.forEach(b => {
                    const wh = warehouses.find(w => w.id === b.warehouseId)
                    const it = items.find(i => i.id === b.itemId)
                    if (!wh || !it) return
                    if (!byBranch[wh.name]) byBranch[wh.name] = []
                    byBranch[wh.name].push(`${it.displayName || it.name} (เหลือ ${b.qty || 0}/ขั้นต่ำ ${b.minQty})`)
                  })
                  const tip = Object.entries(byBranch).map(([w, list]) =>
                    `📍 ${w} (${list.length}):\n  • ${list.slice(0,5).join('\n  • ')}${list.length>5?`\n  • ...(+${list.length-5})`:''}`
                  ).join('\n\n')
                  return (
                    <span title={`${lowCount} รายการที่ stock ≤ ขั้นต่ำ\n\n${tip}`}
                      style={{
                        position: 'absolute', top: -4, right: -4, background: 'var(--red)',
                        color: '#fff', borderRadius: '50%', width: 14, height: 14,
                        fontSize: 9, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        cursor: 'help',
                      }}>{lowCount}</span>
                  )
                })()}
              </span>
              <span className="action-label">แจ้งเติมของ</span>
            </button>
            <button className="action-btn" onClick={() => setWasteOpen(true)}>
              <span className="action-icon">🗑️</span>
              <span className="action-label">บันทึกของเสีย</span>
            </button>
          </div>
        </div>
      </div>

      {/* Hero card */}
      <div style={{ padding: '0 1rem' }}>
        <div className="hero-card">
          <div className="hero-label">มูลค่าใช้วัตถุดิบวันนี้ — {whName}</div>
          <div className="hero-val">฿{kpi.cost.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          <div className="hero-sub">เชื่อม Cost Manager · real-time</div>
        </div>
      </div>

      {/* KPI 2x2 */}
      <div style={{ padding: '0 1rem' }}>
        <div className="kpi-grid">
          <div className="kpi-card">
            <div className="kpi-label">ของเสียวันนี้</div>
            <div className="kpi-val" style={{ fontSize: 18, color: '#D97706' }}>
              ฿{kpi.wasteCost.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
            <div className="kpi-sub">{kpi.wasteCount} รายการ</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">ครั้งตัดวันนี้</div>
            <div className="kpi-val">{kpi.cuts}</div>
            <div className="kpi-sub">ครั้ง</div>
          </div>
          {(() => {
            // คำนวณ list ของ items ใกล้หมด / หมด สำหรับ tooltip
            const scoped = wh === 'all' ? balances : balances.filter(b => b.warehouseId === wh)
            const lowItems = []
            const outItems = []
            scoped.forEach(b => {
              const item = items.find(i => i.id === b.itemId)
              if (!item) return
              if (item.alertEnabled === false) return   // ❌ ปิดแจ้งเตือนรายการนี้
              const whName = warehouses.find(w => w.id === b.warehouseId)?.name || ''
              const tag = wh === 'all' ? ` (${whName})` : ''
              const unit = item.unitUse || b.unit || ''
              const min = Number(b.minQty) || 0
              // ถ้ามี minUnit + minQtyRaw → แสดง min ในหน่วยที่ user ตั้งจริง
              //   minUnit='buy' = unitBuy (Lv1), 'use' = unitUseRaw (Lv2), 'sub' = unitSub (Lv3)
              let minDisplay = `${min} ${unit}`
              if (b.minUnit && b.minQtyRaw != null) {
                const rawUnit =
                  b.minUnit === 'buy' ? (item.unitBuy || item.unitBase || unit) :
                  b.minUnit === 'use' ? (item.unitUseRaw || item.unitUse || unit) :
                  b.minUnit === 'sub' ? (item.unitSubRaw || item.unitSub || unit) :
                  unit
                if (rawUnit && rawUnit !== unit) {
                  minDisplay = `${b.minQtyRaw} ${rawUnit} (= ${min} ${unit})`
                } else {
                  minDisplay = `${b.minQtyRaw} ${rawUnit || unit}`
                }
              }
              const dispName = item.displayName || item.name
              if (b.qty <= 0) {
                outItems.push(`${dispName}${tag} — หมด${min > 0 ? ` · min ${minDisplay}` : ''}`)
              } else if (min > 0 && b.qty <= min) {
                let status = ''
                if (b.qty === min) status = '(พอดีขั้นต่ำ)'
                else if (b.qty <= min * 0.3) status = `(วิกฤต — ขาด ${(min - b.qty).toFixed(0)} ${unit})`
                else status = `(ขาด ${(min - b.qty).toFixed(0)} ${unit})`
                lowItems.push(`${dispName}${tag} — เหลือ ${b.qty} ${unit} · min ${minDisplay} ${status}`)
              }
            })
            // Card factory: เพิ่ม "i" icon + popover (hover desktop / tap mobile)
            // ใช้ timeout 250ms ตอน mouse leave → ให้ user เลื่อนเข้า popover ทันก่อนปิด
            const renderInfoCard = (key, label, list, color) => {
              const hasItems = list.length > 0
              const open = kpiPop === key && hasItems
              const closeTimer = window[`__kpi_${key}_timer`]
              const cancelClose = () => { if (closeTimer) { clearTimeout(closeTimer); window[`__kpi_${key}_timer`] = null } }
              const scheduleClose = () => {
                cancelClose()
                window[`__kpi_${key}_timer`] = setTimeout(() => setKpiPop(p => p === key ? null : p), 250)
              }
              return (
                <div className="kpi-card"
                  style={{ position: 'relative', cursor: hasItems ? 'pointer' : 'default' }}
                  onMouseEnter={() => { if (hasItems) { cancelClose(); setKpiPop(key) } }}
                  onMouseLeave={scheduleClose}
                  onClick={() => hasItems && setKpiPop(p => p === key ? null : key)}>
                  {/* i icon มุมขวาบน */}
                  {hasItems && (
                    <span style={{ position: 'absolute', top: 6, right: 6,
                      width: 18, height: 18, borderRadius: '50%',
                      background: open ? color : '#E5E7EB',
                      color: open ? '#fff' : '#6B7280',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 11, fontWeight: 700, fontStyle: 'italic',
                      transition: 'all .15s',
                    }}>i</span>
                  )}
                  <div className="kpi-label">{label}</div>
                  <div className="kpi-val" style={{ color }}>{list.length}</div>
                  <div className="kpi-sub">รายการ</div>
                  {/* Popover — แสดงเมื่อ open */}
                  {open && (
                    <div onClick={e => e.stopPropagation()}
                      onMouseEnter={cancelClose}
                      onMouseLeave={scheduleClose}
                      style={{ position: 'absolute', top: '100%', right: 0, marginTop: 8,
                        background: '#fff', border: `1.5px solid ${color}`,
                        borderRadius: 12, padding: '10px 12px', minWidth: 240, maxWidth: 320,
                        boxShadow: '0 8px 24px rgba(0,0,0,.15)', zIndex: 100,
                        fontSize: 11, animation: 'kpiPopIn .15s ease' }}>
                      <style>{`@keyframes kpiPopIn { from {opacity:0;transform:translateY(-4px)} to {opacity:1;transform:translateY(0)} }`}</style>
                      <div style={{ fontWeight: 800, color, marginBottom: 6, display: 'flex',
                        justifyContent: 'space-between', alignItems: 'center' }}>
                        <span>{label} ({list.length})</span>
                        <button onClick={() => setKpiPop(null)}
                          style={{ border: 'none', background: 'transparent', cursor: 'pointer',
                            fontSize: 14, color: '#9CA3AF', padding: 0, lineHeight: 1 }}>✕</button>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3,
                        maxHeight: 280, overflowY: 'auto' }}>
                        {list.slice(0, 30).map((s, i) => (
                          <div key={i} style={{ padding: '3px 0', borderBottom: i < list.length - 1 ? '1px solid #F3F4F6' : 'none', color: '#374151' }}>
                            • {s}
                          </div>
                        ))}
                        {list.length > 30 && (
                          <div style={{ padding: '4px 0', color: '#9CA3AF', textAlign: 'center', fontSize: 10 }}>
                            ...(+{list.length - 30} รายการ)
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
            }
            return (
              <>
                {renderInfoCard('low', 'ใกล้หมด', lowItems, '#D97706')}
                {renderInfoCard('out', 'หมดแล้ว', outItems, '#DC2626')}
              </>
            )
          })()}
        </div>
      </div>

      {/* ── Cut Stock Summary ── */}
      {(() => {
        // CSS animations (inject once)
        const animCSS = `
          @keyframes popIn    { from{opacity:0;transform:scale(.93)} to{opacity:1;transform:scale(1)} }
          @keyframes fadeOut  { from{opacity:1;transform:scale(1)}   to{opacity:0;transform:scale(.95)} }
          @keyframes rowIn    { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
          @keyframes chipIn   { from{opacity:0;transform:scale(.7) translateY(4px)} to{opacity:1;transform:scale(1) translateY(0)} }
          @keyframes badgePop { 0%{transform:scale(1)} 40%{transform:scale(1.35)} 70%{transform:scale(.92)} 100%{transform:scale(1)} }
          @keyframes cardFlash{ 0%{box-shadow:0 0 0 0 rgba(227,30,36,.6)} 60%{box-shadow:0 0 0 8px rgba(227,30,36,0)} 100%{box-shadow:0 1px 4px rgba(0,0,0,.04)} }
          @keyframes bdIn     { from{opacity:0} to{opacity:1} }
          @keyframes tickUp   { from{transform:translateY(6px);opacity:0} to{transform:translateY(0);opacity:1} }
        `

        // รวม items จาก todayCutLogs ทั้งหมด (สะสมยอด) — กรอง cancelled/deleted + staffFilter
        const accumulated = {}
        const staffSet = []
        todayCutLogs.forEach(log => {
          if (log.cancelled || log.deletedAt) return  // ข้าม log ที่ยกเลิกทั้งใบ
          const sn = log.staffName || log.staffPhone || '?'
          if (!staffSet.includes(sn)) staffSet.push(sn)
          if (staffFilter.size > 0 && !staffFilter.has(sn)) return   // 🔎 filter ตามคนตัด
          ;(log.items || []).forEach(it => {
            if (it.cancelled) return                   // ข้าม item ที่ยกเลิกราย-line
            const key = it.itemName || it.itemId
            const masterItem = items.find(i => i.id === it.itemId)
            if (accumulated[key]) accumulated[key].qty += (it.qtyUse || it.qty || 0)
            else accumulated[key] = {
              name: it.itemName || key,
              cat: masterItem?.category || 'อื่นๆ',
              sortOrder: masterItem?.sortOrder ?? 999,   // ใช้ sortOrder เรียงใน category
              qty: it.qtyUse || it.qty || 0,
              unit: it.unitUse || ''
            }
          })
        })
        const allItems = Object.values(accumulated).filter(it => it.qty > 0)
        const bycat = {}
        allItems.forEach(it => { if (!bycat[it.cat]) bycat[it.cat] = []; bycat[it.cat].push(it) })
        // เรียง items ใน category ตาม sortOrder (ตรงกับ Master Data)
        Object.keys(bycat).forEach(cat => {
          bycat[cat].sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999) || a.name.localeCompare(b.name, 'th'))
        })
        // ใช้ catOrder จาก Settings เป็นหลัก → fallback CAT_ORDER ถ้ายังไม่โหลด
        const ORDER = catOrder.length > 0 ? catOrder : CAT_ORDER
        const sortedCats = Object.keys(bycat).sort((a, b) => {
          const ai = ORDER.indexOf(a), bi = ORDER.indexOf(b)
          return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi)
        })
        const today = new Date().toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' })

        return (
          <div style={{ padding: '0 1rem' }}>
            <style>{animCSS}</style>

            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 800, color: 'var(--txt1)' }}>
                ✂️ ตัดสต็อกวันนี้
                {/* Badge with pop animation when count changes */}
                <span key={kpi.cuts} style={{
                  background: kpi.cuts > 0 ? 'var(--red)' : '#9CA3AF',
                  color: '#fff', borderRadius: 20, fontSize: 10, fontWeight: 700, padding: '2px 8px',
                  display: 'inline-block',
                  animation: kpi.cuts > 0 ? 'badgePop .4s cubic-bezier(.22,1,.36,1)' : 'none'
                }}>
                  {kpi.cuts} ครั้ง
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--txt3)', fontWeight: 600 }}>{today}</div>
            </div>

            {/* Card — flash border when new cut arrives */}
            <div key={todayCutLogs.length}
              onClick={() => allItems.length > 0 && setCutSummaryOpen(true)}
              style={{ background: '#fff', borderRadius: 16, border: '1px solid var(--border)',
                boxShadow: '0 1px 4px rgba(0,0,0,.04)', overflow: 'hidden',
                cursor: allItems.length > 0 ? 'pointer' : 'default',
                animation: todayCutLogs.length > 0 ? 'cardFlash .8s ease' : 'none',
                transition: 'box-shadow .3s' }}>

              {allItems.length === 0 ? (
                <div style={{ padding: '28px 0', textAlign: 'center', color: 'var(--txt3)', fontSize: 13, fontWeight: 600 }}>
                  <div style={{ fontSize: 30, marginBottom: 8, opacity: .5 }}>✂️</div>
                  ยังไม่มีการตัดสต็อกวันนี้
                </div>
              ) : (
                <>
                  {/* Staff chips — bounce-in stagger */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '10px 14px 8px' }}>
                    <span style={{ fontSize: 10, color: 'var(--txt3)', fontWeight: 700 }}>โดย</span>
                    {staffSet.map((s, i) => (
                      <div key={s} style={{
                        background: '#F3F4F6', borderRadius: 20, padding: '3px 10px',
                        fontSize: 11, color: '#374151', fontWeight: 600,
                        display: 'flex', alignItems: 'center', gap: 4,
                        animation: 'chipIn .35s cubic-bezier(.22,1,.36,1) both',
                        animationDelay: `${i * 60}ms`
                      }}>
                        <div style={{
                          width: 16, height: 16, borderRadius: '50%',
                          background: AV_COLORS[i % AV_COLORS.length],
                          color: '#fff', fontSize: 9, display: 'flex', alignItems: 'center',
                          justifyContent: 'center', fontWeight: 800
                        }}>{s.charAt(0)}</div>
                        {s}
                      </div>
                    ))}
                  </div>

                  {/* Category rows — stagger slide-up */}
                  {sortedCats.map((cat, idx) => (
                    <div key={cat} style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px',
                      borderTop: '1px solid var(--bg)',
                      animation: 'rowIn .35s ease both',
                      animationDelay: `${idx * 55}ms`
                    }}>
                      <span style={{ fontSize: 19, width: 26, textAlign: 'center', flexShrink: 0 }}>{CAT_EMOJI[cat] || '📦'}</span>
                      <span style={{ flex: 1, fontSize: 13, fontWeight: 700, color: 'var(--txt1)' }}>{cat}</span>
                      {/* Count badge — tick-up when value changes */}
                      <span key={bycat[cat].length} style={{
                        fontSize: 12, fontWeight: 700, color: '#6366F1',
                        background: '#EEF2FF', borderRadius: 20, padding: '2px 9px', flexShrink: 0,
                        animation: 'tickUp .25s ease both'
                      }}>
                        {bycat[cat].length} รายการ
                      </span>
                    </div>
                  ))}

                  {/* Footer */}
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '9px 14px', background: 'var(--bg)', borderTop: '1px solid var(--border)'
                  }}>
                    <span style={{ fontSize: 11, color: 'var(--txt3)', fontWeight: 600 }}>
                      รวม {allItems.length} รายการ · {kpi.cuts} ครั้ง
                    </span>
                    <span style={{ fontSize: 11, color: '#6366F1', fontWeight: 700 }}>กดดูรายละเอียด ›</span>
                  </div>
                </>
              )}
            </div>

            {/* ── Popup ── */}
            {cutSummaryOpen && (
              <div onClick={() => setCutSummaryOpen(false)}
                style={{
                  position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 200,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  paddingBottom: 68, paddingLeft: 16, paddingRight: 16,
                  animation: 'bdIn .2s ease'
                }}>
                <div onClick={e => e.stopPropagation()}
                  style={{
                    background: '#fff', borderRadius: 20,
                    width: 'min(560px, 92vw)',                /* PC กว้างขึ้น */
                    maxHeight: 'min(78vh, 720px)',             /* PC สูงขึ้น */
                    minHeight: 280, display: 'flex', flexDirection: 'column',
                    boxShadow: '0 8px 40px rgba(0,0,0,.22)',
                    animation: 'popIn .28s cubic-bezier(.22,1,.36,1)'
                  }}>

                  {/* Popup Header */}
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '12px 16px 10px', borderBottom: '1px solid var(--border)', flexShrink: 0
                  }}>
                    <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--txt1)' }}>📋 สรุปตัดสต็อกวันนี้</div>
                    <button onClick={() => setCutSummaryOpen(false)}
                      style={{ border: 'none', background: '#F3F4F6', borderRadius: '50%', width: 28, height: 28,
                        fontSize: 13, cursor: 'pointer', color: '#555', display:'flex', alignItems:'center', justifyContent:'center' }}>✕</button>
                  </div>

                  <div style={{ overflowY: 'auto', flex: 1, WebkitOverflowScrolling: 'touch' }}>
                    {/* Staff row */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
                      padding: '10px 16px 8px', borderBottom: '1px solid var(--bg)' }}>
                      <span style={{ fontSize: 10, color: 'var(--txt3)', fontWeight: 700, marginRight: 2 }}>🔎 กรองคนตัด</span>
                      {/* "ทั้งหมด" — ล้าง filter */}
                      <button onClick={() => setStaffFilter(new Set())}
                        style={{
                          border: 'none', cursor: 'pointer',
                          background: staffFilter.size === 0 ? 'var(--red)' : '#F3F4F6',
                          color:      staffFilter.size === 0 ? '#fff' : '#374151',
                          borderRadius: 20, padding: '3px 10px', fontSize: 11, fontWeight: 700,
                        }}>
                        ทั้งหมด
                      </button>
                      {staffSet.map((s, i) => {
                        const active = staffFilter.has(s)
                        return (
                          <button key={s} onClick={() => setStaffFilter(prev => {
                            const n = new Set(prev)
                            n.has(s) ? n.delete(s) : n.add(s)
                            return n
                          })}
                            style={{
                              background: active ? AV_COLORS[i % AV_COLORS.length] : '#F3F4F6',
                              color: active ? '#fff' : '#374151',
                              border: 'none', cursor: 'pointer',
                              borderRadius: 20, padding: '3px 10px',
                              fontSize: 11, fontWeight: 600,
                              display: 'flex', alignItems: 'center', gap: 4,
                              animation: 'chipIn .3s cubic-bezier(.22,1,.36,1) both',
                              animationDelay: `${i * 50}ms`
                            }}>
                            <div style={{ width: 16, height: 16, borderRadius: '50%',
                              background: active ? 'rgba(255,255,255,.3)' : AV_COLORS[i % AV_COLORS.length],
                              color: '#fff', fontSize: 9, display: 'flex', alignItems: 'center',
                              justifyContent: 'center', fontWeight: 800 }}>
                              {s.charAt(0)}
                            </div>
                            {s}
                            {active && <span style={{ fontSize: 9 }}>✓</span>}
                          </button>
                        )
                      })}
                    </div>

                    {/* Items by category — stagger */}
                    {sortedCats.map((cat, ci) => (
                      <div key={cat}>
                        <div style={{
                          display: 'flex', alignItems: 'center', gap: 8,
                          padding: '10px 16px 8px',
                          background: '#F8F8F8',                       /* solid (no transparency) */
                          position: 'sticky', top: 0, zIndex: 10,
                          borderTop: '1px solid #EAEAEA',
                          borderBottom: '1px solid #EAEAEA',
                          boxShadow: '0 2px 6px rgba(0,0,0,0.04)',     /* ช่วยแยกชั้น */
                        }}>
                          <span style={{ fontSize: 15 }}>{CAT_EMOJI[cat] || '📦'}</span>
                          <span style={{ fontSize: 12, fontWeight: 800, color: '#1C1C1E',
                            letterSpacing: '.4px', flex: 1 }}>{cat}</span>
                          <span style={{ fontSize: 10, color: 'var(--txt3)', fontWeight: 600 }}>{bycat[cat].length} รายการ</span>
                        </div>
                        {bycat[cat].map((it, idx) => (
                          <div key={it.name} style={{
                            display: 'flex', alignItems: 'center', gap: 8,
                            padding: '7px 16px 7px 36px', borderTop: '1px solid var(--bg)',
                            animation: 'rowIn .3s ease both',
                            animationDelay: `${ci * 40 + (idx + 1) * 35}ms`
                          }}>
                            <span style={{ flex: 1, fontSize: 13, color: 'var(--txt1)', fontWeight: 600 }}>{it.name}</span>
                            <div style={{ flex: 1, borderBottom: '1.5px dotted #E5E7EB', margin: '0 6px',
                              alignSelf: 'flex-end', marginBottom: 4, maxWidth: 60 }} />
                            <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--red)', whiteSpace: 'nowrap' }}>{it.qty}</span>
                            <span style={{ fontSize: 11, color: 'var(--txt3)', fontWeight: 600, whiteSpace: 'nowrap' }}>{it.unit}</span>
                          </div>
                        ))}
                      </div>
                    ))}

                    {/* Total */}
                    <div style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      margin: '8px 16px 12px', padding: '10px 14px', background: 'var(--bg)', borderRadius: 12,
                      animation: 'rowIn .3s ease both', animationDelay: `${sortedCats.length * 40 + 80}ms`
                    }}>
                      <span style={{ fontSize: 12, color: 'var(--txt3)', fontWeight: 600 }}>รวมทั้งหมด</span>
                      <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--txt1)' }}>
                        {allItems.length} รายการ · {kpi.cuts} ครั้ง
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )
      })()}

      {/* ── Flow Status Cards ── */}
      {(() => {
        const rfPending    = refillRequests.filter(r => r.status === 'pending')
        const rfProcessing = refillRequests.filter(r => r.status === 'processing')
        const tfInTransit  = transfers.filter(t => t.status === 'in_transit')
        const lowAlerts    = alerts.filter(a => a.resolved !== true)
        const hasAny = rfPending.length || rfProcessing.length || tfInTransit.length || lowAlerts.length || expAlerts.length

        const FlowCard = ({ icon, title, sub, badge, badgeColor, badgeBg, borderColor, bg, onClick }) => (
          <div onClick={onClick}
            style={{ background: bg || '#fff', border: `1.5px solid ${borderColor || 'var(--border)'}`,
              borderRadius: 14, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12,
              cursor: onClick ? 'pointer' : 'default', flexShrink: 0 }}>
            <span style={{ fontSize: 24, flexShrink: 0 }}>{icon}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--txt)' }}>{title}</div>
              {sub && <div style={{ fontSize: 11, color: 'var(--txt3)', marginTop: 2 }}>{sub}</div>}
            </div>
            {badge != null && (
              <span style={{ background: badgeBg || '#F3F4F6', color: badgeColor || '#6B7280',
                borderRadius: 20, padding: '3px 10px', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>
                {badge}
              </span>
            )}
          </div>
        )

        return (
          <div style={{ padding: '0 1rem' }}>
            <div className="section-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              ⚠️ แจ้งเตือน / สถานะเตรียมของ
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>

              {/* RF pending — summary chip เท่านั้น */}
              {rfPending.length > 0 && (
                <FlowCard
                  icon="📋" bg="#FFFBEB" borderColor="#FCD34D"
                  title="คำร้องแจ้งเติมของ"
                  sub={`มี ${rfPending.length} คำร้องรอดำเนินการ — เลื่อนลงเพื่อดูรายละเอียด`}
                  badge={rfPending.length} badgeBg="#FEF3C7" badgeColor="#D97706"
                />
              )}

              {/* RF processing — มีใบโอนแล้ว กำลังเตรียม */}
              {rfProcessing.length > 0 && (
                <FlowCard
                  icon="📦" bg="#EFF6FF" borderColor="#BFDBFE"
                  title="กำลังเตรียมสินค้า"
                  sub={rfProcessing.map(r => `${r.rfRef||''} → ${r.tfRef||'มีใบโอนแล้ว'}`).join(' · ')}
                  badge={rfProcessing.length} badgeBg="#DBEAFE" badgeColor="#1D4ED8"
                />
              )}

              {/* TF in_transit — กำลังนำส่ง รอตรวจรับ */}
              {tfInTransit.length > 0 && (
                <FlowCard
                  icon="🚚" bg="#F0FDF4" borderColor="#86EFAC"
                  title="สินค้ากำลังนำส่ง — รอตรวจรับ"
                  sub={tfInTransit.map(t =>
                    `${t.tfRef || t.id.slice(-6)} · ${t.fromWarehouseName||'คลัง'} → ${t.toWarehouseName||'ร้าน'}`
                  ).join('\n')}
                  badge={tfInTransit.length} badgeBg="#DCFCE7" badgeColor="#16A34A"
                  onClick={() => tfInTransit.length === 1 ? openReceiveTransfer(tfInTransit[0]) : undefined}
                />
              )}

              {/* Low stock */}
              {lowAlerts.length > 0 && (
                <div>
                  <div style={{ display: 'flex', gap: 6, overflowX: 'auto',
                    scrollbarWidth: 'none', paddingBottom: 2 }}>
                    {lowAlerts.map(a => (
                      <div key={a.id} style={{ flexShrink: 0, borderRadius: 20, padding: '5px 12px',
                        fontSize: 11, fontWeight: 700,
                        background: a.currentQty <= 0 ? '#FEE2E2' : '#FFF7ED',
                        border: `1px solid ${a.currentQty <= 0 ? '#FCA5A5' : '#FDE68A'}`,
                        color: a.currentQty <= 0 ? '#DC2626' : '#92600A' }}>
                        {a.currentQty <= 0 ? '🔴' : '🟡'} {a.itemName}
                        <span style={{ opacity: 0.7, marginLeft: 4 }}>เหลือ {a.currentQty} {a.unit||''}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* EXP alerts */}
              {expAlerts.length > 0 && (
                <div style={{ display: 'flex', gap: 6, overflowX: 'auto',
                  scrollbarWidth: 'none', paddingBottom: 2 }}>
                  {expAlerts.map(lot => (
                    <div key={lot.id} style={{ flexShrink: 0, borderRadius: 20, padding: '5px 12px',
                      fontSize: 11, fontWeight: 700,
                      background: lot.daysLeft <= 0 ? '#FEE2E2' : '#FFFBEB',
                      border: `1px solid ${lot.daysLeft <= 0 ? '#FCA5A5' : '#FDE68A'}`,
                      color: lot.daysLeft <= 0 ? '#DC2626' : '#B45309' }}>
                      🗓️ {lot.itemName}
                      <span style={{ opacity: 0.7, marginLeft: 4 }}>
                        {lot.daysLeft <= 0 ? 'หมดอายุแล้ว' : `EXP ${lot.daysLeft}d`}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* ทุกอย่างปกติ */}
              {!hasAny && (
                <div style={{ padding: '10px 14px', background: '#F9FAFB',
                  border: '1px dashed var(--border2)', borderRadius: 12,
                  fontSize: 12, color: 'var(--txt3)', textAlign: 'center' }}>
                  ✅ ทุกอย่างปกติ ไม่มีรายการรอดำเนินการ
                </div>
              )}
            </div>
          </div>
        )
      })()}

      {/* ── Section: ใบแจ้งเติมของรอดำเนินการ (Owner เท่านั้น) ── */}
      {isOwner() && refillRequests.filter(r => r.status === 'pending').length > 0 && (() => {
        const pendingRFs = refillRequests.filter(r => r.status === 'pending')
          .sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0)) // เก่าสุดขึ้นก่อน
        const allSelected  = pendingRFs.every(r => rfSelectedIds.has(r.id))
        const someSelected = rfSelectedIds.size > 0
        const selectedRFs  = pendingRFs.filter(r => rfSelectedIds.has(r.id))

        function toggleRF(id) {
          setRfSelectedIds(prev => {
            const next = new Set(prev)
            next.has(id) ? next.delete(id) : next.add(id)
            return next
          })
        }
        function toggleAll() {
          setRfSelectedIds(allSelected ? new Set() : new Set(pendingRFs.map(r => r.id)))
        }

        return (
          <div>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 1rem' }}>
              <div className="section-label" style={{ padding: 0, marginBottom: 0, flex: 1 }}>
                📋 คำร้องแจ้งเติมของ
              </div>
              <span style={{ background: '#FFF7ED', color: '#D97706', border: '1px solid #FDE68A',
                borderRadius: 10, padding: '2px 8px', fontSize: 11, fontWeight: 700 }}>
                {pendingRFs.length} ใบ
              </span>
              {/* เลือกทั้งหมด */}
              <button onClick={toggleAll}
                style={{ fontSize: 11, fontWeight: 600, color: allSelected ? '#DC2626' : '#6B7280',
                  background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px' }}>
                {allSelected ? '✗ ยกเลิกทั้งหมด' : '☑ เลือกทั้งหมด'}
              </button>
            </div>

            {/* RF Cards */}
            <div style={{ padding: '8px 1rem 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {pendingRFs.map(rf => {
                const sel = rfSelectedIds.has(rf.id)
                // แปลงเวลา
                const ts = rf.createdAt?.seconds
                  ? new Date(rf.createdAt.seconds * 1000)
                  : null
                const timeStr = ts
                  ? `${ts.getDate()}/${ts.getMonth()+1} เวลา ${String(ts.getHours()).padStart(2,'0')}:${String(ts.getMinutes()).padStart(2,'0')} น.`
                  : ''
                return (
                  <div key={rf.id}
                    onClick={() => toggleRF(rf.id)}
                    style={{ background: sel ? '#FFFBEB' : '#fff', borderRadius: 14,
                      border: `2px solid ${sel ? '#F59E0B' : '#FDE68A'}`,
                      boxShadow: sel ? '0 0 0 3px rgba(245,158,11,0.15)' : '0 1px 4px rgba(0,0,0,0.05)',
                      padding: 14, cursor: 'pointer', transition: 'all 0.15s' }}>

                    {/* Row 1: Checkbox + Ref + Badge + 🗑️ */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                      {/* Checkbox custom */}
                      <div style={{ width: 22, height: 22, borderRadius: 6, border: `2px solid ${sel ? '#F59E0B' : '#D1D5DB'}`,
                        background: sel ? '#F59E0B' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexShrink: 0, transition: 'all 0.15s' }}>
                        {sel && <span style={{ color: '#fff', fontSize: 13, fontWeight: 900 }}>✓</span>}
                      </div>
                      <span style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 13, flex: 1 }}>
                        {rf.rfRef || rf.id.slice(-8)}
                      </span>
                      <span style={{ fontSize: 10, background: '#FFF7ED', color: '#D97706',
                        border: '1px solid #FDE68A', borderRadius: 6, padding: '2px 7px', fontWeight: 700 }}>
                        🟡 รอดำเนินการ
                      </span>
                      {/* ปุ่มลบ */}
                      <button
                        onClick={e => { e.stopPropagation()
                          setRfDeleteId(rfDeleteId === rf.id ? null : rf.id)
                          setRfDeleteReason('')
                        }}
                        style={{ width: 28, height: 28, border: 'none', borderRadius: 8, cursor: 'pointer',
                          background: rfDeleteId === rf.id ? '#FEE2E2' : '#F3F4F6',
                          color: rfDeleteId === rf.id ? '#DC2626' : '#9CA3AF',
                          fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center',
                          flexShrink: 0, transition: 'all 0.15s' }}>
                        🗑️
                      </button>
                    </div>

                    {/* Row 2: แจ้งโดย + เวลา */}
                    <div style={{ display: 'flex', gap: 8, marginBottom: 8, marginLeft: 32 }}>
                      <span style={{ fontSize: 11, color: '#374151', fontWeight: 600 }}>
                        👤 {rf.requestedBy || 'ไม่ระบุ'}
                      </span>
                      {timeStr && (
                        <span style={{ fontSize: 11, color: '#6B7280' }}>· 🕐 {timeStr}</span>
                      )}
                    </div>

                    {/* Row 3: รายการ chips */}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginLeft: 32, marginBottom: rfDeleteId === rf.id ? 10 : 0 }}>
                      {(rf.items || []).map((it, i) => (
                        <span key={i} style={{ fontSize: 11, background: '#F3F4F6',
                          borderRadius: 6, padding: '3px 8px', border: '1px solid #E5E7EB' }}>
                          {it.img} {it.itemName}
                          {it.qty > 0
                            ? <span style={{ color: '#D97706', fontWeight: 700 }}> ×{it.qty} {it.unit}</span>
                            : null}
                        </span>
                      ))}
                    </div>

                    {/* Inline Delete Confirm */}
                    {rfDeleteId === rf.id && (
                      <div onClick={e => e.stopPropagation()}
                        style={{ marginTop: 4, padding: '10px 12px', background: '#FEF2F2',
                          borderRadius: 10, border: '1px solid #FECACA' }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: '#DC2626', marginBottom: 6 }}>
                          🗑️ ยืนยันยกเลิกคำร้อง {rf.rfRef}?
                        </div>
                        <input
                          value={rfDeleteReason}
                          onChange={e => setRfDeleteReason(e.target.value)}
                          placeholder="ระบุเหตุผล (ต้องกรอก)..."
                          style={{ width: '100%', padding: '8px 10px', borderRadius: 8,
                            border: '1.5px solid #FCA5A5', fontSize: 12, fontFamily: 'Sarabun',
                            outline: 'none', boxSizing: 'border-box', marginBottom: 8 }}
                        />
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button onClick={() => { setRfDeleteId(null); setRfDeleteReason('') }}
                            style={{ flex: 1, padding: '8px 0', border: '1px solid #D1D5DB',
                              borderRadius: 8, background: '#fff', fontSize: 12,
                              fontWeight: 600, cursor: 'pointer', color: '#6B7280' }}>
                            ยกเลิก
                          </button>
                          <button
                            onClick={() => deleteRF(rf.id, rf.rfRef, rfDeleteReason)}
                            disabled={rfDeleting || rfDeleteReason.trim().length < 3}
                            style={{ flex: 2, padding: '8px 0', border: 'none', borderRadius: 8,
                              background: rfDeleteReason.trim().length < 3 ? '#FCA5A5' : '#DC2626',
                              color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                              opacity: rfDeleting ? 0.6 : 1 }}>
                            {rfDeleting ? 'กำลังลบ...' : '🗑️ ยืนยันลบ + บันทึก Log'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {/* ── Sticky bar: สร้างใบโอนรวม ── */}
            {someSelected && (
              <div style={{ position: 'sticky', bottom: 72, zIndex: 50,
                margin: '12px 1rem 0', padding: '12px 16px',
                background: 'linear-gradient(135deg,#DC2626,#B91C1C)',
                borderRadius: 14, boxShadow: '0 4px 16px rgba(220,38,38,0.4)',
                display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ color: '#fff', fontWeight: 700, fontSize: 14, fontFamily: 'Prompt' }}>
                    🚚 สร้างใบโอนรวม ({rfSelectedIds.size} ใบ)
                  </div>
                  <div style={{ color: 'rgba(255,255,255,0.8)', fontSize: 11, marginTop: 2 }}>
                    {selectedRFs.reduce((n, r) => n + (r.items?.length || 0), 0)} รายการ
                    {rfSelectedIds.size > 1 && ' · รวม qty อัตโนมัติ'}
                  </div>
                </div>
                <button
                  onClick={e => { e.stopPropagation(); openTransferFromRFs(selectedRFs) }}
                  style={{ background: '#fff', color: '#DC2626', border: 'none', borderRadius: 10,
                    padding: '10px 18px', fontWeight: 700, fontSize: 13, cursor: 'pointer',
                    fontFamily: 'Prompt', flexShrink: 0 }}>
                  ดำเนินการ →
                </button>
              </div>
            )}
          </div>
        )
      })()}

      {/* ── Section: ใบโอนกำลังนำส่ง (in_transit) ── */}
      {transfers.filter(t => t.status === 'in_transit').length > 0 && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 1rem' }}>
            <div className="section-label" style={{ padding: 0, marginBottom: 0, flex: 1 }}>🚚 กำลังนำส่ง</div>
            <span style={{ background: '#DCFCE7', color: '#16A34A', borderRadius: 10,
              padding: '2px 8px', fontSize: 11, fontWeight: 700 }}>
              {transfers.filter(t => t.status === 'in_transit').length}
            </span>
          </div>
          <div style={{ padding: '8px 1rem 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {transfers.filter(t => t.status === 'in_transit').map(tf => {
              const fromName = warehouses.find(w => w.id === tf.fromWarehouseId)?.name || tf.fromWarehouseName || 'คลัง'
              const toName   = warehouses.find(w => w.id === tf.toWarehouseId)?.name   || tf.toWarehouseName   || 'ร้าน'
              return (
                <div key={tf.id} style={{ background: '#fff', borderRadius: 14,
                  border: '1px solid #BBF7D0', boxShadow: '0 1px 4px rgba(0,0,0,0.05)', padding: 14 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <span style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 13 }}>{tf.tfRef || tf.id.slice(-6)}</span>
                    <span style={{ fontSize: 10, background: '#DCFCE7', color: '#16A34A',
                      borderRadius: 6, padding: '2px 7px', fontWeight: 700 }}>🟢 กำลังนำส่ง</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--txt2)', marginBottom: 6 }}>
                    {fromName} → {toName}
                    {tf.driver ? <span style={{ color: '#6B7280' }}> · 🧑 {tf.driver}</span> : null}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--txt3)', marginBottom: 10 }}>
                    {tf.items?.length || 0} รายการ
                    {tf.items?.slice(0, 3).map((it, i) => (
                      <span key={i} style={{ marginLeft: 6 }}>{it.img}{it.itemName}</span>
                    ))}
                    {(tf.items?.length || 0) > 3 && <span> +{tf.items.length - 3}</span>}
                  </div>
                  {isEditor() && (
                    <button onClick={() => openReceiveTransfer(tf)}
                      style={{ width: '100%', background: '#16A34A', color: '#fff', border: 'none',
                        borderRadius: 10, padding: '10px 0', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                      📋 ตรวจรับสินค้า
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Modal: รับสินค้า */}
      <Modal open={receiveOpen} onClose={() => setReceiveOpen(false)} title="รับสินค้าเข้าคลัง"
        lockClose={true}
        footer={rcv.itemId && <button className="btn-primary" onClick={submitReceive} disabled={receiveSaving}>{receiveSaving ? 'กำลังบันทึก...' : '✅ บันทึกรับสินค้า'}</button>}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Item Picker — แสดงยอดของคลังกลาง (เพราะรับสินค้าเข้าคลังกลางเสมอ) */}
          <ItemPickerGrid items={items} balances={balances}
            warehouseId={warehouses.find(w => w.type === 'main' || w.isMain)?.id || null}
            selectedId={rcv.itemId}
            onSelect={item => setRcv(r => ({ ...r, itemId: item.id, unit: item.unitBuy || item.unitBase || '' }))} />
          {/* Form — แสดงเมื่อเลือกแล้ว */}
          {rcv.itemId && (() => {
            const item = items.find(i => i.id === rcv.itemId)
            return (
              <div style={{ background: 'var(--bg)', borderRadius: 12, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{item?.img} {item?.name}</div>
                {/* หน่วย chips */}
                <div>
                  <label className="fi-label">หน่วย</label>
                  <UnitChips
                    opts={getUnitOptions(items.find(i => i.id === rcv.itemId))}
                    selected={rcv.unit}
                    onChange={u => setRcv(r => ({ ...r, unit: u }))}
                  />
                </div>
                {/* จำนวน + วันที่รับ side-by-side */}
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
                  <div>
                    <label className="fi-label">จำนวน</label>
                    <PosQty
                      value={parseFloat(rcv.qty) || 0}
                      onChange={v => setRcv(r => ({ ...r, qty: String(v) }))}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label className="fi-label">วันที่รับ</label>
                    <input className="fi" type="date" value={rcv.receiveDate}
                      onChange={e => setRcv(r => ({ ...r, receiveDate: e.target.value }))} />
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <div style={{ flex: 1 }}>
                    <label className="fi-label">MFG</label>
                    <input className="fi" type="date" value={rcv.mfgDate}
                      onChange={e => setRcv(r => ({ ...r, mfgDate: e.target.value }))} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label className="fi-label">EXP</label>
                    <input className="fi" type="date" value={rcv.expDate}
                      onChange={e => setRcv(r => ({ ...r, expDate: e.target.value }))} />
                  </div>
                </div>
                <div>
                  <label className="fi-label">แหล่งที่มา</label>
                  <select className="fi" value={rcv.source} onChange={e => setRcv(r => ({ ...r, source: e.target.value }))}>
                    {sources.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              </div>
            )
          })()}
        </div>
      </Modal>

      {/* ══ Modal: แจ้งเติมของ — Step 1: เลือกสาขา / Step 2: เลือก item ══ */}
      <Modal open={refillOpen}
        onClose={() => { setRefillOpen(false); setRefillSelected(new Set()); setRefillQtys({}); setRefillUnits({}); setRefillCat('low'); setRefillStep('branch'); setRefillBranch('') }}
        title={refillStep === 'branch' ? 'แจ้งเติมของ — เลือกสาขา' : `แจ้งเติมของ — ${warehouses.find(w => w.id === refillBranch)?.name || ''}`}
        lockClose={true}
        footer={refillStep === 'branch'
          ? (
            <button className="btn-primary"
              disabled={!refillBranch}
              style={{ opacity: refillBranch ? 1 : 0.4 }}
              onClick={() => refillBranch && setRefillStep('item')}>
              ถัดไป → เลือกรายการ
            </button>
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => { setRefillStep('branch'); setRefillSelected(new Set()); setRefillQtys({}) }}
                style={{ flex: '0 0 auto', border: '1.5px solid var(--border)', borderRadius: 12,
                  padding: '12px 16px', fontSize: 13, background: 'var(--bg)',
                  color: 'var(--txt2)', cursor: 'pointer', fontWeight: 600 }}>
                ← สาขา
              </button>
              <button className="btn-primary" onClick={submitRefill}
                disabled={refillSaving || refillSelected.size === 0}
                style={{ flex: 1, opacity: refillSaving || refillSelected.size === 0 ? 0.5 : 1 }}>
                {refillSaving ? 'กำลังส่ง...' : `🧾 แจ้งเติมของ (${refillSelected.size} รายการ)`}
              </button>
            </div>
          )
        }>

        {/* ── Step 1: เลือกสาขา ─────────────────────────── */}
        {refillStep === 'branch' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 13, color: '#92400E', background: '#FFF7ED',
              borderRadius: 10, padding: '10px 14px', border: '1px solid #FDE68A' }}>
              🏪 เลือกสาขาที่ต้องการแจ้งเติมของ
            </div>
            {warehouses
              .filter(w => w.active !== false)
              .filter(w => !(w.type === 'main' || w.isMain))   // ❌ ไม่แสดงคลังกลาง — ใช้รับสินค้าแทน
              .map(wh => {
              const selected = refillBranch === wh.id
              const lowCount = items.filter(item => {
                const bal = balances.find(b => b.itemId === item.id && b.warehouseId === wh.id)
                const qty = bal?.qty || 0
                const min = bal?.minQty || 0
                return min > 0 && qty <= min       // ต้องมี minQty ตั้งไว้ + qty ≤ min
              }).length
              return (
                <button key={wh.id} onClick={() => setRefillBranch(wh.id)}
                  style={{ display: 'flex', alignItems: 'center', gap: 14,
                    padding: '14px 16px', borderRadius: 14, cursor: 'pointer',
                    border: `2px solid ${selected ? '#F59E0B' : 'var(--border)'}`,
                    background: selected ? '#FFFBEB' : 'var(--bg)',
                    transition: 'all .15s', textAlign: 'left', width: '100%' }}>
                  {/* Radio circle */}
                  <div style={{ width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
                    border: `2px solid ${selected ? '#F59E0B' : 'var(--border2)'}`,
                    background: selected ? '#F59E0B' : '#fff',
                    display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {selected && <span style={{ color: '#fff', fontSize: 14, fontWeight: 800, lineHeight: 1 }}>✓</span>}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 15, color: selected ? '#92600A' : 'var(--txt1)' }}>
                      🏪 {wh.name}
                    </div>
                    <div style={{ fontSize: 11, marginTop: 3,
                      color: lowCount > 0 ? '#DC2626' : '#16A34A', fontWeight: 600 }}>
                      {lowCount > 0 ? `⚠️ Stock ต่ำ/หมด ${lowCount} รายการ` : '✅ Stock ปกติทุกรายการ'}
                    </div>
                  </div>
                  {selected && <span style={{ fontSize: 18 }}>→</span>}
                </button>
              )
            })}
          </div>
        )}

        {/* ── Step 2: เลือก item ────────────────────────── */}
        {refillStep === 'item' && <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* Branch pill */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            background: '#FFF7ED', borderRadius: 10, padding: '8px 12px', border: '1px solid #FDE68A' }}>
            <span style={{ fontSize: 12, color: '#92400E', fontWeight: 600 }}>
              🏪 {warehouses.find(w => w.id === refillBranch)?.name} · เลือกรายการที่ต้องการเติม
            </span>
          </div>
          {(() => {
            // กรอง balances เฉพาะสาขาที่เลือก
            const branchBal = refillBranch
              ? balances.filter(b => b.warehouseId === refillBranch)
              : balances
            // helper: หา min ของ item ในสาขานี้
            const getMin = (itemId) => {
              const b = branchBal.find(b => b.itemId === itemId)
              return b?.minQty || 0
            }
            // เรียงตาม Master Data (sortOrder)
            const sortBySortOrder = (a, b) =>
              (a.sortOrder ?? 999) - (b.sortOrder ?? 999) ||
              (a.name || '').localeCompare(b.name || '', 'th')
            const allItems = items.filter(item => {
              const qty = branchBal.filter(b => b.itemId === item.id).reduce((s,b) => s+(b.qty||0),0)
              return qty <= getMin(item.id)
            }).sort(sortBySortOrder)
            const others = items.filter(item => {
              const qty = branchBal.filter(b => b.itemId === item.id).reduce((s,b) => s+(b.qty||0),0)
              return qty > getMin(item.id)
            }).sort(sortBySortOrder)
            const renderItem = (item) => {
              const stockQty = branchBal.filter(b => b.itemId === item.id).reduce((s,b) => s+(b.qty||0),0)
              const minQ     = getMin(item.id)
              const checked  = refillSelected.has(item.id)
              const isOut    = stockQty <= 0
              const currentQty  = refillQtys[item.id]  || 0
              // unit options — ใช้ raw 3 levels (เพื่อให้ user เลือก unit สั่งเติมได้)
              const u1 = item.unitBuy || item.unitBase || ''
              const u2 = item.unitUseRaw || item.unitUse || ''
              const u3 = item.unitSubRaw || item.unitSub || ''
              const unitOpts = []
              if (u1) unitOpts.push(u1)
              if (u2 && u2 !== u1) unitOpts.push(u2)
              if (u3 && u3 !== u1 && u3 !== u2) unitOpts.push(u3)
              // default: หน่วยที่ใหญ่ที่สุด (ลัง) — สั่งซื้อทีละลัง
              const selectedUnit = refillUnits[item.id] || u1 || unitOpts[0] || ''

              function toggleCheck(e) {
                e.stopPropagation()
                setRefillSelected(prev => {
                  const n = new Set(prev)
                  if (n.has(item.id)) { n.delete(item.id) } else {
                    n.add(item.id)
                    // set default qty=1 if not set
                    setRefillQtys(q => q[item.id] ? q : { ...q, [item.id]: 1 })
                  }
                  return n
                })
              }
              function setQty(val) {
                const v = Math.max(0, val)
                setRefillQtys(q => ({ ...q, [item.id]: v }))
              }

              return (
                <div key={item.id} style={{ borderRadius: 14,
                  border: `2px solid ${checked ? '#FCD34D' : 'var(--border)'}`,
                  background: checked ? '#FFFBEB' : '#fff',
                  overflow: 'hidden', transition: 'border-color .15s' }}>

                  {/* Row บน: checkbox + info */}
                  <div onClick={toggleCheck}
                    style={{ display: 'flex', alignItems: 'center', gap: 10,
                      padding: '11px 14px', cursor: 'pointer' }}>
                    {/* Checkbox */}
                    <div style={{ width: 24, height: 24, borderRadius: 7, flexShrink: 0,
                      border: `2px solid ${checked ? '#F59E0B' : 'var(--border2)'}`,
                      background: checked ? '#F59E0B' : '#fff',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      transition: 'all .15s' }}>
                      {checked && <span style={{ color: '#fff', fontSize: 14, fontWeight: 700, lineHeight: 1 }}>✓</span>}
                    </div>
                    <span style={{ fontSize: 22, flexShrink: 0 }}>{item.img || '📦'}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>{item.name}</div>
                      <div style={{ fontSize: 11, fontWeight: 600, marginTop: 2,
                        color: isOut ? '#DC2626' : stockQty <= minQ ? '#D97706' : '#6B7280' }}>
                        {(() => {
                          if (isOut) return '🔴 หมดแล้ว'
                          const disp = formatStockQty(stockQty, item)
                          const icon = stockQty <= minQ ? '🟡' : '🟢'
                          return `${icon} เหลือ ${disp}`
                        })()}
                      </div>
                    </div>
                  </div>

                  {/* Row ล่าง: stepper + unit (เฉพาะเมื่อเลือก) */}
                  {checked && (
                    <div onClick={e => e.stopPropagation()}
                      style={{ borderTop: '1px solid #FDE68A', padding: '10px 14px',
                        display: 'flex', alignItems: 'center', gap: 10, background: '#FFFDF0' }}>

                      {/* Unit pills */}
                      {unitOpts.length > 1 && (
                        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                          {unitOpts.map(u => {
                            const active = selectedUnit === u
                            return (
                              <button key={u} onClick={() => setRefillUnits(r => ({ ...r, [item.id]: u }))}
                                style={{ border: `1.5px solid ${active ? '#F59E0B' : 'var(--border2)'}`,
                                  background: active ? '#F59E0B' : '#fff',
                                  color: active ? '#fff' : 'var(--txt2)',
                                  borderRadius: 8, padding: '4px 10px',
                                  fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                                {u}
                              </button>
                            )
                          })}
                        </div>
                      )}
                      {unitOpts.length === 1 && (
                        <span style={{ fontSize: 12, fontWeight: 700, color: '#D97706',
                          background: '#FEF3C7', borderRadius: 8, padding: '4px 10px', flexShrink: 0 }}>
                          {selectedUnit}
                        </span>
                      )}

                      {/* Spacer */}
                      <div style={{ flex: 1 }} />

                      {/* POS Stepper */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 0,
                        border: '1.5px solid #FCD34D', borderRadius: 12, overflow: 'hidden' }}>
                        <button onClick={() => setQty(currentQty - 1)}
                          style={{ width: 38, height: 38, border: 'none', background: currentQty > 0 ? '#FEF3C7' : '#F3F4F6',
                            color: currentQty > 0 ? '#D97706' : '#C7C7CC',
                            fontSize: 20, fontWeight: 700, cursor: 'pointer',
                            display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          −
                        </button>
                        <div style={{ minWidth: 44, textAlign: 'center',
                          fontFamily: 'Prompt', fontWeight: 700, fontSize: 18,
                          color: currentQty > 0 ? '#1C1C1E' : '#C7C7CC',
                          padding: '0 4px', background: '#fff' }}>
                          {currentQty || 0}
                        </div>
                        <button onClick={() => setQty(currentQty + 1)}
                          style={{ width: 38, height: 38, border: 'none', background: '#F59E0B',
                            color: '#fff', fontSize: 20, fontWeight: 700, cursor: 'pointer',
                            display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          +
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            }
            // หมวดหมู่ที่มีใน items ทั้งหมด — ใช้ catOrder จาก Settings ก่อน
            const FALLBACK_CATS = ['ผลไม้','แยม','ไซรัป','ท็อปปิ้ง','วัตถุดิบ','บรรจุภัณฑ์','อื่นๆ']
            const ORDER = catOrder.length > 0 ? catOrder : FALLBACK_CATS
            const CAT_EMOJI = { ผลไม้:'🍋', แยม:'🍓', ไซรัป:'🍯', ท็อปปิ้ง:'💎', วัตถุดิบ:'🥛', บรรจุภัณฑ์:'🥤', อื่นๆ:'🔖' }
            const availableCats = ['low', ...ORDER.filter(c =>
              items.some(i => (i.category || 'อื่นๆ') === c)
            )]

            // กรองตาม tab
            const displayItems = refillCat === 'low'
              ? allItems                                             // stock ต่ำ/หมด
              : items.filter(i => (i.category || 'อื่นๆ') === refillCat)

            // นับ selected ต่อ cat
            function selCount(cat) {
              if (cat === 'low') return [...refillSelected].filter(id => allItems.find(i=>i.id===id)).length
              return [...refillSelected].filter(id => {
                const it = items.find(i=>i.id===id)
                return (it?.category||'อื่นๆ') === cat
              }).length
            }

            return (
              <>
                {/* Category chips */}
                <div style={{ display: 'flex', gap: 6, overflowX: 'auto',
                  scrollbarWidth: 'none', paddingBottom: 4, marginBottom: 4 }}>
                  {availableCats.map(cat => {
                    const active = refillCat === cat
                    const cnt = selCount(cat)
                    return (
                      <button key={cat} onClick={() => setRefillCat(cat)}
                        style={{ flexShrink: 0, border: 'none', borderRadius: 20,
                          padding: '6px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                          transition: 'all .15s',
                          background: active ? '#F59E0B' : '#F3F4F6',
                          color: active ? '#fff' : '#6B7280',
                          display: 'flex', alignItems: 'center', gap: 5 }}>
                        {cat === 'low'
                          ? <><span>⚠️</span> ต่ำ/หมด</>
                          : <><span>{CAT_EMOJI[cat]||'📦'}</span> {cat}</>
                        }
                        {cnt > 0 && (
                          <span style={{ background: active ? 'rgba(255,255,255,0.35)' : '#F59E0B',
                            color: active ? '#fff' : '#fff', borderRadius: 10,
                            minWidth: 18, height: 18, fontSize: 10, fontWeight: 700,
                            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px' }}>
                            {cnt}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>

                {/* รายการตาม tab */}
                {displayItems.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: 24, color: 'var(--txt3)', fontSize: 13 }}>
                    {refillCat === 'low' ? '✅ ไม่มีรายการ stock ต่ำ' : 'ไม่มีรายการในหมวดนี้'}
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {refillCat === 'low' && (
                      <div style={{ fontSize: 10, fontWeight: 700, color: '#DC2626',
                        letterSpacing: 0.5, paddingLeft: 2 }}>⚠️ STOCK ต่ำ / หมด</div>
                    )}
                    {displayItems.map(renderItem)}
                  </div>
                )}
              </>
            )
          })()}
        </div>}{/* end step item */}
      </Modal>

      {/* ══ Modal: สร้างใบโอน + นำส่ง (Owner/คลัง) ══ */}
      <Modal open={transferOpen} onClose={() => { setTransferOpen(false); setTfAddMode(false); setTfStep('pick') }}
        lockClose={true}
        title={tfStep === 'pick'
          ? `Step 1/2 · เลือกวัตถุดิบ (${transferItems.length})`
          : `Step 2/2 · กำหนดจำนวน + หน่วย (${transferItems.length})`}
        footer={(() => {
          const hasOutItem = transferItems.some(ti => {
            const b = balances.find(b => b.itemId === ti.itemId && b.warehouseId === tfr.fromWH)
            return !b || (b.qty || 0) <= 0
          })
          // Step 1 footer = "ถัดไป"
          if (tfStep === 'pick') {
            const canNext = tfr.fromWH && tfr.toWH && transferItems.length > 0
            return (
              <button className="btn-primary" disabled={!canNext}
                style={{ opacity: canNext ? 1 : 0.5 }}
                onClick={() => setTfStep('qty')}>
                ถัดไป → กำหนดจำนวน ({transferItems.length})
              </button>
            )
          }
          // Step 2 footer = "ย้อนกลับ" + "เปิดสรุป"
          const allHasQty = transferItems.every(ti => parseFloat(ti.qty) > 0)
          const disabled = transferSaving || !allHasQty || hasOutItem
          return (
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-secondary" style={{ flex: 1 }}
                onClick={() => setTfStep('pick')}>← ย้อนกลับ</button>
              <button className="btn-primary" style={{ flex: 2, opacity: disabled ? 0.5 : 1 }}
                disabled={disabled}
                onClick={() => setTfStep('confirm')}>
                {hasOutItem ? '⚠️ Stock หมด' : !allHasQty ? 'กรอกจำนวนให้ครบ' : 'ตรวจสอบ → ยืนยัน'}
              </button>
            </div>
          )
        })()}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* ── RF Import Picker ── */}
          {(() => {
            const pendingRFs = refillRequests.filter(r => r.status === 'pending')
            if (pendingRFs.length === 0) return null
            return (
              <div style={{ borderRadius: 12, border: '1.5px solid #FCD34D',
                background: '#FFFBEB', overflow: 'hidden' }}>
                {/* Header แถบกด toggle */}
                <div onClick={() => setTfrRFExpand(v => !v)}
                  style={{ display: 'flex', alignItems: 'center', gap: 8,
                    padding: '9px 12px', cursor: 'pointer' }}>
                  <span style={{ fontSize: 14 }}>📋</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#92400E', flex: 1 }}>
                    นำเข้าจากใบแจ้งเติมของ ({pendingRFs.length} ใบรอ)
                  </span>
                  {tfrRFImport.size > 0 && (
                    <span style={{ background: '#F59E0B', color: '#fff', borderRadius: 10,
                      padding: '1px 8px', fontSize: 11, fontWeight: 700 }}>
                      เลือก {tfrRFImport.size}
                    </span>
                  )}
                  <span style={{ color: '#D97706', fontSize: 13,
                    transform: tfrRFExpand ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }}>▾</span>
                </div>

                {tfrRFExpand && (
                  <div style={{ borderTop: '1px solid #FDE68A', padding: '8px 10px',
                    display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {pendingRFs.map(rf => {
                      const sel = tfrRFImport.has(rf.id)
                      const ts  = rf.requestedAt?.seconds
                        ? new Date(rf.requestedAt.seconds * 1000) : null
                      const timeStr = ts
                        ? `${ts.getDate()}/${ts.getMonth()+1} ${String(ts.getHours()).padStart(2,'0')}:${String(ts.getMinutes()).padStart(2,'0')}`
                        : ''
                      return (
                        <div key={rf.id}
                          onClick={() => setTfrRFImport(prev => {
                            const n = new Set(prev)
                            n.has(rf.id) ? n.delete(rf.id) : n.add(rf.id)
                            return n
                          })}
                          style={{ display: 'flex', alignItems: 'center', gap: 8,
                            padding: '8px 10px', borderRadius: 10, cursor: 'pointer',
                            background: sel ? '#FEF3C7' : '#fff',
                            border: `1.5px solid ${sel ? '#F59E0B' : '#E5E7EB'}`,
                            transition: 'all .15s' }}>
                          {/* Checkbox */}
                          <div style={{ width: 20, height: 20, borderRadius: 5, flexShrink: 0,
                            border: `2px solid ${sel ? '#F59E0B' : '#D1D5DB'}`,
                            background: sel ? '#F59E0B' : '#fff',
                            display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            {sel && <span style={{ color: '#fff', fontSize: 12, fontWeight: 900 }}>✓</span>}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: '#1C1C1E' }}>
                              {rf.rfRef || rf.id.slice(-8)}
                            </div>
                            <div style={{ fontSize: 10, color: '#6B7280' }}>
                              👤 {rf.requestedBy || '-'}
                              {timeStr && ` · 🕐 ${timeStr}`}
                              {` · ${rf.items?.length || 0} รายการ`}
                            </div>
                          </div>
                        </div>
                      )
                    })}
                    {/* ปุ่ม นำเข้า */}
                    <button
                      disabled={tfrRFImport.size === 0}
                      onClick={() => {
                        const selected = pendingRFs.filter(r => tfrRFImport.has(r.id))
                        mergeRFsIntoItems(selected)
                        setTfr(t => ({
                          ...t,
                          _rfIds:  selected.map(r => r.id),
                          _rfRefs: selected.map(r => r.rfRef || r.id.slice(-6)),
                        }))
                        setTfrRFExpand(false)
                      }}
                      style={{ marginTop: 4, padding: '9px 0', border: 'none', borderRadius: 10,
                        background: tfrRFImport.size > 0 ? '#F59E0B' : '#E5E7EB',
                        color: tfrRFImport.size > 0 ? '#fff' : '#9CA3AF',
                        fontWeight: 700, fontSize: 13, cursor: tfrRFImport.size > 0 ? 'pointer' : 'default',
                        fontFamily: 'Prompt' }}>
                      {tfrRFImport.size > 0
                        ? `📥 นำเข้า ${tfrRFImport.size} ใบ → เพิ่มรายการในใบโอน`
                        : 'เลือกใบแจ้งเติมของก่อน'}
                    </button>
                  </div>
                )}
              </div>
            )
          })()}

          {/* คลัง */}
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <label className="fi-label">จากคลัง</label>
              <select className="fi" value={tfr.fromWH} onChange={e => setTfr(t => ({ ...t, fromWH: e.target.value }))}>
                <option value="">เลือก</option>
                {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label className="fi-label">ไปยัง</label>
              <select className="fi" value={tfr.toWH} onChange={e => setTfr(t => ({ ...t, toWH: e.target.value }))}>
                <option value="">เลือก</option>
                {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="fi-label">คนนำส่ง</label>
            <input className="fi" placeholder="ระบุชื่อคนนำส่ง" value={tfr.driver}
              onChange={e => setTfr(t => ({ ...t, driver: e.target.value }))} />
          </div>

          {/* รายการ */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <label className="fi-label" style={{ margin: 0 }}>📦 วัตถุดิบ — กดเพื่อเลือก/ยกเลิก</label>
              {transferItems.length > 0 && (
                <span style={{ fontSize: 11, color: 'var(--red)', fontWeight: 700,
                  background: 'var(--red-p)', borderRadius: 8, padding: '3px 10px' }}>
                  เลือก {transferItems.length} รายการ
                </span>
              )}
            </div>
            {/* Persistent picker (เหมือน CutStock) — คลิกเพื่อ add/remove (Step 1 เท่านั้น) */}
            {tfStep === 'pick' && (
            <div style={{ marginBottom: 10, border: '1px solid var(--border)',
              borderRadius: 10, padding: 4, background: 'var(--bg)' }}>
              <ItemPickerGrid items={items} balances={balances}
                warehouseId={tfr.fromWH || null} selectedId={null}
                selectedIds={new Set(transferItems.map(t => t.itemId))}
                filterFn={(item, stock) => stock > 0}
                onSelect={item => {
                  // ถ้ามีอยู่แล้ว → ลบออก (toggle); ถ้าไม่มี → เพิ่ม
                  const exists = transferItems.find(t => t.itemId === item.id)
                  if (exists) {
                    setTransferItems(prev => prev.filter(t => t.itemId !== item.id))
                    return
                  }
                  const unitOpts = []
                  if (item.unitUse)  unitOpts.push(item.unitUse)
                  if (item.unitBase && !unitOpts.includes(item.unitBase)) unitOpts.push(item.unitBase)
                  setTransferItems(prev => [...prev, {
                    itemId: item.id, itemName: item.name, img: item.img || '📦',
                    category: item.category || 'อื่นๆ',
                    qty: '1', unit: unitOpts[unitOpts.length - 1] || '', unitOpts,
                  }])
                }} />
            </div>
            )}
            {tfStep === 'qty' && transferItems.length === 0 ? (
              <div style={{ background: '#F9FAFB', border: '1px dashed var(--border2)',
                borderRadius: 10, padding: 14, textAlign: 'center', fontSize: 12, color: 'var(--txt3)' }}>
                ย้อนกลับไปเลือกวัตถุดิบก่อน
              </div>
            ) : tfStep === 'qty' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {[...transferItems].sort((a, b) => {
                  const ORDER = catOrder.length > 0 ? catOrder : []
                  const ai = ORDER.indexOf(a.category), bi = ORDER.indexOf(b.category)
                  const ca = ai < 0 ? 999 : ai, cb = bi < 0 ? 999 : bi
                  if (ca !== cb) return ca - cb
                  const ma = items.find(i => i.id === a.itemId)?.sortOrder ?? 999
                  const mb = items.find(i => i.id === b.itemId)?.sortOrder ?? 999
                  return ma - mb
                }).map((it, idx) => {
                  // หา unitOpts จาก item master หรือที่เก็บไว้ใน it.unitOpts
                  const master   = items.find(i => i.id === it.itemId)
                  const unitOpts = it.unitOpts?.length
                    ? it.unitOpts
                    : (() => {
                        const opts = []
                        if (master?.unitUse)  opts.push(master.unitUse)
                        if (master?.unitBase && !opts.includes(master.unitBase)) opts.push(master.unitBase)
                        if (opts.length === 0 && it.unit) opts.push(it.unit)
                        return opts
                      })()
                  // V2: ดึง main warehouse stock — sum ทุก balance doc กัน duplicate ที่อาจค้างจาก legacy
                  const matchingBals = tfr.fromWH
                    ? balances.filter(b => b.itemId === it.itemId && b.warehouseId === tfr.fromWH)
                    : []
                  const stockInFrom = matchingBals.reduce((s, b) => s + (b.qty || 0), 0)
                  const mainMin     = matchingBals.reduce((m, b) => Math.max(m, b.minQty || 0), 0)
                  const stockStatus = tfr.fromWH ? getStockStatus(stockInFrom, mainMin) : null
                  const stockColors = {
                    ok:   { bg: '#F0FDF4', color: '#15803D', icon: '✅', label: 'เพียงพอ' },
                    low:  { bg: '#FFFBEB', color: '#B45309', icon: '⚠️', label: 'เหลือน้อย' },
                    out:  { bg: '#FEE2E2', color: '#DC2626', icon: '❌', label: 'คลังกลางหมดแล้ว' },
                  }
                  const stockTone = stockStatus ? stockColors[stockStatus] : null
                  return (
                    <div key={idx} style={{ background: '#F9FAFB', borderRadius: 12,
                      border: '1px solid var(--border)', padding: '10px 12px' }}>
                      {/* Row 1: emoji + ชื่อ + ลบ */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                        <span style={{ fontSize: 22, flexShrink: 0 }}>{it.img}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700 }}>{it.itemName}</div>
                          {stockTone && master && (
                            <div style={{ fontSize: 10, marginTop: 2, display: 'flex',
                              alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                              <span style={{ background: stockTone.bg, color: stockTone.color,
                                borderRadius: 6, padding: '2px 8px', fontWeight: 700 }}>
                                {stockTone.icon} {stockTone.label}
                              </span>
                              <span style={{ color: '#6B7280' }}>
                                คลัง: <strong>{formatStockQty(stockInFrom, master)}</strong>
                              </span>
                              {(() => {
                                // คำนวณยอดหลังโอน + FIFO LOT breakdown
                                const factor = parseConvFactor(master?.unitConversion) || 1
                                const qtyIn  = parseFloat(it.qty) || 0
                                if (!qtyIn) return null
                                const qtyUseOut = (it.unit && master?.unitBase && it.unit === master.unitBase)
                                  ? qtyIn * factor : qtyIn
                                const after = stockInFrom - qtyUseOut
                                return (
                                  <span style={{ color: after < 0 ? '#DC2626' : '#9CA3AF', fontSize: 10 }}>
                                    (จะเหลือ <strong>{formatStockQty(Math.max(0, after), master)}</strong>{after < 0 ? ' · ไม่พอ!' : ''})
                                  </span>
                                )
                              })()}
                            </div>
                          )}
                          {/* LOT FIFO breakdown — แสดงเฉพาะตอนกรอกจำนวนแล้ว */}
                          {tfr.fromWH && master && (() => {
                            const qtyIn = parseFloat(it.qty) || 0
                            if (!qtyIn) return null
                            const factor = parseConvFactor(master?.unitConversion) || 1
                            const qtyUseOut = (it.unit && master?.unitBase && it.unit === master.unitBase)
                              ? qtyIn * factor : qtyIn
                            // เลือก LOT ของคลังต้นทาง ที่ยังเหลือ
                            const availLots = sortLotsFIFO(
                              lots.filter(l => l.itemId === it.itemId
                                && l.warehouseId === tfr.fromWH
                                && (Number(l.inWarehouse) || 0) > 0
                                && l.status !== 'split')
                            )
                            if (availLots.length === 0) return null
                            // FIFO greedy allocate
                            let remain = qtyUseOut
                            const used = []
                            for (const lot of availLots) {
                              if (remain <= 0) break
                              const avail = Number(lot.inWarehouse) || 0
                              const take  = Math.min(avail, remain)
                              if (take > 0) {
                                used.push({ lot, take })
                                remain -= take
                              }
                            }
                            if (used.length === 0) return null
                            return (
                              <div style={{ marginTop: 4, fontSize: 10, color: '#6B7280',
                                background: '#FFF7ED', borderRadius: 6, padding: '4px 8px',
                                border: '1px solid #FDE68A' }}>
                                📦 จะหัก LOT: {used.map((u, i) => {
                                  const dateLabel = u.lot.receiveDate ? u.lot.receiveDate.replace(/-/g,'/').slice(5) : '-'
                                  return (
                                    <span key={i}>
                                      {i > 0 && ', '}
                                      <strong>#{u.lot.id.slice(-5)}</strong> (รับ {dateLabel}) −{u.take} {master.unitUse}
                                    </span>
                                  )
                                })}
                                {remain > 0 && (
                                  <span style={{ color: '#DC2626', fontWeight: 700 }}> · ขาด {remain} {master.unitUse}</span>
                                )}
                              </div>
                            )
                          })()}
                          {stockStatus === 'out' && (
                            <div style={{ marginTop: 6, fontSize: 10, color: '#991B1B',
                              background: '#FEE2E2', borderRadius: 8, padding: '6px 10px',
                              display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span>ให้เตรียมสั่งของจากซัพพลายเออร์ค่ะ</span>
                              <button onClick={async () => {
                                const ownerPhone = window._bizSession?.phone || 'owner'
                                await addDoc(collection(db, COL.PUSH_QUEUE), {
                                  title: `Stock หมด — ${it.itemName}`,
                                  body:  `คลังกลางหมด ขอเตรียมสั่งซื้อ`,
                                  read: false, tag: 'stock_out',
                                  recipient: ownerPhone, createdAt: serverTimestamp(),
                                })
                                setToast('📣 แจ้ง Owner แล้ว')
                              }}
                                style={{ marginLeft: 'auto', border: 'none',
                                  background: '#DC2626', color: '#fff', borderRadius: 6,
                                  padding: '3px 10px', fontSize: 10, fontWeight: 700,
                                  cursor: 'pointer', whiteSpace: 'nowrap' }}>
                                📣 แจ้ง Owner
                              </button>
                            </div>
                          )}
                        </div>
                        <button onClick={() => setTransferItems(prev => prev.filter(p => p.itemId !== it.itemId))}
                          style={{ border: 'none', background: '#FEE2E2', color: '#DC2626',
                            borderRadius: 8, width: 30, height: 30, fontSize: 15, cursor: 'pointer',
                            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>✕</button>
                      </div>
                      {/* Row 2: unit chips + POS stepper */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        {unitOpts.length > 0 && (
                          <UnitChips
                            opts={unitOpts.map(u => ({ value: u, label: u, sub: '' }))}
                            selected={it.unit}
                            onChange={u => setTransferItems(prev => prev.map(p =>
                              p.itemId === it.itemId ? { ...p, unit: u } : p))}
                          />
                        )}
                        <PosQty
                          value={parseFloat(it.qty) || 0}
                          onChange={v => setTransferItems(prev => prev.map(p =>
                            p.itemId === it.itemId ? { ...p, qty: String(v) } : p))}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </Modal>

      {/* ══ Confirm popup สร้างใบโอน ══ */}
      {tfStep === 'confirm' && transferOpen && (
        <div onClick={() => setTfStep('qty')}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 300,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 20, width: 'min(480px, 92vw)',
              maxHeight: '85vh', display: 'flex', flexDirection: 'column',
              boxShadow: '0 10px 50px rgba(0,0,0,.3)' }}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontSize: 16, fontWeight: 800 }}>🚚 ยืนยันสร้างใบโอน</div>
              <div style={{ fontSize: 11, color: 'var(--txt3)', marginTop: 2 }}>
                {warehouses.find(w => w.id === tfr.fromWH)?.name} → {warehouses.find(w => w.id === tfr.toWH)?.name}
                {tfr.driver ? ` · คนนำส่ง: ${tfr.driver}` : ''}
              </div>
            </div>
            <div style={{ overflowY: 'auto', flex: 1, padding: '8px 16px' }}>
              {[...transferItems].sort((a, b) => {
                const ORDER = catOrder.length > 0 ? catOrder : []
                const ai = ORDER.indexOf(a.category), bi = ORDER.indexOf(b.category)
                const ca = ai < 0 ? 999 : ai, cb = bi < 0 ? 999 : bi
                if (ca !== cb) return ca - cb
                const ma = items.find(i => i.id === a.itemId)?.sortOrder ?? 999
                const mb = items.find(i => i.id === b.itemId)?.sortOrder ?? 999
                return ma - mb
              }).map((it, i) => {
                const master = items.find(m => m.id === it.itemId)
                const factor = parseConvFactor(master?.unitConversion) || 1
                const qtyUse = (it.unit === master?.unitBase) ? (parseFloat(it.qty) || 0) * factor : (parseFloat(it.qty) || 0)
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10,
                    padding: '8px 0', borderTop: i > 0 ? '1px solid var(--bg)' : 'none' }}>
                    <span style={{ fontSize: 18 }}>{it.img}</span>
                    <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{it.itemName}</span>
                    <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--red)' }}>
                      {it.qty} {it.unit}
                    </span>
                    {it.unit === master?.unitBase && factor > 1 && (
                      <span style={{ fontSize: 10, color: 'var(--txt3)' }}>
                        (= {qtyUse} {master?.unitUse})
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
            <div style={{ padding: 14, borderTop: '1px solid var(--border)',
              background: 'var(--bg)', borderRadius: '0 0 20px 20px' }}>
              <div style={{ fontSize: 12, color: 'var(--txt3)', marginBottom: 10, textAlign: 'center' }}>
                รวม <strong style={{ color: 'var(--txt1)' }}>{transferItems.length}</strong> รายการ — ตรวจสอบก่อนยืนยัน
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn-secondary" style={{ flex: 1 }}
                  onClick={() => setTfStep('qty')}>← แก้ไข</button>
                <button className="btn-primary" style={{ flex: 2 }}
                  disabled={transferSaving}
                  onClick={async () => { await submitTransfer(); setTfStep('pick') }}>
                  {transferSaving ? 'กำลังบันทึก...' : '✅ ยืนยันสร้าง + นำส่ง'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══ Modal: ตรวจรับสินค้า (หน้าร้านติ๊กทีละรายการ) ══ */}
      {receivingTF && (
        <Modal open={receiveTransferOpen}
          onClose={() => { setReceiveTransferOpen(false); setReceivingTF(null) }}
          title={`ตรวจรับ ${receivingTF.tfRef || ''}`}
          lockClose={receivingChecked.size > 0}
          footer={
            <button
              onClick={() => setReceiveConfirmOpen(true)}
              disabled={receivingSaving || receivingChecked.size < (receivingTF.items?.length || 0)}
              style={{ width: '100%', background: '#16A34A', color: '#fff', border: 'none',
                borderRadius: 14, padding: '13px 0', fontSize: 15, fontWeight: 700, cursor: 'pointer',
                opacity: receivingSaving || receivingChecked.size < (receivingTF.items?.length || 0) ? 0.45 : 1 }}>
              {receivingSaving ? 'กำลังบันทึก...'
                : receivingChecked.size < (receivingTF.items?.length || 0)
                  ? `ติ๊กอีก ${(receivingTF.items?.length||0) - receivingChecked.size} รายการ`
                  : '→ ดูสรุปก่อนยืนยัน'}
            </button>
          }>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {/* Info bar */}
            <div style={{ background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 10, padding: '10px 14px' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#166534', marginBottom: 2 }}>
                🚚 {receivingTF.fromWarehouseName} → {receivingTF.toWarehouseName}
              </div>
              {receivingTF.driver && (
                <div style={{ fontSize: 11, color: '#6B7280' }}>คนนำส่ง: {receivingTF.driver}</div>
              )}
              <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>
                ติ๊กถูก {receivingChecked.size}/{receivingTF.items?.length || 0} รายการ
              </div>
            </div>

            {/* Progress bar */}
            <div style={{ background: '#F3F4F6', borderRadius: 99, height: 6, overflow: 'hidden' }}>
              <div style={{ height: '100%', background: '#16A34A', transition: 'width .3s',
                width: `${(receivingChecked.size / (receivingTF.items?.length || 1)) * 100}%` }} />
            </div>

            {/* Items grouped by category */}
            {(() => {
              const allItems = receivingTF.items || []
              // group by category
              const grouped = {}
              allItems.forEach((it, idx) => {
                const cat = it.category || 'อื่นๆ'
                if (!grouped[cat]) grouped[cat] = []
                grouped[cat].push({ ...it, _idx: idx })
              })
              const ORDER = catOrder.length > 0 ? catOrder : ['ผลไม้','แยม','ไซรัป','ท็อปปิ้ง','วัตถุดิบ','บรรจุภัณฑ์','อื่นๆ']
              const sortedCats = Object.keys(grouped).sort((a,b) =>
                (ORDER.indexOf(a) === -1 ? 99 : ORDER.indexOf(a)) -
                (ORDER.indexOf(b) === -1 ? 99 : ORDER.indexOf(b)))
              // sort items in each cat by sortOrder
              Object.keys(grouped).forEach(c => grouped[c].sort((a, b) => {
                const ma = items.find(i => i.id === a.itemId)?.sortOrder ?? 999
                const mb = items.find(i => i.id === b.itemId)?.sortOrder ?? 999
                return ma - mb
              }))
              return sortedCats.map(cat => (
                <div key={cat}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--txt3)',
                    letterSpacing: 0.8, marginBottom: 6, paddingBottom: 4,
                    borderBottom: '1px solid #F3F4F6' }}>
                    {cat.toUpperCase()}
                  </div>
                  {grouped[cat].map(it => {
                    const ticked = receivingChecked.has(it._idx)
                    return (
                      <div key={it._idx}
                        onClick={() => setReceivingChecked(prev => {
                          const n = new Set(prev); ticked ? n.delete(it._idx) : n.add(it._idx); return n
                        })}
                        style={{ display: 'flex', alignItems: 'center', gap: 12,
                          background: ticked ? '#F0FDF4' : '#fff',
                          border: `2px solid ${ticked ? '#86EFAC' : 'var(--border)'}`,
                          borderRadius: 12, padding: '11px 14px', marginBottom: 7,
                          cursor: 'pointer', transition: 'all .15s' }}>
                        {/* Tick circle */}
                        <div style={{ width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
                          border: `2px solid ${ticked ? '#16A34A' : 'var(--border2)'}`,
                          background: ticked ? '#16A34A' : '#fff',
                          display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          {ticked && <span style={{ color: '#fff', fontSize: 14, fontWeight: 700 }}>✓</span>}
                        </div>
                        <span style={{ fontSize: 22, flexShrink: 0 }}>{it.img || '📦'}</span>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 700,
                            color: ticked ? '#16A34A' : 'var(--txt)',
                            textDecoration: ticked ? 'none' : 'none' }}>
                            {it.itemName}
                          </div>
                          <div style={{ fontSize: 12, color: ticked ? '#16A34A' : 'var(--txt2)',
                            fontWeight: 700, marginTop: 1 }}>
                            {it.qty} {it.unit}
                          </div>
                        </div>
                        {ticked && <span style={{ fontSize: 18, flexShrink: 0 }}>✅</span>}
                      </div>
                    )
                  })}
                </div>
              ))
            })()}
          </div>
        </Modal>
      )}

      {/* ══ Popup สรุป ตรวจรับสินค้า ก่อน commit ══ */}
      {receivingTF && receiveConfirmOpen && (
        <div onClick={() => !receivingSaving && setReceiveConfirmOpen(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 400,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 20, width: 'min(480px, 92vw)',
              maxHeight: '85vh', display: 'flex', flexDirection: 'column',
              boxShadow: '0 10px 50px rgba(0,0,0,.3)' }}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontSize: 16, fontWeight: 800 }}>📦 ยืนยันรับสินค้า</div>
              <div style={{ fontSize: 11, color: 'var(--txt3)', marginTop: 2 }}>
                {receivingTF.fromWarehouseName} → {receivingTF.toWarehouseName}
                {receivingTF.driver ? ` · นำส่ง: ${receivingTF.driver}` : ''}
              </div>
            </div>
            <div style={{ overflowY: 'auto', flex: 1, padding: '8px 16px' }}>
              <div style={{ fontSize: 11, color: '#16A34A', fontWeight: 700, padding: '6px 0' }}>
                ✓ ติ๊กถูกครบ {receivingTF.items?.length || 0} รายการ — stock จะอัพเดทเมื่อกดยืนยัน
              </div>
              {(receivingTF.items || []).map((it, i) => {
                const master = items.find(m => m.id === it.itemId)
                const factor = parseConvFactor(master?.unitConversion) || 1
                const qtyUse = (it.unit === master?.unitBase) ? (parseFloat(it.qty) || 0) * factor : (parseFloat(it.qty) || 0)
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10,
                    padding: '8px 0', borderTop: i > 0 ? '1px solid var(--bg)' : '1px solid var(--bg)' }}>
                    <span style={{ fontSize: 18 }}>{it.img || '📦'}</span>
                    <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{it.itemName}</span>
                    <span style={{ fontSize: 13, fontWeight: 800, color: '#16A34A' }}>
                      +{it.qty} {it.unit}
                    </span>
                    {it.unit === master?.unitBase && factor > 1 && (
                      <span style={{ fontSize: 10, color: 'var(--txt3)' }}>
                        (= {qtyUse} {master?.unitUse})
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
            <div style={{ padding: 14, borderTop: '1px solid var(--border)',
              background: 'var(--bg)', borderRadius: '0 0 20px 20px' }}>
              <div style={{ fontSize: 12, color: 'var(--txt3)', marginBottom: 10, textAlign: 'center' }}>
                ⚠️ กดยืนยันแล้ว stock + LOT จะอัพเดททั้ง 2 ฝั่งทันที (ย้อนไม่ได้)
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn-secondary" style={{ flex: 1 }}
                  disabled={receivingSaving}
                  onClick={() => setReceiveConfirmOpen(false)}>← กลับไปแก้</button>
                <button style={{ flex: 2, background: '#16A34A', color: '#fff', border: 'none',
                  borderRadius: 14, padding: '12px 0', fontSize: 14, fontWeight: 700,
                  cursor: receivingSaving ? 'wait' : 'pointer', opacity: receivingSaving ? 0.5 : 1 }}
                  disabled={receivingSaving}
                  onClick={async () => {
                    await confirmReceiveTransfer()
                    setReceiveConfirmOpen(false)
                  }}>
                  {receivingSaving ? 'กำลังบันทึก...' : '✅ ยืนยันรับสินค้า'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Bell — การแจ้งเตือน */}
      <Modal open={bellOpen} onClose={() => setBellOpen(false)} title="🔔 การแจ้งเตือน">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {alertCount === 0 ? (
            <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--txt3)', fontSize: 13 }}>
              ✅ ไม่มีการแจ้งเตือนขณะนี้
            </div>
          ) : (
            <>
              {/* Low stock alerts — คำนวณ live จาก balances (รวมคลังกลาง + สาขา) */}
              {(() => {
                const mainIds = new Set(warehouses.filter(w => w.type === 'main' || w.isMain).map(w => w.id))
                // สร้าง alert dynamic จาก balances ปัจจุบัน (ตรงกับยอดจริงเสมอ)
                const liveAlerts = balances
                  .filter(b => {
                    const wh = warehouses.find(w => w.id === b.warehouseId)
                    if (!wh || wh.active === false) return false
                    const item = items.find(i => i.id === b.itemId)
                    if (item?.alertEnabled === false) return false  // ❌ ปิดแจ้งเตือนรายการนี้
                    const min = b.minQty || 0
                    return min > 0 && (b.qty || 0) <= min
                  })
                  .map(b => {
                    const item = items.find(i => i.id === b.itemId)
                    return {
                      id: `${b.warehouseId}_${b.itemId}`,
                      itemId: b.itemId, warehouseId: b.warehouseId,
                      itemName: item?.displayName || item?.name || b.itemId,
                      currentQty: b.qty || 0,
                      minQty: b.minQty || 0,
                      unit: item?.unitUse || b.unit || '',
                    }
                  })
                  // sort: หมด → ใกล้หมด, แล้วตาม sortOrder
                  .sort((a, b) => {
                    if ((a.currentQty <= 0) !== (b.currentQty <= 0)) return a.currentQty <= 0 ? -1 : 1
                    const ia = items.find(i => i.id === a.itemId)?.sortOrder ?? 999
                    const ib = items.find(i => i.id === b.itemId)?.sortOrder ?? 999
                    return ia - ib
                  })
                if (liveAlerts.length === 0) return null
                const mainAlerts   = liveAlerts.filter(a => mainIds.has(a.warehouseId))
                const branchAlerts = liveAlerts.filter(a => !mainIds.has(a.warehouseId))
                const renderAlert = (a) => {
                  const whName = warehouses.find(w => w.id === a.warehouseId)?.name || ''
                  const isOut = a.currentQty <= 0
                  return (
                    <div key={a.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      background: isOut ? '#FEE2E2' : '#FFF7ED',
                      border: `1px solid ${isOut ? '#FCA5A5' : '#FCD34D'}`,
                      borderRadius: 10, padding: '10px 12px', marginBottom: 6 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: isOut ? '#DC2626' : '#92600A' }}>
                          {isOut ? '🔴' : '🟡'} {a.itemName}
                          {whName && <span style={{ fontSize: 10, fontWeight: 500, color: '#6B7280', marginLeft: 6 }}>({whName})</span>}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--txt3)', marginTop: 2 }}>
                          เหลือ <strong>{a.currentQty}</strong> {a.unit || ''} · ขั้นต่ำ {a.minQty || 0} {a.unit || ''}
                        </div>
                      </div>
                      <span style={{
                        background: isOut ? '#DC2626' : '#D97706', color: '#fff',
                        borderRadius: 6, padding: '3px 8px', fontSize: 10, fontWeight: 700,
                        flexShrink: 0, marginLeft: 8,
                      }}>
                        {isOut ? 'หมด' : 'ใกล้หมด'}
                      </span>
                    </div>
                  )
                }
                return (
                  <>
                    {/* 🏬 เกาะคลังกลาง */}
                    {mainAlerts.length > 0 && (
                      <div style={{ background: '#FAFAFA', border: '1px solid #E5E7EB',
                        borderRadius: 12, padding: '10px 12px' }}>
                        <div style={{ fontSize: 11, fontWeight: 800, color: '#1F2937',
                          marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                          🏬 คลังกลาง
                          <span style={{ background: '#FEE2E2', color: '#DC2626',
                            borderRadius: 99, padding: '0 8px', fontSize: 10 }}>
                            {mainAlerts.length} รายการ
                          </span>
                        </div>
                        {mainAlerts.map(renderAlert)}
                      </div>
                    )}
                    {/* 🏪 เกาะสาขา */}
                    {branchAlerts.length > 0 && (
                      <div style={{ background: '#FAFAFA', border: '1px solid #E5E7EB',
                        borderRadius: 12, padding: '10px 12px' }}>
                        <div style={{ fontSize: 11, fontWeight: 800, color: '#1F2937',
                          marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                          🏪 สาขา
                          <span style={{ background: '#FEE2E2', color: '#DC2626',
                            borderRadius: 99, padding: '0 8px', fontSize: 10 }}>
                            {branchAlerts.length} รายการ
                          </span>
                        </div>
                        {branchAlerts.map(renderAlert)}
                      </div>
                    )}
                  </>
                )
              })()}
              {/* EXP alerts */}
              {expAlerts.length > 0 && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--txt3)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    ใกล้หมดอายุ (ภายใน 7 วัน)
                  </div>
                  {expAlerts.map(lot => (
                    <div key={lot.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      background: lot.daysLeft <= 0 ? '#FEE2E2' : '#FFFBEB',
                      border: `1px solid ${lot.daysLeft <= 0 ? '#FCA5A5' : '#FDE68A'}`,
                      borderRadius: 10, padding: '10px 12px', marginBottom: 6 }}>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: lot.daysLeft <= 0 ? '#DC2626' : '#B45309' }}>
                          {lot.daysLeft <= 0 ? '🔴' : '🟠'} {lot.itemName}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--txt3)', marginTop: 2 }}>
                          LOT: {lot.id} · {lot.daysLeft <= 0 ? 'หมดอายุแล้ว' : `เหลือ ${lot.daysLeft} วัน`}
                        </div>
                      </div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: lot.daysLeft <= 0 ? '#DC2626' : '#D97706',
                        flexShrink: 0, marginLeft: 8 }}>
                        {lot.daysLeft <= 0 ? 'หมดอายุ' : `${lot.daysLeft}d`}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </Modal>

      {/* Modal: บันทึกของเสีย */}
      <Modal open={wasteOpen}
        onClose={() => { setWasteOpen(false); setWasteCart({}); setWasteStep('pick') }}
        title={waste.type === 'closing'
          ? (wasteStep === 'pick'
            ? `บันทึกของเสีย — Step 1/2 เลือกรายการ (${Object.keys(wasteCart).length})`
            : `บันทึกของเสีย — Step 2/2 กรอกน้ำหนัก (${Object.keys(wasteCart).length})`)
          : 'บันทึกของเสีย'}
        lockClose={true}
        footer={(() => {
          // fruit_daily — เดิม
          if (waste.type === 'fruit_daily') {
            return waste.itemId && (
              <button className="btn-primary" onClick={saveWaste} disabled={wasteSaving}>
                {wasteSaving ? 'กำลังบันทึก...' : '💾 บันทึก'}
              </button>
            )
          }
          // closing — wizard 2 step
          if (wasteStep === 'pick') {
            const n = Object.keys(wasteCart).length
            return (
              <button className="btn-primary" disabled={n === 0}
                style={{ opacity: n === 0 ? 0.5 : 1 }}
                onClick={() => setWasteStep('qty')}>
                ถัดไป → กรอกน้ำหนัก ({n})
              </button>
            )
          }
          return (
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-secondary" style={{ flex: 1 }}
                onClick={() => setWasteStep('pick')}>← ย้อนกลับ</button>
              <button className="btn-primary" style={{ flex: 2 }}
                disabled={wasteSaving} onClick={saveWasteCart}>
                {wasteSaving ? 'กำลังบันทึก...' : '💾 บันทึกทั้งหมด'}
              </button>
            </div>
          )
        })()}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* ประเภท */}
          <div style={{ display: 'flex', gap: 8 }}>
            {[{ v: 'fruit_daily', l: '🍋 ผลไม้ระหว่างวัน' }, { v: 'closing', l: '🌙 ปิดร้าน' }].map(({ v, l }) => (
              <button key={v} onClick={() => { setWaste(w => ({ ...w, type: v, itemId: '', qty: '', unit: '' })); setWasteCart({}); setWasteStep('pick') }}
                style={{ flex: 1, padding: '8px 0', borderRadius: 10, border: `2px solid ${waste.type === v ? 'var(--red)' : 'var(--border)'}`,
                  background: waste.type === v ? 'var(--red-p)' : 'var(--surf)',
                  fontSize: 12, fontWeight: waste.type === v ? 700 : 500, cursor: 'pointer',
                  color: waste.type === v ? 'var(--red)' : 'var(--txt2)' }}>
                {l}
              </button>
            ))}
          </div>
          {/* คลังที่จะตัด (เฉพาะ fruit_daily — ปิดร้านไม่ตัด stock) */}
          {waste.type === 'fruit_daily' && (
            <div>
              <label style={{ fontSize: 11, color: 'var(--txt3)', fontWeight: 600 }}>
                🏬 ตัดจากคลัง <span style={{ color: '#DC2626' }}>*</span>
              </label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                {warehouses.filter(w => w.active !== false).map(w => {
                  const sel = waste.wh === w.id
                  const isMain = w.type === 'main' || w.isMain
                  return (
                    <button key={w.id} onClick={() => setWaste(p => ({ ...p, wh: w.id }))}
                      style={{ flex: '1 1 auto', padding: '8px 12px', borderRadius: 10,
                        border: `2px solid ${sel ? 'var(--red)' : 'var(--border)'}`,
                        background: sel ? 'var(--red-p)' : 'var(--surf)',
                        color: sel ? 'var(--red)' : 'var(--txt2)',
                        fontSize: 12, fontWeight: sel ? 700 : 500, cursor: 'pointer' }}>
                      {isMain ? '🏬' : '🏪'} {w.name}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          {/* Item Picker */}
          {(() => {
            // ผลไม้ระหว่างวัน → บังคับเฉพาะ ส้ม + มะนาว
            const FRUIT_DAILY_NAMES = ['ส้ม', 'มะนาว']
            const filterFn = waste.type === 'fruit_daily'
              ? (item) => FRUIT_DAILY_NAMES.some(n => item.name?.trim() === n)
              : (item) => item.wasteMode === true

            // ปิดร้าน → รวม raw items (wasteMode=true) + compounds (สูตรผสม) จาก CM
            const wasteSourceItems = waste.type === 'closing'
              ? [...items, ...cmCompounds]
              : items
            const available = wasteSourceItems.filter(i => filterFn(i))
            if (waste.type === 'fruit_daily') {
              return available.length === 0 ? (
                <div style={{ background: '#FFF7ED', borderRadius: 10, padding: 12, fontSize: 12, color: '#92600A', textAlign: 'center' }}>
                  ⚠️ ไม่พบ "ส้ม" หรือ "มะนาว" ในระบบ
                </div>
              ) : (
                /* fruit_daily: แสดงแค่ 2 ปุ่ม — ไม่ต้องใช้ full picker */
                <div style={{ display: 'flex', gap: 10 }}>
                  {available.map(item => {
                    const sel = waste.itemId === item.id
                    return (
                      <button key={item.id} onClick={() => {
                        // ใช้ wasteLevel เป็น default unit สำหรับฟอร์มของเสีย
                        const wl = item.wasteLevel || 'use'
                        const defaultUnit =
                          (wl === 'sub' && item.unitSub) ? item.unitSub :
                          (wl === 'buy' && item.unitBuy) ? item.unitBuy :
                          item.unitUse || item.unitBase || ''
                        setWaste(w => ({ ...w, itemId: item.id, unit: defaultUnit, qty: '' }))
                      }} style={{ flex: 1, border: `2px solid ${sel ? 'var(--red)' : 'var(--border)'}`,
                        background: sel ? 'var(--red-p)' : 'var(--surf)', borderRadius: 14,
                        padding: '14px 8px', cursor: 'pointer', textAlign: 'center',
                        transition: 'all .15s', position: 'relative' }}>
                        {sel && <span style={{ position: 'absolute', top: 6, right: 8, fontSize: 14 }}>✅</span>}
                        <div style={{ fontSize: 30 }}>{item.img || '🍊'}</div>
                        <div style={{ fontSize: 13, fontWeight: 700, marginTop: 6, color: sel ? 'var(--red)' : 'var(--txt)' }}>
                          {item.name}
                        </div>
                      </button>
                    )
                  })}
                </div>
              )
            }
            // ปิดร้าน — Step 1: multi-select picker | Step 2: qty editor
            if (available.length === 0) {
              return (
                <div style={{ background: '#FFF7ED', borderRadius: 10, padding: 12, fontSize: 12, color: '#92600A', textAlign: 'center' }}>
                  ⚠️ ยังไม่มีวัตถุดิบที่เปิด Waste Mode<br />ไปตั้งค่าที่ ตั้งค่า → วัตถุดิบ หรือเพิ่มสูตรผสมใน Cost Manager
                </div>
              )
            }
            // STEP 1 — Multi-select grid
            //   จัดลำดับ: ส้ม/มะนาว ก่อน (sortOrder 0/1) → compounds ตามลำดับ CM (sortOrder 100+)
            //   พร้อม metaText แสดงราคา/หน่วยให้ user เลือกหน่วยถูก
            if (wasteStep === 'pick') {
              const FRUIT_FIRST = ['ส้ม', 'มะนาว']
              const sortedSource = wasteSourceItems.map((it, i) => {
                let so = it.sortOrder ?? 999
                const idx = FRUIT_FIRST.indexOf(it.name?.trim())
                if (idx >= 0) so = idx       // 0, 1
                else if (it.isCompound) so = 100 + i   // compound เรียงตาม CM order
                return { ...it, sortOrder: so }
              })
              const metaForWaste = (it) => {
                const u = it.unitUse || it.unitBase || ''
                const p = Number(it.unitPrice) || 0
                if (p > 0 && u) return `${u} · ฿${p.toFixed(2)}/${u}`
                if (u) return u
                return ''
              }
              return (
                <ItemPickerGrid items={sortedSource} balances={balances} warehouseId={null}
                  selectedIds={new Set(Object.keys(wasteCart))}
                  filterFn={filterFn}
                  hideSidebar hideStock
                  metaText={metaForWaste}
                  onSelect={item => {
                    setWasteCart(prev => {
                      const next = { ...prev }
                      if (next[item.id]) { delete next[item.id]; return next }
                      const wl = item.wasteLevel || 'use'
                      const defaultUnit =
                        (wl === 'sub' && item.unitSub) ? item.unitSub :
                        (wl === 'buy' && item.unitBuy) ? item.unitBuy :
                        item.unitUse || item.unitBase || ''
                      next[item.id] = { qty: '', unit: defaultUnit }
                      return next
                    })
                  }} />
              )
            }
            // STEP 2 — กรอกน้ำหนัก/หน่วย ทีละรายการ
            const cartEntries = Object.entries(wasteCart)
            if (cartEntries.length === 0) {
              return (
                <div style={{ background: '#F9FAFB', borderRadius: 10, padding: 14, textAlign: 'center',
                  fontSize: 12, color: 'var(--txt3)' }}>
                  ย้อนกลับไปเลือกรายการก่อน
                </div>
              )
            }
            let totalCostAll = 0
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {cartEntries.map(([itemId, v]) => {
                  const item = items.find(i => i.id === itemId) || cmCompounds.find(c => c.id === itemId)
                  if (!item) return null
                  const unitOpts = getUnitOptions(item)
                  const selUnit = v.unit || unitOpts[0]?.value || ''
                  const qtyVal = parseFloat(v.qty) || 0
                  const cost = calcWasteCost(item, selUnit, qtyVal)
                  totalCostAll += cost
                  return (
                    <div key={itemId} style={{ background: 'var(--bg)', borderRadius: 12,
                      padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8,
                      border: '1px solid var(--border)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 20 }}>{item.img || '📦'}</span>
                        <span style={{ flex: 1, fontSize: 13, fontWeight: 700 }}>{item.name}</span>
                        <span style={{ fontSize: 12, fontWeight: 700, color: cost > 0 ? '#92600A' : '#9CA3AF',
                          background: cost > 0 ? '#FEF3C7' : 'transparent',
                          padding: '2px 8px', borderRadius: 6 }}>
                          {cost > 0 ? `฿${cost.toFixed(2)}` : '—'}
                        </span>
                        <button onClick={() => setWasteCart(prev => { const n = { ...prev }; delete n[itemId]; return n })}
                          style={{ border: 'none', background: '#FEE2E2', color: '#DC2626',
                            borderRadius: 6, width: 24, height: 24, fontSize: 12, cursor: 'pointer' }}>✕</button>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        {unitOpts.map(opt => {
                          const active = selUnit === opt.value
                          return (
                            <button key={opt.value}
                              onClick={() => setWasteCart(prev => ({ ...prev, [itemId]: { ...prev[itemId], unit: opt.value } }))}
                              style={{ border: `1.5px solid ${active ? 'var(--red)' : 'var(--border)'}`,
                                background: active ? 'var(--red-p)' : '#fff',
                                color: active ? 'var(--red)' : 'var(--txt2)',
                                borderRadius: 8, padding: '4px 10px', cursor: 'pointer',
                                fontSize: 11, fontWeight: 700 }}>
                              {opt.label}
                            </button>
                          )
                        })}
                        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
                          <input type="number" inputMode="decimal" step="any" min="0"
                            value={v.qty} placeholder="0"
                            onChange={e => setWasteCart(prev => ({ ...prev, [itemId]: { ...prev[itemId], qty: e.target.value } }))}
                            style={{ width: 88, padding: '8px 10px', borderRadius: 10,
                              border: '2px solid var(--red)', background: '#FFF1F2',
                              fontSize: 16, fontWeight: 800, color: 'var(--red)',
                              textAlign: 'right', outline: 'none', fontFamily: 'Prompt' }} />
                          <span style={{ fontSize: 11, color: 'var(--txt3)', fontWeight: 600 }}>
                            {selUnit}
                          </span>
                        </div>
                      </div>
                    </div>
                  )
                })}
                {/* Total */}
                <div style={{ background: '#FEF3C7', border: '1px solid #FDE68A',
                  borderRadius: 10, padding: '10px 14px', display: 'flex',
                  justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: '#92600A' }}>รวมมูลค่าทิ้งทั้งหมด</span>
                  <strong style={{ fontSize: 16, color: '#92600A', fontFamily: 'Prompt' }}>
                    ฿{totalCostAll.toFixed(2)}
                  </strong>
                </div>
              </div>
            )
          })()}
          {/* Form (เฉพาะ fruit_daily — closing ใช้ wizard ด้านบนแทน) */}
          {waste.type === 'fruit_daily' && waste.itemId && (() => {
            const item = items.find(i => i.id === waste.itemId)
              || cmCompounds.find(c => c.id === waste.itemId)
            const unitOpts = getUnitOptions(item)
            const selectedUnit = waste.unit || unitOpts[0]?.value || ''
            const estimatedCost = calcWasteCost(item, selectedUnit, waste.qty)
            const hasCost = estimatedCost > 0

            return (
              <div style={{ background: 'var(--bg)', borderRadius: 12, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {/* Unit selector */}
                <div>
                  <label className="fi-label">หน่วย</label>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {unitOpts.map(opt => {
                      const active = selectedUnit === opt.value
                      return (
                        <button key={opt.value}
                          onClick={() => setWaste(w => ({ ...w, unit: opt.value }))}
                          style={{ border: `2px solid ${active ? 'var(--red)' : 'var(--border)'}`,
                            background: active ? 'var(--red-p)' : 'var(--surf)',
                            borderRadius: 10, padding: '6px 14px', cursor: 'pointer',
                            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
                          <span style={{ fontSize: 13, fontWeight: 700,
                            color: active ? 'var(--red)' : 'var(--txt)' }}>{opt.label}</span>
                          {opt.sub ? <span style={{ fontSize: 9.5, color: active ? 'var(--red)' : 'var(--txt3)' }}>{opt.sub}</span> : null}
                        </button>
                      )
                    })}
                  </div>
                </div>

                {/* qty + cost preview */}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <PosQty value={parseFloat(waste.qty)||0} onChange={v => setWaste(w => ({...w, qty: String(v)}))} />
                  {/* มูลค่า */}
                  <div style={{ flexShrink: 0, marginBottom: 1 }}>
                    <div style={{
                      background: hasCost ? '#FEF3C7' : 'var(--border)',
                      borderRadius: 10, padding: '8px 12px', minWidth: 90, textAlign: 'center',
                      border: `1px solid ${hasCost ? '#FDE68A' : 'transparent'}`,
                      transition: 'all .2s'
                    }}>
                      <div style={{ fontSize: 9, color: hasCost ? '#92600A' : 'var(--txt3)', fontWeight: 700, marginBottom: 1 }}>มูลค่า</div>
                      <div style={{ fontSize: 15, fontWeight: 700, fontFamily: 'Prompt',
                        color: hasCost ? '#92600A' : 'var(--txt3)' }}>
                        {hasCost ? `฿${estimatedCost.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                      </div>
                    </div>
                  </div>
                </div>

                {/* cost source hint */}
                {!cmCosts[item?.name] && (
                  <div style={{ fontSize: 10, color: '#D97706', background: '#FFF7ED',
                    borderRadius: 8, padding: '5px 10px' }}>
                    ⚠️ ไม่พบข้อมูลต้นทุนจาก Cost Manager — มูลค่าจะบันทึกเป็น ฿0
                  </div>
                )}
              </div>
            )
          })()}
        </div>
      </Modal>
    </div>
  )
}
