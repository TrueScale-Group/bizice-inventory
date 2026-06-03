import { useState, useCallback, useEffect } from 'react'
import { BottomNav }    from './components/BottomNav'
import PullToRefresh    from './components/PullToRefresh'
import AppTopBar        from './components/AppTopBar'
import DesktopSidebar     from './components/DesktopSidebar'
import DesktopContentBar  from './components/DesktopContentBar'
import { OfflineBanner }  from './components/OfflineBanner'
import Dashboard from './pages/Dashboard'
import Warehouse from './pages/Warehouse'
import CutStock  from './pages/CutStock'
import Report    from './pages/Report'
import Settings  from './pages/Settings'

export default function App() {
  const [tab, setTab]           = useState('dashboard')
  const [refreshKey, setRefreshKey] = useState(0)

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

  const pages = {
    dashboard: <Dashboard key={`dash-${refreshKey}`} />,
    warehouse: <Warehouse key={`wh-${refreshKey}`} />,
    cutstock:  <CutStock  key={`cs-${refreshKey}`} />,
    report:    <Report    key={`rp-${refreshKey}`} />,
    settings:  <Settings  key={`st-${refreshKey}`} />,
  }

  return (
    <div className="app-shell">
      {/* ── Desktop sidebar (hidden on mobile via CSS) ── */}
      <DesktopSidebar tab={tab} onChange={setTab} />

      {/* ── Mobile topbar (hidden on desktop via CSS) ── */}
      <AppTopBar tab={tab} />

      {/* 📡 Offline banner */}
      <OfflineBanner />

      {/* ── Scrollable content ── */}
      <PullToRefresh onRefresh={handleRefresh}>
        {/* Desktop header bar: วันที่ + Online (hidden on mobile) */}
        <DesktopContentBar tab={tab} />
        <div className="page-content">
          {pages[tab]}
        </div>
      </PullToRefresh>

      {/* ── Mobile bottom nav (hidden on desktop via CSS) ── */}
      <BottomNav active={tab} onChange={setTab} />
    </div>
  )
}
