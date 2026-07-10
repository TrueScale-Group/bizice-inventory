import { initializeApp } from 'firebase/app'
import { getFirestore, collection, getDocs } from 'firebase/firestore'
const app = initializeApp({ apiKey:'AIzaSyDRs60WURPcNArQXl5RRuwqJcLjtN3CMe4', authDomain:'mixue-cost-manager.firebaseapp.com', projectId:'mixue-cost-manager', storageBucket:'mixue-cost-manager.firebasestorage.app', messagingSenderId:'414432707376', appId:'1:414432707376:web:1cf394f174257a86cdbef5' })
const db = getFirestore(app)
const q = (process.argv[2] || 'ถุงเก็บอุณหภูมิ 2')
const snap = await getDocs(collection(db, 'Inv_items'))
for (const d of snap.docs) {
  const it = d.data()
  if (!(it.name||'').includes(q) && !(it.displayName||'').includes(q)) continue
  console.log(`\n📦 ${it.name} (${it.displayName||'-'}) · id=${d.id}`)
  console.log(`   unitBase=${JSON.stringify(it.unitBase)} unitUse=${JSON.stringify(it.unitUse)} unitBuy=${JSON.stringify(it.unitBuy)} unitSub=${JSON.stringify(it.unitSub)}`)
  console.log(`   unitConversion=${JSON.stringify(it.unitConversion)}`)
}
process.exit(0)
