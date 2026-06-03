import { initializeApp } from 'firebase/app'
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore'

const firebaseConfig = {
  apiKey: 'AIzaSyDRs60WURPcNArQXl5RRuwqJcLjtN3CMe4',
  authDomain: 'mixue-cost-manager.firebaseapp.com',
  projectId: 'mixue-cost-manager',
  storageBucket: 'mixue-cost-manager.firebasestorage.app',
  messagingSenderId: '414432707376',
  appId: '1:414432707376:web:1cf394f174257a86cdbef5',
}

const app = initializeApp(firebaseConfig)

// 📱 Offline persistence — แคชข้อมูล Firestore ลง IndexedDB
//    เปิด multi-tab support → หลายแท็บใช้แคชเดียวกันได้
//    → เปิด PWA ออฟไลน์ก็ยัง query ข้อมูลล่าสุดที่เคยโหลดได้
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager(),
  }),
})
