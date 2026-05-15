import { useEffect, useState } from 'react'
import { db } from '../firebase'
import { doc, onSnapshot } from 'firebase/firestore'
import { COL } from '../constants/collections'

export function useConnection() {
  const [state, setState] = useState('online')
  const [lastSync, setLastSync] = useState('')

  useEffect(() => {
    const onOnline  = () => setState('online')
    const onOffline = () => setState('offline')
    window.addEventListener('online',  onOnline)
    window.addEventListener('offline', onOffline)

    const unsub = onSnapshot(
      doc(db, COL.APP_SETTINGS, 'inventory_settings'),
      () => {
        setState('online')
        setLastSync(new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }))
      },
      () => setState('offline')
    )

    return () => {
      window.removeEventListener('online',  onOnline)
      window.removeEventListener('offline', onOffline)
      unsub()
    }
  }, [])

  return { state, lastSync }
}
