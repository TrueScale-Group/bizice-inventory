import { initializeApp } from 'firebase/app'
import { getFirestore, doc, getDoc } from 'firebase/firestore'
const app = initializeApp({ apiKey:'AIzaSyDRs60WURPcNArQXl5RRuwqJcLjtN3CMe4', authDomain:'mixue-cost-manager.firebaseapp.com', projectId:'mixue-cost-manager', storageBucket:'mixue-cost-manager.firebasestorage.app', messagingSenderId:'414432707376', appId:'1:414432707376:web:1cf394f174257a86cdbef5' })
const db = getFirestore(app)
const d = await getDoc(doc(db, 'Inv_items', process.argv[2] || 'fjXFeoma8Wf0V6mbfGBz'))
const it = d.data()
console.log(JSON.stringify({
  name: it.name, unitBase: it.unitBase, unitUse: it.unitUse, unitBuy: it.unitBuy,
  unitSub: it.unitSub, unitUseRaw: it.unitUseRaw, unitSubRaw: it.unitSubRaw,
  unitConversion: it.unitConversion, convSub: it.convSub, cmCutLevel: it.cmCutLevel,
  unitLevels: it.unitLevels,
}, null, 2))
process.exit(0)
