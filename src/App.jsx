import { useState, useCallback } from 'react'
import { BottomNav }    from './components/BottomNav'
import PullToRefresh    from './components/PullToRefresh'
import AppTopBar        from './components/AppTopBar'
import DesktopSidebar     from './components/DesktopSidebar'
import DesktopContentBar  from './components/DesktopContentBar'
import Dashboard from './pages/Dashboard'
import Warehouse from './pages/Warehouse'
import CutStock  from './pages/CutStock'
import Report    from './pages/Report'
import Settings  from './pages/Settings'

export default function App() {
  const [tab, setTab]           = useState('dashboard')
  const [refreshKey, setRefreshKey] = useState(0)

  // bump key → remount active page → re-run all useEffects / Firestore listeners
  const handleRefresh = useCallback(async () => {
    await new Promise(r => setTimeout(r, 600))
    setRefreshKey(k => k + 1)
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
