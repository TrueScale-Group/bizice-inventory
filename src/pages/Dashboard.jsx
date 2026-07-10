import { useState, useEffect } from 'react'
import { db, sendHubPush } from '../firebase'
import { collection, query, where, onSnapshot, orderBy, limit,
         doc, getDoc, getDocs, addDoc, updateDoc, serverTimestamp, Timestamp, writeBatch, increment } from 'firebase/firestore'
import { ConnectionStatus } from '../components/ConnectionStatus'
import { Modal } from '../components/Modal'
import { Toast } from '../components/Toast'
import { useSession } from '../hooks/useSession'
import { useItems, useItemsLoaded } from '../hooks/useItems'
import { useStockBalances } from '../hooks/useStock'
import { toThaiDate, toThaiTime, lotDateStr, toDateKey } from '../utils/formatDate'
import { COL } from '../constants/collections'
import { sortLotsFIFO, formatDateDDMMYY } from '../utils/fifo'
import { fetchLotsForWarehouse, planFifoConsume, applyFifoConsume, writeLotShortage, getLotAvail } from '../utils/lotFifo'
import { beepAdd, beepRemove } from '../utils/audio'
import { formatStockQty, balanceId, getStockStatus, parseConvFactor, qtyToUse, useToQty, unitOptionsOf } from '../utils/unit'
import { sortByMaster } from '../utils/sortItems'

const DEFAULT_SOURCES = ['ตลาดไท', 'ซัพพลายเออร์', 'โอนจากคลัง', 'ซื้อเอง', 'อื่นๆ']

// บวกวัน/เดือนเข้าวันที่ (YYYY-MM-DD) → คืน YYYY-MM-DD (ใช้คำนวณวันหมดอายุจากวันผลิต)
function addDateDuration(dateStr, value, unit) {
  if (!dateStr || value === '' || value == null) return ''
  const d = new Date(dateStr + 'T00:00:00')
  const n = parseInt(value, 10)
  if (isNaN(d.getTime()) || isNaN(n)) return ''
  if (unit === 'month') d.setMonth(d.getMonth() + n)
  else d.setDate(d.getDate() + n)
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}
// จำนวนวันระหว่าง 2 วันที่ (YYYY-MM-DD) → คืน null ถ้าไม่ครบ
function daysBetween(fromStr, toStr) {
  if (!fromStr || !toStr) return null
  const a = new Date(fromStr + 'T00:00:00'), b = new Date(toStr + 'T00:00:00')
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return null
  return Math.round((b - a) / 86400000)
}

const CAT_ORDER = ['แยม','ผลไม้','ไซรัป','ท็อปปิ้ง','วัตถุดิบ','ขนม','บรรจุภัณฑ์','อื่นๆ','สูตรผสม']
const CAT_EMOJI = { แยม:'🍓', ผลไม้:'🍋', ไซรัป:'🍯', ท็อปปิ้ง:'💎', วัตถุดิบ:'🥛', ขนม:'🍪', บรรจุภัณฑ์:'🥤', อื่นๆ:'🔖' }
const AV_COLORS = ['#6366F1','#E31E24','#0EA5E9','#16A34A','#F59E0B','#8B5CF6']

const CATS = [
  { id: 'all', name: 'ทั้งหมด', emoji: '🔍' },
  { id: 'แยม', name: 'แยม', emoji: '🍓' },
  { id: 'ผลไม้', name: 'ผลไม้', emoji: '🍋' },
  { id: 'ไซรัป', name: 'ไซรัป', emoji: '🍯' },
  { id: 'ท็อปปิ้ง', name: 'ท็อปปิ้ง', emoji: '💎' },
  { id: 'วัตถุดิบ', name: 'วัตถุดิบ', emoji: '🥛' },
  { id: 'ขนม', name: 'ขนม', emoji: '🍪' },
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
    .filter(i => {
      if (!search) return true
      const q = search.toLowerCase()
      return (i.name || '').toLowerCase().includes(q) || (i.displayName || '').toLowerCase().includes(q)
    })
    .sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999) ||
      (a.displayName || a.name || '').localeCompare(b.displayName || b.name || '', 'th'))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* Search */}
      <div className="search-wrap" style={{ margin: 0 }}>
        <span className="search-icon">🔍</span>
        <input className="search-input" placeholder="ค้นหา..." value={search}
          onChange={e => setSearch(e.target.value)} />
        {search && <button onClick={() => setSearch('')}
          style={{ border: 'none', background: 'none', color: '#8E8E93', fontSize: 15, cursor: 'pointer', padding: '0 8px' }}>×</button>}
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
                    <div style={{ fontSize: 11, fontWeight: 700, marginTop: 4, lineHeight: 1.3 }}>{item.displayName || item.name}</div>
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

export default function Dashboard({ wh, setWh, warehouses, mainWarehouse = null }) {
  const { name, isEditor, isOwner } = useSession()
  const [loading, setLoading] = useState(true)
  const [kpi, setKpi] = useState({ cost: 0, cuts: 0, low: 0, out: 0, wasteCost: 0, wasteCount: 0 })
  const [todayCutLogs, setTodayCutLogs] = useState([])
  const [cutSummaryOpen, setCutSummaryOpen] = useState(false)
  const [cutFlash, setCutFlash] = useState(false)
  const prevCutsRef = useState(0)
  const [alerts, setAlerts] = useState([])
  const [transfers, setTransfers] = useState([])
  const items = useItems()                 // shared singleton — ลด Inv_items reads (เดิม subscribe เอง)
  const itemsLoaded = useItemsLoaded()
  // balances ทุกคลัง — shared singleton 'all' (transfer modal + KPI ต้องการข้าม-warehouse)
  const balances = useStockBalances('all')
  const [sources, setSources] = useState(DEFAULT_SOURCES)
  const [toast, setToast] = useState('')
  const [expAlerts, setExpAlerts] = useState([]) // lots expiring within 7 days with qty > 0
  const [lots, setLots] = useState([])           // all LOT docs (for transfer FIFO breakdown)
  const [catOrder, setCatOrder] = useState([])   // ลำดับหมวดหมู่จาก Settings (sortOrder)
  const [staffFilter, setStaffFilter] = useState(new Set())   // filter ใน cutSummary popup (ว่าง = ทั้งหมด)
  const [kpiPop, setKpiPop] = useState(null)                  // 'low' | 'out' | null — popover รายการ KPI
  const [kpiPopRect, setKpiPopRect] = useState(null)          // ตำแหน่ง card (rect) สำหรับ popover แบบ fixed (กันหน้าขยับ)

  // Modals
  const [transferOpen, setTransferOpen] = useState(false)
  const [refillOpen, setRefillOpen]   = useState(false)
  const [refillStep, setRefillStep]   = useState('branch') // 'branch' | 'item'
  const [refillBranch, setRefillBranch] = useState('')
  const [refillEditId, setRefillEditId] = useState(null)   // RF doc id ที่กำลังแก้ไข (null = สร้างใหม่)
  const [wasteOpen, setWasteOpen] = useState(false)
  const [bellOpen, setBellOpen] = useState(false)

  // (Receive form เดิม — ลบแล้ว แทนด้วยระบบสั่งซื้อ 2-step ที่ balanceId ถูกต้อง + แปลงหน่วย)

  // Transfer form — multi-item
  const [tfr, setTfr] = useState({ fromWH: '', toWH: '', driver: '' })
  const [transferItems, setTransferItems] = useState([])
  const [ownerNotified, setOwnerNotified] = useState(new Set())   // itemId ที่กด "แจ้ง Owner" แล้ว (กันกดซ้ำ)
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
  const [receivingQty, setReceivingQty]               = useState({})        // { [idx]: ยอดรับจริง (string) } — รองรับของมาไม่ครบ
  const [receiveConfirmOpen, setReceiveConfirmOpen]   = useState(false)     // popup สรุปก่อน commit
  const [receivingSaving, setReceivingSaving]         = useState(false)

  // 🛒 Purchase Order (สั่งซื้อ → รับของ) — Supplier → คลังกลาง (2-step)
  const [purchaseOrders, setPurchaseOrders] = useState([])
  const [poOpen, setPoOpen]       = useState(false)            // modal สั่งซื้อ (step 1)
  const [poStep, setPoStep]       = useState('pick')           // 'pick' | 'qty'
  const [poEditId, setPoEditId]   = useState(null)             // แก้ไขใบสั่งซื้อ (ordered) → doc id, null = สร้างใหม่
  const [poForm, setPoForm]       = useState({ supplier: '', orderDate: '', expectedDate: '', shipper: '' })
  const [poItems, setPoItems]     = useState([])               // [{itemId,itemName,img,category,qty,unit,unitOpts}]
  const [poSaving, setPoSaving]   = useState(false)
  const [poRcvOpen, setPoRcvOpen] = useState(false)            // modal รับของ (step 2)
  const [poRcv, setPoRcv]         = useState(null)             // PO doc ที่กำลังตรวจรับ
  const [poRcvChecked, setPoRcvChecked] = useState({})         // { [idx]: { checked, qty, mismatch, reason } }
  const [poRcvSaving, setPoRcvSaving]   = useState(false)
  const [poRcvDate, setPoRcvDate]       = useState('')         // วันที่รับ (ย้อนได้ ≤ 3 วัน)
  const [poMismatch, setPoMismatch]     = useState(null)       // { idx, itemName, img, orderedQty, unit, qty, reason } | null
  const [lotInfoOpen, setLotInfoOpen]   = useState(false)      // popup เพิ่มข้อมูล LOT (วันหมดอายุ) หลังรับ
  const [lotInfoData, setLotInfoData]   = useState({})         // { [lotId]: { receiveDate, mfgDate, expDate, shelfValue, shelfUnit, expMode } }
  const [lotInfoSaving, setLotInfoSaving] = useState(false)
  const [lotInfoWh, setLotInfoWh]       = useState('')         // คลังที่ป๊อปอัป LOT แสดง (badge=สาขาที่ดู · auto หลังรับ=คลังกลาง)
  const [tfConfirmChecks, setTfConfirmChecks] = useState({})   // ตรวจสอบก่อนนำส่ง: { [itemId]: true } — ติ๊กตอนหยิบของออกจากคลัง
  const [cardDetail, setCardDetail]     = useState(null)       // popup รายละเอียดการ์ด: { type:'po'|'tf', data, statusLabel }
  const [cutSumXBounce, setCutSumXBounce] = useState(false)    // เด้งกากบาท popup สรุปตัด เมื่อกด background

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
      if (l.cancelled) return s   // ยกเลิกทั้งใบ → ไม่นับเข้ามูลค่าใช้วัตถุดิบ (ตรงกับหน้ารายงาน)
      // เชื่อ totalCost ที่บันทึก (คิดเฉพาะ item ที่ไม่ cancelled อยู่แล้ว — รวมกรณี =0 จากการยกเลิกทั้งใบ)
      //   ⚠️ ห้ามใช้ `> 0` เพราะ 0 ที่ถูกต้อง (ทุก item ยกเลิก) จะโดน recompute เอา item ที่ยกเลิกกลับมา
      if (typeof l.totalCost === 'number') return s + l.totalCost
      // เฉพาะ log เก่าที่ไม่มี field totalCost → recompute โดยกรอง item ที่ยกเลิก + ใช้ costTotal ที่บันทึกก่อน
      const itemSum = (l.items || []).filter(it => !it.cancelled).reduce((ss, it) => {
        if (typeof it.costTotal === 'number') return ss + it.costTotal
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

      // คำนวณ qty in unitUse สำหรับ deduct stock (รองรับหน่วยหลายชั้น + หน่วยย่อย)
      let qtyInUse = qtyVal
      if (item) {
        const subConv = Number(item.convSub) || 0
        if (unit === item.unitSub && subConv > 0) qtyInUse = qtyVal / subConv
        else qtyInUse = qtyToUse(qtyVal, unit, item)   // ลัง/มัด/ใบ ผ่าน unitLevels
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

        // 2b. หัก LOT แบบ FIFO ให้ตรงกับ stock ที่เพิ่งลด (atomic ใน batch เดียว) — ข้ามถ้า item ปิด LOT
        if (item.lotEnabled !== false) {
          const workingLots = await fetchLotsForWarehouse(targetWh)
          const { allocations, shortage } = planFifoConsume(workingLots, { itemId: item.id, warehouseId: targetWh, qtyUse: qtyInUse })
          applyFifoConsume(batch, allocations, targetWh)
          if (shortage > 0) writeLotShortage(batch, { itemId: item.id, itemName: item.name, warehouseId: targetWh, shortage, unitUse: item.unitUse || '', reasonType: 'ของเสีย', note: 'fruit_daily' })
        }
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

  // items มาจาก useItems() (shared) — เคลียร์ loading เมื่อโหลด Master Data เสร็จ
  useEffect(() => { if (itemsLoaded) setLoading(false) }, [itemsLoaded])

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
      setKpi(k => ({ ...k, cuts: logs.filter(l => !l.cancelled).length }))
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
      const wlogs = snap.docs.map(d => d.data()).filter(d => !d.deletedAt && !d.cancelled)
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
      // 🧹 รวมเป็น 1 chip ต่อ 1 สินค้า — กันซ้ำเมื่อ LOT เดียวกันถูกแบ่งข้ามคลัง (แม่+ลูกจากการโอน)
      //    เลือกอันที่ exp ใกล้สุด (daysLeft น้อยสุด) เป็นตัวแทน
      const byItem = {}
      expiring.forEach(lot => {
        const k = lot.itemId || lot.itemName
        if (!byItem[k] || lot.daysLeft < byItem[k].daysLeft) byItem[k] = lot
      })
      setExpAlerts(Object.values(byItem))
    })
    // โหลด category order จาก Settings (live sync)
    const unsubCats = onSnapshot(doc(db, COL.APP_SETTINGS, 'categories'), snap => {
      if (snap.exists() && Array.isArray(snap.data().list)) {
        setCatOrder(snap.data().list.map(c => c.name))
      }
    })
    return () => { unsub(); unsubCats() }
  }, [])

  // Load active transfers (pending + preparing + in_transit)
  useEffect(() => {
    const q = query(collection(db, COL.TRANSFER_ORDERS),
      where('status', 'in', ['pending', 'preparing', 'in_transit']), limit(10))
    const unsub = onSnapshot(q, snap => {
      setTransfers(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    })
    return () => unsub()
  }, [])

  // 🛒 Load active purchase orders (ordered + partial = ยังรับไม่ครบ · received = ไว้ "ถอนการรับ" ภายในวัน)
  useEffect(() => {
    const q = query(collection(db, COL.PURCHASE_ORDERS),
      where('status', 'in', ['ordered', 'partial', 'received']), limit(30))
    const unsub = onSnapshot(q, snap => setPurchaseOrders(snap.docs.map(d => ({ id: d.id, ...d.data() }))))
    return () => unsub()
  }, [])

  // Load pending refill requests
  // ไม่ใช้ orderBy ใน query เพื่อหลีกเลี่ยง Composite Index requirement
  // — sort ใน client แทน
  useEffect(() => {
    const q = query(collection(db, COL.REFILL_REQUESTS),
      where('status', 'in', ['pending', 'processing', 'partial']), limit(30))
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

  // KPI low/out — คำนวณจาก balances (shared singleton) ทุกครั้งที่ balances / wh / items เปลี่ยน
  //   (เดิมคำนวณใน callback ของ onSnapshot — ย้ายออกมาเพราะ balances มาจาก hook แล้ว)
  useEffect(() => {
    // กรองเฉพาะ wh ที่ scope ปัจจุบัน (ถ้า all = ทุก wh)
    const scoped = wh === 'all' ? balances : balances.filter(b => b.warehouseId === wh)
    let low = 0, out = 0
    scoped.forEach(b => {
      const item = items.find(i => i.id === b.itemId)
      if (!item) return
      if (item.alertEnabled === false) return   // 🔕 ปิดแจ้งเตือนใน Master → ไม่นับ
      if (b.qty <= 0) out++
      else if (b.qty <= (b.minQty || item.minQty || 0)) low++
    })
    setKpi(k => ({ ...k, low, out }))
  }, [balances, wh, items])

  const whName = wh === 'all' ? 'ทุกร้าน' : (warehouses.find(w => w.id === wh)?.name || wh)

  // 🛒 ═══════════ Purchase Order: สั่งซื้อ (step 1) → รับของ (step 2) ═══════════
  function poToday() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' })
  }

  /** เปิด modal สั่งซื้อ */
  function openPO() {
    setPoEditId(null)
    setPoForm({ supplier: sources[0] || DEFAULT_SOURCES[0], orderDate: poToday(), expectedDate: '', shipper: '' })
    setPoItems([]); setPoStep('pick'); setPoOpen(true)
  }

  /** แก้ไขใบสั่งซื้อที่ยัง "ระหว่างขนส่ง" (ordered) — กดผิด/แก้จำนวน */
  function openEditPO(po) {
    setPoEditId(po.id)
    setPoForm({ supplier: po.supplier || sources[0] || '', orderDate: po.orderDate || poToday(),
      expectedDate: po.expectedDate || '', shipper: po.shipper || '' })
    setPoItems((po.items || []).map(it => {
      const m = items.find(x => x.id === it.itemId)
      const unitOpts = []
      if (m?.unitBuy || m?.unitBase) unitOpts.push(m.unitBuy || m.unitBase)
      if (m?.unitUse && !unitOpts.includes(m.unitUse)) unitOpts.push(m.unitUse)
      if (it.unit && !unitOpts.includes(it.unit)) unitOpts.unshift(it.unit)
      return { itemId: it.itemId, itemName: it.itemName, img: it.img || m?.img || '📦',
        category: it.category || m?.category || 'อื่นๆ', qty: String(it.qty), unit: it.unit, unitOpts }
    }))
    setPoStep('qty'); setPoOpen(true)
  }

  /** step 1: บันทึกใบสั่งซื้อ → status ordered (ยังไม่กระทบ stock) */
  async function submitPO() {
    if (!poForm.supplier) { setToast('⚠️ เลือกแหล่งที่มา'); return }
    if (poItems.length === 0) { setToast('⚠️ เพิ่มรายการอย่างน้อย 1 รายการ'); return }
    if (!poItems.every(it => parseFloat(it.qty) > 0)) { setToast('⚠️ ระบุจำนวนทุกรายการ'); return }
    setPoSaving(true)
    try {
      const itemsPayload = poItems.map(it => ({
        itemId: it.itemId, itemName: it.itemName, img: it.img, category: it.category || 'อื่นๆ',
        qty: parseFloat(it.qty), unit: it.unit, fulfilledQtyUse: 0,
      }))
      // ── โหมดแก้ไข (ordered) — อัปเดตใบเดิม ไม่สร้างใหม่ ──
      if (poEditId) {
        await updateDoc(doc(db, COL.PURCHASE_ORDERS, poEditId), {
          supplier: poForm.supplier, orderDate: poForm.orderDate, expectedDate: poForm.expectedDate || '',
          shipper: (poForm.shipper || '').trim(), items: itemsPayload, editedBy: name, editedAt: serverTimestamp(),
        })
        await addDoc(collection(db, COL.AUDIT_LOGS), {
          action: 'purchase_order_edit', staffName: name,
          detail: `แก้ไขใบสั่งซื้อ ${poEditId.slice(-6)} (${itemsPayload.length} รายการ)`,
          timestamp: serverTimestamp(),
        })
        setPoOpen(false); setPoEditId(null); setPoItems([]); setPoStep('pick')
        setPoForm({ supplier: '', orderDate: '', expectedDate: '', shipper: '' })
        setToast('✅ แก้ไขใบสั่งซื้อแล้ว')
        setPoSaving(false); return
      }
      const _n = new Date()
      const poId = `PO-${String(_n.getMonth()+1).padStart(2,'0')}.${String(_n.getFullYear()).slice(-2)}-${String(Date.now()).slice(-2)}`
      await addDoc(collection(db, COL.PURCHASE_ORDERS), {
        poRef: poId, status: 'ordered',
        supplier: poForm.supplier, orderDate: poForm.orderDate, expectedDate: poForm.expectedDate || '',
        shipper: (poForm.shipper || '').trim(),
        items: itemsPayload, createdBy: name, createdAt: serverTimestamp(),
      })
      try {
        const nref = await addDoc(collection(db, 'hub_notifications'), {
          app: 'inventory', type: 'purchase-order', tag: 'stock',
          title: `🛒 สั่งซื้อใหม่ ${poId}`,
          body: `${poForm.supplier} — ${itemsPayload.length} รายการ · ระหว่างขนส่ง`,
          poRef: poId, itemCount: itemsPayload.length,
          createdAt: serverTimestamp(), read: false, read_by: [],
        })
        sendHubPush(nref.id)
      } catch {}
      await addDoc(collection(db, COL.AUDIT_LOGS), {
        action: 'purchase_order', staffName: name,
        detail: `สั่งซื้อ ${poId} จาก ${poForm.supplier} (${itemsPayload.length} รายการ)`,
        timestamp: serverTimestamp(),
      })
      setPoOpen(false); setPoItems([]); setPoForm({ supplier: '', orderDate: '', expectedDate: '', shipper: '' })
      setToast(`✅ สั่งซื้อ ${poId} แล้ว — รอรับของ`)
    } catch (e) { console.error(e); setToast('❌ บันทึกไม่สำเร็จ') }
    finally { setPoSaving(false) }
  }

  /** step 2: เปิด modal ตรวจรับ — เติม checklist ตามยอดค้าง */
  function openReceivePO(po) {
    setPoRcv(po)
    const init = {}
    ;(po.items || []).forEach((it, i) => {
      const master = items.find(m => m.id === it.itemId)
      const reqUse = qtyToUse(it.qty, it.unit, master)
      const remainUse = Math.max(0, reqUse - (Number(it.fulfilledQtyUse) || 0))
      const remainInUnit = useToQty(remainUse, it.unit, master)
      // เริ่มต้น "ยังไม่ติ๊ก" — ยอดรับตั้งตามที่สั่ง (ล็อกไว้ กันมือไปกดเพิ่ม) จนกว่าจะกด "ไม่ตรง"
      init[i] = { checked: false, qty: String(remainInUnit || 0), mismatch: false, reason: '' }
    })
    setPoRcvChecked(init); setPoRcvDate(poToday()); setPoRcvOpen(true)
  }

  /** step 2: ยืนยันรับของ → +stock คลังกลาง (balanceId ถูกต้อง + แปลงหน่วย) + LOT + movement */
  async function submitReceivePO() {
    const po = poRcv; if (!po) return
    const mainWh = mainWarehouse || warehouses.find(w => w.type === 'main' || w.isMain)
    if (!mainWh) { setToast('⚠️ ไม่พบคลังกลาง'); return }
    const anyChecked = Object.values(poRcvChecked).some(c => c?.checked && parseFloat(c.qty) > 0)
    if (!anyChecked) { setToast('⚠️ ติ๊กรายการที่รับ + ระบุจำนวน'); return }
    setPoRcvSaving(true)
    try {
      const batch = writeBatch(db)
      // วันที่รับ — ใช้ที่เลือก (ย้อนได้ ≤ 3 วัน) · ถ้าย้อนหลัง → stamp receivedAt เป็นวันนั้น (เที่ยง) เพื่อให้รายงานลงวันถูก
      const today = poRcvDate || poToday()
      const isBackdated = today !== poToday()
      const rcvStamp = isBackdated ? Timestamp.fromDate(new Date(`${today}T12:00:00+07:00`)) : serverTimestamp()
      const newItems = [...(po.items || [])]
      for (let i = 0; i < newItems.length; i++) {
        const it = newItems[i]
        const chk = poRcvChecked[i]
        if (!chk?.checked) continue
        const recvQty = parseFloat(chk.qty) || 0
        if (recvQty <= 0) continue
        const master = items.find(m => m.id === it.itemId)
        const qtyUse = qtyToUse(recvQty, it.unit, master)   // รองรับหน่วยหลายชั้น
        // ✅ balance — pattern ถูกต้อง (warehouseId_itemId) + เก็บใน unitUse
        const balRef = doc(db, COL.STOCK_BALANCES, balanceId(mainWh.id, it.itemId))
        const snap = await getDoc(balRef)
        const cur = snap.exists() ? (snap.data().qty || 0) : 0
        batch.set(balRef, {
          warehouseId: mainWh.id, itemId: it.itemId, qty: cur + qtyUse,
          unit: master?.unitUse || it.unit || '', lastUpdated: serverTimestamp(),
        }, { merge: true })
        // LOT — id ผูก poRef กันชนข้ามใบ (PO คนละใบ item เดียวกันวันเดียวกัน) + accumulate กันเขียนทับ
        //     ข้ามถ้า item ปิดระบบ LOT (lotEnabled=false ใน Master Data)
        if (master?.lotEnabled !== false) {
          const poTag = String(po.poRef || po.id).replace(/[^A-Za-z0-9]/g, '')
          const lotId = `${it.itemId}_${today.replace(/-/g, '')}_${poTag}`
          const lotRef = doc(db, COL.LOT_TRACKING, lotId)
          const lotSnap = await getDoc(lotRef)
          const prevQty = lotSnap.exists() ? (Number(lotSnap.data().inWarehouse) || 0) : 0
          const newQty = prevQty + qtyUse   // รับซ้ำ id เดิม (partial รอบเดียวกัน) → บวกเพิ่ม ไม่ทับ
          batch.set(lotRef, {
            itemId: it.itemId, itemName: it.itemName, warehouseId: mainWh.id,
            receiveDate: today, expDate: lotSnap.exists() ? (lotSnap.data().expDate || '') : '',
            pendingInfo: lotSnap.exists() ? (lotSnap.data().pendingInfo ?? true) : true,
            // dual-schema: ทั้ง inWarehouse (PO/transfer/EXP อ่าน) + qty/locationQty (Warehouse อ่าน)
            totalQty: newQty, inWarehouse: newQty, inShop: 0, used: 0,
            qty: newQty, locationQty: { [mainWh.id]: newQty },
            source: po.supplier, poRef: po.poRef, createdAt: serverTimestamp(),
          }, { merge: true })
        }
        // movement (แนบสาเหตุถ้ารับไม่ตรงที่สั่ง)
        const mmNote = chk.mismatch ? ` · ⚠️ ไม่ตรง: ${(chk.reason || '').trim() || 'ไม่ระบุ'}` : ''
        batch.set(doc(collection(db, COL.STOCK_MOVEMENTS)), {
          type: 'receive', itemId: it.itemId, itemName: it.itemName, warehouseId: mainWh.id,
          qty: qtyUse, qtyUse, unit: master?.unitUse || '', unitUse: master?.unitUse || '',
          staffName: name, note: `รับจาก ${po.supplier} · ${po.poRef}${mmNote}`, poRef: po.poRef,
          ...(chk.mismatch ? { mismatch: true, mismatchReason: (chk.reason || '').trim() } : {}),
          timestamp: serverTimestamp(),
        })
        newItems[i] = { ...it, fulfilledQtyUse: (Number(it.fulfilledQtyUse) || 0) + qtyUse }
      }
      // สถานะ PO: รับครบทุกรายการ → received · ไม่ครบ → partial
      const allDone = newItems.every(it => {
        const master = items.find(m => m.id === it.itemId)
        const reqUse = qtyToUse(it.qty, it.unit, master)
        return (Number(it.fulfilledQtyUse) || 0) + 1e-6 >= reqUse
      })
      batch.update(doc(db, COL.PURCHASE_ORDERS, po.id), {
        items: newItems, status: allDone ? 'received' : 'partial', receiveDate: today,
        ...(allDone ? { receivedBy: name, receivedAt: rcvStamp } : { partialAt: rcvStamp }),
      })
      await batch.commit()
      await addDoc(collection(db, COL.AUDIT_LOGS), {
        action: 'purchase_receive', staffName: name,
        detail: `รับของ ${po.poRef} จาก ${po.supplier}${allDone ? ' (ครบ)' : ' (บางส่วน)'}`,
        timestamp: serverTimestamp(),
      })
      // 🔔 แจ้ง Hub (หมวด "สั่งซื้อ") — รับของเข้าคลังกลางแล้ว
      try {
        const nRecv = Object.values(poRcvChecked).filter(c => c?.checked && parseFloat(c.qty) > 0).length
        const nref = await addDoc(collection(db, 'hub_notifications'), {
          app: 'inventory', type: 'purchase-receive', tag: 'stock',
          title: `📦 รับเข้าคลังกลาง ${po.poRef}${allDone ? '' : ' (บางส่วน)'}`,
          body: `${po.supplier} → คลังกลาง · รับ ${nRecv} รายการ · stock อัปเดตแล้ว${allDone ? '' : ' · ยังค้างบางรายการ'}`,
          poRef: po.poRef, itemCount: nRecv,
          createdAt: serverTimestamp(), read: false, read_by: [],
        })
        sendHubPush(nref.id)
      } catch {}
      setPoRcvOpen(false); setPoRcv(null)
      setToast(allDone ? `✅ รับของ ${po.poRef} ครบแล้ว` : `🟠 รับของ ${po.poRef} บางส่วน — ค้างบางรายการ`)
      // 📅 เด้ง popup เพิ่มข้อมูล LOT (วันหมดอายุ) ของรายการที่เพิ่งรับ — รับเข้าคลังกลาง
      setLotInfoData({}); setLotInfoWh(mainWh.id); setLotInfoOpen(true)
    } catch (e) { console.error(e); setToast('❌ รับของไม่สำเร็จ') }
    finally { setPoRcvSaving(false) }
  }


  /** 🗑️ ยกเลิกใบสั่งซื้อ (ordered เท่านั้น — ยังไม่รับ ไม่กระทบ stock) */
  async function cancelPO(po) {
    if (po.status !== 'ordered') { setToast('⚠️ ยกเลิกได้เฉพาะใบที่ยังไม่รับ'); return }
    const reason = window.prompt(`ยกเลิกใบสั่งซื้อ ${po.poRef}?\n\nระบุเหตุผล (เช่น สั่งผิด, ซัพไม่ส่ง):`, '')
    if (reason === null) return
    try {
      await updateDoc(doc(db, COL.PURCHASE_ORDERS, po.id), {
        status: 'cancelled', cancelReason: (reason || '').trim() || 'ไม่ระบุ',
        cancelledBy: name, cancelledAt: serverTimestamp(),
      })
      await addDoc(collection(db, COL.AUDIT_LOGS), {
        action: 'purchase_cancel', staffName: name,
        detail: `ยกเลิกใบสั่งซื้อ ${po.poRef} — ${(reason || '').trim() || 'ไม่ระบุ'}`,
        timestamp: serverTimestamp(),
      })
      setToast(`🗑️ ยกเลิกใบสั่งซื้อ ${po.poRef} แล้ว`)
    } catch (e) { console.error(e); setToast('❌ ยกเลิกไม่สำเร็จ') }
  }

  /** ↩️ ถอนการรับของ (received/partial → ordered) — ดึง stock คืน + ลบ LOT ของ PO นี้ */
  async function undoReceivePO(po) {
    const mainWh = mainWarehouse || warehouses.find(w => w.type === 'main' || w.isMain)
    if (!mainWh) { setToast('⚠️ ไม่พบคลังกลาง'); return }
    // ── กันถอยข้ามวัน (มาตรฐานเดียวกับยกเลิกใบโอน) ──
    const refTs = po.receivedAt || po.partialAt
    const refKey = refTs?.seconds
      ? new Date(refTs.seconds * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' })
      : poToday()
    if (refKey !== poToday()) {
      window.alert(`❌ ถอนการรับของข้ามวันไม่ได้\n\nรับเมื่อ ${refKey} · วันนี้ ${poToday()}\nกรุณาใช้ "ปรับยอดคงคลัง" แทน`)
      return
    }
    // ── เช็ค stock คลังกลางพอที่จะถอนคืนไหม ──
    const shortages = []
    for (const it of (po.items || [])) {
      const recvUse = Number(it.fulfilledQtyUse) || 0
      if (recvUse <= 0) continue
      const snap = await getDoc(doc(db, COL.STOCK_BALANCES, balanceId(mainWh.id, it.itemId)))
      const cur = Number(snap.exists() ? snap.data().qty : 0) || 0
      if (cur < recvUse - 1e-4) {
        const m = items.find(x => x.id === it.itemId)
        shortages.push(`· ${m?.displayName || it.itemName} — ต้องถอน ${recvUse} แต่เหลือ ${cur} ${m?.unitUse || ''}`)
      }
    }
    if (shortages.length > 0) {
      window.alert(`❌ ถอนไม่ได้ — stock คลังกลางถูกใช้/โอนไปบางส่วนแล้ว:\n\n${shortages.join('\n')}\n\nกรุณาใช้ "ปรับยอดคงคลัง" แทน`)
      return
    }
    if (!window.confirm(`↩️ ถอนการรับของ ${po.poRef}?\n\n• ดึง stock ที่รับเข้าออกจากคลังกลาง\n• ลบ LOT ที่สร้างจากใบนี้\n• ใบกลับเป็น "ระหว่างขนส่ง" (สั่งซื้อใหม่/ตรวจรับใหม่ได้)`)) return
    try {
      const batch = writeBatch(db)
      const newItems = (po.items || []).map(it => {
        const recvUse = Number(it.fulfilledQtyUse) || 0
        if (recvUse > 0) {
          const m = items.find(x => x.id === it.itemId)
          batch.set(doc(db, COL.STOCK_BALANCES, balanceId(mainWh.id, it.itemId)), {
            qty: increment(-recvUse), lastUpdated: serverTimestamp(),
          }, { merge: true })
          batch.set(doc(collection(db, COL.STOCK_MOVEMENTS)), {
            type: 'receive_undo', itemId: it.itemId, itemName: it.itemName, warehouseId: mainWh.id,
            qty: recvUse, qtyUse: recvUse, unit: m?.unitUse || '', unitUse: m?.unitUse || '',
            adjustReason: 'ถอนการรับของ (ดึง stock คืน)', note: `PO ${po.poRef}`,
            staffName: name, timestamp: serverTimestamp(),
          })
        }
        return { ...it, fulfilledQtyUse: 0 }
      })
      // ลบ LOT ที่สร้างจาก PO นี้
      const lotsSnap = await getDocs(query(collection(db, COL.LOT_TRACKING), where('poRef', '==', po.poRef)))
      lotsSnap.docs.forEach(d => batch.delete(doc(db, COL.LOT_TRACKING, d.id)))
      // PO กลับเป็น ordered
      batch.update(doc(db, COL.PURCHASE_ORDERS, po.id), {
        items: newItems, status: 'ordered',
        receivedBy: null, receivedAt: null, partialAt: null,
        undoneBy: name, undoneAt: serverTimestamp(),
      })
      await batch.commit()
      await addDoc(collection(db, COL.AUDIT_LOGS), {
        action: 'purchase_receive_undo', staffName: name,
        detail: `ถอนการรับของ ${po.poRef} — ดึง stock คืน + ลบ LOT (${lotsSnap.size} ล็อต)`,
        timestamp: serverTimestamp(),
      })
      try {
        const nref = await addDoc(collection(db, 'hub_notifications'), {
          app: 'inventory', type: 'purchase-receive-undo', tag: 'stock',
          title: `↩️ ถอนการรับของ ${po.poRef}`,
          body: `${po.supplier} → คลังกลาง · ${name} ดึง stock คืนแล้ว · ใบกลับเป็นระหว่างขนส่ง`,
          poRef: po.poRef, createdAt: serverTimestamp(), read: false, read_by: [],
        })
        sendHubPush(nref.id)
      } catch {}
      setToast(`↩️ ถอนการรับของ ${po.poRef} แล้ว — stock คืนเข้าที่`)
    } catch (e) { console.error(e); setToast('❌ ถอนการรับไม่สำเร็จ') }
  }

  // วันหมดอายุที่มีผล: โหมด 'duration' = คำนวณจากวันผลิต + อายุ · โหมดอื่น = ใส่เอง
  function effectiveExp(v) {
    if (!v) return ''
    if (v.expMode === 'duration') return addDateDuration(v.mfgDate, v.shelfValue, v.shelfUnit || 'day')
    return v.expDate || ''
  }

  /** บันทึกวันที่รับ/วันผลิต/วันหมดอายุ เข้า LOT ที่ค้างข้อมูล (รับแล้วแต่ยังไม่ได้ใส่ exp) */
  async function saveLotInfo() {
    // บันทึกเฉพาะล็อตที่กรอกอย่างน้อย 1 ช่อง
    const entries = Object.entries(lotInfoData)
      .map(([lotId, v]) => [lotId, v, effectiveExp(v)])
      .filter(([, v, exp]) => v && (exp || v.receiveDate || v.mfgDate))
    if (entries.length === 0) { setLotInfoOpen(false); return }
    setLotInfoSaving(true)
    try {
      const batch = writeBatch(db)
      for (const [lotId, v, exp] of entries) {
        const patch = {}
        if (exp) { patch.expDate = exp; patch.pendingInfo = false }
        if (v.receiveDate) patch.receiveDate = v.receiveDate
        if (v.mfgDate) patch.mfgDate = v.mfgDate
        batch.set(doc(db, COL.LOT_TRACKING, lotId), patch, { merge: true })
      }
      await batch.commit()
      setToast(`✅ บันทึกข้อมูล LOT ${entries.length} รายการ`)
      setLotInfoOpen(false); setLotInfoData({})
    } catch (e) { console.error(e); setToast('❌ บันทึกไม่สำเร็จ') }
    finally { setLotInfoSaving(false) }
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
        const unitUse  = itemMeta?.unitUse || item.unit || ''
        const qtyIn    = parseFloat(item.qty) || 0
        const addQty   = qtyToUse(qtyIn, item.unit, itemMeta)   // รองรับหน่วยหลายชั้น (ลัง/มัด/ใบ)

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
        fromWarehouseId: tf.fromWarehouseId || '', toWarehouseId: tf.toWarehouseId || '',
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
        // หน่วย default ที่แสดงบนจอ = u1 (unitBuy/unitBase = "ลัง")
        // ต้องตรงกับ selectedUnit ใน renderItem มิฉะนั้น fallback จะเพี้ยนเป็น unitUse
        const u1 = item.unitBuy || item.unitBase || ''
        const u2 = item.unitUseRaw || item.unitUse || ''
        const u3 = item.unitSubRaw || item.unitSub || ''
        const dispDefault = u1 || u2 || u3 || ''
        return {
          itemId: id, itemName: item.name, img: item.img || '📦',
          category: item.category || 'อื่นๆ',
          unit: refillUnits[id] || dispDefault,
          qty: refillQtys[id] || 0,
        }
      }).filter(Boolean)
      const branchName = warehouses.find(w => w.id === refillBranch)?.name || ''

      if (refillEditId) {
        // ── โหมดแก้ไข: อัปเดตใบเดิม (ไม่สร้างใบใหม่ / ไม่ push ซ้ำ) ──
        const editRf = refillRequests.find(r => r.id === refillEditId)
        await updateDoc(doc(db, COL.REFILL_REQUESTS, refillEditId), {
          items: rfItems,
          branchId: refillBranch || editRf?.branchId || '',
          branchName: branchName || editRf?.branchName || '',
          editedBy: name || window._bizSession?.name || '',
          editedAt: serverTimestamp(),
        })
        await addDoc(collection(db, COL.AUDIT_LOGS), {
          action: 'refill_edit', staffName: name,
          branchId: refillBranch || editRf?.branchId || '',
          detail: `แก้ไขใบแจ้งเติม ${editRf?.rfRef || refillEditId.slice(-8)} — ${rfItems.length} รายการ`,
          timestamp: serverTimestamp()
        })
        setToast(`✏️ แก้ไขใบแจ้งเติม ${editRf?.rfRef || ''} เรียบร้อย`)
      } else {
        // ── โหมดสร้างใหม่ ──
        await addDoc(collection(db, COL.REFILL_REQUESTS), {
          rfRef: rfId, status: 'pending',
          items: rfItems,
          branchId: refillBranch || '',
          branchName,
          requestedBy: name || window._bizSession?.name || '',
          requestedAt: serverTimestamp(),
        })
        await addDoc(collection(db, COL.AUDIT_LOGS), {
          action: 'refill_request', staffName: name,
          branchId: refillBranch || '',
          detail: `แจ้งเติมของ ${rfId} — ${rfItems.length} รายการ`,
          timestamp: serverTimestamp()
        })
        // 🔔 Push → Hub bell + FCM (Owner/Admin จะเห็นแม้ Hub ปิด)
        try {
          const nref = await addDoc(collection(db, 'hub_notifications'), {
            app: 'inventory', type: 'refill-request', tag: 'stock',
            title: `🧾 แจ้งเติมของใหม่ ${rfId}`,
            body: `${name || 'สาขา'} แจ้งเติม ${rfItems.length} รายการ — รอคลังดำเนินการ`,
            rfRef: rfId, itemCount: rfItems.length,
            // refill ไม่มี toWarehouseId → ระบุ branch_id = สาขาที่ขอเติม · ไม่มีสาขา = owner/admin เท่านั้น (กัน branch หลุด)
            notifyAppEditors: !!refillBranch, branch_id: refillBranch || '',
            createdAt: serverTimestamp(),
            read: false, read_by: [],
          })
          sendHubPush(nref.id)
        } catch {}
        setToast(`✅ แจ้งเติมของ ${rfId} เรียบร้อย — รอคลังดำเนินการ`)
      }
      setRefillOpen(false)
      setRefillSelected(new Set())
      setRefillQtys({})
      setRefillUnits({})
      setRefillCat('low')
      setRefillEditId(null)
    } catch(e) {
      setToast('❌ เกิดข้อผิดพลาด')
    } finally {
      setRefillSaving(false)
    }
  }

  /** เปิด modal แจ้งเติมของในโหมดแก้ไข — เติมข้อมูลจากใบเดิมกลับมา (editor ทุกคนแก้ได้) */
  function openEditRF(rf) {
    // 🔒 ใบที่ส่งไปแล้วบางส่วน (partial) ห้ามแก้ — กัน fulfilledQtyUse ถูกล้าง → ส่งซ้ำของที่รับไปแล้ว
    if (rf.status === 'partial') {
      setToast('⚠️ ใบนี้ส่งไปแล้วบางส่วน — แก้ไขไม่ได้ (กันยอดเพี้ยน) · ใช้ "ปิดใบ" หรือรอเติมรอบหน้า')
      return
    }
    const sel = new Set()
    const qtys = {}
    const units = {}
    ;(rf.items || []).forEach(it => {
      if (!it.itemId) return
      sel.add(it.itemId)
      qtys[it.itemId]  = Number(it.qty) || 0
      if (it.unit) units[it.itemId] = it.unit
    })
    setRefillSelected(sel)
    setRefillQtys(qtys)
    setRefillUnits(units)
    setRefillEditId(rf.id)
    setRefillCat('low')
    // แก้ไข = ระบุสาขาตั้งแต่ตอนแจ้งแล้ว → ไม่ต้องเลือกซ้ำ ข้ามไปหน้ารายการเลย
    const branches = warehouses.filter(w => w.active !== false && !(w.type === 'main' || w.isMain))
    // หา branch: ใบใหม่มี branchId · ใบเก่า fallback = match ชื่อ/สาขาเดียวที่มี/สาขาแรก
    const resolvedBranch =
      rf.branchId
      || branches.find(w => w.id === rf.branchId)?.id
      || (branches.length === 1 ? branches[0].id : '')
      || branches.find(w => w.name === rf.branchName)?.id
      || branches[0]?.id
      || ''
    setRefillBranch(resolvedBranch)
    setRefillStep('item')   // ข้ามขั้นเลือกสาขาเสมอในโหมดแก้ไข
    setRefillOpen(true)
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

        // ยอดที่ต้องโอน = ยอดค้าง (ถ้าใบเคยส่งบางส่วน) ไม่งั้น = ยอดเต็มที่ขอ — รองรับหน่วยหลายชั้น
        const _reqUse   = qtyToUse(parseFloat(it.qty) || 0, it.unit, itemMaster)
        const _fulfilled = Number(it.fulfilledQtyUse) || 0
        const _remainUse = Math.max(0, _reqUse - _fulfilled)
        const effQty = _fulfilled > 0
          ? useToQty(_remainUse, it.unit, itemMaster)
          : (parseFloat(it.qty) || 0)
        if (effQty <= 0) return   // รายการนี้ส่งครบแล้ว — ข้าม

        if (merged[it.itemId]) {
          merged[it.itemId].qty = String(parseFloat(merged[it.itemId].qty || 0) + effQty)
          if (merged[it.itemId].unit !== (it.unit || merged[it.itemId].unit))
            console.warn(`[transfer] หน่วยต่างกัน รวม qty อาจไม่เป๊ะ:`, it.itemName)
        } else {
          merged[it.itemId] = {
            itemId: it.itemId, itemName: it.itemName, img: it.img || '📦',
            category: it.category || 'อื่นๆ',
            qty: effQty ? String(effQty) : '',
            unit: it.unit || unitOpts[0] || '',   // ⚠️ ใช้หน่วยที่ staff เลือก (it.unit) เป็นหลัก
            unitOpts,
          }
        }
      })
    })
    setTransferItems(Object.values(merged))
  }

  /** หา id คลังกลาง (ต้นทางโอนเสมอ) + สาขาเดียวที่มี (ปลายทาง default) */
  function transferDefaults() {
    const mainId = (mainWarehouse || warehouses.find(w => w.type === 'main' || w.isMain))?.id || ''
    const branches = warehouses.filter(w => w.active !== false && !(w.type === 'main' || w.isMain))
    return { mainId, defaultTo: branches.length === 1 ? branches[0].id : '' }
  }

  /** เปิด modal สร้างใบโอน (เปล่า — ให้ user เลือก RF เอง) */
  function openTransferFromRFs(rfs) {
    const { mainId, defaultTo } = transferDefaults()
    setTransferItems([])
    setTfr({ fromWH: mainId, toWH: defaultTo, driver: '', _rfIds: [], _rfRefs: [] })
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
    const { mainId, defaultTo } = transferDefaults()
    setTransferItems([])
    setTfr({ fromWH: mainId, toWH: defaultTo, driver: '', _rfIds: [], _rfRefs: [] })
    setTfAddMode(false); setTfStep('pick')
    setTfrRFExpand(false)  // ยุบไว้ก่อน (กดขยายเอง) — ประหยัดที่
    setTfrRFImport(new Set())
    setTransferOpen(true)
  }

  /** ปุ่มเดียวฉลาด (ต้องใส่เหตุผลทั้งคู่):
   *   • partial (ส่งบางส่วนแล้ว) → ปิดใบ (status done · closedRemaining) — ของที่ส่งไปแล้วยังอยู่
   *   • pending (ยังไม่ส่ง)       → ยกเลิกทั้งใบ (status cancelled) */
  async function deleteRF(rfId, rfRef, reason) {
    if (!reason || reason.trim().length < 3) {
      setToast('⚠️ กรุณาระบุเหตุผลอย่างน้อย 3 ตัวอักษร'); return
    }
    const rf = refillRequests.find(r => r.id === rfId)
    const isPartial = rf?.status === 'partial'
    setRfDeleting(true)
    try {
      if (isPartial) {
        await updateDoc(doc(db, COL.REFILL_REQUESTS, rfId), {
          status: 'done', closedRemaining: true,
          closedBy: name, closedReason: reason.trim(), closedAt: serverTimestamp(),
        })
        await addDoc(collection(db, COL.AUDIT_LOGS), {
          action: 'refill_close', staffName: name, branchId: rf?.branchId || '',
          detail: `ปิดใบแจ้งเติม ${rfRef || rfId.slice(-8)} — ไม่ส่งส่วนที่ค้าง | เหตุผล: ${reason.trim()}`,
          timestamp: serverTimestamp(),
        })
      } else {
        await updateDoc(doc(db, COL.REFILL_REQUESTS, rfId), {
          status: 'cancelled', cancelledBy: name, cancelReason: reason.trim(), cancelledAt: serverTimestamp(),
        })
        await addDoc(collection(db, COL.AUDIT_LOGS), {
          action: 'refill_cancel', staffName: name, branchId: rf?.branchId || '',
          detail: `ยกเลิกคำร้อง ${rfRef || rfId.slice(-8)} | เหตุผล: ${reason.trim()}`,
          timestamp: serverTimestamp(),
        })
      }
      setRfDeleteId(null)
      setRfDeleteReason('')
      setToast(isPartial ? `🚫 ปิดใบ ${rfRef || ''} — ไม่ส่งส่วนที่ค้างแล้ว` : `🗑️ ยกเลิกคำร้อง ${rfRef || ''} แล้ว`)
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
        lotPick: it.lotPick || null,   // §9.4 — LOT ที่เลือกส่ง (null = อัตโนมัติ FIFO)
      }))
      // เก็บ RF list ทั้งหมดบน TF เพื่อให้ confirmReceive update done ครบทุกใบ
      const allRfIds  = tfr._rfIds?.length ? tfr._rfIds : (tfr._rfId ? [tfr._rfId] : [])
      const allRfRefs = tfr._rfRefs?.length ? tfr._rfRefs : (tfr._rfRef ? [tfr._rfRef] : [])
      const tfDoc = await addDoc(collection(db, COL.TRANSFER_ORDERS), {
        tfRef: tfId, status: 'preparing',   // เฟส 1: เตรียมสินค้า (ยังไม่ส่ง) — กด "ส่งสินค้า" จึงจะ in_transit
        fromWarehouseId: tfr.fromWH, fromWarehouseName: fromName,
        toWarehouseId:   tfr.toWH,   toWarehouseName:   toName,
        driver: tfr.driver,
        items: itemsPayload,
        refillRequestId: allRfIds[0] || null, refillRef: allRfRefs[0] || null,   // legacy single
        refillRequestIds: allRfIds, refillRefs: allRfRefs,                       // ใหม่: array รองรับ multi-RF
        createdBy: name, createdAt: serverTimestamp(),
      })
      // อัปเดต RF status → processing (รองรับทั้ง _rfIds array และ _rfId เดี่ยว legacy)
      const rfIds = tfr._rfIds?.length ? tfr._rfIds : (tfr._rfId ? [tfr._rfId] : [])
      for (const rfId of rfIds) {
        await updateDoc(doc(db, COL.REFILL_REQUESTS, rfId), {
          status: 'processing', transferOrderId: tfDoc.id, tfRef: tfId
        })
      }
      const rfRefs = tfr._rfRefs?.join(', ') || tfr._rfRef || ''
      // 🔔 Push → Hub bell + FCM
      try {
        const nref = await addDoc(collection(db, 'hub_notifications'), {
          app: 'inventory', type: 'transfer-prepare', tag: 'stock',
          title: `📦 ใบโอนใหม่ ${tfId} — เตรียมสินค้า`,
          body: `${fromName} → ${toName} — ${itemsPayload.length} รายการ · รอจัดส่ง`,
          tfRef: tfId, itemCount: itemsPayload.length,
          fromWarehouseId: tfr.fromWH, toWarehouseId: tfr.toWH,
          notifyAppEditors: !!tfr.toWH,   // editor สาขาปลายทางได้ noti ด้วย · ไม่มีปลายทาง = owner/admin เท่านั้น (กัน branch หลุด)
          createdAt: serverTimestamp(),
          read: false, read_by: [],
        })
        sendHubPush(nref.id)
      } catch {}
      await addDoc(collection(db, COL.AUDIT_LOGS), {
        action: 'transfer_create', staffName: name,
        fromWarehouseId: tfr.fromWH || '', toWarehouseId: tfr.toWH || '',
        detail: `สร้างใบโอน ${tfId} (เตรียมสินค้า) จาก ${fromName} → ${toName} (${itemsPayload.length} รายการ)${rfRefs ? ' | RF: ' + rfRefs : ''}`,
        timestamp: serverTimestamp()
      })
      setTransferOpen(false)
      setTransferItems([])
      setTfr({ fromWH: '', toWH: '', driver: '' })
      setToast(`✅ สร้างใบโอน ${tfId} แล้ว — กด "ส่งสินค้า" เมื่อพร้อมจัดส่ง`)
    } catch(e) {
      console.error(e); setToast('❌ เกิดข้อผิดพลาด')
    } finally {
      setTransferSaving(false)
    }
  }

  /** เฟส 2: กด "ส่งสินค้า" → preparing → in_transit (เริ่มนำส่ง + แจ้งสาขา) */
  async function dispatchTransfer(tf) {
    if (!tf || tf.status !== 'preparing') return
    try {
      const fromName = tf.fromWarehouseName || tf.fromWarehouseId
      const toName   = tf.toWarehouseName   || tf.toWarehouseId
      await updateDoc(doc(db, COL.TRANSFER_ORDERS, tf.id), {
        status: 'in_transit', departedBy: name, departedAt: serverTimestamp(),
        loadedBy: name, loadedAt: serverTimestamp(),   // ✅ เช็คขึ้นรถครบโดยใคร/เมื่อไหร่
      })
      try {
        const nref = await addDoc(collection(db, 'hub_notifications'), {
          app: 'inventory', type: 'transfer-dispatch', tag: 'stock',
          title: `🚚 กำลังนำส่ง ${tf.tfRef || tf.id.slice(-6)}`,
          body: `${fromName} → ${toName} — ${tf.items?.length || 0} รายการ · รอ${toName}ตรวจรับ`,
          tfRef: tf.tfRef || '', itemCount: tf.items?.length || 0,
          fromWarehouseId: tf.fromWarehouseId, toWarehouseId: tf.toWarehouseId,
          notifyAppEditors: !!tf.toWarehouseId,   // editor สาขาปลายทาง · ไม่มีปลายทาง = owner/admin (กัน branch หลุด)
          createdAt: serverTimestamp(), read: false, read_by: [],
        })
        sendHubPush(nref.id)
      } catch {}
      await addDoc(collection(db, COL.AUDIT_LOGS), {
        action: 'transfer_dispatch', staffName: name,
        fromWarehouseId: tf.fromWarehouseId || '', toWarehouseId: tf.toWarehouseId || '',
        detail: `ส่งสินค้า ${tf.tfRef || tf.id} จาก ${fromName} → ${toName} · คนนำส่ง: ${tf.driver || '-'}`,
        timestamp: serverTimestamp()
      })
      setToast(`🚚 ส่งสินค้า ${tf.tfRef || ''} แล้ว — รอสาขาตรวจรับ`)
    } catch (e) {
      console.error(e); setToast('❌ ส่งสินค้าไม่สำเร็จ')
    }
  }

  /** ↩️ ถอยใบเตรียมจัดส่ง (preparing) — ยังไม่ตัด stock → ยกเลิกได้เลย + คืน RF เป็น pending */
  async function cancelPreparingTransfer(tf) {
    if (!tf || tf.status !== 'preparing') return
    if (!window.confirm(`↩️ ถอยใบเตรียม ${tf.tfRef || tf.id.slice(-6)}?\n\n• ยกเลิกใบนี้ (ยังไม่ตัด stock — ปลอดภัย)\n• ใบแจ้งเติมที่ผูกไว้กลับเป็น "รอดำเนินการ"`)) return
    try {
      const batch = writeBatch(db)
      batch.update(doc(db, COL.TRANSFER_ORDERS, tf.id), {
        status: 'cancelled', cancelReason: 'ถอยใบเตรียม (ก่อนส่ง)', cancelledBy: name, cancelledAt: serverTimestamp(),
      })
      // คืน RF ที่ผูกไว้ → pending
      const rfIds = Array.isArray(tf.refillRequestIds) && tf.refillRequestIds.length
        ? tf.refillRequestIds : (tf.refillRequestId ? [tf.refillRequestId] : [])
      rfIds.forEach(id => { if (id) batch.update(doc(db, COL.REFILL_REQUESTS, id), { status: 'pending', transferOrderId: null, tfRef: null }) })
      await batch.commit()
      await addDoc(collection(db, COL.AUDIT_LOGS), {
        action: 'transfer_cancel_prepare', staffName: name,
        fromWarehouseId: tf.fromWarehouseId || '', toWarehouseId: tf.toWarehouseId || '',
        detail: `ถอยใบเตรียม ${tf.tfRef || tf.id} (ยังไม่ส่ง)${rfIds.length ? ` · คืน RF ${rfIds.length} ใบ` : ''}`,
        timestamp: serverTimestamp(),
      })
      setToast(`↩️ ถอยใบเตรียม ${tf.tfRef || ''} แล้ว`)
    } catch (e) { console.error(e); setToast('❌ ถอยไม่สำเร็จ') }
  }

  /** เปิด modal รับสินค้า */
  function openReceiveTransfer(tf) {
    setReceivingTF(tf)
    setReceivingChecked(new Set())
    setReceivingQty({})
    setReceiveTransferOpen(true)
  }

  // ติ๊กรับ/ยกเลิกรายการ — ตอนติ๊กครั้งแรก default ยอดรับจริง = ยอดที่ส่งมา (แก้เป็น 0/ยอดอื่นได้)
  function toggleReceiveItem(idx, plannedQty) {
    const isOn = receivingChecked.has(idx)
    setReceivingChecked(prev => { const n = new Set(prev); isOn ? n.delete(idx) : n.add(idx); return n })
    if (!isOn) setReceivingQty(q => (q[idx] != null ? q : { ...q, [idx]: String(plannedQty ?? '') }))
  }

  /** ยืนยันรับสินค้า — ปรับ stock ทั้ง 2 ฝั่ง */
  async function confirmReceiveTransfer() {
    if (!receivingTF) return
    const tf = receivingTF
    // ต้องติ๊กทุกรายการก่อนรับ — ของที่ไม่มาให้กรอก 0
    const allChecked = (tf.items || []).every((_, i) => receivingChecked.has(i))
    if (!allChecked) { setToast('⚠️ ติ๊กให้ครบทุกรายการ — ของที่ไม่มาให้กรอก 0'); return }
    // ยอดรับจริงต่อ index = ยอดที่กรอก (default = ที่ส่งมา · กรอก 0 ได้)
    const actualOf = (it, ix) => parseFloat(receivingQty[ix] ?? it.qty) || 0
    setReceivingSaving(true)
    try {
      const batch = writeBatch(db)
      const fromName = tf.fromWarehouseName || tf.fromWarehouseId
      const toName   = tf.toWarehouseName   || tf.toWarehouseId
      // ปรับ stock + LOT ทั้ง 2 ฝั่ง — แปลงเป็น unitUse ก่อน (stock_balances + LOT เก็บใน unitUse)
      const lotTransfers = []   // เก็บ FIFO breakdown สำหรับ audit log
      for (let _ix = 0; _ix < (tf.items || []).length; _ix++) {
        const it = tf.items[_ix]
        const itemMeta = items.find(i => i.id === it.itemId)
        const unitUse  = itemMeta?.unitUse || it.unit || ''
        // ยอดรับจริง — ติ๊ก=ตามที่กรอก · ไม่ติ๊ก=0 (ไม่ได้โอนมา) แปลงเป็น unitUse
        const qtyIn    = actualOf(it, _ix)
        const addQtyUse = qtyToUse(qtyIn, it.unit, itemMeta)
        if (addQtyUse <= 0) continue   // รับ 0 / ไม่ติ๊ก → ไม่ขยับ stock/LOT (ส่วนที่ขาด → RF)

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
          createdByName: tf.createdBy || '', receivedByName: name,
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
          createdByName: tf.createdBy || '', receivedByName: name,
          note: `${noteBase} ← ${fromName}`,
          transferTfId: tf.id, transferRef: tf.tfRef || '',
          timestamp: serverTimestamp(),
        })

        // ── 2. LOT TRACKING (FIFO) — sync ทั้ง 2 ฝั่ง ─────────────
        //   ต้นทาง: หัก LOT ตาม FIFO (รับก่อนใช้ก่อน)
        //   ปลายทาง: สร้าง/เพิ่ม LOT ใหม่ ผูกกับ parentLotId เพื่อ traceability
        //   item ที่ปิดระบบ LOT (lotEnabled=false) → srcLots ว่าง = ข้ามทั้งหัก/สร้าง LOT
        const srcLots = itemMeta?.lotEnabled === false ? [] : sortLotsFIFO(
          lots.filter(l => l.itemId === it.itemId
            && l.warehouseId === tf.fromWarehouseId
            && getLotAvail(l, tf.fromWarehouseId) > 0
            && l.status !== 'split')
        )
        // §9.4 — ถ้าผู้โอนเลือก LOT เจาะจง → ดันขึ้นหน้าสุด (ที่เหลือยัง FIFO)
        if (it.lotPick) {
          const pi = srcLots.findIndex(l => l.id === it.lotPick)
          if (pi > 0) { const [pick] = srcLots.splice(pi, 1); srcLots.unshift(pick) }
        }
        let remain = addQtyUse
        const allocations = []
        for (const lot of srcLots) {
          if (remain <= 0) break
          const avail = getLotAvail(lot, tf.fromWarehouseId)
          const take  = Math.min(avail, remain)
          if (take > 0) {
            allocations.push({ srcLot: lot, take })
            remain -= take
          }
        }
        // ถ้า LOT มีไม่พอ → log แต่ก็โอนตามที่กรอก (stock_balances ถูก deduct ไปแล้ว)
        if (remain > 0 && itemMeta?.lotEnabled !== false) {
          console.warn('[transfer] LOT ไม่พอ — โอนต่อ', { itemName: it.itemName, shortage: remain })
        }
        // Apply allocations
        for (const a of allocations) {
          // หัก src LOT — รักษา 2 schema ให้ตรงกัน (inWarehouse + locationQty)
          const srcRef = doc(db, COL.LOT_TRACKING, a.srcLot.id)
          const srcUpd = { lastUpdated: serverTimestamp() }
          if (a.srcLot.locationQty && typeof a.srcLot.locationQty === 'object') {
            srcUpd[`locationQty.${tf.fromWarehouseId}`] = Math.max(0, (Number(a.srcLot.locationQty[tf.fromWarehouseId]) || 0) - a.take)
          }
          srcUpd.inWarehouse = Math.max(0, (Number(a.srcLot.inWarehouse) || 0) - a.take)
          batch.update(srcRef, srcUpd)
          // สร้าง/upsert dest LOT (id = srcLotId__to__destWH เพื่อกัน collision)
          const destLotId = `${a.srcLot.id}__to__${tf.toWarehouseId}`
          const destRef   = doc(db, COL.LOT_TRACKING, destLotId)
          const destSnap  = await getDoc(destRef)
          if (destSnap.exists()) {
            const dPrev = Number(destSnap.data().inWarehouse) || 0
            const newTotalQty = (Number(destSnap.data().totalQty) || 0) + a.take
            batch.update(destRef, {
              inWarehouse: dPrev + a.take,
              totalQty:    newTotalQty,
              // qty ต้องเท่ากับ totalQty เสมอ (ยอดรับสะสมทั้งหมด) — ห้ามใช้ dPrev (=inWarehouse ที่ลดลงเมื่อถูกใช้ไปแล้ว)
              // ไม่งั้นยอด "รวม" ที่การ์ด LOT โชว์จะต่ำกว่าความจริงทุกครั้งที่มีการโอนซ้ำเข้า lot เดิมหลังถูกใช้ไปบางส่วน
              qty:         newTotalQty,
              [`locationQty.${tf.toWarehouseId}`]: dPrev + a.take,
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
              qty:         a.take,
              locationQty: { [tf.toWarehouseId]: a.take },
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
      // อัปเดต TF — เก็บยอดรับจริงต่อรายการ (receivedQty) + ธงของมาไม่ครบ
      const receivedItems = (tf.items || []).map((it, ix) => ({
        ...it, receivedQty: actualOf(it, ix),
      }))
      const hasShortage = receivedItems.some(it => (it.receivedQty || 0) < (parseFloat(it.qty) || 0))
      batch.update(doc(db, COL.TRANSFER_ORDERS, tf.id), {
        status: 'received', receivedBy: name, receivedAt: serverTimestamp(),
        items: receivedItems, ...(hasShortage ? { hadShortage: true } : {}),
      })
      // อัปเดต RF → done
      // อัพเดท RF ทั้งหมดที่ link กับ TF นี้ → done (รองรับทั้ง array ใหม่ + legacy)
      const rfIdsToFinish = Array.isArray(tf.refillRequestIds) && tf.refillRequestIds.length
        ? tf.refillRequestIds
        : (tf.refillRequestId ? [tf.refillRequestId] : [])

      // ── Per-item fulfillment: กระจาย "ยอดรับจริง" ลงรายการในใบ RF ──
      // helper: แปลงจำนวน (ตามหน่วยที่บันทึก) → unitUse
      const toUse = (qty, unit, itemId) => {
        const master = items.find(i => i.id === itemId)
        return qtyToUse(parseFloat(qty) || 0, unit, master)   // รองรับหน่วยหลายชั้น
      }
      // 1. ยอดรับจริงต่อ itemId (unitUse) จากใบโอนนี้ — ใช้ยอดรับจริง (ของมาไม่ครบ → RF ค้างไว้รอบหน้า)
      const receivedPool = {}
      ;(tf.items || []).forEach((it, ix) => {
        receivedPool[it.itemId] = (receivedPool[it.itemId] || 0) + toUse(actualOf(it, ix), it.unit, it.itemId)
      })
      // 2. กระจายให้รายการในแต่ละ RF ตามลำดับ — เติมยอดที่ยังค้างก่อน
      rfIdsToFinish.forEach(rfId => {
        if (!rfId) return
        const rf = refillRequests.find(r => r.id === rfId)
        if (!rf) { batch.update(doc(db, COL.REFILL_REQUESTS, rfId), { status: 'done', completedAt: serverTimestamp() }); return }
        const newItems = (rf.items || []).map(ri => {
          const reqUse   = toUse(ri.qty, ri.unit, ri.itemId)
          const already  = Number(ri.fulfilledQtyUse) || 0
          const need     = Math.max(0, reqUse - already)
          const pool     = receivedPool[ri.itemId] || 0
          const give     = Math.min(need, pool)
          receivedPool[ri.itemId] = pool - give
          return { ...ri, fulfilledQtyUse: already + give }
        })
        const allDone = newItems.every(ri => (Number(ri.fulfilledQtyUse) || 0) + 1e-6 >= toUse(ri.qty, ri.unit, ri.itemId))
        batch.update(doc(db, COL.REFILL_REQUESTS, rfId), {
          items: newItems,
          status: allDone ? 'done' : 'partial',
          ...(allDone ? { completedAt: serverTimestamp() } : { partialAt: serverTimestamp() }),
        })
      })
      // ── ส่วนที่ขาด → สร้างใบแจ้งเติม (RF) ใหม่ ให้สาขาปลายทาง ──
      //   เฉพาะใบโอนที่ "ไม่ได้ผูก RF เดิม" · ใบที่ผูก RF อยู่แล้ว RF เดิมเป็น 'partial' ครอบให้แล้ว (กันสร้างซ้ำ)
      let shortRfRef = ''
      if (rfIdsToFinish.length === 0) {
        const shortItems = receivedItems
          .map(it => ({ it, short: (parseFloat(it.qty) || 0) - (it.receivedQty || 0) }))
          .filter(x => x.short > 1e-9)
          .map(({ it, short }) => ({
            itemId: it.itemId, itemName: it.itemName, img: it.img || '📦',
            category: it.category || 'อื่นๆ', unit: it.unit, qty: Number(short.toFixed(2)),
          }))
        if (shortItems.length) {
          const _n = new Date()
          shortRfRef = `RF-${String(_n.getMonth() + 1).padStart(2, '0')}.${String(_n.getFullYear()).slice(-2)}-${String(Date.now()).slice(-2)}`
          batch.set(doc(collection(db, COL.REFILL_REQUESTS)), {
            rfRef: shortRfRef, status: 'pending', items: shortItems,
            branchId: tf.toWarehouseId, branchName: tf.toWarehouseName || toName || '',
            requestedBy: name, requestedAt: serverTimestamp(),
            fromTransferRef: tf.tfRef || tf.id,   // ลิงก์ย้อนกลับว่ามาจากใบโอนไหน
          })
        }
      }
      await batch.commit()
      const lotSummary = lotTransfers.length
        ? ` · LOT: ${lotTransfers.map(t => `${t.itemName} ${t.from}→${t.to.slice(-5)} -${t.take}${t.unit}`).join(', ').slice(0, 200)}`
        : ''
      await addDoc(collection(db, COL.AUDIT_LOGS), {
        action: 'transfer_received', staffName: name,
        fromWarehouseId: tf.fromWarehouseId || '', toWarehouseId: tf.toWarehouseId || '',
        detail: `รับสินค้า ${tf.tfRef || tf.id} จาก ${fromName} · คนนำส่ง: ${tf.driver || '-'} · รับโดย: ${name}${lotSummary}`,
        timestamp: serverTimestamp()
      })
      // 🔔 Push → Hub bell + FCM
      try {
        const nref = await addDoc(collection(db, 'hub_notifications'), {
          app: 'inventory', type: 'transfer-received', tag: 'stock',
          title: `📦 รับสินค้า ${tf.tfRef || tf.id?.slice(-6)} ${hasShortage ? '(บางส่วน)' : 'แล้ว'}`,
          body: hasShortage
            ? `${toName} รับบางส่วน (ของมาไม่ครบ) · จาก ${fromName} · โดย ${name}${shortRfRef ? ` · ขาด → ${shortRfRef}` : ''}`
            : `${toName} ยืนยันรับครบ · จาก ${fromName} · โดย ${name}`,
          tfRef: tf.tfRef || tf.id, itemCount: tf.items?.length || 0,
          fromWarehouseId: tf.fromWarehouseId, toWarehouseId: tf.toWarehouseId,
          notifyAppEditors: !!tf.toWarehouseId,   // editor สาขาปลายทาง · ไม่มีปลายทาง = owner/admin (กัน branch หลุด)
          createdAt: serverTimestamp(),
          read: false, read_by: [],
        })
        sendHubPush(nref.id)
      } catch {}
      setReceiveTransferOpen(false)
      setReceivingTF(null)
      setToast(hasShortage
        ? (shortRfRef
            ? `✅ รับ ${tf.tfRef || ''} ตามจริง — ของที่ขาดสร้างใบแจ้งเติม ${shortRfRef} แล้ว`
            : `✅ รับ ${tf.tfRef || ''} ตามจริง — ส่วนที่ขาดค้างที่ใบแจ้งเติมเดิม`)
        : `✅ รับสินค้า ${tf.tfRef || ''} ครบถ้วน — stock + LOT อัปเดตทั้ง 2 คลัง`)
    } catch(e) {
      console.error(e); setToast('❌ เกิดข้อผิดพลาด')
    } finally {
      setReceivingSaving(false)
    }
  }

  // Bell alert count: unresolved low_stock_alerts + expiring lots
  const unresolvedAlerts = alerts.filter(a => a.resolved !== true)
  // live count: นับจาก balances (item × wh ที่ qty ≤ minQty) — รวมทุกคลัง
  // ข้ามรายการที่ปิดแจ้งเตือนใน Master (alertEnabled=false) + ที่ไม่มีใน Master → ตรงกับ list กระดิ่ง
  const liveAlertCount = balances.filter(b => {
    const wh = warehouses.find(w => w.id === b.warehouseId)
    if (!wh || wh.active === false) return false
    const item = items.find(i => i.id === b.itemId)
    if (!item) return false
    if (item.alertEnabled === false) return false
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

      {/* (ยุบแถบวันที่ออก — วันที่แสดงอยู่ใน hero card แล้ว · กระชับบนมือถือ) */}

      {/* ⚡ Action grid (ย้ายมาบนสุดให้กดได้ทันที ไม่ต้องเลื่อนลง) */}
      <div>
        <div className="section-label">⚡ ทำรายการ</div>
        <div style={{ padding: '0 1rem' }}>
          <div className="action-grid">
            <button className="action-btn" onClick={() => isEditor() && openPO()}>
              <span className="action-icon">🛒</span>
              <span className="action-label">สั่งซื้อ</span>
            </button>
            <button className="action-btn"
              onClick={() => isOwner() ? openTransferBlank() : setToast('⚠️ เฉพาะ Owner / Admin สร้างใบโอนได้')}>
              <span className="action-icon">🚚</span>
              <span className="action-label">โอนสินค้า</span>
            </button>
            <button className="action-btn" onClick={() => { setRefillStep('branch'); setRefillBranch(''); setRefillOpen(true) }}>
              <span className="action-icon">🧾</span>
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
                outItems.push({ text: `${dispName}${tag} — หมด${min > 0 ? ` · MIN ${minDisplay}` : ''}`, level: 'out' })
              } else if (min > 0 && b.qty <= min) {
                if (b.qty === min) {
                  lowItems.push({ text: `${dispName}${tag} — เหลือ ${b.qty} ${unit} · MIN ${minDisplay} (พอดีขั้นต่ำ)`, level: 'ok' })
                } else if (b.qty <= min * 0.3) {
                  lowItems.push({ text: `${dispName}${tag} — เหลือ ${b.qty} ${unit} · MIN ${minDisplay} (วิกฤต — ขาด ${(min - b.qty).toFixed(0)} ${unit})`, level: 'critical' })
                } else {
                  lowItems.push({ text: `${dispName}${tag} — เหลือ ${b.qty} ${unit} · MIN ${minDisplay} (ขาด ${(min - b.qty).toFixed(0)} ${unit})`, level: 'low' })
                }
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
                  onMouseEnter={e => { if (hasItems) { cancelClose(); setKpiPopRect(e.currentTarget.getBoundingClientRect()); setKpiPop(key) } }}
                  onMouseLeave={scheduleClose}
                  onClick={e => { if (hasItems) { setKpiPopRect(e.currentTarget.getBoundingClientRect()); setKpiPop(p => p === key ? null : key) } }}>
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
                      style={{ position: 'fixed',   // fixed = ไม่ขยาย document → หน้าไม่ขยับ
                        top:    kpiPopRect && (window.innerHeight - kpiPopRect.bottom >= 320) ? kpiPopRect.bottom + 8 : undefined,
                        bottom: kpiPopRect && (window.innerHeight - kpiPopRect.bottom <  320) ? (window.innerHeight - kpiPopRect.top + 8) : undefined,
                        left: '50%', transform: 'translateX(-50%)',
                        width: 'min(320px, calc(100vw - 24px))',
                        background: '#fff', border: `1.5px solid ${color}`,
                        borderRadius: 12, padding: '10px 12px',
                        boxShadow: '0 8px 24px rgba(0,0,0,.15)', zIndex: 9999,
                        fontSize: 11, animation: 'kpiPopIn .15s ease' }}>
                      <style>{`@keyframes kpiPopIn { from {opacity:0;transform:translateX(-50%) translateY(-4px)} to {opacity:1;transform:translateX(-50%) translateY(0)} }`}</style>
                      <div style={{ fontWeight: 800, color, marginBottom: 6, display: 'flex',
                        justifyContent: 'space-between', alignItems: 'center' }}>
                        <span>{label} ({list.length})</span>
                        <button onClick={() => setKpiPop(null)}
                          style={{ border: 'none', background: 'transparent', cursor: 'pointer',
                            fontSize: 14, color: '#9CA3AF', padding: 0, lineHeight: 1 }}>×</button>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3,
                        maxHeight: 280, overflowY: 'auto' }}>
                        {list.slice(0, 30).map((item, i) => {
                          const tc =
                            item.level === 'ok'       ? '#D97706' :
                            item.level === 'low'      ? '#DC2626' :
                            item.level === 'critical' ? '#991B1B' :
                            item.level === 'out'      ? '#DC2626' : '#374151'
                          const sep = item.text.indexOf(' — ')
                          const namePart   = sep >= 0 ? item.text.slice(0, sep) : item.text
                          const detailPart = sep >= 0 ? item.text.slice(sep) : ''
                          return (
                            <div key={i} style={{ padding: '3px 0', borderBottom: i < list.length - 1 ? '1px solid #F3F4F6' : 'none' }}>
                              • <span style={{ fontWeight: 700, color: '#1C1C1E' }}>{namePart}</span>
                              <span style={{ color: tc, fontWeight: item.level === 'critical' ? 700 : 400 }}>{detailPart}</span>
                            </div>
                          )
                        })}
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
        let cutCount = 0   // จำนวน "ครั้ง" (ใบตัด) ที่ผ่าน staffFilter
        todayCutLogs.forEach(log => {
          if (log.cancelled || log.deletedAt) return  // ข้าม log ที่ยกเลิกทั้งใบ
          const sn = log.staffName || log.staffPhone || '?'
          if (!staffSet.includes(sn)) staffSet.push(sn)
          if (staffFilter.size > 0 && !staffFilter.has(sn)) return   // 🔎 filter ตามคนตัด
          cutCount++   // นับครั้งเฉพาะใบที่ผ่าน filter
          ;(log.items || []).forEach(it => {
            if (it.cancelled) return                   // ข้าม item ที่ยกเลิกราย-line
            const key = it.itemName || it.itemId
            const masterItem = items.find(i => i.id === it.itemId)
            if (accumulated[key]) accumulated[key].qty += (it.qtyUse || it.qty || 0)
            else accumulated[key] = {
              name: masterItem?.displayName || it.itemName || key,
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
                <div style={{ padding: '11px 14px', display: 'flex', flexDirection: 'column', gap: 9 }}>
                  {/* แถว 1: คนตัด + รวมรายการ */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    {staffSet.map((s, i) => (
                      <div key={s} style={{
                        background: '#F3F4F6', borderRadius: 20, padding: '3px 9px',
                        fontSize: 11, color: '#374151', fontWeight: 600,
                        display: 'flex', alignItems: 'center', gap: 4 }}>
                        <div style={{ width: 16, height: 16, borderRadius: '50%',
                          background: AV_COLORS[i % AV_COLORS.length], color: '#fff', fontSize: 9,
                          display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800 }}>
                          {s.charAt(0)}</div>
                        {s}
                      </div>
                    ))}
                    <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--txt3)', fontWeight: 700 }}>
                      รวม {allItems.length} รายการ
                    </span>
                  </div>
                  {/* แถว 2: หมวด chips (emoji + จำนวน) แบบกระชับ + กดดู */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    {sortedCats.map(cat => (
                      <span key={cat} title={cat} style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                        background: '#EEF2FF', borderRadius: 20, padding: '3px 9px',
                        fontSize: 12, fontWeight: 700, color: '#4338CA' }}>
                        <span style={{ fontSize: 14 }}>{CAT_EMOJI[cat] || '📦'}</span>
                        {bycat[cat].length}
                      </span>
                    ))}
                    <span style={{ marginLeft: 'auto', fontSize: 11, color: '#6366F1', fontWeight: 700, whiteSpace: 'nowrap' }}>
                      กดดู ›
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* ── Popup ── */}
            {cutSummaryOpen && (
              <div onClick={() => { setCutSumXBounce(false); requestAnimationFrame(() => requestAnimationFrame(() => setCutSumXBounce(true))) }}
                style={{
                  position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 200,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  paddingBottom: 68, paddingLeft: 16, paddingRight: 16,
                  animation: 'bdIn .2s ease'
                }}>
                <div onClick={e => e.stopPropagation()}
                  style={{
                    background: '#fff', borderRadius: 20, overflow: 'hidden',  /* clip เนื้อหาให้มุมมนครบ 4 ด้าน */
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
                    <button onClick={() => setCutSummaryOpen(false)} aria-label="ปิด"
                      onAnimationEnd={() => setCutSumXBounce(false)}
                      style={{ border: '1.5px solid #FCA5A5', background: '#FEE2E2', borderRadius: '50%', width: 30, height: 30,
                        fontSize: 14, fontWeight: 800, cursor: 'pointer', color: '#DC2626', display:'flex', alignItems:'center', justifyContent:'center',
                        animation: cutSumXBounce ? 'xBounce 0.45s ease' : 'none' }}>×</button>
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
                            display: 'flex', alignItems: 'center', gap: 6,
                            padding: '7px 16px 7px 36px', borderTop: '1px solid var(--bg)',
                            animation: 'rowIn .3s ease both',
                            animationDelay: `${ci * 40 + (idx + 1) * 35}ms`
                          }}>
                            <span style={{ flex: 1, fontSize: 13, color: 'var(--txt1)', fontWeight: 600, minWidth: 0 }}>{it.name}</span>
                            <div style={{ flex: 1, borderBottom: '1.5px dotted #E5E7EB', alignSelf: 'flex-end', marginBottom: 4 }} />
                            <span style={{ width: 36, textAlign: 'right', fontSize: 13, fontWeight: 800, color: 'var(--red)', flexShrink: 0 }}>
                              {Number.isInteger(it.qty) ? it.qty : parseFloat(it.qty.toFixed(2))}
                            </span>
                            <span style={{ width: 36, fontSize: 11, color: 'var(--txt3)', fontWeight: 600, flexShrink: 0 }}>{it.unit}</span>
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
                        {allItems.length} รายการ · {cutCount} ครั้ง
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
        // 🏪 กรองตามสาขาที่เลือก ('' หรือ 'all' = ทุกสาขา)
        const whAll    = !wh || wh === 'all'
        const inBranch = (id) => whAll || id === wh
        const rfPending    = refillRequests.filter(r => r.status === 'pending' && (whAll || r.branchId === wh))
        const pendingLots  = lots.filter(l => l.pendingInfo && ((l.inWarehouse || 0) + (l.inShop || 0)) > 0 && inBranch(l.warehouseId)
          && items.find(m => m.id === l.itemId)?.lotEnabled !== false)   // 🔕 item ปิด LOT → ไม่ทวงข้อมูล
        // EXP เฉพาะสาขาที่เลือก — recompute จาก lots (กรองสาขา → dedup 1 chip/สินค้า) กัน LOT แม่+ลูกข้ามคลัง
        const _in7 = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
        const _byItem = {}
        lots.forEach(lot => {
          if (!inBranch(lot.warehouseId)) return
          if (items.find(m => m.id === lot.itemId)?.lotEnabled === false) return   // 🔕 item ปิด LOT → ไม่เตือน EXP
          const qty = (lot.inWarehouse || 0) + (lot.inShop || 0)
          if (qty <= 0 || !lot.expDate) return
          const exp = new Date(lot.expDate)
          if (exp > _in7) return
          const daysLeft = Math.ceil((exp - new Date()) / (1000 * 60 * 60 * 24))
          const k = lot.itemId || lot.itemName
          if (!_byItem[k] || daysLeft < _byItem[k].daysLeft) _byItem[k] = { ...lot, daysLeft }
        })
        const branchExpAlerts = Object.values(_byItem)
        // low/out stock → ดูที่ 🔔 กระดิ่ง (คำนวณสด) · ใบโอน → section ด้านล่าง · ที่นี่เหลือ RF + EXP + LOT รอข้อมูล
        const hasAny = rfPending.length || branchExpAlerts.length || pendingLots.length

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

              {/* 📅 LOT รอเพิ่มข้อมูล (วันหมดอายุ) — รับสินค้าแล้วแต่ยังไม่ใส่ exp */}
              {pendingLots.length > 0 && (
                <FlowCard
                  icon="📅" bg="#F0F9FF" borderColor="#7DD3FC"
                  title="สินค้ารับแล้ว · รอเพิ่มข้อมูล LOT"
                  sub={`มี ${pendingLots.length} รายการรอใส่วันหมดอายุ — กดเพื่อเพิ่มข้อมูล`}
                  badge={pendingLots.length} badgeBg="#E0F2FE" badgeColor="#0284C7"
                  onClick={() => { setLotInfoData({}); setLotInfoWh(wh); setLotInfoOpen(true) }}
                />
              )}

              {/* Low/out stock chips — ลบออกแล้ว (ซ้ำกับ 🔔 กระดิ่งที่คำนวณสดจาก balance) */}

              {/* EXP alerts */}
              {branchExpAlerts.length > 0 && (
                <div style={{ display: 'flex', gap: 6, overflowX: 'auto',
                  scrollbarWidth: 'none', paddingBottom: 2 }}>
                  {branchExpAlerts.map(lot => (
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

      {/* ── Section: ใบแจ้งเติมของรอดำเนินการ ──
           editor เห็นทุกใบ + ลบได้ · สร้างใบโอนรวม (กระทบ stock) = Owner เท่านั้น */}
      {isEditor() && refillRequests.filter(r => (r.status === 'pending' || r.status === 'partial') && (!wh || wh === 'all' || r.branchId === wh)).length > 0 && (() => {
        const pendingRFs = refillRequests.filter(r => (r.status === 'pending' || r.status === 'partial') && (!wh || wh === 'all' || r.branchId === wh))
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
              {/* เลือกทั้งหมด — ทุก editor (ใช้เลือกไปสร้างใบโอนรวม) */}
              {isEditor() && !someSelected && (
                <button onClick={toggleAll}
                  style={{ fontSize: 11, fontWeight: 600, color: '#6B7280',
                    background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px' }}>
                  ☑ เลือกทั้งหมด
                </button>
              )}
              {/* ปุ่มสร้างใบโอนรวม — เล็ก อยู่ที่ header (แทนแถบแดงใหญ่) */}
              {isEditor() && someSelected && (
                <button onClick={() => setRfSelectedIds(new Set())}
                  style={{ fontSize: 11, fontWeight: 600, color: '#9CA3AF',
                    background: 'none', border: 'none', cursor: 'pointer', padding: '2px 2px', flexShrink: 0 }}>
                  ✗
                </button>
              )}
              {isEditor() && someSelected && (
                <button onClick={e => { e.stopPropagation(); openTransferFromRFs(selectedRFs) }}
                  style={{ fontSize: 11, fontWeight: 700, color: '#fff',
                    background: 'linear-gradient(135deg,#DC2626,#B91C1C)', border: 'none',
                    borderRadius: 9, padding: '6px 11px', cursor: 'pointer', flexShrink: 0,
                    display: 'flex', alignItems: 'center', gap: 5,
                    boxShadow: '0 2px 6px rgba(220,38,38,0.3)' }}>
                  🚚 โอนรวม {rfSelectedIds.size} ใบ →
                </button>
              )}
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
                const canSelect = isEditor()  // เลือกเพื่อสร้างใบโอนรวม = ทุก editor
                const isPartial = rf.status === 'partial'
                // ธีมการ์ด: ส่งไม่ครบ (partial) = แดง · รอดำเนินการ (pending) = เหลือง
                const theme = isPartial
                  ? { selBg:'#FEE2E2', bg:'#FEF2F2', selBd:'#EF4444', bd:'#FCA5A5', shadow:'rgba(239,68,68,0.18)' }
                  : { selBg:'#FFFBEB', bg:'#fff',    selBd:'#F59E0B', bd:'#FDE68A', shadow:'rgba(245,158,11,0.15)' }
                return (
                  <div key={rf.id}
                    onClick={() => setCardDetail({ type: 'rf', data: rf })}
                    style={{ background: sel ? theme.selBg : theme.bg, borderRadius: 14,
                      border: `2px solid ${sel ? theme.selBd : theme.bd}`,
                      boxShadow: sel ? `0 0 0 3px ${theme.shadow}` : '0 1px 4px rgba(0,0,0,0.05)',
                      padding: 14, cursor: 'pointer', transition: 'all 0.15s' }}>

                    {/* Row 1: Checkbox + Ref + Badge + 🗑️ */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                      {/* Checkbox custom — Owner เท่านั้น (ใช้เลือกไปสร้างใบโอน) */}
                      {canSelect && (
                        <div onClick={e => { e.stopPropagation(); toggleRF(rf.id) }}
                          style={{ width: 22, height: 22, borderRadius: 6, border: `2px solid ${sel ? theme.selBd : '#D1D5DB'}`,
                            background: sel ? theme.selBd : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                            flexShrink: 0, transition: 'all 0.15s', cursor: 'pointer' }}>
                          {sel && <span style={{ color: '#fff', fontSize: 13, fontWeight: 900 }}>✓</span>}
                        </div>
                      )}
                      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 8, overflow: 'hidden' }}>
                        <span style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 13, flexShrink: 0 }}>
                          {rf.rfRef || rf.id.slice(-8)}
                        </span>
                        <span style={{ fontSize: 11.5, color: '#374151', fontWeight: 600, whiteSpace: 'nowrap',
                          overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          👤 {rf.requestedBy || 'ไม่ระบุ'}{timeStr ? ` · 🕐 ${timeStr}` : ''}
                        </span>
                      </div>
                      {isPartial ? (
                        <span style={{ fontSize: 10, background: '#FEE2E2', color: '#DC2626',
                          border: '1px solid #FCA5A5', borderRadius: 6, padding: '2px 7px', fontWeight: 800 }}>
                          🔴 ส่งไม่ครบ · เหลือเฉพาะที่ค้าง
                        </span>
                      ) : (
                        <span style={{ fontSize: 10, background: '#FFF7ED', color: '#D97706',
                          border: '1px solid #FDE68A', borderRadius: 6, padding: '2px 7px', fontWeight: 700 }}>
                          🟡 รอดำเนินการ
                        </span>
                      )}
                      {/* ปุ่มแก้ไข — เฉพาะใบที่ยังไม่ส่ง (pending) · ใบ partial แก้ไม่ได้ (กันยอดเพี้ยน) */}
                      {!isPartial && (
                        <button
                          onClick={e => { e.stopPropagation(); openEditRF(rf) }}
                          title="แก้ไขใบแจ้งเติม"
                          style={{ width: 28, height: 28, border: 'none', borderRadius: 8, cursor: 'pointer',
                            background: '#EFF6FF', color: '#2563EB',
                            fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center',
                            flexShrink: 0, transition: 'all 0.15s' }}>
                          ✏️
                        </button>
                      )}
                      {/* ปุ่มเดียวฉลาด — partial: ปิดใบ(🚫) · pending: ยกเลิก(🗑️) */}
                      <button
                        onClick={e => { e.stopPropagation()
                          setRfDeleteId(rfDeleteId === rf.id ? null : rf.id)
                          setRfDeleteReason('')
                        }}
                        title={isPartial ? 'ไม่ส่งส่วนที่ค้าง · ปิดใบ' : 'ยกเลิกคำร้อง'}
                        style={{ width: 28, height: 28, border: 'none', borderRadius: 8, cursor: 'pointer',
                          background: rfDeleteId === rf.id ? '#FEE2E2' : '#F3F4F6',
                          color: rfDeleteId === rf.id ? '#DC2626' : '#9CA3AF',
                          fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center',
                          flexShrink: 0, transition: 'all 0.15s' }}>
                        {isPartial ? '🚫' : '🗑️'}
                      </button>
                    </div>

                    {/* รายการ chips */}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginLeft: 32, marginBottom: rfDeleteId === rf.id ? 10 : 0 }}>
                      {sortByMaster(rf.items, { items, catOrder }).map((it, i) => {
                        const master = items.find(m => m.id === it.itemId)
                        const reqUse = qtyToUse(parseFloat(it.qty) || 0, it.unit, master)
                        const fulfilled = Number(it.fulfilledQtyUse) || 0
                        const remainUse = reqUse - fulfilled
                        if (isPartial) {
                          // 🔴 ส่งไม่ครบ → แสดงเฉพาะ "ที่ยังค้าง" (รายการที่ส่งครบแล้วซ่อน · ไม่โชว์ยอดที่ขอเดิม)
                          if (remainUse <= 1e-6 || !master) return null
                          return (
                            <span key={i} style={{ fontSize: 11, background: '#FEF2F2',
                              borderRadius: 6, padding: '3px 8px', border: '1px solid #FCA5A5' }}>
                              {it.img} {master?.displayName || it.itemName}
                              <span style={{ color: '#DC2626', fontWeight: 800 }}> ค้าง {formatStockQty(remainUse, master)}</span>
                            </span>
                          )
                        }
                        // 🟡 รอดำเนินการ → แสดงยอดที่ขอเต็ม
                        return (
                          <span key={i} style={{ fontSize: 11, background: '#F3F4F6',
                            borderRadius: 6, padding: '3px 8px', border: '1px solid #E5E7EB' }}>
                            {it.img} {master?.displayName || it.itemName}
                            {it.qty > 0
                              ? <span style={{ color: '#D97706', fontWeight: 700 }}> ×{it.qty} {it.unit}</span>
                              : null}
                          </span>
                        )
                      })}
                    </div>

                    {/* Inline Delete Confirm */}
                    {rfDeleteId === rf.id && (
                      <div onClick={e => e.stopPropagation()}
                        style={{ marginTop: 4, padding: '10px 12px', background: '#FEF2F2',
                          borderRadius: 10, border: '1px solid #FECACA' }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: '#DC2626', marginBottom: 6 }}>
                          {isPartial
                            ? `🚫 ปิดใบ — ไม่ส่งส่วนที่ค้าง ${rf.rfRef}? (ของที่ส่งแล้วยังอยู่)`
                            : `🗑️ ยืนยันยกเลิกคำร้อง ${rf.rfRef}?`}
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
                            {rfDeleting ? 'กำลังบันทึก...' : (isPartial ? '🚫 ปิดใบ + บันทึก Log' : '🗑️ ยืนยันยกเลิก + บันทึก Log')}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {/* ปุ่มสร้างใบโอนรวมย้ายไปอยู่ที่ header แล้ว (เล็กลง ไม่เด่นเกินไป) */}
          </div>
        )
      })()}

      {/* ── Section: ใบสั่งซื้อรอรับของ (ordered/partial) + รับแล้ววันนี้ (ถอนได้) ── */}
      {(() => {
        const recvTodayKey = poToday()
        // 🛒 PO = สั่งซื้อเข้า "คลังกลาง" เท่านั้น → โชว์เฉพาะตอนดูคลังกลาง/ทุกร้าน (สาขาอื่นไม่เกี่ยว)
        const _w = warehouses.find(x => x.id === wh)
        const isMainView = !wh || wh === 'all' || _w?.type === 'main' || _w?.isMain
        const visiblePOs = !isMainView ? [] : purchaseOrders.filter(po => {
          if (po.status === 'ordered' || po.status === 'partial') return true
          // received → แสดงเฉพาะที่รับวันนี้ (เผื่อถอน)
          if (po.status === 'received') {
            const ts = po.receivedAt
            const k = ts?.seconds ? new Date(ts.seconds * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' }) : null
            return k === recvTodayKey
          }
          return false
        })
        if (visiblePOs.length === 0) return null
        return (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 1rem' }}>
            <div className="section-label" style={{ padding: 0, marginBottom: 0, flex: 1 }}>🛒 รอรับของ (สั่งซื้อ)</div>
            <span style={{ background: '#FEF3C7', color: '#B45309', borderRadius: 10,
              padding: '2px 8px', fontSize: 11, fontWeight: 700 }}>{visiblePOs.length}</span>
          </div>
          <div style={{ padding: '8px 1rem 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[...visiblePOs].sort((a,b)=>(a.createdAt?.seconds||0)-(b.createdAt?.seconds||0)).map(po => {
              const isPartial  = po.status === 'partial'
              const isReceived = po.status === 'received'
              const badge = isReceived ? { t: '✅ รับแล้ววันนี้', bg: '#DCFCE7', c: '#16A34A', border: '#86EFAC' }
                : isPartial ? { t: '🟠 รับบางส่วน · ค้าง', bg: '#FFEDD5', c: '#C2410C', border: '#FED7AA' }
                : { t: '🚚 ระหว่างขนส่ง', bg: '#FEF9C3', c: '#92400E', border: '#FDE68A' }
              return (
                <div key={po.id} onClick={() => setCardDetail({ type: 'po', data: po })}
                  style={{ background: '#fff', borderRadius: 14, cursor: 'pointer',
                  border: `1px solid ${badge.border}`, boxShadow: '0 1px 4px rgba(0,0,0,0.05)', padding: 14 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <span style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 13, flex: 1 }}>{po.poRef || po.id.slice(-6)}</span>
                    {/* ✏️ แก้ไข + 🗑️ ยกเลิก — เฉพาะ ordered (ยังไม่รับ) */}
                    {isEditor() && po.status === 'ordered' && (
                      <>
                        <button onClick={(e) => { e.stopPropagation(); openEditPO(po) }}
                          style={{ border: '1px solid #FCD34D', background: '#FFFBEB', color: '#B45309',
                            borderRadius: 7, padding: '3px 9px', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                          ✏️ แก้ไข
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); cancelPO(po) }}
                          style={{ border: '1px solid #FCA5A5', background: '#FEF2F2', color: '#DC2626',
                            borderRadius: 7, padding: '3px 9px', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                          🗑️ ยกเลิก
                        </button>
                      </>
                    )}
                    <span style={{ fontSize: 10, fontWeight: 700, borderRadius: 6, padding: '2px 7px',
                      background: badge.bg, color: badge.c }}>{badge.t}</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--txt2)', marginBottom: 6 }}>
                    🏭 {po.supplier || 'supplier'} → คลังกลาง
                    {po.shipper ? <span style={{ color: '#6B7280' }}> · 🚚 {po.shipper}</span> : null}
                    {po.orderDate ? <span style={{ color: '#9CA3AF' }}> · สั่ง {po.orderDate}</span> : null}
                    {po.expectedDate ? <span style={{ color: '#9CA3AF' }}> · คาดถึง {po.expectedDate}</span> : null}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--txt3)', marginBottom: 10 }}>
                    <strong>{po.items?.length || 0} รายการ</strong>
                    {sortByMaster(po.items, { items, catOrder }).slice(0, 3).map((it, i) => (
                      <span key={i} style={{ marginLeft: 6 }}>{it.img}{it.itemName} ×{it.qty}</span>
                    ))}
                    {(po.items?.length || 0) > 3 && <span> +{po.items.length - 3}</span>}
                  </div>
                  {isEditor() && (
                    <div style={{ display: 'flex', gap: 8 }} onClick={(e) => e.stopPropagation()}>
                      {!isReceived && (
                        <button onClick={() => openReceivePO(po)}
                          style={{ flex: 1, background: '#D97706', color: '#fff', border: 'none',
                            borderRadius: 10, padding: '10px 0', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                          📋 ตรวจรับของ
                        </button>
                      )}
                      {/* ↩️ ถอนการรับของ — partial หรือ received (ภายในวัน) */}
                      {(isPartial || isReceived) && (
                        <button onClick={() => undoReceivePO(po)}
                          style={{ flex: isReceived ? 1 : '0 0 auto', background: '#fff', color: '#B45309',
                            border: '1.5px solid #FCD34D', borderRadius: 10, padding: '10px 14px',
                            fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                          ↩️ ถอนการรับของ
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
        )
      })()}

      {/* ── Section: ใบโอนเตรียมจัดส่ง (preparing) — เฟส 1 ── */}
      {transfers.filter(t => t.status === 'preparing' && (!wh || wh === 'all' || t.fromWarehouseId === wh || t.toWarehouseId === wh)).length > 0 && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 1rem' }}>
            <div className="section-label" style={{ padding: 0, marginBottom: 0, flex: 1 }}>📦 เตรียมจัดส่ง</div>
            <span style={{ background: '#DBEAFE', color: '#1D4ED8', borderRadius: 10,
              padding: '2px 8px', fontSize: 11, fontWeight: 700 }}>
              {transfers.filter(t => t.status === 'preparing' && (!wh || wh === 'all' || t.fromWarehouseId === wh || t.toWarehouseId === wh)).length}
            </span>
          </div>
          <div style={{ padding: '8px 1rem 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {transfers.filter(t => t.status === 'preparing' && (!wh || wh === 'all' || t.fromWarehouseId === wh || t.toWarehouseId === wh)).map(tf => {
              const fromName = warehouses.find(w => w.id === tf.fromWarehouseId)?.name || tf.fromWarehouseName || 'คลัง'
              const toName   = warehouses.find(w => w.id === tf.toWarehouseId)?.name   || tf.toWarehouseName   || 'ร้าน'
              return (
                <div key={tf.id} onClick={() => setCardDetail({ type: 'tf', data: tf })}
                  style={{ background: '#fff', borderRadius: 14, cursor: 'pointer',
                  border: '1px solid #BFDBFE', boxShadow: '0 1px 4px rgba(0,0,0,0.05)', padding: 14 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <span style={{ fontFamily: 'Prompt', fontWeight: 700, fontSize: 13 }}>{tf.tfRef || tf.id.slice(-6)}</span>
                    <span style={{ fontSize: 10, background: '#DBEAFE', color: '#1D4ED8',
                      borderRadius: 6, padding: '2px 7px', fontWeight: 700 }}>📦 เตรียมสินค้า</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--txt2)', marginBottom: 6 }}>
                    {fromName} → {toName}
                    {tf.driver ? <span style={{ color: '#6B7280' }}> · 🧑 {tf.driver}</span> : null}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--txt3)', marginBottom: 10 }}>
                    {tf.items?.length || 0} รายการ
                    {sortByMaster(tf.items, { items, catOrder }).slice(0, 3).map((it, i) => (
                      <span key={i} style={{ marginLeft: 6 }}>{it.img}{it.itemName}</span>
                    ))}
                    {(tf.items?.length || 0) > 3 && <span> +{tf.items.length - 3}</span>}
                  </div>
                  {isOwner() && (
                    <div style={{ display: 'flex', gap: 8 }} onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => cancelPreparingTransfer(tf)}
                        style={{ flex: '0 0 auto', border: '1.5px solid #FCA5A5', background: '#FEF2F2', color: '#DC2626',
                          borderRadius: 10, padding: '11px 14px', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                        ↩️ ถอย
                      </button>
                      <button onClick={() => dispatchTransfer(tf)}
                        style={{ flex: 1, background: '#1D4ED8', color: '#fff', border: 'none',
                          borderRadius: 10, padding: '11px 0', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                        🚚 ส่งสินค้า
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Section: ใบโอนกำลังนำส่ง (in_transit) — เฟส 2 ── */}
      {transfers.filter(t => t.status === 'in_transit' && (!wh || wh === 'all' || t.fromWarehouseId === wh || t.toWarehouseId === wh)).length > 0 && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 1rem' }}>
            <div className="section-label" style={{ padding: 0, marginBottom: 0, flex: 1 }}>🚚 กำลังนำส่ง</div>
            <span style={{ background: '#DCFCE7', color: '#16A34A', borderRadius: 10,
              padding: '2px 8px', fontSize: 11, fontWeight: 700 }}>
              {transfers.filter(t => t.status === 'in_transit' && (!wh || wh === 'all' || t.fromWarehouseId === wh || t.toWarehouseId === wh)).length}
            </span>
          </div>
          <div style={{ padding: '8px 1rem 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {transfers.filter(t => t.status === 'in_transit' && (!wh || wh === 'all' || t.fromWarehouseId === wh || t.toWarehouseId === wh)).map(tf => {
              const fromName = warehouses.find(w => w.id === tf.fromWarehouseId)?.name || tf.fromWarehouseName || 'คลัง'
              const toName   = warehouses.find(w => w.id === tf.toWarehouseId)?.name   || tf.toWarehouseName   || 'ร้าน'
              return (
                <div key={tf.id} onClick={() => setCardDetail({ type: 'tf', data: tf })}
                  style={{ background: '#fff', borderRadius: 14, cursor: 'pointer',
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
                    {sortByMaster(tf.items, { items, catOrder }).slice(0, 3).map((it, i) => (
                      <span key={i} style={{ marginLeft: 6 }}>{it.img}{it.itemName}</span>
                    ))}
                    {(tf.items?.length || 0) > 3 && <span> +{tf.items.length - 3}</span>}
                    {tf.loadedBy && <div style={{ marginTop: 3, color: '#16A34A', fontWeight: 600 }}>✅ เช็คขึ้นรถครบ · {tf.loadedBy}</div>}
                  </div>
                  {isEditor() && (
                    <button onClick={(e) => { e.stopPropagation(); openReceiveTransfer(tf) }}
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

      {/* ══ Popup: รายละเอียดการ์ด (PO / TF) — กดการ์ดเพื่อดูรายการเต็ม ══ */}
      <Modal open={!!cardDetail} onClose={() => setCardDetail(null)}
        title={cardDetail ? (cardDetail.type === 'po'
          ? `🛒 ${cardDetail.data.poRef || cardDetail.data.id?.slice(-6)}`
          : cardDetail.type === 'rf'
          ? `📋 ${cardDetail.data.rfRef || cardDetail.data.id?.slice(-8)}`
          : `🚚 ${cardDetail.data.tfRef || cardDetail.data.id?.slice(-6)}`) : ''}>
        {cardDetail && (() => {
          const d = cardDetail.data
          const isPO = cardDetail.type === 'po'
          const isRF = cardDetail.type === 'rf'
          const fromTo = isPO
            ? `🏭 ${d.supplier || '-'} → คลังกลาง${d.shipper ? ` · 🚚 ${d.shipper}` : ''}`
            : isRF
            ? `📍 ${warehouses.find(w => w.id === d.branchId)?.name || d.branchName || 'สาขา'} · 👤 ${d.requestedBy || 'ไม่ระบุ'}`
            : `${warehouses.find(w => w.id === d.fromWarehouseId)?.name || d.fromWarehouseName || 'คลัง'} → ${warehouses.find(w => w.id === d.toWarehouseId)?.name || d.toWarehouseName || 'ร้าน'}${d.driver ? ` · 🧑 ${d.driver}` : ''}`
          const ORDER = catOrder.length > 0 ? catOrder : CAT_ORDER
          const rows = (d.items || []).map(it => {
            const m = items.find(x => x.id === it.itemId)
            const ci = ORDER.indexOf(m?.category)
            return { it, m, _cat: ci < 0 ? 999 : ci, _sort: m?.sortOrder ?? 999 }
          }).sort((a, b) => (a._cat - b._cat) || (a._sort - b._sort))
          const totalU = Number((d.items || []).reduce((s, it) => s + (parseFloat(it.qty) || 0), 0).toFixed(2))
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 12, color: '#92400E', background: '#FFF7ED', borderRadius: 9,
                padding: '7px 11px', border: '1px solid #FDE68A' }}>{fromTo}</div>
              {isPO ? (
                <div style={{ fontSize: 11, color: 'var(--txt3)' }}>
                  📅 สั่ง {d.orderDate || '-'}{d.expectedDate ? ` · คาดถึง ${d.expectedDate}` : ''}
                  {d.receivedBy ? ` · รับโดย ${d.receivedBy}` : ''}
                </div>
              ) : isRF ? (
                <div style={{ fontSize: 11, fontWeight: 700,
                  color: d.status === 'partial' ? '#C2410C' : '#D97706' }}>
                  {d.status === 'partial' ? '🟠 ส่งบางส่วน · ค้างส่ง' : '🟡 รอดำเนินการ'}
                </div>
              ) : (d.loadedBy && <div style={{ fontSize: 11, color: '#16A34A', fontWeight: 600 }}>✅ เช็คขึ้นรถครบ · {d.loadedBy}</div>)}
              {!isPO && !isRF && d.hadShortage && (
                <div style={{ fontSize: 11, fontWeight: 700, color: '#D97706', background: '#FFFBEB',
                  border: '1px solid #FDE68A', borderRadius: 9, padding: '6px 10px' }}>
                  ⚠️ รับไม่ครบ — รับตามยอดจริง · ส่วนที่ขาดสร้างใบแจ้งเติมไว้แล้ว
                </div>
              )}
              <div style={{ fontSize: 12, fontWeight: 700 }}>📋 รายการ ({d.items?.length || 0}) · {totalU} หน่วย</div>
              {isRF && d.status === 'partial' ? (() => {
                // 🔴 ค้างส่ง / 🟢 ส่งแล้ว — แยกกลุ่มจาก fulfilledQtyUse
                const enrich = (d.items || []).map(it => {
                  const m = items.find(x => x.id === it.itemId)
                  const reqUse = qtyToUse(parseFloat(it.qty) || 0, it.unit, m)
                  const fulfilled = Number(it.fulfilledQtyUse) || 0
                  const ci = ORDER.indexOf(m?.category)
                  return { it, m, fulfilled, remainUse: reqUse - fulfilled, _cat: ci < 0 ? 999 : ci, _sort: m?.sortOrder ?? 999 }
                }).sort((a, b) => (a._cat - b._cat) || (a._sort - b._sort))
                const pend = enrich.filter(x => x.remainUse > 1e-6)
                const sent = enrich.filter(x => x.fulfilled > 1e-6)
                const grp = (title, color, bg, bd, list, qtyOf) => list.length > 0 && (
                  <div>
                    <div style={{ fontSize: 11.5, fontWeight: 800, color, marginBottom: 5 }}>{title} ({list.length})</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                      {list.map((x, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 9, background: bg,
                          borderRadius: 9, border: `1px solid ${bd}`, padding: '7px 10px' }}>
                          <span style={{ fontSize: 16, flexShrink: 0 }}>{x.it.img}</span>
                          <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, color,
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{x.m?.displayName || x.it.itemName}</span>
                          <span style={{ fontSize: 12.5, fontWeight: 800, color, flexShrink: 0 }}>{qtyOf(x)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {grp('🔴 ค้างส่ง', '#DC2626', '#FEF2F2', '#FCA5A5', pend, x => x.m ? formatStockQty(x.remainUse, x.m) : '')}
                    {grp('🟢 ส่งแล้ว', '#16A34A', '#F0FDF4', '#BBF7D0', sent, x => x.m ? formatStockQty(x.fulfilled, x.m) : '')}
                  </div>
                )
              })() : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {rows.map(({ it, m }, i) => {
                  const recv = isPO && Number(it.fulfilledQtyUse) > 0
                  const isRecvTF = !isPO && !isRF && d.status === 'received' && it.receivedQty != null
                  const planned  = parseFloat(it.qty) || 0
                  const got      = Number(it.receivedQty) || 0
                  const short    = isRecvTF && got < planned
                  return (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 9,
                      background: short ? '#FFFBEB' : '#fff',
                      borderRadius: 9, border: `1px solid ${short ? '#FDE68A' : 'var(--border)'}`, padding: '7px 10px' }}>
                      <span style={{ fontSize: 16, flexShrink: 0 }}>{it.img}</span>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap',
                        overflow: 'hidden', textOverflow: 'ellipsis' }}>{m?.displayName || it.itemName}</span>
                      {recv && <span style={{ fontSize: 10, color: '#16A34A', fontWeight: 700 }}>รับแล้ว</span>}
                      {isRecvTF ? (
                        <span style={{ fontSize: 12.5, fontWeight: 700, flexShrink: 0 }}>
                          {short && <span style={{ color: 'var(--txt3)', textDecoration: 'line-through', fontWeight: 600, marginRight: 5 }}>{planned}</span>}
                          <span style={{ color: short ? '#D97706' : '#16A34A' }}>{got} {it.unit}</span>
                          {short && ' ⚠️'}
                        </span>
                      ) : (
                        <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--txt2)', flexShrink: 0 }}>{it.qty} {it.unit}</span>
                      )}
                    </div>
                  )
                })}
              </div>
              )}
            </div>
          )
        })()}
      </Modal>

      {/* ══ Modal: สั่งซื้อ (Step 1) — Supplier → คลังกลาง ══ */}
      <Modal open={poOpen}
        onClose={() => { setPoOpen(false); setPoItems([]); setPoStep('pick'); setPoEditId(null) }}
        lockClose={true}
        title={(() => {
          const totalU = Number(poItems.reduce((s, it) => s + (parseFloat(it.qty) || 0), 0).toFixed(2))
          const lead = poEditId ? '✏️ แก้ใบสั่งซื้อ' : '🛒 สั่งซื้อ'
          return poStep === 'pick'
            ? `${lead} · เลือกวัตถุดิบ (${poItems.length})`
            : `${lead} · ${poItems.length} รายการ · ${totalU} หน่วย`
        })()}
        footer={(() => {
          if (poStep === 'pick') {
            const canNext = poForm.supplier && poItems.length > 0
            return (
              <button className="btn-primary" disabled={!canNext} style={{ opacity: canNext ? 1 : 0.5 }}
                onClick={() => setPoStep('qty')}>
                ถัดไป → จำนวน ({poItems.length})
              </button>
            )
          }
          const allQty = poItems.every(it => parseFloat(it.qty) > 0)
          return (
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-secondary" style={{ flex: 1 }} onClick={() => setPoStep('pick')}>← ย้อนกลับ</button>
              <button className="btn-primary" style={{ flex: 2, opacity: (poSaving || !allQty) ? 0.5 : 1 }}
                disabled={poSaving || !allQty} onClick={submitPO}>
                {poSaving ? 'กำลังบันทึก...' : poEditId ? `💾 บันทึกการแก้ไข (${poItems.length})` : `🛒 ยืนยันสั่งซื้อ (${poItems.length})`}
              </button>
            </div>
          )
        })()}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* แหล่งที่มา + วันที่ */}
          <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 8,
            background: 'var(--bg)', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11.5, color: 'var(--txt2)', fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0 }}>🏭</span>
              <select className="fi" value={poForm.supplier} style={{ flex: 1, height: 32, padding: '0 8px', fontSize: 12.5 }}
                onChange={e => setPoForm(f => ({ ...f, supplier: e.target.value }))}>
                {sources.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <span style={{ fontSize: 11.5, whiteSpace: 'nowrap', flexShrink: 0 }}>🚚</span>
              <input className="fi" type="text" value={poForm.shipper} placeholder="ขนส่ง"
                style={{ flex: 1, height: 32, padding: '0 8px', fontSize: 12.5 }}
                onChange={e => setPoForm(f => ({ ...f, shipper: e.target.value }))} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11.5, color: 'var(--txt2)', fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0 }}>📅 สั่ง</span>
              <input className="fi" type="date" value={poForm.orderDate} style={{ flex: 1, height: 32, padding: '0 8px', fontSize: 12.5 }}
                onChange={e => setPoForm(f => ({ ...f, orderDate: e.target.value }))} />
              <span style={{ fontSize: 11, color: 'var(--txt3)', whiteSpace: 'nowrap' }}>คาดถึง</span>
              <input className="fi" type="date" value={poForm.expectedDate} style={{ flex: 1, height: 32, padding: '0 8px', fontSize: 12.5 }}
                onChange={e => setPoForm(f => ({ ...f, expectedDate: e.target.value }))} />
            </div>
          </div>

          {poStep === 'pick' ? (
            <div>
              <label className="fi-label" style={{ fontSize: 11 }}>📦 วัตถุดิบ — กดเพื่อเลือก/ยกเลิก</label>
              <div style={{ marginTop: 4, border: '1px solid var(--border)', borderRadius: 10, padding: 4, background: 'var(--bg)' }}>
                <ItemPickerGrid items={items} balances={balances}
                  warehouseId={warehouses.find(w => w.type === 'main' || w.isMain)?.id || null}
                  selectedIds={new Set(poItems.map(t => t.itemId))} filterFn={() => true}
                  onSelect={item => {
                    const exists = poItems.find(t => t.itemId === item.id)
                    if (exists) { setPoItems(prev => prev.filter(t => t.itemId !== item.id)); return }
                    const unitOpts = unitOptionsOf(item)   // รองรับหลายชั้น (ลัง/มัด/ใบ)
                    setPoItems(prev => [...prev, {
                      itemId: item.id, itemName: item.name, img: item.img || '📦',
                      category: item.category || 'อื่นๆ', qty: '1',
                      unit: unitOpts[0] || '', unitOpts,
                    }])
                  }} />
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {[...poItems].sort((a, b) => {
                const ORDER = catOrder.length > 0 ? catOrder : CAT_ORDER
                const ma = items.find(m => m.id === a.itemId), mb = items.find(m => m.id === b.itemId)
                const ca = ORDER.indexOf(ma?.category), cb = ORDER.indexOf(mb?.category)
                const ia = ca < 0 ? 999 : ca, ib = cb < 0 ? 999 : cb
                if (ia !== ib) return ia - ib
                return (ma?.sortOrder ?? 999) - (mb?.sortOrder ?? 999)
              }).map(it => {
                const master = items.find(m => m.id === it.itemId)
                return (
                <div key={it.itemId} style={{ background: '#fff', borderRadius: 9,
                  border: '1px solid var(--border)', padding: '5px 8px', display: 'flex',
                  alignItems: 'center', gap: 7 }}>
                  <span style={{ fontSize: 16, flexShrink: 0 }}>{it.img}</span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap',
                    overflow: 'hidden', textOverflow: 'ellipsis' }}>{master?.displayName || it.itemName}</span>
                  {it.unitOpts?.length > 1 && (
                    <UnitChips opts={it.unitOpts.map(u => ({ value: u, label: u, sub: '' }))} selected={it.unit}
                      onChange={u => setPoItems(prev => prev.map(p => p.itemId === it.itemId ? { ...p, unit: u } : p))} />
                  )}
                  {it.unitOpts?.length === 1 && (
                    <span style={{ fontSize: 11, color: 'var(--txt3)', flexShrink: 0 }}>{it.unit}</span>
                  )}
                  <PosQty value={parseFloat(it.qty) || 0}
                    onChange={v => setPoItems(prev => prev.map(p => p.itemId === it.itemId ? { ...p, qty: String(v) } : p))} />
                  <button onClick={() => setPoItems(prev => prev.filter(p => p.itemId !== it.itemId))}
                    style={{ border: 'none', background: 'transparent', color: '#9CA3AF', borderRadius: 6,
                      width: 20, height: 20, fontSize: 12, cursor: 'pointer', flexShrink: 0 }}>×</button>
                </div>
                )
              })}
              {/* ➕ เพิ่มวัตถุดิบที่ลืม — กลับไปหน้าเลือก (รายการเดิมยังอยู่) */}
              <button onClick={() => setPoStep('pick')}
                style={{ marginTop: 2, border: '1.5px dashed #FDBA74', background: '#FFF7ED', color: '#C2410C',
                  borderRadius: 10, padding: '9px 0', fontWeight: 700, fontSize: 12.5, cursor: 'pointer' }}>
                ➕ เพิ่มวัตถุดิบ
              </button>
            </div>
          )}
        </div>
      </Modal>

      {/* ══ Modal: ตรวจรับของ (Step 2) — checklist เทียบที่สั่ง ══ */}
      <Modal open={poRcvOpen} onClose={() => { setPoRcvOpen(false); setPoRcv(null) }}
        lockClose={true}
        title={poRcv ? `📋 ตรวจรับ ${poRcv.poRef || ''}` : 'ตรวจรับของ'}
        footer={(() => {
          // นับเฉพาะรายการที่ยัง "ค้างรับ" (ยังไม่รับครบ) → ต้องตรวจให้ครบทุกตัว
          let total = 0, reviewed = 0
          ;(poRcv?.items || []).forEach((it, i) => {
            const m = items.find(x => x.id === it.itemId)
            const reqUse = qtyToUse(it.qty, it.unit, m)
            const remainUse = Math.max(0, reqUse - (Number(it.fulfilledQtyUse) || 0))
            if (useToQty(remainUse, it.unit, m) <= 0) return  // รับครบแล้ว — ข้าม
            total++
            if (poRcvChecked[i]?.checked) reviewed++
          })
          const allReviewed = total > 0 && reviewed === total
          const canSubmit = allReviewed && !poRcvSaving
          return (
            <button onClick={submitReceivePO} disabled={!canSubmit}
              style={{ width: '100%', border: 'none', borderRadius: 12, padding: '13px 0',
                fontWeight: 700, fontSize: 14, cursor: canSubmit ? 'pointer' : 'not-allowed',
                color: '#fff', background: canSubmit ? '#16A34A' : '#FCD34D',
                opacity: poRcvSaving ? 0.6 : 1, transition: 'background .2s' }}>
              {poRcvSaving ? 'กำลังบันทึก...'
                : allReviewed ? `✅ ยืนยันรับของ (${reviewed}/${total})`
                : `ตรวจสอบให้ครบก่อน (${reviewed}/${total})`}
            </button>
          )
        })()}>
        {poRcv && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 11.5, color: '#92400E', background: '#FFF7ED', borderRadius: 9,
              padding: '7px 11px', border: '1px solid #FDE68A' }}>
              🏭 {poRcv.supplier} → คลังกลาง{poRcv.shipper ? ` · 🚚 ${poRcv.shipper}` : ''} · ติ๊ก ✓ = รับตรงที่สั่ง · กด “ไม่ตรง” ถ้าจำนวนไม่ตรง
            </div>
            {/* 📅 วันที่รับ — ย้อนได้ ≤ 3 วัน (เผื่อลงข้อมูลย้อนหลังตามวันที่มาส่งจริง) */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg)',
              border: '1px solid var(--border)', borderRadius: 10, padding: '7px 10px' }}>
              <span style={{ fontSize: 12, color: 'var(--txt2)', fontWeight: 700, whiteSpace: 'nowrap', flexShrink: 0 }}>📅 วันที่รับ</span>
              <input className="fi" type="date" value={poRcvDate}
                min={new Date(Date.now() - 3 * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' })}
                max={poToday()}
                style={{ flex: 1, height: 34, padding: '0 9px', fontSize: 13 }}
                onChange={e => setPoRcvDate(e.target.value)} />
              {poRcvDate !== poToday() && (
                <span style={{ fontSize: 10.5, fontWeight: 700, color: '#C2410C', background: '#FFEDD5',
                  borderRadius: 6, padding: '3px 7px', whiteSpace: 'nowrap', flexShrink: 0 }}>ย้อนหลัง</span>
              )}
            </div>
            {(poRcv.items || [])
              .map((it, i) => {
                const m = items.find(x => x.id === it.itemId)
                const ORDER = catOrder.length > 0 ? catOrder : CAT_ORDER
                const ci = ORDER.indexOf(m?.category)
                return { it, i, _cat: ci < 0 ? 999 : ci, _sort: m?.sortOrder ?? 999 }
              })
              .sort((a, b) => (a._cat - b._cat) || (a._sort - b._sort))
              .map(({ it, i }) => {
              const chk = poRcvChecked[i] || { checked: false, qty: '0', mismatch: false, reason: '' }
              const master = items.find(m => m.id === it.itemId)
              const reqUse = qtyToUse(it.qty, it.unit, master)
              const remainUse = Math.max(0, reqUse - (Number(it.fulfilledQtyUse) || 0))
              const remainInUnit = useToQty(remainUse, it.unit, master)
              const done = remainInUnit <= 0
              const recvQty = parseFloat(chk.qty) || 0
              return (
                <div key={i} style={{ background: chk.checked ? (chk.mismatch ? '#FFF7ED' : '#F0FDF4') : '#fff',
                  borderRadius: 11,
                  border: `1.5px solid ${chk.checked ? (chk.mismatch ? '#FDBA74' : '#86EFAC') : 'var(--border)'}`,
                  padding: '8px 10px', opacity: done ? 0.55 : 1, display: 'flex', alignItems: 'center', gap: 9 }}>
                  {/* checkbox */}
                  <div onClick={() => !done && setPoRcvChecked(c => ({ ...c, [i]: { ...chk, checked: !chk.checked, qty: chk.mismatch ? chk.qty : String(remainInUnit || 0) } }))}
                    style={{ width: 24, height: 24, borderRadius: 7, flexShrink: 0, cursor: done ? 'default' : 'pointer',
                      border: `2px solid ${chk.checked ? '#16A34A' : '#D1D5DB'}`,
                      background: chk.checked ? '#16A34A' : '#fff', display: 'flex',
                      alignItems: 'center', justifyContent: 'center' }}>
                    {chk.checked && <span style={{ color: '#fff', fontSize: 14, fontWeight: 900 }}>✓</span>}
                  </div>
                  <span style={{ fontSize: 18, flexShrink: 0 }}>{it.img}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, whiteSpace: 'nowrap',
                      overflow: 'hidden', textOverflow: 'ellipsis' }}>{master?.displayName || it.itemName}</div>
                    <div style={{ fontSize: 10.5, color: '#6B7280' }}>
                      📦 สั่ง <strong>{Number(remainInUnit.toFixed(2))} {it.unit}</strong>
                      {chk.checked && chk.mismatch && <span style={{ color: '#EA580C', fontWeight: 700 }}> · รับจริง {recvQty} {it.unit}</span>}
                      {chk.checked && chk.mismatch && chk.reason && <span style={{ color: '#9CA3AF' }}> · {chk.reason}</span>}
                      {done && ' · ✓ รับครบแล้ว'}
                    </div>
                  </div>
                  {/* ปุ่ม "ไม่ตรง" → popup */}
                  {chk.checked && !done && (
                    <button onClick={() => setPoMismatch({ idx: i, itemName: master?.displayName || it.itemName,
                      img: it.img, orderedQty: Number(remainInUnit.toFixed(2)), unit: it.unit,
                      qty: String(recvQty || remainInUnit || 0), reason: chk.reason || '' })}
                      style={{ flexShrink: 0, border: `1px solid ${chk.mismatch ? '#EA580C' : '#D1D5DB'}`,
                        background: chk.mismatch ? '#FFEDD5' : '#fff', color: chk.mismatch ? '#EA580C' : '#6B7280',
                        borderRadius: 8, padding: '5px 9px', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                      {chk.mismatch ? '✏️ แก้' : 'ไม่ตรง'}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </Modal>

      {/* ══ Popup: รับไม่ตรง — ระบุจำนวนจริง + สาเหตุ ══ */}
      <Modal open={!!poMismatch} onClose={() => setPoMismatch(null)}
        title="⚠️ รับไม่ตรงที่สั่ง"
        footer={poMismatch && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-secondary" style={{ flex: 1 }} onClick={() => setPoMismatch(null)}>ยกเลิก</button>
            <button className="btn-primary" style={{ flex: 2 }}
              disabled={!(parseFloat(poMismatch.qty) >= 0) || !poMismatch.reason.trim()}
              onClick={() => {
                const m = poMismatch
                setPoRcvChecked(c => ({ ...c, [m.idx]: { ...(c[m.idx] || {}), checked: true,
                  mismatch: true, qty: String(parseFloat(m.qty) || 0), reason: m.reason.trim() } }))
                setPoMismatch(null)
              }}>ยืนยันจำนวนจริง</button>
          </div>
        )}>
        {poMismatch && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#F9FAFB',
              borderRadius: 11, padding: '10px 12px', border: '1px solid var(--border)' }}>
              <span style={{ fontSize: 22 }}>{poMismatch.img}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{poMismatch.itemName}</div>
                <div style={{ fontSize: 11, color: '#6B7280' }}>📦 สั่ง {poMismatch.orderedQty} {poMismatch.unit}</div>
              </div>
            </div>
            <div>
              <label className="fi-label" style={{ fontSize: 11.5 }}>รับจริงเท่าไหร่ ({poMismatch.unit})</label>
              <div style={{ marginTop: 5 }}>
                <PosQty value={parseFloat(poMismatch.qty) || 0}
                  onChange={v => setPoMismatch(m => ({ ...m, qty: String(v) }))} />
              </div>
            </div>
            <div>
              <label className="fi-label" style={{ fontSize: 11.5 }}>สาเหตุที่ไม่ตรง <span style={{ color: '#DC2626' }}>*</span></label>
              <input className="fi" type="text" value={poMismatch.reason} autoFocus
                placeholder="เช่น ของขาด, แตกเสียหาย, ส่งเกิน, ส่งมาไม่ครบ"
                style={{ marginTop: 5, width: '100%', height: 38, padding: '0 11px', fontSize: 13 }}
                onFocus={e => { const t = e.target; setTimeout(() => t.scrollIntoView({ block: 'center', behavior: 'smooth' }), 80) }}
                onChange={e => setPoMismatch(m => ({ ...m, reason: e.target.value }))} />
            </div>
          </div>
        )}
      </Modal>

      {/* ══ Popup: เพิ่มข้อมูล LOT (วันหมดอายุ) — รับแล้วแต่ยังไม่ใส่ exp ══ */}
      <Modal open={lotInfoOpen} onClose={() => { setLotInfoOpen(false); setLotInfoData({}) }}
        title="📅 เพิ่มข้อมูล LOT — วันที่รับ / วันหมดอายุ"
        footer={
          <button className="btn-primary" onClick={saveLotInfo} disabled={lotInfoSaving}
            style={{ opacity: lotInfoSaving ? 0.5 : 1 }}>
            {lotInfoSaving ? 'กำลังบันทึก...' : '💾 บันทึกข้อมูล LOT'}
          </button>}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 10.5, color: '#0369A1', background: '#F0F9FF', borderRadius: 8,
            padding: '6px 9px', border: '1px solid #BAE6FD' }}>
            ℹ️ กรอก <strong>วันที่รับ · วันผลิต · วันหมดอายุ</strong> — หมดอายุเลือก “ใส่เอง” หรือ “คำนวณจากวันผลิต” ก็ได้ (กรอกทีหลังได้)
          </div>
          {(() => {
            const ORDER = catOrder.length > 0 ? catOrder : CAT_ORDER
            const pend = lots
              .filter(l => l.pendingInfo && ((l.inWarehouse || 0) + (l.inShop || 0)) > 0 && (!lotInfoWh || lotInfoWh === 'all' || l.warehouseId === lotInfoWh)
                && items.find(m => m.id === l.itemId)?.lotEnabled !== false)   // 🔕 item ปิด LOT → ไม่ทวงข้อมูล
              .map(l => {
                const m = items.find(x => x.id === l.itemId)
                const ci = ORDER.indexOf(m?.category)
                return { ...l, _cat: ci < 0 ? 999 : ci, _sort: m?.sortOrder ?? 999 }
              })
              .sort((a, b) => (a._cat - b._cat) || (a._sort - b._sort))
            if (pend.length === 0) return (
              <div style={{ padding: '14px', textAlign: 'center', fontSize: 12, color: 'var(--txt3)' }}>
                ✅ ไม่มี LOT ที่ค้างข้อมูล
              </div>
            )
            return pend.map(l => {
              const master = items.find(m => m.id === l.itemId)
              const u = master?.unitUse || ''
              const qty = (l.inWarehouse || 0) + (l.inShop || 0)
              const v = lotInfoData[l.id] || {}
              const mode = v.expMode || 'date'   // 'date'=ใส่เอง · 'duration'=คำนวณจากวันผลิต
              const upd = (patch) => setLotInfoData(d => ({ ...d, [l.id]: { ...(d[l.id] || {}), ...patch } }))
              const computedExp   = addDateDuration(v.mfgDate, v.shelfValue, v.shelfUnit || 'day')
              const directExp     = v.expDate || ''
              const shelfFromDate = daysBetween(v.mfgDate, directExp)
              const IH = 30
              const fld = { width: '100%', height: IH, padding: '0 6px', fontSize: 10.5, marginTop: 1 }
              // สีพื้นหลังต่อช่อง: รับ=ฟ้า · ผลิต=เขียว · หมดอายุ=แดง (อ่อน)
              const tint = (bg, bd) => ({ ...fld, background: bg, border: `1px solid ${bd}` })
              const C_BLUE = ['#EFF6FF', '#BFDBFE'], C_GREEN = ['#F0FDF4', '#BBF7D0'], C_RED = ['#FFF1F2', '#FECDD3']
              const lbl = { flex: 1, fontSize: 9.5, color: 'var(--txt3)', minWidth: 0 }
              const segBtn = (m, label) => (
                <button key={m} type="button" onClick={() => upd({ expMode: m })}
                  style={{ flex: 1, border: 'none', borderRadius: 5, padding: '3px 4px', fontSize: 10.5, fontWeight: 700,
                    cursor: 'pointer', background: mode === m ? 'var(--surf)' : 'transparent',
                    color: mode === m ? 'var(--txt)' : 'var(--txt3)',
                    boxShadow: mode === m ? '0 1px 2px rgba(0,0,0,.12)' : 'none' }}>{label}</button>
              )
              const autoBox = (text, ok, bg = '#F9FAFB', bd = '#EEEEEE') => (
                <div style={{ height: IH, lineHeight: `${IH}px`, padding: '0 6px', fontSize: 10.5, fontWeight: 700,
                  color: ok ? 'var(--txt)' : 'var(--txt3)', background: bg, border: `1px solid ${bd}`, borderRadius: 7, marginTop: 1,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{text}</div>
              )
              return (
                <div key={l.id} style={{ background: '#fff', borderRadius: 9, border: '1px solid var(--border)', padding: '6px 8px' }}>
                  {/* header — บรรทัดเดียว: ชื่อ + จำนวนรับ */}
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
                    <span style={{ fontSize: 16, flexShrink: 0 }}>{master?.img || '📦'}</span>
                    <span style={{ fontSize: 13.5, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden',
                      textOverflow: 'ellipsis', flex: 1, minWidth: 0 }}>{master?.displayName || l.itemName}</span>
                    <span style={{ fontSize: 10, color: '#9CA3AF', flexShrink: 0 }}>รับ {Number(qty.toFixed(2))} {u}</span>
                  </div>
                  {/* 💡 คัดลอกจาก LOT อื่นของ item เดียวกันที่มี EXP แล้ว (เช่น คลังกลาง) — จัด LOT ย้อนหลังไวขึ้น
                      เคสของเข้าสาขาด้วย "ปรับยอด(+)" ระบบไม่รู้ว่ามาจากล็อตไหน จึงถาม — แต่ถ้าคลังอื่นมีข้อมูลอยู่ กดเดียวจบ */}
                  {(() => {
                    const ref = lots
                      .filter(x => x.itemId === l.itemId && x.id !== l.id && x.status !== 'split' && x.expDate)
                      .sort((a, b) => (b.receiveDate || '').localeCompare(a.receiveDate || ''))[0]
                    if (!ref) return null
                    const refWh = warehouses.find(w => w.id === ref.warehouseId)?.name || 'คลังอื่น'
                    return (
                      <button type="button"
                        onClick={() => upd({ expDate: ref.expDate, mfgDate: (v.mfgDate ?? l.mfgDate) || ref.mfgDate || '', expMode: 'date' })}
                        style={{ marginTop: 5, width: '100%', border: '1px dashed #93C5FD', background: '#EFF6FF',
                          color: '#1D4ED8', borderRadius: 7, padding: '4px 8px', fontSize: 10.5, fontWeight: 700,
                          cursor: 'pointer', textAlign: 'left' }}>
                        📋 ใช้ EXP จาก LOT {refWh}: {formatDateDDMMYY(ref.expDate)}{ref.mfgDate ? ` · MFG ${formatDateDDMMYY(ref.mfgDate)}` : ''} — กดเพื่อเติม
                      </button>
                    )
                  })()}
                  {/* รับ + ผลิต */}
                  <div style={{ display: 'flex', gap: 6, marginTop: 5 }}>
                    <label style={lbl}>📥 รับ
                      <input className="fi" type="date" value={v.receiveDate ?? (l.receiveDate || '')} style={tint(...C_BLUE)}
                        onChange={e => upd({ receiveDate: e.target.value })} />
                    </label>
                    <label style={lbl}>🏭 ผลิต
                      <input className="fi" type="date" value={v.mfgDate ?? (l.mfgDate || '')} style={tint(...C_GREEN)}
                        onChange={e => upd({ mfgDate: e.target.value })} />
                    </label>
                  </div>
                  {/* โหมดวันหมดอายุ */}
                  <div style={{ display: 'flex', background: '#F2F2F7', borderRadius: 6, padding: 2, marginTop: 5 }}>
                    {segBtn('date', 'ใส่เอง')}
                    {segBtn('duration', 'คำนวณ')}
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', marginTop: 5 }}>
                    {mode === 'duration' ? (
                      <>
                        <div style={{ flex: 1.15, minWidth: 0 }}>
                          <div style={{ fontSize: 9.5, color: 'var(--txt3)' }}>อายุสินค้า</div>
                          <div style={{ display: 'flex', gap: 4, marginTop: 1 }}>
                            <input className="fi" type="number" min="0" inputMode="numeric" placeholder="0" value={v.shelfValue ?? ''}
                              style={{ flex: 1, minWidth: 0, height: IH, padding: '0 6px', fontSize: 11.5 }}
                              onChange={e => upd({ shelfValue: e.target.value })} />
                            <select className="fi" value={v.shelfUnit || 'day'}
                              style={{ width: 62, flexShrink: 0, height: IH, padding: '0 4px', fontSize: 11.5 }}
                              onChange={e => upd({ shelfUnit: e.target.value })}>
                              <option value="day">วัน</option>
                              <option value="month">เดือน</option>
                            </select>
                          </div>
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 9.5, color: 'var(--txt3)' }}>📅 หมดอายุ</div>
                          {autoBox(computedExp || '— ผลิต+อายุ', !!computedExp, ...C_RED)}
                        </div>
                      </>
                    ) : (
                      <>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 9.5, color: 'var(--txt3)' }}>📅 หมดอายุ</div>
                          <input className="fi" type="date" value={directExp} style={tint(...C_RED)}
                            onChange={e => upd({ expDate: e.target.value })} />
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 9.5, color: 'var(--txt3)' }}>อายุ</div>
                          {autoBox(shelfFromDate != null ? `${shelfFromDate} วัน` : '— ใส่ผลิต', shelfFromDate != null)}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )
            })
          })()}
        </div>
      </Modal>


      {/* ══ Modal: แจ้งเติมของ — Step 1: เลือกสาขา / Step 2: เลือก item ══ */}
      <Modal open={refillOpen}
        onClose={() => { setRefillOpen(false); setRefillSelected(new Set()); setRefillQtys({}); setRefillUnits({}); setRefillCat('low'); setRefillStep('branch'); setRefillBranch(''); setRefillEditId(null) }}
        title={refillEditId
          ? `✏️ แก้ไขใบแจ้งเติม — ${warehouses.find(w => w.id === refillBranch)?.name || ''}`
          : (refillStep === 'branch' ? 'แจ้งเติมของ — เลือกสาขา' : `แจ้งเติมของ — ${warehouses.find(w => w.id === refillBranch)?.name || ''}`)}
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
              {!refillEditId && (
                <button onClick={() => { setRefillStep('branch'); setRefillSelected(new Set()); setRefillQtys({}) }}
                  style={{ flex: '0 0 auto', border: '1.5px solid var(--border)', borderRadius: 12,
                    padding: '12px 16px', fontSize: 13, background: 'var(--bg)',
                    color: 'var(--txt2)', cursor: 'pointer', fontWeight: 600 }}>
                  ← สาขา
                </button>
              )}
              <button className="btn-primary" onClick={submitRefill}
                disabled={refillSaving || refillSelected.size === 0}
                style={{ flex: 1, opacity: refillSaving || refillSelected.size === 0 ? 0.5 : 1 }}>
                {refillSaving
                  ? 'กำลังบันทึก...'
                  : refillEditId
                    ? `✏️ บันทึกการแก้ไข (${refillSelected.size} รายการ)`
                    : `🧾 แจ้งเติมของ (${refillSelected.size} รายการ)`}
              </button>
            </div>
          )
        }>

        {/* ── Step 1: เลือกสาขา ─────────────────────────── */}
        {refillStep === 'branch' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <div style={{ fontSize: 12, color: '#1D4ED8', background: '#EFF6FF',
              borderRadius: 9, padding: '7px 11px', border: '1px solid #BFDBFE', fontWeight: 600 }}>
              🏪 เลือกสาขาที่ต้องการแจ้งเติมของ
            </div>
            {warehouses
              .filter(w => w.active !== false)
              .filter(w => !(w.type === 'main' || w.isMain))   // ❌ ไม่แสดงคลังกลาง — ใช้รับสินค้าแทน
              .map(wh => {
              const selected = refillBranch === wh.id
              const lowCount = items.filter(item => {
                if (item.alertEnabled === false) return false   // 🔕 ปิดแจ้งเตือน → ไม่นับ
                const bal = balances.find(b => b.itemId === item.id && b.warehouseId === wh.id)
                const qty = bal?.qty || 0
                const min = bal?.minQty || 0
                return min > 0 && qty <= min       // ต้องมี minQty ตั้งไว้ + qty ≤ min
              }).length
              return (
                <button key={wh.id} onClick={() => setRefillBranch(wh.id)}
                  style={{ display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 12px', borderRadius: 11, cursor: 'pointer',
                    border: `1.5px solid ${selected ? '#3B82F6' : 'var(--border)'}`,
                    background: selected ? '#EFF6FF' : 'var(--bg)',
                    transition: 'all .15s', textAlign: 'left', width: '100%' }}>
                  {/* Radio circle */}
                  <div style={{ width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
                    border: `2px solid ${selected ? '#3B82F6' : 'var(--border2)'}`,
                    background: selected ? '#3B82F6' : '#fff',
                    display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {selected && <span style={{ color: '#fff', fontSize: 12, fontWeight: 800, lineHeight: 1 }}>✓</span>}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 13.5, color: selected ? '#1D4ED8' : 'var(--txt1)' }}>
                      🏪 {wh.name}
                    </div>
                    <div style={{ fontSize: 10.5, marginTop: 2,
                      color: lowCount > 0 ? '#DC2626' : '#16A34A', fontWeight: 600 }}>
                      {lowCount > 0 ? `⚠️ Stock ต่ำ/หมด ${lowCount} รายการ` : '✅ Stock ปกติทุกรายการ'}
                    </div>
                  </div>
                  {selected && <span style={{ fontSize: 16, color: '#3B82F6' }}>→</span>}
                </button>
              )
            })}
          </div>
        )}

        {/* ── Step 2: เลือก item ────────────────────────── */}
        {refillStep === 'item' && <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* Branch pill */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            background: '#EFF6FF', borderRadius: 9, padding: '7px 11px', border: '1px solid #BFDBFE' }}>
            <span style={{ fontSize: 12, color: '#1D4ED8', fontWeight: 600 }}>
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
            // 🙈 ซ่อน item ที่ถูกตั้งซ่อนจากคลังสาขานี้ (Master Data: visibleIn[branch] === false)
            const visItems = items.filter(item => item.visibleIn?.[refillBranch] !== false)
            const allItems = visItems.filter(item => {
              if (item.alertEnabled === false) return false   // 🔕 ปิดแจ้งเตือน → ไม่ขึ้น auto-list ต่ำ/หมด (ยังเลือกผ่านหมวดได้)
              const qty = branchBal.filter(b => b.itemId === item.id).reduce((s,b) => s+(b.qty||0),0)
              return qty <= getMin(item.id)
            }).sort(sortBySortOrder)
            const others = visItems.filter(item => {
              const qty = branchBal.filter(b => b.itemId === item.id).reduce((s,b) => s+(b.qty||0),0)
              return qty > getMin(item.id)
            }).sort(sortBySortOrder)
            // ⚠️ ใช้ mainWarehouse prop (คลังกลางเก็บแยก) — warehouses ถูก filter เหลือสาขาเดียวสำหรับ staff
            //    ถ้า find จาก warehouses ที่ filter แล้ว → undefined → mainQty=0 ทุกรายการ (bug เดิม)
            const mainWh = mainWarehouse || warehouses.find(w => w.type === 'main' || w.isMain)
            const renderItem = (item) => {
              const stockQty = branchBal.filter(b => b.itemId === item.id).reduce((s,b) => s+(b.qty||0),0)
              const mainQty  = mainWh
                ? balances.filter(b => b.itemId === item.id && b.warehouseId === mainWh.id).reduce((s,b) => s+(b.qty||0),0)
                : 0
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

              // จำนวนที่ขอ → แปลงเป็นหน่วยเล็ก (unitUse) เพื่อเทียบกับสต็อกคลังกลาง — รองรับหน่วยหลายชั้น
              const reqInUse = qtyToUse(currentQty, selectedUnit, item)
              const overMain = checked && currentQty > 0 && reqInUse > mainQty

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
                <div key={item.id} style={{ borderRadius: 11,
                  border: `1.5px solid ${overMain ? '#FCA5A5' : checked ? '#FCD34D' : 'var(--border)'}`,
                  background: overMain ? '#FFF5F5' : checked ? '#FFFBEB' : '#fff',
                  overflow: 'hidden', transition: 'border-color .15s' }}>

                  {/* Row บน: checkbox + info */}
                  <div onClick={toggleCheck}
                    style={{ display: 'flex', alignItems: 'center', gap: 8,
                      padding: '7px 11px', cursor: 'pointer' }}>
                    {/* Checkbox */}
                    <div style={{ width: 20, height: 20, borderRadius: 6, flexShrink: 0,
                      border: `2px solid ${checked ? '#F59E0B' : 'var(--border2)'}`,
                      background: checked ? '#F59E0B' : '#fff',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      transition: 'all .15s' }}>
                      {checked && <span style={{ color: '#fff', fontSize: 12, fontWeight: 700, lineHeight: 1 }}>✓</span>}
                    </div>
                    <span style={{ fontSize: 18, flexShrink: 0 }}>{item.img || '📦'}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 700, whiteSpace: 'nowrap',
                        overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.displayName || item.name}</div>
                      <div style={{ fontSize: 9.5, fontWeight: 600, marginTop: 1, color: '#9CA3AF',
                        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          🏠 กลาง {formatStockQty(mainQty, item)}
                        </span>
                        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {isOut ? '🔴' : stockQty <= minQ ? '🟡' : '🟢'} สาขา {formatStockQty(stockQty, item)}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Row ล่าง: stepper + unit (เฉพาะเมื่อเลือก) */}
                  {checked && (<>
                    <div onClick={e => e.stopPropagation()}
                      style={{ borderTop: '1px solid #FDE68A', padding: '6px 11px',
                        display: 'flex', alignItems: 'center', gap: 6, background: '#FFFDF0' }}>

                      {/* Unit pills */}
                      {unitOpts.length > 1 && (
                        <div style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
                          {unitOpts.map(u => {
                            const active = selectedUnit === u
                            return (
                              <button key={u} onClick={() => setRefillUnits(r => ({ ...r, [item.id]: u }))}
                                style={{ border: `1.5px solid ${active ? '#F59E0B' : 'var(--border2)'}`,
                                  background: active ? '#F59E0B' : '#fff',
                                  color: active ? '#fff' : 'var(--txt2)',
                                  borderRadius: 7, padding: '3px 8px',
                                  fontSize: 10.5, fontWeight: 700, cursor: 'pointer' }}>
                                {u}
                              </button>
                            )
                          })}
                        </div>
                      )}
                      {unitOpts.length === 1 && (
                        <span style={{ fontSize: 11, fontWeight: 700, color: '#D97706',
                          background: '#FEF3C7', borderRadius: 7, padding: '3px 8px', flexShrink: 0 }}>
                          {selectedUnit}
                        </span>
                      )}

                      {/* Spacer */}
                      <div style={{ flex: 1 }} />

                      {/* POS Stepper */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 0,
                        border: '1.5px solid #FCD34D', borderRadius: 9, overflow: 'hidden' }}>
                        <button onClick={() => setQty(currentQty - 1)}
                          style={{ width: 30, height: 30, border: 'none', background: currentQty > 0 ? '#FEF3C7' : '#F3F4F6',
                            color: currentQty > 0 ? '#D97706' : '#C7C7CC',
                            fontSize: 16, fontWeight: 700, cursor: 'pointer',
                            display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          −
                        </button>
                        <div style={{ minWidth: 34, textAlign: 'center',
                          fontFamily: 'Prompt', fontWeight: 700, fontSize: 15,
                          color: currentQty > 0 ? '#1C1C1E' : '#C7C7CC',
                          padding: '0 3px', background: '#fff' }}>
                          {currentQty || 0}
                        </div>
                        <button onClick={() => setQty(currentQty + 1)}
                          style={{ width: 30, height: 30, border: 'none', background: '#F59E0B',
                            color: '#fff', fontSize: 16, fontWeight: 700, cursor: 'pointer',
                            display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          +
                        </button>
                      </div>
                    </div>
                    {/* ⚠️ เตือนเมื่อขอเติมมากกว่าที่คลังกลางมี */}
                    {overMain && (
                      <div style={{ padding: '5px 11px 7px', background: '#FEF2F2',
                        borderTop: '1px solid #FECACA', fontSize: 10.5, fontWeight: 700, color: '#DC2626' }}>
                        ⚠️ เกินสต็อกคลังกลาง (มี {formatStockQty(mainQty, item)}) — โอนได้ไม่ครบ
                      </div>
                    )}
                  </>)}
                </div>
              )
            }
            // หมวดหมู่ที่มีใน items ทั้งหมด — ใช้ catOrder จาก Settings ก่อน
            const FALLBACK_CATS = ['ผลไม้','แยม','ไซรัป','ท็อปปิ้ง','วัตถุดิบ','ขนม','บรรจุภัณฑ์','อื่นๆ']
            const ORDER = catOrder.length > 0 ? catOrder : FALLBACK_CATS
            const CAT_EMOJI = { ผลไม้:'🍋', แยม:'🍓', ไซรัป:'🍯', ท็อปปิ้ง:'💎', วัตถุดิบ:'🥛', ขนม:'🍪', บรรจุภัณฑ์:'🥤', อื่นๆ:'🔖' }
            // 'selected' = แท็บรวมทุกรายการที่เลือกจะแจ้งเติม (โผล่เฉพาะตอนมีของเลือก)
            const availableCats = ['low',
              ...(refillSelected.size > 0 ? ['selected'] : []),
              ...ORDER.filter(c => items.some(i => (i.category || 'อื่นๆ') === c))
            ]

            // กรองตาม tab — ทุก tab เรียงตาม Master Data (sortOrder)
            const displayItems = refillCat === 'low'
              ? allItems                                             // stock ต่ำ/หมด (sort แล้ว)
              : refillCat === 'selected'
                ? visItems.filter(i => refillSelected.has(i.id)).sort(sortBySortOrder)  // ทั้งหมดที่เลือก
                : visItems.filter(i => (i.category || 'อื่นๆ') === refillCat).sort(sortBySortOrder)

            // นับ selected ต่อ cat
            function selCount(cat) {
              if (cat === 'selected') return refillSelected.size
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
                          background: active ? (cat === 'selected' ? '#16A34A' : '#F59E0B') : '#F3F4F6',
                          color: active ? '#fff' : '#6B7280',
                          display: 'flex', alignItems: 'center', gap: 5 }}>
                        {cat === 'low'
                          ? <><span>⚠️</span> ต่ำ/หมด</>
                          : cat === 'selected'
                            ? <><span>✅</span> ที่เลือก</>
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
                    {refillCat === 'low' ? '✅ ไม่มีรายการ stock ต่ำ'
                      : refillCat === 'selected' ? '☑ ยังไม่ได้เลือกรายการ'
                      : 'ไม่มีรายการในหมวดนี้'}
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {refillCat === 'low' && (
                      <div style={{ fontSize: 10, fontWeight: 700, color: '#DC2626',
                        letterSpacing: 0.5, paddingLeft: 2 }}>⚠️ STOCK ต่ำ / หมด</div>
                    )}
                    {refillCat === 'selected' && (
                      <div style={{ fontSize: 10, fontWeight: 700, color: '#16A34A',
                        letterSpacing: 0.5, paddingLeft: 2 }}>✅ ทั้งหมดที่จะแจ้งเติม ({refillSelected.size})</div>
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
            // รวมทุก balance doc (กัน duplicate ค้างจาก legacy ที่อาจมี doc qty=0)
            const stockUse = balances
              .filter(b => b.itemId === ti.itemId && b.warehouseId === tfr.fromWH)
              .reduce((s, b) => s + (b.qty || 0), 0)
            return stockUse <= 0
          })
          // 🔒 มีรายการที่โอนเกินสต็อกคลังกลางไหม (กันโอนเกิน)
          const hasOverItem = transferItems.some(ti => {
            const master = items.find(i => i.id === ti.itemId)
            const stockUse = balances.filter(b => b.itemId === ti.itemId && b.warehouseId === tfr.fromWH)
              .reduce((s, b) => s + (b.qty || 0), 0)
            const qtyUseOut = qtyToUse(parseFloat(ti.qty) || 0, ti.unit, master)
            return qtyUseOut > stockUse
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
          const disabled = transferSaving || !allHasQty || hasOutItem || hasOverItem
          return (
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-secondary" style={{ flex: 1 }}
                onClick={() => setTfStep('pick')}>← ย้อนกลับ</button>
              <button className="btn-primary" style={{ flex: 2, opacity: disabled ? 0.5 : 1 }}
                disabled={disabled}
                onClick={() => { setTfConfirmChecks({}); setTfStep('confirm') }}>
                {hasOutItem ? '⚠️ Stock หมด' : hasOverItem ? '⚠️ จำนวนเกินสต็อก' : !allHasQty ? 'กรอกจำนวนให้ครบ' : 'ตรวจสอบ → ยืนยัน'}
              </button>
            </div>
          )
        })()}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>

          {/* ── RF Import Picker ── (เฉพาะโอน คลังกลาง → สาขา · RF = สาขาขอเติมจากคลัง) */}
          {(() => {
            const mainId = warehouses.find(w => w.type === 'main' || w.isMain)?.id || ''
            if (tfr.fromWH !== mainId) return null   // โอนกลับคลัง (สาขา→คลัง) ไม่มี RF
            const pendingRFs = refillRequests.filter(r => r.status === 'pending' || r.status === 'partial')
            if (pendingRFs.length === 0) return null
            return (
              <div style={{ borderRadius: 12, border: '1.5px solid #FCD34D',
                background: '#FFFBEB', overflow: 'hidden' }}>
                {/* Header แถบกด toggle */}
                <div onClick={() => setTfrRFExpand(v => !v)}
                  style={{ display: 'flex', alignItems: 'center', gap: 8,
                    padding: '7px 11px', cursor: 'pointer' }}>
                  <span style={{ fontSize: 13 }}>📋</span>
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: '#92400E', flex: 1 }}>
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
                  <div style={{ borderTop: '1px solid #FDE68A', padding: '6px 8px',
                    display: 'flex', flexDirection: 'column', gap: 6 }}>
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
                      style={{ marginTop: 2, padding: '7px 0', border: 'none', borderRadius: 9,
                        background: tfrRFImport.size > 0 ? '#F59E0B' : '#E5E7EB',
                        color: tfrRFImport.size > 0 ? '#fff' : '#9CA3AF',
                        fontWeight: 700, fontSize: 12, cursor: tfrRFImport.size > 0 ? 'pointer' : 'default',
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

          {/* ควบรวม: คลังต้นทาง(ล็อก) → สาขา + คนนำส่ง ในการ์ดเดียว */}
          <div style={{ border: '1px solid #FBD5D5', borderRadius: 10, padding: 8,
            background: '#FFF8F8', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {/* แถวคลัง: ต้นทาง → ปลายทาง · กดปุ่ม ⇄ เพื่อสลับทิศ (คลัง↔สาขา) */}
            {(() => {
              const mainId = warehouses.find(w => w.type === 'main' || w.isMain)?.id || ''
              const fromIsMain = tfr.fromWH === mainId
              const branchField = fromIsMain ? 'toWH' : 'fromWH'   // ฝั่งที่เป็น "สาขา" (เลือกได้)
              const MainBadge = (
                <span style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '6px 8px',
                  borderRadius: 7, background: '#FEECEC', fontSize: 11.5, fontWeight: 700,
                  color: '#B91C1C', whiteSpace: 'nowrap', flexShrink: 0 }}>
                  🏭 {warehouses.find(w => w.id === mainId)?.name || 'คลังกลาง'} 🔒
                </span>
              )
              const BranchSelect = (
                <select className="fi" value={tfr[branchField]}
                  style={{ flex: 1, height: 32, padding: '0 8px', fontSize: 12.5 }}
                  onChange={e => setTfr(t => ({ ...t, [branchField]: e.target.value }))}>
                  <option value="">เลือกสาขา{fromIsMain ? 'ปลายทาง' : 'ต้นทาง'}</option>
                  {warehouses
                    .filter(w => w.active !== false && !(w.type === 'main' || w.isMain))
                    .map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              )
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {fromIsMain ? MainBadge : BranchSelect}
                  {/* ปุ่มสลับทิศ — วงกลมมีลูกศร 2 ทาง ดูออกว่ากดได้ */}
                  <button type="button" aria-label="สลับทิศทางการโอน"
                    title="สลับทิศทางการโอน (คลัง ↔ สาขา)"
                    onClick={() => setTfr(t => ({ ...t, fromWH: t.toWH, toWH: t.fromWH }))}
                    style={{ flexShrink: 0, width: 30, height: 30, borderRadius: '50%',
                      border: '1.5px solid #F87171', background: '#fff', color: '#DC2626',
                      fontSize: 15, fontWeight: 800, lineHeight: 1, cursor: 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontFamily: "-apple-system, system-ui, 'Segoe UI Symbol', sans-serif",
                      boxShadow: '0 1px 3px rgba(220,38,38,.25)' }}>⇄</button>
                  {fromIsMain ? BranchSelect : MainBadge}
                </div>
              )
            })()}
            {/* แถวคนนำส่ง */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11.5, color: 'var(--txt2)', fontWeight: 600,
                whiteSpace: 'nowrap', flexShrink: 0 }}>🛵 คนนำส่ง</span>
              <input className="fi" placeholder="ระบุชื่อ (ถ้ามี)" value={tfr.driver}
                style={{ flex: 1, height: 32, padding: '0 8px', fontSize: 12.5 }}
                onChange={e => setTfr(t => ({ ...t, driver: e.target.value }))} />
            </div>
          </div>

          {/* รายการ */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <label className="fi-label" style={{ margin: 0, fontSize: 11 }}>📦 วัตถุดิบ — กดเพื่อเลือก/ยกเลิก</label>
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
                  // หน่วยให้เลือก — รองรับหลายชั้น (ลัง/มัด/ใบ) จาก unitLevels
                  const masterOpts = unitOptionsOf(master)
                  const unitOpts = masterOpts.length
                    ? masterOpts
                    : (it.unitOpts?.length ? it.unitOpts : (it.unit ? [it.unit] : []))
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
                    <div key={idx} style={{ background: '#FFF8F8', borderRadius: 10,
                      border: '1px solid #FBD5D5', padding: '7px 9px' }}>
                      {/* Row 1: emoji + ชื่อ + ลบ */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <span style={{ fontSize: 17, flexShrink: 0 }}>{it.img}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12.5, fontWeight: 700 }}>{master?.displayName || it.itemName}</div>
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
                                const qtyIn  = parseFloat(it.qty) || 0
                                if (!qtyIn) return null
                                const qtyUseOut = qtyToUse(qtyIn, it.unit, master)
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
                            const qtyUseOut = qtyToUse(qtyIn, it.unit, master)
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
                          {/* §9.4 — เลือก LOT ที่จะส่ง (default FIFO) เพื่อให้คลังกลาง monitor EXP ได้ */}
                          {tfr.fromWH && master && (() => {
                            const availLots = sortLotsFIFO(lots.filter(l => l.itemId === it.itemId
                              && l.warehouseId === tfr.fromWH && getLotAvail(l, tfr.fromWH) > 0 && l.status !== 'split'))
                            if (availLots.length <= 1) return null  // มีล็อตเดียว/ไม่มี → ไม่ต้องเลือก
                            return (
                              <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                                <span style={{ fontSize: 10, color: '#6B7280', whiteSpace: 'nowrap' }}>เลือก LOT:</span>
                                <select value={it.lotPick || ''}
                                  onChange={e => setTransferItems(prev => prev.map(p => p.itemId === it.itemId ? { ...p, lotPick: e.target.value || null } : p))}
                                  style={{ flex: 1, minWidth: 0, fontSize: 10.5, height: 28, borderRadius: 6,
                                    border: `1px solid ${it.lotPick ? '#FDBA74' : 'var(--border)'}`,
                                    background: it.lotPick ? '#FFF7ED' : '#fff', padding: '0 6px' }}>
                                  <option value="">อัตโนมัติ (FIFO — เก่าสุดก่อน)</option>
                                  {availLots.map(l => {
                                    const d = l.receiveDate ? l.receiveDate.slice(5).replace('-', '/') : '-'
                                    const ex = l.expDate ? ` · EXP ${l.expDate.slice(5).replace('-', '/')}` : ''
                                    return <option key={l.id} value={l.id}>รับ {d} · เหลือ {Number(getLotAvail(l, tfr.fromWH).toFixed(2))} {master.unitUse}{ex}</option>
                                  })}
                                </select>
                              </div>
                            )
                          })()}
                          {stockStatus === 'out' && (
                            <div style={{ marginTop: 6, fontSize: 10, color: '#991B1B',
                              background: '#FEE2E2', borderRadius: 8, padding: '6px 10px',
                              display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span>ให้เตรียมสั่งของจากซัพพลายเออร์ค่ะ</span>
                              {(() => {
                                const sentAlready = ownerNotified.has(it.itemId)
                                return (
                                <button disabled={sentAlready}
                                  onClick={async () => {
                                    if (sentAlready) return
                                    const branchName = warehouses.find(w => w.id === tfr.toWH)?.name || ''
                                    try {
                                      // ส่งผ่าน path หลัก → เด้งกระดิ่ง Hub + FCM ถึง Owner/Admin จริง
                                      const nref = await addDoc(collection(db, 'hub_notifications'), {
                                        app: 'inventory', type: 'stock-out', tag: 'stock',
                                        title: `🔴 คลังกลางหมด — ${it.itemName}`,
                                        body: `${it.itemName} หมดที่คลังกลาง · ${branchName ? `สาขา ${branchName} ` : ''}ขอเตรียมสั่งซื้อจากซัพพลายเออร์ · โดย ${name || '-'}`,
                                        itemId: it.itemId, itemName: it.itemName,
                                        createdAt: serverTimestamp(), read: false, read_by: [],
                                      })
                                      sendHubPush(nref.id)
                                      setOwnerNotified(prev => new Set(prev).add(it.itemId))
                                      setToast(`📣 แจ้ง Owner แล้ว — ${it.itemName}`)
                                    } catch (e) { console.error(e); setToast('❌ แจ้ง Owner ไม่สำเร็จ') }
                                  }}
                                  style={{ marginLeft: 'auto', border: 'none',
                                    background: sentAlready ? '#9CA3AF' : '#DC2626', color: '#fff', borderRadius: 6,
                                    padding: '3px 10px', fontSize: 10, fontWeight: 700,
                                    cursor: sentAlready ? 'default' : 'pointer', whiteSpace: 'nowrap' }}>
                                  {sentAlready ? '✓ แจ้งแล้ว' : '📣 แจ้ง Owner'}
                                </button>
                                )
                              })()}
                            </div>
                          )}
                        </div>
                        <button onClick={() => setTransferItems(prev => prev.filter(p => p.itemId !== it.itemId))}
                          style={{ border: 'none', background: 'transparent', color: '#F87171',
                            borderRadius: 6, width: 22, height: 22, fontSize: 13, cursor: 'pointer',
                            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>×</button>
                      </div>
                      {/* Row 2: unit chips + POS stepper */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        {unitOpts.length > 0 && (
                          <UnitChips
                            opts={unitOpts.map(u => ({ value: u, label: u, sub: '' }))}
                            selected={it.unit}
                            onChange={u => setTransferItems(prev => prev.map(p =>
                              p.itemId === it.itemId ? { ...p, unit: u } : p))}
                          />
                        )}
                        {(() => {
                          // 🔒 Block กรอกเกินสต็อกคลังกลาง — cap ตามหน่วยที่เลือก (รองรับหน่วยหลายชั้น)
                          const maxInUnit = Math.floor(useToQty(stockInFrom, it.unit, master))
                          return (
                            <PosQty
                              value={parseFloat(it.qty) || 0}
                              onChange={v => {
                                const capped = Math.min(Math.max(0, v), Math.max(0, maxInUnit))
                                if (v > maxInUnit) setToast(`⚠️ คลังกลางมีแค่ ${formatStockQty(stockInFrom, master)} — โอนได้สูงสุด ${maxInUnit} ${it.unit}`)
                                setTransferItems(prev => prev.map(p =>
                                  p.itemId === it.itemId ? { ...p, qty: String(capped) } : p))
                              }}
                            />
                          )
                        })()}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </Modal>

      {/* ══ Confirm popup สร้างใบโอน — กดพื้นหลังไม่ปิด (กันติ๊กหาย) ต้องกด "แก้ไข" ══ */}
      {tfStep === 'confirm' && transferOpen && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 300,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 20, overflow: 'hidden', width: 'min(480px, 92vw)',
              maxHeight: '85vh', display: 'flex', flexDirection: 'column',
              boxShadow: '0 10px 50px rgba(0,0,0,.3)' }}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontSize: 16, fontWeight: 800 }}>📦 ตรวจสอบก่อนนำส่ง</div>
              <div style={{ fontSize: 11, color: 'var(--txt3)', marginTop: 2 }}>
                {warehouses.find(w => w.id === tfr.fromWH)?.name} → {warehouses.find(w => w.id === tfr.toWH)?.name}
                {tfr.driver ? ` · คนนำส่ง: ${tfr.driver}` : ''}
              </div>
              <div style={{ fontSize: 10.5, color: '#1D4ED8', fontWeight: 700, marginTop: 5 }}>
                🛒 หยิบของออกจากคลังแล้วติ๊กทีละรายการ
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
              }).map((it) => {
                const master = items.find(m => m.id === it.itemId)
                const qtyUse = qtyToUse(parseFloat(it.qty) || 0, it.unit, master)
                const on = !!tfConfirmChecks[it.itemId]
                return (
                  <div key={it.itemId} onClick={() => setTfConfirmChecks(c => ({ ...c, [it.itemId]: !on }))}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
                      padding: '8px 9px', marginTop: 6, borderRadius: 9,
                      background: on ? '#F0FDF4' : '#fff',
                      border: `1.5px solid ${on ? '#86EFAC' : 'var(--border)'}` }}>
                    <div style={{ width: 22, height: 22, borderRadius: 6, flexShrink: 0,
                      border: `2px solid ${on ? '#16A34A' : '#D1D5DB'}`, background: on ? '#16A34A' : '#fff',
                      display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {on && <span style={{ color: '#fff', fontSize: 13, fontWeight: 900 }}>✓</span>}
                    </div>
                    <span style={{ fontSize: 18 }}>{it.img}</span>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap',
                      overflow: 'hidden', textOverflow: 'ellipsis' }}>{master?.displayName || it.itemName}</span>
                    <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--red)', flexShrink: 0 }}>
                      {it.qty} {it.unit}
                    </span>
                    {master?.unitUse && it.unit !== master.unitUse && qtyUse !== (parseFloat(it.qty) || 0) && (
                      <span style={{ fontSize: 10, color: 'var(--txt3)', flexShrink: 0 }}>
                        (= {qtyUse} {master?.unitUse})
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
            {(() => {
              const checked = transferItems.filter(it => tfConfirmChecks[it.itemId]).length
              const allChecked = transferItems.length > 0 && checked === transferItems.length
              return (
                <div style={{ padding: 14, borderTop: '1px solid var(--border)',
                  background: 'var(--bg)', borderRadius: '0 0 20px 20px' }}>
                  <div style={{ fontSize: 12, color: 'var(--txt3)', marginBottom: 10, textAlign: 'center' }}>
                    ตรวจแล้ว <strong style={{ color: allChecked ? '#16A34A' : 'var(--red)' }}>{checked}/{transferItems.length}</strong> รายการ
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn-secondary" style={{ flex: 1 }}
                      onClick={() => setTfStep('qty')}>← แก้ไข</button>
                    <button style={{ flex: 2, border: 'none', borderRadius: 12, padding: '13px 0',
                      fontWeight: 700, fontSize: 14, color: '#fff',
                      cursor: (allChecked && !transferSaving) ? 'pointer' : 'not-allowed',
                      background: (allChecked && !transferSaving) ? 'var(--red)' : '#FCD34D' }}
                      disabled={!allChecked || transferSaving}
                      onClick={async () => { await submitTransfer(); setTfStep('pick'); setTfConfirmChecks({}) }}>
                      {transferSaving ? 'กำลังบันทึก...' : allChecked ? '✅ ยืนยันสร้าง + นำส่ง' : `ติ๊กให้ครบก่อน (${checked}/${transferItems.length})`}
                    </button>
                  </div>
                </div>
              )
            })()}
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
                ติ๊กถูก {receivingChecked.size}/{receivingTF.items?.length || 0} รายการ · <span style={{ color: '#D97706', fontWeight: 600 }}>ของไม่มา → ติ๊กแล้วกรอก 0</span>
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
              const ORDER = catOrder.length > 0 ? catOrder : ['ผลไม้','แยม','ไซรัป','ท็อปปิ้ง','วัตถุดิบ','ขนม','บรรจุภัณฑ์','อื่นๆ']
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
                    const ticked  = receivingChecked.has(it._idx)
                    const planned = parseFloat(it.qty) || 0
                    const actStr  = receivingQty[it._idx] ?? String(it.qty ?? '')
                    const actNum  = parseFloat(actStr) || 0
                    const mismatch = ticked && actNum !== planned
                    const accent = !ticked ? null : (mismatch ? '#D97706' : '#16A34A')
                    return (
                      <div key={it._idx}
                        onClick={() => toggleReceiveItem(it._idx, it.qty)}
                        style={{ display: 'flex', alignItems: 'center', gap: 12,
                          background: ticked ? (mismatch ? '#FFFBEB' : '#F0FDF4') : '#fff',
                          border: `2px solid ${ticked ? (mismatch ? '#FCD34D' : '#86EFAC') : 'var(--border)'}`,
                          borderRadius: 12, padding: '10px 12px', marginBottom: 7,
                          cursor: 'pointer', transition: 'all .15s' }}>
                        {/* Tick circle */}
                        <div style={{ width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
                          border: `2px solid ${ticked ? accent : 'var(--border2)'}`,
                          background: ticked ? accent : '#fff',
                          display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          {ticked && <span style={{ color: '#fff', fontSize: 14, fontWeight: 700 }}>✓</span>}
                        </div>
                        <span style={{ fontSize: 22, flexShrink: 0 }}>{it.img || '📦'}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: ticked ? accent : 'var(--txt)' }}>
                            {it.itemName}
                          </div>
                          {ticked ? (
                            // กรอกยอดรับจริง (0 หรือยอดอื่น) — กรณีของมาไม่ครบ
                            <div onClick={e => e.stopPropagation()}
                              style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
                              <span style={{ fontSize: 10.5, color: 'var(--txt3)', flexShrink: 0 }}>รับจริง</span>
                              <input type="number" min="0" inputMode="decimal" value={actStr}
                                onChange={e => setReceivingQty(q => ({ ...q, [it._idx]: e.target.value }))}
                                style={{ width: 66, height: 30, padding: '0 6px', fontSize: 13, fontWeight: 800,
                                  textAlign: 'center', borderRadius: 8, border: `1.5px solid ${mismatch ? '#FCD34D' : '#86EFAC'}`,
                                  color: accent, background: '#fff' }} />
                              <span style={{ fontSize: 11.5, color: 'var(--txt2)', fontWeight: 700, flexShrink: 0 }}>{it.unit}</span>
                              <span style={{ fontSize: 10.5, color: mismatch ? '#D97706' : 'var(--txt3)', flexShrink: 0 }}>
                                / ส่งมา {planned}
                              </span>
                            </div>
                          ) : (
                            <div style={{ fontSize: 12, color: 'var(--txt2)', fontWeight: 700, marginTop: 1 }}>
                              {it.qty} {it.unit}
                            </div>
                          )}
                        </div>
                        {ticked && <span style={{ fontSize: 17, flexShrink: 0 }}>{mismatch ? '⚠️' : '✅'}</span>}
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
            style={{ background: '#fff', borderRadius: 20, overflow: 'hidden', width: 'min(480px, 92vw)',
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
              {(() => {
                const shortN = (receivingTF.items || []).filter((it, ix) =>
                  (parseFloat(receivingQty[ix] ?? it.qty) || 0) < (parseFloat(it.qty) || 0)).length
                return (
                  <div style={{ fontSize: 11, fontWeight: 700, padding: '6px 0',
                    color: shortN ? '#D97706' : '#16A34A' }}>
                    {shortN
                      ? `⚠️ มี ${shortN} รายการรับไม่ครบ — รับตามที่กรอก · ส่วนที่ขาดจะกลายเป็นใบแจ้งเติม`
                      : `✓ รับครบทุกรายการ — stock จะอัพเดทเมื่อกดยืนยัน`}
                  </div>
                )
              })()}
              {sortByMaster(receivingTF.items, { items, catOrder }).map((it, i) => {
                const ix       = receivingTF.items.indexOf(it)
                const planned  = parseFloat(it.qty) || 0
                const actNum   = parseFloat(receivingQty[ix] ?? it.qty) || 0
                const short    = actNum < planned
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10,
                    padding: '8px 0', borderTop: '1px solid var(--bg)' }}>
                    <span style={{ fontSize: 18 }}>{it.img || '📦'}</span>
                    <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{it.itemName}</span>
                    {short && (
                      <span style={{ fontSize: 11, color: 'var(--txt3)', textDecoration: 'line-through' }}>
                        {planned}
                      </span>
                    )}
                    <span style={{ fontSize: 13, fontWeight: 800, color: short ? '#D97706' : '#16A34A' }}>
                      +{actNum} {it.unit}
                    </span>
                    {short && <span style={{ fontSize: 13 }}>⚠️</span>}
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
                            borderRadius: 6, width: 24, height: 24, fontSize: 12, cursor: 'pointer' }}>×</button>
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
