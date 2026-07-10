import { initializeApp } from 'firebase/app'
import { getFirestore, collection, getDocs } from 'firebase/firestore'
const app = initializeApp({ apiKey:'AIzaSyDRs60WURPcNArQXl5RRuwqJcLjtN3CMe4', authDomain:'mixue-cost-manager.firebaseapp.com', projectId:'mixue-cost-manager', storageBucket:'mixue-cost-manager.firebasestorage.app', messagingSenderId:'414432707376', appId:'1:414432707376:web:1cf394f174257a86cdbef5' })
const db = getFirestore(app)
const itemId = process.argv[2] || 'fjXFeoma8Wf0V6mbfGBz'
const wh = {}; (await getDocs(collection(db,'Inv_warehouses'))).docs.forEach(d=>wh[d.id]=d.data().name)
const bals = (await getDocs(collection(db,'Inv_stock_balances'))).docs.map(d=>({id:d.id,...d.data()})).filter(b=>b.itemId===itemId)
console.log('balances:')
bals.forEach(b=>console.log(`  ${wh[b.warehouseId]||b.warehouseId}: qty=${b.qty} ${b.unit||''}`))
process.exit(0)
