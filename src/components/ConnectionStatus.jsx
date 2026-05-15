import { useConnection } from '../hooks/useConnection'

export function ConnectionStatus() {
  const { state, lastSync } = useConnection()
  const labels = { online: 'Online', offline: 'Offline', syncing: 'กำลัง sync...' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
      <div className={`conn-pill conn-${state}`}>
        <span className={`conn-dot ${state}`} />
        <span>{labels[state]}</span>
      </div>
      {state === 'online' && lastSync && (
        <span style={{ fontSize: 9, color: 'var(--txt3)' }}>{lastSync} น.</span>
      )}
      {state === 'offline' && (
        <span style={{ fontSize: 9, color: '#DC2626' }}>⚠️ ไม่มีสัญญาณ</span>
      )}
    </div>
  )
}
