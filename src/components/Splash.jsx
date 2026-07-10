export default function Splash({ subtitle = '', hide = false }) {
  return (
    <div id="splash" className={hide ? 'hide' : ''}>
      <div className="sp-ice">
        <svg width="100" height="100" viewBox="0 0 100 100" fill="none">
          <polygon points="50,98 18,48 82,48" fill="rgba(255,255,255,0.22)" stroke="rgba(255,255,255,0.45)" strokeWidth="1.5" strokeLinejoin="round" />
          <line x1="50" y1="98" x2="35" y2="48" stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
          <line x1="50" y1="98" x2="50" y2="48" stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
          <line x1="50" y1="98" x2="65" y2="48" stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
          <line x1="20" y1="60" x2="80" y2="60" stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
          <line x1="25" y1="72" x2="75" y2="72" stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
          <ellipse cx="50" cy="34" rx="20" ry="16" fill="rgba(255,255,255,0.9)" />
          <ellipse cx="38" cy="31" rx="14" ry="12" fill="#fff" />
          <ellipse cx="62" cy="31" rx="14" ry="12" fill="rgba(255,210,210,1)" />
          <ellipse cx="50" cy="26" rx="13" ry="11" fill="#fff" />
          <ellipse cx="38" cy="21" rx="9" ry="8" fill="#fff" />
          <ellipse cx="62" cy="21" rx="9" ry="8" fill="rgba(255,195,195,1)" />
          <ellipse cx="50" cy="16" rx="8" ry="7" fill="#fff" />
          <circle cx="38" cy="13" r="5" fill="#fff" />
          <circle cx="62" cy="13" r="5" fill="rgba(255,200,200,1)" />
          <circle cx="50" cy="8" r="4" fill="#fff" />
        </svg>
      </div>
      <div className="sp-name">BizICE</div>
      <div className="sp-sub">{subtitle}</div>
      <div className="sp-dots"><div className="sp-dot"></div><div className="sp-dot"></div><div className="sp-dot"></div></div>
    </div>
  )
}
