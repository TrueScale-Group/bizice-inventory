import { initializeApp } from 'firebase/app'
import { getFirestore } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: 'AIzaSyDRs60WURPcNArQXl5RRuwqJcLjtN3CMe4',
  authDomain: 'mixue-cost-manager.firebaseapp.com',
  projectId: 'mixue-cost-manager',
  storageBucket: 'mixue-cost-manager.firebasestorage.app',
  messagingSenderId: '414432707376',
  appId: '1:414432707376:web:1cf394f174257a86cdbef5',
}

const app = initializeApp(firebaseConfig)
export const db = getFirestore(app)
