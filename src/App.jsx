import { useState, useCallback, useEffect, useRef } from 'react'
import { collection, onSnapshot } from 'firebase/firestore'
import { db } from './firebase'
import { COL } from './constants/collections'
import { defaultWarehouseId } from './utils/warehouses'
import { useSession } from './hooks/useSession'
import Splash          from './components/Splash'
import { BottomNav }    from './components/BottomNav'
import PullToRefresh    from './components/PullToRefresh'
import AppTopBar        from './components/AppTopBar'
import DesktopSidebar     from './components/DesktopSidebar'
import DesktopContentBar  from './components/DesktopContentBar'
import { OfflineBanner }  from './components/OfflineBanner'
import WarehouseCycle     from './components/WarehouseCycle'
import Dashboard from './pages/Dashboard'
import Warehouse from './pages/Warehouse'
import CutStock  from './pages/CutStock'
import Report    from './pages/Report'
import Settings  from './pages/Settings'

export default function App() {
  const [tab, setTab]           = useState('dashboard')
  const [refreshKey, setRefreshKey] = useState(0)
  const [exitHint, setExitHint] = useState(false)   // toast "กดอีกครั้งเพื่อออก"
  const [warehouses, setWarehouses] = useState([])
  const [mainWarehouse, setMainWarehouse] = useState(null)   // คลังกลาง — เก็บไว้เสมอแม้ staff (list ถูก filter)
  const [wh, setWh]             = useState('')
  const [switching, setSwitching] = useState(false)   // overlay เบลอ+spinner ตอนสลับสาขา
  const [ready, setReady] = useState(false)            // 🟢 splash hide เมื่อข้อมูลชุดแรกพร้อม

  const { role, branch_id } = useSession()
  const isStaff = role === 'staff'

  const tabRef  = useRef(tab);    useEffect(() => { tabRef.current = tab }, [tab])
  const exitRef = useRef(false)
  const exitTimer = useRef(null)
  const switchTimer = useRef(null)

  // 🏪 สลับสาขาจากผู้ใช้ (กดปุ่ม cycle) → setWh + โชว์ overlay 500ms (เหมือน Maintenance)
  const handleBranchChange = useCallback((nextId) => {
    setWh(nextId)
    if (switchTimer.current) clearTimeout(switchTimer.current)
    setSwitching(true)
    switchTimer.current = setTimeout(() => setSwitching(false), 500)
  }, [])

  // 🏪 โหลดคลังสินค้าครั้งเดียวที่ระดับ App — แชร์ให้ทุกหน้า
  // Staff: เห็นเฉพาะสาขาตัวเอง (branch_id จาก session) — owner/admin เห็นทุกคลัง
  useEffect(() => {
    const unsub = onSnapshot(collection(db, COL.WAREHOUSES), snap => {
      const wList = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(w => w.active !== false)
      const visible = (isStaff && branch_id) ? wList.filter(w => w.id === branch_id) : wList
      setWarehouses(visible)
      // คลังกลางเก็บแยกจาก list ที่ถูก filter — staff ต้องเห็นยอดคลังกลางตอนแจ้งเติมของ (แม้ switcher ล็อกสาขาตัวเอง)
      setMainWarehouse(wList.find(w => w.type === 'main' || w.isMain) || null)
      setWh(prev => prev || defaultWarehouseId(visible, isStaff ? branch_id : ''))
      setReady(true)   // 🟢 ข้อมูลชุดแรกพร้อม → ซ่อน splash
    })
    return () => unsub()
  }, [isStaff, branch_id])

  // 🛟 safety auto-hide splash — กันค้างถาวรถ้าโหลดล้มเหลว
  useEffect(() => {
    const t = setTimeout(() => setReady(true), 8000)
    return () => clearTimeout(t)
  }, [])

  // เมื่อสลับไปหน้าที่ไม่รองรับ "ทุกร้าน" ให้ reset เป็นสาขาเริ่มต้น
  useEffect(() => {
    if ((tab === 'cutstock' || tab === 'warehouse') && wh === 'all' && warehouses.length) {
      setWh(defaultWarehouseId(warehouses, isStaff ? branch_id : ''))
    }
  }, [tab])

  // 🔙 ดักปุ่ม back มือถือ (Android) — กัน "หน้าขาว" จากการหลุดออก SPA
  //   มี popup เปิด → ปิด popup · ไม่ได้อยู่แดชบอร์ด → ถอยกลับแดชบอร์ด ·
  //   อยู่แดชบอร์ดแล้ว → กด back ครั้งแรกเตือน, กดอีกครั้งใน 2.5 วิ → ออกไป Hub
  useEffect(() => {
    if (!window.__invBackStack) window.__invBackStack = []
    window.history.pushState({ inv: 1 }, '')   // guard entry กันหลุดออก
    const HUB = 'https://bizice.web.app'
    const reguard = () => window.history.pushState({ inv: 1 }, '')
    const onPop = () => {
      const stack = window.__invBackStack
      if (stack && stack.length) {            // 1) มี popup → ปิดอันบนสุด
        try { stack[stack.length - 1]?.() } catch {}
        reguard(); return
      }
      if (tabRef.current !== 'dashboard') {   // 2) ไม่ใช่แดชบอร์ด → ถอยกลับ
        setTab('dashboard'); reguard(); return
      }
      if (exitRef.current) {                  // 3) กด back ซ้ำ → ออกจริง
        try { (window.top || window).location.href = HUB } catch { window.location.href = HUB }
        return
      }
      exitRef.current = true; setExitHint(true)
      clearTimeout(exitTimer.current)
      exitTimer.current = setTimeout(() => { exitRef.current = false; setExitHint(false) }, 2500)
      reguard()
    }
    window.addEventListener('popstate', onPop)
    return () => { window.removeEventListener('popstate', onPop); clearTimeout(exitTimer.current) }
  }, [])

  // 📱 อัพเดทสี status bar เมื่อสลับหน้า/แท็บ (ใช้ theme color เดิมของแอพ)
  useEffect(() => {
    window.setStatusBarColor?.('#E31E24')
  }, [tab])

  // 📱 Service Worker — cache app shell สำหรับ offline mode
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js')
        .then(reg => console.log('[PWA] SW registered:', reg.scope))
        .catch(err => console.warn('[PWA] SW failed:', err))
    }
  }, [])

  // Firestore onSnapshot เป็น real-time อยู่แล้ว ไม่ต้อง remount
  // handleRefresh แค่แสดง animation โดยไม่ทำลาย state/listeners
  const handleRefresh = useCallback(async () => {
    await new Promise(r => setTimeout(r, 800))
    // ไม่ bump refreshKey — ข้อมูลยังอยู่ครบ
  }, [])

  // ❌ ยกเลิก "ทุกร้าน" (รวมทุกสาขา) — แสดงแยกสาขาเท่านั้น (509 → สาขาอื่น → คลังกลาง)
  const includeAll = false

  const pages = {
    dashboard: <Dashboard key={`dash-${refreshKey}`} wh={wh} setWh={setWh} warehouses={warehouses} mainWarehouse={mainWarehouse} />,
    warehouse: <Warehouse key={`wh-${refreshKey}`}   wh={wh} setWh={setWh} warehouses={warehouses} />,
    cutstock:  <CutStock  key={`cs-${refreshKey}`}   wh={wh} setWh={setWh} warehouses={warehouses} />,
    report:    <Report    key={`rp-${refreshKey}`}   wh={wh} setWh={setWh} warehouses={warehouses} />,
    settings:  <Settings  key={`st-${refreshKey}`} warehouses={warehouses} />,
  }

  return (
    <div className="app-shell">
      {/* 🍦 BizICE splash — แสดงจนข้อมูลชุดแรกพร้อม */}
      <Splash subtitle="Inventory" hide={ready} />

      {/* ── Desktop sidebar (hidden on mobile via CSS) ── */}
      <DesktopSidebar tab={tab} onChange={setTab} />

      {/* ── Mobile topbar (hidden on desktop via CSS) ── */}
      <AppTopBar tab={tab} warehouses={warehouses} />

      {/* Branch strip — mobile only, sticky ใต้ AppTopBar เหมือน Maintenance */}
      {warehouses.length > 0 && tab !== 'settings' && (
        <div className="branch-strip">
          <WarehouseCycle warehouses={warehouses} value={wh} onChange={handleBranchChange} includeAll={includeAll} locked={isStaff} />
        </div>
      )}

      {/* 📡 Offline banner */}
      <OfflineBanner />

      {/* ── Scrollable content ── */}
      <PullToRefresh onRefresh={handleRefresh}>
        {/* Desktop header bar: วันที่ + สาขา + Online (hidden on mobile) */}
        <DesktopContentBar tab={tab} warehouses={warehouses} wh={wh} setWh={handleBranchChange} includeAll={includeAll} locked={isStaff} />
        <div className="page-content" style={{ position: 'relative' }}>
          {/* 🏪 Branch switch overlay — เบลอเฉพาะพื้นที่ content + ไอคอน refresh หมุน (แบบ Maintenance) */}
          {switching && (
            <div className="branch-switch-overlay">
              <svg className="branch-switch-spinner" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4" />
                <path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4" />
              </svg>
            </div>
          )}
          {pages[tab]}
        </div>
      </PullToRefresh>

      {/* ── Mobile bottom nav (hidden on desktop via CSS) ── */}
      <BottomNav active={tab} onChange={setTab} />

      {/* 🔙 toast เตือนตอนกด back บนแดชบอร์ด */}
      {exitHint && (
        <div style={{ position: 'fixed', left: '50%', bottom: 'calc(80px + env(safe-area-inset-bottom))',
          transform: 'translateX(-50%)', zIndex: 9999, background: 'rgba(17,24,39,.92)', color: '#fff',
          padding: '9px 16px', borderRadius: 20, fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap',
          boxShadow: '0 4px 16px rgba(0,0,0,.25)' }}>
          ↩️ กดอีกครั้งเพื่อออกไปหน้าหลัก · หรือกด 🏠 Home
        </div>
      )}
    </div>
  )
}
