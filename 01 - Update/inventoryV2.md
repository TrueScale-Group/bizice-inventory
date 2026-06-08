# inventoryV2.md — Mixue Inventory System
> Spec สำหรับ Claude Code · BizICE Platform · พี่จีโน่
> Version: 2.0 · อัพเดตจาก V1 · วันที่: 26 พ.ค. 2569
> สิ่งที่เปลี่ยนจาก V1: session fallback · สีแดง brand · font · Desktop layout · permission model · stock adjust · schema minQty · unit conversion · bug fix batch write · ใบขอโอนแสดง stock คลังกลาง

---

## 1. Overview

| Item | Detail |
|------|--------|
| App name | Mixue Inventory |
| Deploy URL | https://truescale-group.github.io/bizice-inventory/ |
| GitHub repo | truescale-group/bizice-inventory |
| Firebase project | mixue-cost-manager |
| Version | 1.5.0 |
| Tech stack | React 18 + Vite 5 + Tailwind 3 + Firebase 10 |
| Deploy | GitHub Pages · gh-pages branch · `.nojekyll` auto |
| Platform | Mobile-first iOS Safari · Responsive Desktop ≥900px |

---

## 2. Dependencies (package.json exact versions)

```json
{
  "dependencies": {
    "firebase": "^10.12.2",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.1",
    "autoprefixer": "^10.4.19",
    "gh-pages": "^6.1.1",
    "postcss": "^8.4.38",
    "tailwindcss": "^3.4.4",
    "vite": "^5.3.1"
  }
}
```

**Deploy script:**
```json
"deploy": "npm run build && node -e \"require('fs').writeFileSync('dist/.nojekyll','')\" && gh-pages -d dist -t"
```

---

## 3. Design Tokens (index.css + tailwind.config.js)

### CSS Variables (ใช้ใน index.css)
```css
:root {
  --red:       #E31E24;   /* Mixue brand red — ไม่ใช่ #FF3B30 */
  --red-d:     #B01519;
  --red-p:     #FFF0F0;
  --red-p2:    #FFE4E5;
  --bg:        #F2F2F7;
  --surf:      #FFFFFF;
  --surf2:     #F0EEE9;
  --border:    rgba(0,0,0,0.07);
  --border2:   rgba(0,0,0,0.13);
  --txt:       #1A1A1A;
  --txt2:      #555;
  --txt3:      #9A9A9A;
  --green:     #15803D;
  --green-bg:  #F0FDF4;
  --green-b:   #BBF7D0;
  --orange:    #C2410C;
  --orange-bg: #FFF7ED;
  --orange-b:  #FED7AA;
  --blue:      #1D4ED8;
  --blue-bg:   #EFF6FF;
  --r:         10px;
  --rl:        16px;
  --rxl:       22px;
  --sh:        0 1px 4px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
  --sh-md:     0 6px 20px rgba(0,0,0,0.09), 0 2px 6px rgba(0,0,0,0.05);
}
```

### Tailwind Custom (tailwind.config.js)
```js
theme: {
  extend: {
    fontFamily: {
      prompt:  ['Prompt', 'sans-serif'],
      sarabun: ['Sarabun', 'sans-serif'],
    },
    colors: {
      red: {
        brand: '#E31E24',
        dark:  '#B01519',
        light:  '#FFF0F0',
        light2: '#FFE4E5',
      },
    },
  },
}
```

### Fonts (Google Fonts — ใน index.html)
```html
<link href="https://fonts.googleapis.com/css2?family=Prompt:wght@300;400;500;600;700&family=Sarabun:wght@300;400;500;600&display=swap" rel="stylesheet" />
```
- **Prompt** — heading · brand name · ตัวเลขสำคัญ (`font-prompt`)
- **Sarabun** — body · ทั่วไป (`font-sarabun`) · default font ของทั้งแอพ

---

## 4. Firebase Config

```js
// src/firebase.js
import { initializeApp } from 'firebase/app'
import { getFirestore }  from 'firebase/firestore'

const firebaseConfig = {
  apiKey:            'AIzaSyDRs60WURPcNArQXl5RRuwqJcLjtN3CMe4',
  authDomain:        'mixue-cost-manager.firebaseapp.com',
  projectId:         'mixue-cost-manager',
  storageBucket:     'mixue-cost-manager.firebasestorage.app',
  messagingSenderId: '414432707376',
  appId:             '1:414432707376:web:1cf394f174257a86cdbef5',
}

const app = initializeApp(firebaseConfig)
export const db = getFirestore(app)
```

---

## 5. Session Guard (index.html — อัพเดตจาก V1)

```html
<script>
(function () {
  const HUB = 'https://truescale-group.github.io/mixue-ice-sakon/';
  try {
    const params = new URLSearchParams(location.search);
    let s = JSON.parse(localStorage.getItem('bizice_session') || 'null');

    // ✅ V2 เพิ่ม: Fallback จาก URL params (iOS Safari localStorage partitioning)
    if ((!s || !s.name) && params.get('user')) {
      s = {
        name:   decodeURIComponent(params.get('user') || 'ผู้ใช้'),
        phone:  decodeURIComponent(params.get('phone') || ''),
        role:   params.get('mode') === 'owner'  ? 'owner'  :
                params.get('mode') === 'editor' ? 'editor' : 'viewer',
        expiry: Date.now() + 86400000
      };
      try { localStorage.setItem('bizice_session', JSON.stringify(s)); } catch(e){}
    }

    if (!s || !s.name) { window.location.replace(HUB); return; }
    if (s.expiry && Date.now() > s.expiry) {
      localStorage.removeItem('bizice_session');
      window.location.replace(HUB);
      return;
    }
    window._bizSession = s;
    window._bizMode = params.get('mode') || s.role || 'viewer';
  } catch (e) { window.location.replace(HUB); }
})();
</script>
```

### Session Object (V2)
```ts
interface BizSession {
  phone:  string;                          // "0843904727"
  name:   string;                          // "พี่จีโน่"
  role:   'owner' | 'editor' | 'viewer';  // ✅ V2 เพิ่ม 'editor'
  expiry: number;                          // timestamp ms
}
```

### Permission Helpers
```js
const isOwner  = () => window._bizSession?.role === 'owner';
const isEditor = () => ['owner','editor'].includes(window._bizSession?.role);
const isViewer = () => window._bizSession?.role === 'viewer';
```

---

## 6. Permission Model (V2 — เปลี่ยนจาก V1)

| ฟีเจอร์ | Owner | Editor (Staff) | Viewer |
|---------|-------|----------------|--------|
| ดู Dashboard / คลัง / รายงาน | ✅ ทุกคลัง | ✅ ตามสาขา | ✅ อ่านอย่างเดียว |
| **ตัดสต็อก** | ✅ | ✅ หน้าร้านเท่านั้น | ❌ |
| **รับสินค้าจากซัพพลายเออร์** | ✅ | ✅ คลังกลางเท่านั้น | ❌ |
| **รับสินค้าจากใบโอน** | ✅ | ✅ สาขาที่รับ | ❌ |
| **โอนสินค้าไปสาขา** | ✅ | ✅ คลังกลางเท่านั้น | ❌ |
| **ปรับยอดคงคลัง** | ✅ Owner only | ❌ | ❌ |
| ตั้งค่า · แก้ไข master data | ✅ | ❌ | ❌ |
| Tab วิเคราะห์ (PIN) | ✅ | ❌ | ❌ |

### กฎสำคัญ
```
คลังกลาง → ของเพิ่มได้แค่ "รับสินค้า" เท่านั้น
คลังกลาง → ของออกได้แค่ "โอนสินค้า" เท่านั้น (ไม่มีตัดสต็อก)
หน้าร้าน → ของเพิ่มได้แค่ "รับจากใบโอน" เท่านั้น
หน้าร้าน → ของออกได้แค่ "ตัดสต็อก" เท่านั้น
```

### ❌ ยกเลิกออกจาก V2
- **Opening Stock** (บันทึกครั้งเดียว) → เปลี่ยนเป็น "ปรับยอดคงคลัง" โดย Owner ทำซ้ำได้ไม่จำกัด

---

## 7. App Structure

```
src/
├── main.jsx
├── App.jsx                     ← router + layout shell
├── firebase.js
├── index.css                   ← CSS variables + responsive
├── components/
│   ├── BottomNav.jsx           ← mobile (hidden ≥900px)
│   ├── AppTopBar.jsx           ← mobile topbar (hidden ≥900px)
│   ├── DesktopSidebar.jsx      ← sidebar (hidden <900px)
│   ├── DesktopContentBar.jsx   ← desktop header bar (hidden <900px)
│   ├── PullToRefresh.jsx       ← scroll container + animation
│   ├── ConnectionStatus.jsx    ← shared · Online/Offline/Syncing
│   ├── Modal.jsx               ← reusable bottom sheet
│   └── LotPopup.jsx            ← LOT bottom sheet
├── pages/
│   ├── Dashboard.jsx
│   ├── Warehouse.jsx
│   ├── CutStock.jsx
│   ├── Report.jsx
│   └── Settings.jsx
└── utils/
    ├── audio.js                ← beepClick, beepSuccess
    ├── fifo.js                 ← sortLotsFIFO, getExpStatus
    ├── unit.js                 ← convertToBase (หน่วยแปลง)
    └── formatDate.js
```

### App.jsx pattern
```jsx
export default function App() {
  const [tab, setTab]       = useState('dashboard')
  const [refreshKey]        = useState(0)
  const handleRefresh       = useCallback(async () => {
    await new Promise(r => setTimeout(r, 800))
    // ไม่ bump refreshKey — onSnapshot real-time อยู่แล้ว
  }, [])

  return (
    <div className="app-shell">
      <DesktopSidebar tab={tab} onChange={setTab} />
      <AppTopBar tab={tab} />
      <PullToRefresh onRefresh={handleRefresh}>
        <DesktopContentBar tab={tab} />
        <div className="page-content">{pages[tab]}</div>
      </PullToRefresh>
      <BottomNav active={tab} onChange={setTab} />
    </div>
  )
}
```

### Responsive Breakpoints
```css
/* Mobile default: BottomNav + AppTopBar */
/* ≥480px tablet-small: stock-grid 3col */
/* ≥640px tablet-iPad: pos-grid 3col · bottom-nav centered */
/* ≥900px desktop: DesktopSidebar 240px · hide BottomNav + AppTopBar */
```

---

## 8. Firestore Collections (V2 — 13 collections)

### ⚠️ Schema เปลี่ยนจาก V1

### 8.1 `warehouses`
```ts
{
  id:         string;   // "main" | "itu"
  name:       string;   // "คลังกลาง" | "ร้าน ITU"
  type:       'main' | 'branch';
  color:      string;   // "#E31E24"
  isMain:     boolean;
  branchCode: string;
  active:     boolean;
  createdAt:  Timestamp;
}
```

### 8.2 `items`
```ts
{
  id:             string;
  name:           string;   // "แยมสตรอว์เบอร์รี"
  category:       string;   // "แยม" | "ผลไม้" | "ไซรัป" | "ท็อปปิ้ง" | "วัตถุดิบ" | "บรรจุภัณฑ์"
  img:            string;   // emoji "🍓"
  unitBase:       string;   // "กก." — หน่วยซื้อ/เก็บ (คลังกลาง)
  unitUse:        string;   // "ขีด" — หน่วยตัดใช้งาน (หน้าร้าน)
  unitConversion: string;   // "1 กก. = 10 ขีด"
  wasteMode:      boolean;
  sourceId?:      string;   // link Cost Manager
  createdAt:      Timestamp;
}
```

> ✅ V2: ลบ `minQty` และ `maxQty` ออกจาก `items` → ย้ายไป `stock_balances` แยกต่อ warehouse

### 8.3 `stock_balances` ⭐ เปลี่ยนมากสุด
```ts
// document id = `${warehouseId}_${itemId}`  เช่น "main_item001" | "itu_item001"
{
  warehouseId:     string;
  itemId:          string;
  qty:             number;    // ยอดคงเหลือ ในหน่วย unit ของ warehouse นั้น
  unit:            string;    // main → unitBase ("กก.") · itu → unitUse ("ขีด")
  minQty:          number;    // ✅ V2: min ต่าง warehouse ต่างกัน (หน่วยตาม unit ข้างบน)
  lastUpdated:     Timestamp;
  lastUpdatedBy:   string;    // phone
}
```

**ตัวอย่าง:**
```
main_item001 → { qty: 15, unit: "กก.", minQty: 5 }   ← คลังกลางใช้ กก.
itu_item001  → { qty: 30, unit: "ขีด", minQty: 10 }  ← หน้าร้านใช้ ขีด
```

### 8.4 `stock_movements`
```ts
{
  id:           string;
  type:         'cut' | 'receive' | 'transfer_out' | 'transfer_in' | 'waste' | 'adjust';
  itemId:       string;
  itemName:     string;
  warehouseId:  string;
  qty:          number;    // บวก = รับเข้า, ลบ = ออก (หน่วย unit ของ warehouse)
  unit:         string;
  unitUse:      string;
  qtyUse:       number;
  staffPhone:   string;
  staffName:    string;
  shopName:     string;
  timestamp:    Timestamp;
  templateName?: string;
  adjustReason?: string;   // ✅ V2: เฉพาะ type='adjust'
  note?:         string;
}
```

### 8.5 `transfer_orders`
```ts
{
  id:              string;   // "TF-2569-0042"
  fromWarehouseId: string;
  toWarehouseId:   string;
  items: Array<{
    itemId:   string;
    itemName: string;
    lotDate:  string;
    qty:      number;
    unit:     string;
    mainStockAtTime: number;  // ✅ V2: stock คลังกลาง ณ เวลาสร้างใบ (snapshot)
  }>;
  status:      'pending' | 'received';
  driver:      string;
  createdBy:   string;
  createdAt:   Timestamp;
  receivedBy?: string;
  receivedAt?: Timestamp;
}
```

### 8.6 `lot_tracking`
```ts
// doc id = `${itemId}_${warehouseId}_${receiveDate}`
{
  itemId:      string;
  itemName:    string;
  warehouseId: string;
  receiveDate: string;   // "01/05/69"
  mfgDate:     string;
  expDate:     string;
  totalQty:    number;
  inWarehouse: number;
  inShop:      number;
  used:        number;
  source:      string;
  createdAt:   Timestamp;
}
```

### 8.7 `waste_logs`
```ts
{
  id:          string;
  date:        string;   // "2569-05-14"
  warehouseId: string;
  type:        'fruit_daily' | 'closing';
  itemId:      string;
  itemName:    string;
  qty:         number;
  unit:        string;
  costPerUnit: number;
  totalCost:   number;
  staffPhone:  string;
  staffName:   string;
  timestamp:   Timestamp;
}
```

### 8.8 `cut_stock_logs`
```ts
{
  id:           string;
  date:         string;
  warehouseId:  string;
  shopName:     string;
  staffPhone:   string;
  staffName:    string;
  templateName?: string;
  items: Array<{
    itemId:    string;
    itemName:  string;
    img:       string;
    qtyUse:    number;
    unitUse:   string;
    qtyBase:   number;   // ✅ V2: เก็บ qtyBase ที่หัก stock จริงด้วย
    unitBase:  string;
    costTotal: number;
  }>;
  totalCost:    number;
  timestamp:    Timestamp;
  deletedAt?:   Timestamp;
  deleteReason?: string;
  deletedBy?:   string;
}
```

### 8.9 `quick_templates`
```ts
{
  id:        string;
  name:      string;
  icon:      string;
  items:     Array<{ itemId: string; qty: number; unitUse: string; }>;
  createdBy: string;
  order:     number;
}
```

### 8.10 `audit_logs`
```ts
{
  action:      string;   // "cut_stock" | "adjust_stock" | "receive" | "delete_log" | ...
  staffPhone:  string;
  staffName:   string;
  warehouseId: string;
  detail:      string;
  timestamp:   Timestamp;
}
```

### 8.11 `app_settings`
```ts
// doc id = "inventory_settings"
{
  wasteTargetPct:          number;   // 8
  expWarningDays:          number;   // 7
  notifLowStock:           boolean;  // true
  notifWasteOverThreshold: boolean;  // false
  analyzePin:              string;   // "1234"
  // ✅ V2: ลบ openingStockDone ออก
  updatedAt:               Timestamp;
}
```

### 8.12 `low_stock_alerts`
```ts
{
  itemId:      string;
  itemName:    string;
  warehouseId: string;
  currentQty:  number;
  minQty:      number;
  sentAt:      Timestamp;
  read:        boolean;
}
```

### 8.13 `push_queue`
```ts
// doc id = phone
{
  title: string;
  body:  string;
  read:  boolean;
  tag:   string;
}
```

---

## 9. Firestore Real-time — Rules & Patterns

```
⚠️ ใช้ onSnapshot() เสมอ — ห้าม Manual Sync
⚠️ unsubscribe ทุกครั้งเมื่อออกจากหน้า / เปลี่ยน filter
⚠️ subscribe เฉพาะ warehouseId ที่กำลังดู — ไม่ subscribe ทั้ง collection
```

```js
// ✅ Pattern ที่ถูกต้อง
useEffect(() => {
  const q = query(
    collection(db, 'stock_balances'),
    where('warehouseId', '==', currentWH)
  )
  const unsub = onSnapshot(q, (snap) => {
    const data = {}
    snap.forEach(doc => { data[doc.id] = doc.data() })
    setBalances(data)
  })
  return () => unsub()
}, [currentWH])
```

**Free Tier:** ~280–350 reads/วัน = <1% ของ 50,000 reads/วัน ✅

---

## 10. Unit Conversion Utilities ⭐ V2 ใหม่

```js
// src/utils/unit.js

/**
 * แปลง qtyUse (unitUse) → qtyBase (unitBase)
 * conversion = "1 กก. = 10 ขีด"
 * ตัวอย่าง: convertToBase(3, "ขีด", "1 กก. = 10 ขีด") → 0.3 (กก.)
 */
export function convertToBase(qtyUse, unitUse, conversion, unitBase) {
  if (!conversion || unitUse === unitBase) return qtyUse
  const match = conversion.match(/1\s*\S+\s*=\s*([\d.]+)/)
  const factor = match ? parseFloat(match[1]) : 1
  return qtyUse / factor
}

/**
 * แปลง qtyBase (unitBase) → qtyUse (unitUse)
 * ตัวอย่าง: convertToUse(0.3, "1 กก. = 10 ขีด") → 3 (ขีด)
 */
export function convertToUse(qtyBase, conversion) {
  if (!conversion) return qtyBase
  const match = conversion.match(/1\s*\S+\s*=\s*([\d.]+)/)
  const factor = match ? parseFloat(match[1]) : 1
  return qtyBase * factor
}

/**
 * stock status สำหรับ badge สี
 * ใช้ minQty จาก stock_balances (ไม่ใช่ items)
 */
export function getStockStatus(qty, minQty) {
  if (qty <= 0)           return 'out'   // 🔴 หมด
  if (qty <= minQty)      return 'low'   // 🟡 ใกล้หมด
  return 'ok'                            // ✅ ปกติ
}
```

---

## 11. Bug Fix — cutStock ต้องใช้ writeBatch เสมอ ⭐ V2

### ❌ แบบผิด (V1) — อาจทำให้ stock ไม่ลด
```js
// ผิด 1: ไม่ใช้ batch → log บันทึกแต่ stock ไม่ลดได้
await addDoc(collection(db, 'stock_movements'), movData)
await updateDoc(doc(db, 'stock_balances', `${wh}_${id}`), { qty: increment(-q) })

// ผิด 2: doc id ผิด → update ไม่โดน
doc(db, 'stock_balances', itemId)  // ❌ ขาด warehouseId prefix

// ผิด 3: ไม่แปลงหน่วย → หัก stock ผิดปริมาณ
batch.update(balRef, { qty: increment(-qtyUse) })  // ❌ qtyUse ไม่ใช่ qtyBase
```

### ✅ แบบถูก (V2) — cutStock function
```js
// src/utils/cutStock.js
import { writeBatch, doc, collection, increment, serverTimestamp } from 'firebase/firestore'
import { db } from '../firebase'
import { convertToBase } from './unit'

export async function cutStock({ cuts, staffPhone, staffName, shopName, warehouseId, templateName }) {
  const batch = writeBatch(db)
  const session = window._bizSession

  for (const cut of cuts) {
    const { itemId, itemName, img, qtyUse, unitUse, unitBase, unitConversion, costPerUnit } = cut

    // 1. แปลงหน่วย: qtyUse (unitUse) → qtyBase (unitBase)
    const qtyBase = convertToBase(qtyUse, unitUse, unitConversion, unitBase)

    // 2. update stock_balances — doc id ต้องเป็น `${warehouseId}_${itemId}`
    const balRef = doc(db, 'stock_balances', `${warehouseId}_${itemId}`)
    batch.update(balRef, {
      qty:           increment(-qtyBase),
      lastUpdated:   serverTimestamp(),
      lastUpdatedBy: staffPhone,
    })

    // 3. add stock_movements
    const movRef = doc(collection(db, 'stock_movements'))
    batch.set(movRef, {
      type:        'cut',
      itemId,
      itemName,
      warehouseId,
      qty:         -qtyBase,
      unit:        unitBase,
      qtyUse:      -qtyUse,
      unitUse,
      staffPhone,
      staffName,
      shopName,
      templateName: templateName || null,
      timestamp:   serverTimestamp(),
    })
  }

  // 4. add cut_stock_logs (1 doc ต่อ 1 ครั้งยืนยัน)
  const logRef = doc(collection(db, 'cut_stock_logs'))
  batch.set(logRef, {
    date:        new Date().toISOString().split('T')[0],
    warehouseId,
    shopName,
    staffPhone,
    staffName,
    templateName: templateName || null,
    items:       cuts.map(c => ({
      itemId:    c.itemId,
      itemName:  c.itemName,
      img:       c.img,
      qtyUse:    c.qtyUse,
      unitUse:   c.unitUse,
      qtyBase:   convertToBase(c.qtyUse, c.unitUse, c.unitConversion, c.unitBase),
      unitBase:  c.unitBase,
      costTotal: c.qtyUse * (c.costPerUnit || 0),
    })),
    totalCost:   cuts.reduce((s, c) => s + c.qtyUse * (c.costPerUnit || 0), 0),
    timestamp:   serverTimestamp(),
  })

  // 5. audit log
  const audRef = doc(collection(db, 'audit_logs'))
  batch.set(audRef, {
    action:      'cut_stock',
    staffPhone,
    staffName,
    warehouseId,
    detail:      `ตัดสต็อก ${cuts.length} รายการ${templateName ? ` (${templateName})` : ''}`,
    timestamp:   serverTimestamp(),
  })

  // 6. commit ครั้งเดียว — atomic
  await batch.commit()

  // 7. หลัง commit: เช็ค stock ต่ำ → push alert
  await checkLowStockAfterCut(cuts, warehouseId)
}

async function checkLowStockAfterCut(cuts, warehouseId) {
  const { getDoc, doc, setDoc, serverTimestamp } = await import('firebase/firestore')
  for (const cut of cuts) {
    const balRef = doc(db, 'stock_balances', `${warehouseId}_${cut.itemId}`)
    const snap   = await getDoc(balRef)
    if (!snap.exists()) continue
    const { qty, minQty } = snap.data()
    if (qty <= minQty) {
      await setDoc(doc(db, 'low_stock_alerts', `${warehouseId}_${cut.itemId}`), {
        itemId:      cut.itemId,
        itemName:    cut.itemName,
        warehouseId,
        currentQty:  qty,
        minQty,
        sentAt:      serverTimestamp(),
        read:        false,
      })
      // push ให้ Owner
      await setDoc(doc(db, 'push_queue', window._bizSession?.phone || 'owner'), {
        title: `Stock ต่ำ — ${cut.itemName}`,
        body:  `เหลือ ${qty} ${cut.unitBase} (min ${minQty})`,
        read:  false,
        tag:   'low_stock',
      })
    }
  }
}
```

---

## 12. ปรับยอดคงคลัง (Owner Only) ⭐ V2 ใหม่

> แทน Opening Stock ที่ยกเลิกไป — ทำซ้ำได้ไม่จำกัด

### UI — กด card ในหน้าคลัง
```
[card]
  🍓 แยมสตรอว์เบอร์รี    15 กก.
  [badge: ปกติ]  [ปุ่ม ปรับยอด]   ← แสดงเฉพาะ isOwner()
```

### Modal ปรับยอด
```
handle bar
ปรับยอดคงคลัง   [✕]
──────────────────────────────────
[item row: emoji · ชื่อ · qty เดิม]

[toggle: เพิ่ม ↔ ลด]

จำนวนปรับ  [number input]   หน่วย [unit]
คลังสินค้า [dropdown]

สาเหตุ * [dropdown]
  เพิ่ม: รับโอนสำเร็จรูป · ปรับจากนับสินค้า · อื่นๆ
  ลด:   ตัดวัตถุดิบใช้ไป · ปรับจากนับสินค้า ·
        สินค้าสูญหาย · ทำลายสินค้า ·
        สินค้าชำรุด/เสื่อมสภาพ · ภัยพิบัติ/อัคคีภัย · อื่นๆ

หมายเหตุ [text input]

[preview: หลังปรับแล้วจะเหลือ X unit]  ← auto-calc

[ยืนยันปรับยอด]
```

### adjustStock function
```js
export async function adjustStock({ itemId, itemName, warehouseId, qty, unit,
                                    direction, reason, note, staffPhone, staffName }) {
  const batch = writeBatch(db)
  const delta = direction === 'add' ? qty : -qty

  // 1. update stock_balances
  const balRef = doc(db, 'stock_balances', `${warehouseId}_${itemId}`)
  batch.update(balRef, {
    qty:           increment(delta),
    lastUpdated:   serverTimestamp(),
    lastUpdatedBy: staffPhone,
  })

  // 2. stock_movements type: 'adjust'
  const movRef = doc(collection(db, 'stock_movements'))
  batch.set(movRef, {
    type:         'adjust',
    itemId, itemName, warehouseId,
    qty:          delta,
    unit,
    adjustReason: reason,
    note:         note || null,
    staffPhone, staffName,
    timestamp:    serverTimestamp(),
  })

  // 3. audit_logs
  const audRef = doc(collection(db, 'audit_logs'))
  batch.set(audRef, {
    action:      'adjust_stock',
    staffPhone, staffName, warehouseId,
    detail:      `ปรับยอด ${itemName} ${direction === 'add' ? '+' : '-'}${qty} ${unit} · ${reason}`,
    timestamp:   serverTimestamp(),
  })

  await batch.commit()
}
```

---

## 13. Connection Status Component (Shared)

```tsx
// src/components/ConnectionStatus.jsx
import { useEffect, useState } from 'react'
import { db } from '../firebase'
import { doc, onSnapshot } from 'firebase/firestore'

export function ConnectionStatus() {
  const [state, setState]     = useState('online')   // 'online'|'offline'|'syncing'
  const [lastSync, setLastSync] = useState('')

  useEffect(() => {
    const onOnline  = () => setState('online')
    const onOffline = () => setState('offline')
    window.addEventListener('online',  onOnline)
    window.addEventListener('offline', onOffline)

    const unsub = onSnapshot(
      doc(db, 'app_settings', 'inventory_settings'),
      () => {
        setState('online')
        setLastSync(new Date().toLocaleTimeString('th-TH', { hour:'2-digit', minute:'2-digit' }))
      },
      () => setState('offline')
    )
    return () => {
      window.removeEventListener('online',  onOnline)
      window.removeEventListener('offline', onOffline)
      unsub()
    }
  }, [])

  // 3 states: online (เขียว) · offline (แดง) · syncing (ส้ม blink)
  return (
    <div className="conn-wrap">
      <div className={`conn-pill ${state}`}>
        <span className={`conn-dot ${state}`} />
        <span className="conn-txt">
          {state === 'online' ? 'Online' : state === 'offline' ? 'Offline' : 'กำลัง sync...'}
        </span>
      </div>
      {state === 'online' && lastSync && (
        <span className="last-sync-txt">อัปเดตล่าสุด {lastSync} น.</span>
      )}
      {state === 'offline' && (
        <span className="last-sync-txt" style={{ color: 'var(--red)' }}>⚠️ ไม่มีสัญญาณ</span>
      )}
    </div>
  )
}
```

**CSS (index.css):**
```css
.conn-pill { display:flex;align-items:center;gap:5px;padding:4px 10px;border-radius:20px;font-size:11px;font-weight:600 }
.conn-pill.online  { background:var(--green-bg); color:var(--green); }
.conn-pill.offline { background:#FEE2E2; color:#DC2626; }
.conn-pill.syncing { background:var(--orange-bg); color:var(--orange); }
.conn-dot { width:7px;height:7px;border-radius:50%; }
.conn-dot.online  { background:var(--green); box-shadow:0 0 0 2px rgba(21,128,61,.25); }
.conn-dot.offline { background:#DC2626; }
.conn-dot.syncing { background:#D97706; animation:blink 1s infinite; }
```

---

## 14. Audio Utilities

```js
// src/utils/audio.js
let _ctx = null
const ctx = () => {
  if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)()
  return _ctx
}
export function beepClick() {
  try {
    const o = ctx().createOscillator(), g = ctx().createGain()
    o.connect(g); g.connect(ctx().destination)
    o.frequency.value = 880; o.type = 'sine'
    g.gain.setValueAtTime(.15, ctx().currentTime)
    g.gain.exponentialRampToValueAtTime(.001, ctx().currentTime + .1)
    o.start(); o.stop(ctx().currentTime + .1)
  } catch {}
}
export function beepSuccess() {
  [523, 659, 784].forEach((f, i) => setTimeout(() => beepClick(), i * 90))
}
```

---

## 15. Tab 2 — คลัง (V2 updates)

### Card — เพิ่ม 2 ปุ่ม
```
[emoji]  {itemName}
         {category}
{qty} {unit}
[====progress====]
[badge]   [LOT n ⚠️]   [ⓘ min stock]   [ปรับยอด — Owner only]
ตัด: {unitUse}
```

### Modal แก้ไข min stock (กด ⓘ)
```
handle bar
ตั้งค่า stock ขั้นต่ำ — {itemName}  [✕]
────────────────────────────────────
[info: "เมื่อ stock ต่ำกว่านี้ จะขึ้น badge สีเหลือง/แดงค่ะ"]

คลังกลาง    min: [___] กก.    ← unitBase
ร้าน ITU    min: [___] ขีด    ← unitUse

[บันทึก]
```

**Save:**
```js
const batch = writeBatch(db)
batch.update(doc(db,'stock_balances','main_item001'), { minQty: mainMin })
batch.update(doc(db,'stock_balances','itu_item001'),  { minQty: ituMin })
await batch.commit()
```

---

## 16. Tab 3 — ตัดสต็อก (V2 — ใช้ cutStock function จาก section 11)

### ⚠️ ข้อกำหนดสำคัญ
```
- หน้าร้านเท่านั้น (isEditor หรือ isOwner)
- คลังกลางไม่มีเมนูตัดสต็อก
- ต้องใช้ cutStock() ที่มี writeBatch เสมอ — ห้ามเขียน update แยก
- แปลงหน่วยด้วย convertToBase() ก่อน update stock_balances เสมอ
```

### POS Card — แสดง unitUse
```
☆ (fav)              [qty badge]
      {emoji}
      {itemName}
      เหลือ {qty} {unitUse}   ← ดึงจาก stock_balances ของ warehouseId นั้น
  [−]   {qty}   [+]
        {unitUse}
```

### Cart Confirm — Pre-cut Warning
```js
// คำนวณ stock หลังตัด
const afterQty = currentQty - convertToBase(qtyUse, unitUse, item.unitConversion, item.unitBase)
const willBeLow = afterQty <= balances[`${wh}_${id}`]?.minQty
```

---

## 17. Tab 1 — แดชบอร์ด (V2 — Modal ใบขอโอน อัพเดต)

### Modal สร้างใบโอน — แสดง stock คลังกลาง ⭐ V2

```
จากคลัง [dropdown]   ไปยัง [dropdown]
คนนำส่ง [text]

⚠️ FIFO — Lot เก่าสุดออกก่อน

เลือกสินค้าและ Lot:
  แต่ละ item แสดง:
  ┌─────────────────────────────────────┐
  │ 🍓 แยมสตรอว์เบอร์รี                │
  │ [lot buttons]                        │
  │                                      │
  │ 📦 คลังกลาง: 15 กก.   ✅ เพียงพอ  │  ← สีเขียว
  │ 📦 คลังกลาง: 2 กก.    ⚠️ เหลือน้อย│  ← สีเหลือง
  │ 📦 คลังกลาง: 0        ❌ หมดแล้ว   │  ← สีแดง + ข้อความ
  └─────────────────────────────────────┘
  ถ้าคลังกลาง = 0:
    → "คลังกลางหมดแล้ว · ให้เตรียมสั่งของจากซัพพลายเออร์ค่ะ"
    → ปุ่ม "ขอโอน" disabled
    → ปุ่ม "แจ้ง Owner" → push_queue
```

**Logic:**
```js
// ดึง stock คลังกลางของแต่ละ item
const mainBalance = balances[`main_${item.itemId}`]
const mainQty     = mainBalance?.qty ?? 0
const mainMin     = mainBalance?.minQty ?? 0

const mainStatus =
  mainQty <= 0     ? 'out'  :   // ❌ แดง
  mainQty <= mainMin ? 'low' :  // ⚠️ เหลือง
  'ok'                          // ✅ เขียว
```

---

## 18. Tab 4 — รายงาน (ไม่เปลี่ยนจาก V1 — ดู V1 section 12)

4 Sub-tabs: รายวัน · สัปดาห์+เดือน · ของเสีย · วิเคราะห์ (PIN)

**Food Cost formulas:**
```
Actual Food Cost %    = Σ(qtyUse × price/unitUse จาก Cost Manager) ÷ income_records × 100
Theoretical%          = จาก mixue_data.menus[].costPct (Cost Manager)
Variance              = Actual% − Theoretical%
Gross Profit          = รายรับ − ต้นทุนวัตถุดิบ
```

---

## 19. Tab 5 — ตั้งค่า (V2 updates)

### กลุ่ม 1 — บัญชีผู้ใช้
| Row | Action |
|-----|--------|
| 🔐 เปลี่ยน PIN | modal · save `app_settings.analyzePin` |
| 👥 จัดการ Staff | badge "→ Hub" · redirect HUB · ไม่มี staff modal ในแอพ |

### กลุ่ม 2 — คลัง + วัตถุดิบ
| Row | Action |
|-----|--------|
| 🏪 จัดการคลังสินค้า | เพิ่ม/แก้ไข/ปิด · ชื่อ/ประเภท/สี |
| 📦 วัตถุดิบ (Master Data) | เพิ่ม/แก้ไข · ชื่อ/หมวด/emoji/unitBase/unitUse/conversion/wasteMode |
| 🗑️ โหมดของเสีย | toggle per item |
| ⚡ Quick Template | สร้าง/แก้ไข/ลบ (Owner only) |

### กลุ่ม 3 — การแจ้งเตือน
| Row | Default |
|-----|---------|
| 📉 Stock ต่ำกว่า min | ON |
| 📅 แจ้งเตือนก่อน EXP | 7 วัน |
| 🗑️ ของเสียเกิน threshold | OFF |

**ไม่มี:** สรุปรายวัน (น้องมี่) — น้องมี่ดึงจาก Firestore เองอัตโนมัติ

### กลุ่ม 4 — ระบบ (V2)
| Row | Detail |
|-----|--------|
| 🔗 เชื่อมต่อระบบ | Cost Manager ✓ · Daily Income ✓ · น้องมี่ ✓ |
| 📤 Export ข้อมูล | CSV / PDF · date range |
| 🔄 รีเฟรชข้อมูล | Force refresh · re-subscribe |

> ✅ V2: ลบ Opening Stock ออก — ใช้ "ปรับยอดคงคลัง" ใน tab คลังแทน

### Integration (3 ระบบ)
```
🧮 Cost Manager    → shared Firebase · ราคา/หน่วย → คำนวณ Food Cost %
💵 Daily Income    → income_records collection · ยอดรายรับ
🤖 น้องมี่ LINE    → push_queue · reporter mode
```

### Danger Zone
```
🗑️ Clear All Data  → ใส่ PIN → ลบ stock_balances + cut_stock_logs
🚪 ออกจากระบบ     → clear bizice_session → redirect HUB
```

---

## 20. Integration — Daily Income & Cost Manager

```js
// ยอดรายรับ
async function getDailyIncome(dateKey) {
  const snap = await getDoc(doc(db, 'income_records', dateKey))
  if (!snap.exists()) return 0
  const d = snap.data()
  return (d.morning?.total || 0) + (d.afternoon?.total || 0)
}

// ราคาต่อหน่วย
let priceCache = {}
async function getItemPrice(itemName) {
  if (priceCache[itemName]) return priceCache[itemName]
  const snap  = await getDoc(doc(db, 'mixue_data', 'mixue-cost-manager'))
  const lib   = snap.data()?.library || []
  const item  = lib.find(i => i.name === itemName)
  const price = item?.unitPrice || item?.total || 0
  priceCache[itemName] = price
  return price
}
```

---

## 21. FIFO Utilities

```js
// src/utils/fifo.js
export function sortLotsFIFO(lots) {
  return [...lots].sort((a, b) => {
    const parse = s => {
      const [d, m, y] = s.split('/').map(Number)
      return new Date(2500 + y, m - 1, d)
    }
    return parse(a.receiveDate) - parse(b.receiveDate)
  })
}

export function getExpStatus(expDate) {
  const [d, m, y] = expDate.split('/').map(Number)
  const exp  = new Date(2500 + y, m - 1, d)
  const days = Math.round((exp - new Date()) / 86400000)
  if (days < 0)   return { status:'expired', days, color:'#E24B4A' }
  if (days <= 30) return { status:'warning', days, color:'#633806' }
  return { status:'ok', days, color:'#3B6D11' }
}
```

---

## 22. Build & Deploy

```bash
npm install
npm run dev      # localhost:5176/bizice-inventory/
npm run build
npm run deploy   # build + .nojekyll + gh-pages
```

**vite.config.js:**
```js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  base: '/bizice-inventory/',
  build: { outDir: 'dist' }
})
```

---

## 23. Test Accounts

| Role | Phone | Analyze PIN |
|------|-------|-------------|
| Owner (พี่จีโน่) | 0843904727 | 1234 |
| Editor (Staff) | 0812345678 | — |

---

## 24. Done Criteria Checklist (V2)

### Core & Session
- [ ] Session guard · URL params fallback (iOS Safari)
- [ ] Role: owner / editor / viewer ครบ 3 ระดับ
- [ ] `<ConnectionStatus />` · 3 states (Online/Offline/Syncing)
- [ ] Last sync auto · ไม่มี Manual Sync button
- [ ] Responsive: Mobile / Tablet / Desktop ≥900px

### Schema & Data
- [ ] `stock_balances` doc id = `${warehouseId}_${itemId}` เสมอ
- [ ] `stock_balances.unit` = unitBase (main) / unitUse (itu)
- [ ] `stock_balances.minQty` ต่าง warehouse ต่างกัน
- [ ] ลบ `minQty` / `maxQty` ออกจาก `items` collection

### Bug Fix
- [ ] `cutStock()` ใช้ `writeBatch` เสมอ — ห้าม update แยก
- [ ] แปลงหน่วย `convertToBase()` ก่อน `increment(-qtyBase)` เสมอ
- [ ] `adjustStock()` ใช้ `writeBatch` เสมอ

### Tab คลัง
- [ ] 2-col card · LOT Popup · piece chips
- [ ] ปุ่ม ⓘ → modal แก้ minQty แยก warehouse
- [ ] ปุ่ม "ปรับยอด" แสดงเฉพาะ isOwner()
- [ ] Modal ปรับยอด: toggle เพิ่ม/ลด · dropdown สาเหตุ · preview ยอดหลังปรับ

### Tab ตัดสต็อก
- [ ] หน้าร้านเท่านั้น · คลังกลางไม่มีเมนูนี้
- [ ] POS grid + เสียง + Favorite + Template
- [ ] Pre-cut Warning ⚠️ ใช้ minQty จาก stock_balances
- [ ] Auto Alert หลังตัด ถ้า stock ต่ำ

### Tab แดชบอร์ด
- [ ] ใบขอโอน: แสดง stock คลังกลาง 3 state (เขียว/เหลือง/แดง)
- [ ] ถ้าคลังกลาง = 0 → ข้อความแดง + disable + แจ้ง Owner

### Tab รายงาน
- [ ] 4 sub-tabs · ของเสีย 2 block แยก
- [ ] Stacked bar · Waste % Revenue · Target Waste
- [ ] Tab วิเคราะห์: PIN + Food Cost + Gross Profit + Spike

### Tab ตั้งค่า
- [ ] Staff → "→ Hub" ไม่มี staff modal
- [ ] ลบ Opening Stock ออก
- [ ] Integration: Cost Manager + Daily Income + น้องมี่
- [ ] Force Refresh

### Deploy
- [ ] base: '/bizice-inventory/'
- [ ] .nojekyll auto ใน deploy script
- [ ] https://truescale-group.github.io/bizice-inventory/
