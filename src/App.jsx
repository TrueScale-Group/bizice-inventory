import { useState } from 'react'
import { BottomNav } from './components/BottomNav'
import Dashboard from './pages/Dashboard'
import Warehouse from './pages/Warehouse'
import CutStock  from './pages/CutStock'
import Report    from './pages/Report'
import Settings  from './pages/Settings'

export default function App() {
  const [tab, setTab] = useState('dashboard')

  const pages = {
    dashboard: <Dashboard />,
    warehouse: <Warehouse />,
    cutstock:  <CutStock />,
    report:    <Report />,
    settings:  <Settings />,
  }

  return (
    <div className="app-shell">
      <div className="page-content">
        {pages[tab]}
      </div>
      <BottomNav active={tab} onChange={setTab} />
    </div>
  )
}
