const TABS = [
  { id: 'dashboard', icon: '📊', label: 'แดชบอร์ด' },
  { id: 'warehouse', icon: '📦', label: 'คลัง' },
  { id: 'cutstock',  icon: '✂️', label: 'ตัดสต็อก', primary: true },
  { id: 'report',    icon: '📋', label: 'รายงาน' },
  { id: 'settings',  icon: '⚙️', label: 'ตั้งค่า' },
]

export function BottomNav({ active, onChange }) {
  return (
    <nav className="bottom-nav">
      <style>{`
        @keyframes cutPulse {
          0%,100% { box-shadow: 0 4px 14px rgba(227,30,36,.42), 0 0 0 0 rgba(227,30,36,.55); }
          70%     { box-shadow: 0 4px 14px rgba(227,30,36,.42), 0 0 0 14px rgba(227,30,36,0); }
        }
        @keyframes cutWiggle {
          0%,100% { transform: rotate(-8deg); }
          50%     { transform: rotate(8deg); }
        }
        .nav-cut-fab {
          position: absolute; top: -22px; left: 50%;
          transform: translateX(-50%);
          width: 56px; height: 56px; border-radius: 50%;
          background: #FEE2E6;                         /* แดงอ่อน ~10% */
          display: flex; align-items: center; justify-content: center;
          color: var(--red);
          border: 3px solid #fff;
          box-shadow: 0 4px 10px rgba(227,30,36,.15);
          transition: transform .2s ease, box-shadow .2s ease, background .2s ease;
          z-index: 5;
        }
        .nav-cut-fab.active {
          background: #FFD4DA;                          /* แดงอ่อนหน่อยขึ้นตอน active */
          animation: cutPulse 1.8s ease-in-out infinite;
        }
        .nav-cut-fab:hover { transform: translateX(-50%) scale(1.06); }
        .nav-cut-fab .cut-emoji {
          display: inline-flex; align-items: center; justify-content: center;
          font-size: 26px; line-height: 1;
          width: 100%; height: 100%;
        }
        .nav-cut-fab.active .cut-emoji {
          animation: cutWiggle 1.4s ease-in-out infinite;
          transform-origin: center;
        }
        .nav-item.is-cut { position: relative; }
        .nav-item.is-cut .nav-label { margin-top: 38px; font-weight: 800; color: var(--red); }
      `}</style>
      {TABS.map(t => {
        if (t.primary) {
          return (
            <button key={t.id}
              className={`nav-item is-cut${active === t.id ? ' active' : ''}`}
              onClick={() => onChange(t.id)}>
              <span className={`nav-cut-fab${active === t.id ? ' active' : ''}`}>
                <span className="cut-emoji">{t.icon}</span>
              </span>
              <span className="nav-label">{t.label}</span>
            </button>
          )
        }
        return (
          <button key={t.id}
            className={`nav-item${active === t.id ? ' active' : ''}`}
            onClick={() => onChange(t.id)}>
            <span className="nav-pill">
              <span className="nav-icon">{t.icon}</span>
            </span>
            <span className="nav-label">{t.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
