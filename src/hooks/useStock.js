import { useEffect, useState } from 'react'
import { db } from '../firebase'
import { collection, query, where, onSnapshot } from 'firebase/firestore'

export function useStock(warehouseId) {
  const [balances, setBalances] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!warehouseId) {
      setBalances([])
      setLoading(false)
      return
    }
    setLoading(true)
    const q = warehouseId === 'all'
      ? query(collection(db, 'stock_balances'))
      : query(collection(db, 'stock_balances'), where('warehouseId', '==', warehouseId))

    const unsub = onSnapshot(q, snap => {
      setBalances(snap.docs.map(d => ({ id: d.id, ...d.data() })))
      setLoading(false)
    }, () => setLoading(false))

    return () => unsub()
  }, [warehouseId])

  return { balances, loading }
}
