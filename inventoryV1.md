# inventoryV1.md — Mixue Inventory System
> Spec สำหรับ Claude Code · BizICE Platform · พี่จีโน่
> Last updated: 15 พ.ค. 2569 (Final — ครบทุก feature)

---

## 1. Overview

| Item | Detail |
|------|--------|
| App name | Mixue Inventory |
| Deploy URL | https://truescale-group.github.io/bizice-inventory/ |
| GitHub repo | truescale-group/bizice-inventory |
| Firebase project | mixue-cost-manager |
| Tech stack | React + Vite + Tailwind CSS |
| Deploy | GitHub Pages (gh-pages branch) |
| Platform | Mobile-first · iOS Safari primary (พนักงาน 100% iPhone) |

---

## 2. Firebase Config

```js
const firebaseConfig = {
  apiKey: "AIzaSyDRs60WURPcNArQXl5RRuwqJcLjtN3CMe4",
  authDomain: "mixue-cost-manager.firebaseapp.com",
  projectId: "mixue-cost-manager",
  storageBucket: "mixue-cost-manager.firebasestorage.app",
  messagingSenderId: "414432707376",
  appId: "1:414432707376:web:1cf394f174257a86cdbef5"
};
```

---

## 3. Session Guard

ใส่ใน `index.html` `<head>` ก่อน React mount เสมอ

```js
(function () {
  const HUB = 'https://truescale-group.github.io/mixue-ice-sakon/';
  try {
    const s = JSON.parse(localStorage.getItem('bizice_session') || 'null');
    if (!s || !s.name) { window.location.replace(HUB); return; }
    if (s.expiry && Date.now() > s.expiry) {
      localStorage.removeItem('bizice_session');
      window.location.replace(HUB);
      return;
    }
    window._bizSession = s;
    window._bizMode = new URLSearchParams(location.search).get('mode') || 'viewer';
  } catch (e) { window.location.replace(HUB); }
})();
```

### Session Object
```ts
interface BizSession {
  phone: string;       // "0843904727"
  name: string;        // "พี่จีโน่"
  role: 'owner' | 'staff';
  apps: Record<string, 'editor' | 'viewer' | 'none'>;
  expiry: number;      // timestamp ms
}
```

### Permission Logic
```js
const isEditor = () => {
  const s = window._bizSession;
  if (!s) return false;
  if (s.role === 'owner') return true;
  return s.apps?.['inventory'] === 'editor';
};
const isOwner = () => window._bizSession?.role === 'owner';
```

---

## 4. Firestore Collections (13 collections)

### 4.1 `warehouses`
```ts
{
  id: string;
  name: string;         // "คลังกลาง" | "ร้าน ITU"
  type: 'main' | 'branch';
  color: string;        // "#FF3B30"
  isMain: boolean;
  branchCode: string;   // "itu"
  active: boolean;
  createdAt: Timestamp;
}
```

### 4.2 `items`
```ts
{
  id: string;
  name: string;         // "แยมสตรอว์เบอร์รี"
  category: string;     // "แยม" | "ผลไม้" | "ไซรัป" | "ท็อปปิ้ง" | "วัตถุดิบ" | "บรรจุภัณฑ์"
  img: string;          // emoji "🍓"
  unitBase: string;     // "กก." — หน่วยหลัก (ซื้อเข้า)
  unitUse: string;      // "ขีด" — หน่วยตัดสต็อก
  unitConversion: string; // "1 กก. = 10 ขีด"
  minQty: number;
  maxQty: number;
  wasteMode: boolean;   // true = ติดตามของเสีย
  sourceId?: string;    // link กับ Cost Manager item id
  createdAt: Timestamp;
}
```

### 4.3 `stock_balances`
```ts
// document id = `${warehouseId}_${itemId}`
{
  warehouseId: string;
  itemId: string;
  qty: number;          // ยอดคงเหลือในหน่วยหลัก (unitBase)
  unit: string;
  lastUpdated: Timestamp;
  lastUpdatedBy: string; // phone
}
```

### 4.4 `stock_movements`
```ts
{
  id: string;
  type: 'cut' | 'receive' | 'transfer_out' | 'transfer_in' | 'waste' | 'opening';
  itemId: string;
  itemName: string;
  warehouseId: string;
  qty: number;          // บวก = รับเข้า, ลบ = ออก
  unit: string;
  unitUse: string;
  qtyUse: number;
  staffPhone: string;
  staffName: string;
  shopName: string;
  timestamp: Timestamp;
  templateName?: string;
  note?: string;
}
```

### 4.5 `transfer_orders`
```ts
{
  id: string;           // "TF-2569-0042"
  fromWarehouseId: string;
  toWarehouseId: string;
  items: Array<{
    itemId: string;
    itemName: string;
    lotDate: string;    // "01/05/69"
    qty: number;
    unit: string;
  }>;
  status: 'pending' | 'received';
  driver: string;
  createdBy: string;
  createdAt: Timestamp;
  receivedBy?: string;
  receivedAt?: Timestamp;
}
```

### 4.6 `lot_tracking`
```ts
// document id = `${itemId}_${warehouseId}_${receiveDate}`
{
  itemId: string;
  itemName: string;
  warehouseId: string;
  receiveDate: string;  // "01/05/69" — LOT key
  mfgDate: string;
  expDate: string;
  totalQty: number;
  inWarehouse: number;
  inShop: number;
  used: number;
  source: string;       // "ตลาดไท"
  createdAt: Timestamp;
}
```

### 4.7 `waste_logs`
```ts
{
  id: string;
  date: string;         // "2569-05-14"
  warehouseId: string;
  type: 'fruit_daily' | 'closing';
  itemId: string;
  itemName: string;
  qty: number;
  unit: string;         // "ลูก" | "กรัม" | "มล."
  costPerUnit: number;
  totalCost: number;
  staffPhone: string;
  staffName: string;
  timestamp: Timestamp;
}
```

### 4.8 `cut_stock_logs`
```ts
{
  id: string;
  date: string;         // "2569-05-14"
  warehouseId: string;
  shopName: string;
  staffPhone: string;
  staffName: string;
  templateName?: string;
  items: Array<{
    itemId: string;
    itemName: string;
    img: string;
    qtyUse: number;
    unitUse: string;
    costTotal: number;
  }>;
  totalCost: number;
  timestamp: Timestamp;
  deletedAt?: Timestamp;
  deleteReason?: string;
  deletedBy?: string;
}
```

### 4.9 `quick_templates`
```ts
{
  id: string;
  name: string;         // "เปิดร้านเช้า"
  icon: string;         // "☀️"
  items: Array<{ itemId: string; qty: number; unitUse: string; }>;
  createdBy: string;    // phone (owner only)
  order: number;
}
```

### 4.10 `audit_logs`
```ts
{
  action: string;       // "cut_stock" | "receive" | "delete_log" | "login" | ...
  staffPhone: string;
  staffName: string;
  warehouseId: string;
  detail: string;
  timestamp: Timestamp;
}
```

### 4.11 `app_settings`
```ts
// document id = "inventory_settings"
{
  wasteTargetPct: number;          // 8 (%)
  expWarningDays: number;          // 7
  notifLowStock: boolean;          // true
  notifWasteOverThreshold: boolean;// false
  analyzePin: string;              // "1234"
  openingStockDone: boolean;       // false
  updatedAt: Timestamp;
}
```

### 4.12 `low_stock_alerts`
```ts
{
  itemId: string;
  itemName: string;
  warehouseId: string;
  currentQty: number;
  minQty: number;
  sentAt: Timestamp;
  read: boolean;
}
```

### 4.13 `push_queue`
```ts
// document id = phone
{
  title: string;
  body: string;
  read: boolean;
  tag: string;
}
```

---

## 5. Firestore Real-time Strategy

```
⚠️ ห้ามใช้ Manual Sync — ใช้ onSnapshot() เท่านั้น
⚠️ ต้อง unsubscribe ทุกครั้งเมื่อออกจากหน้า / เปลี่ยน filter
```

```js
// ✅ Pattern ที่ถูกต้อง
useEffect(() => {
  const unsub = db.collection('stock_balances')
    .where('warehouseId', '==', currentWH)
    .onSnapshot((snap) => {
      // update state
    });
  return () => unsub(); // cleanup เมื่อ unmount หรือ currentWH เปลี่ยน
}, [currentWH]);
```

**Free Tier:** ~280 reads/วัน = 0.56% ของ 50,000 reads/วัน ✅ ไม่เสียเงิน

---

## 6. Connection Status Component (Shared — ใช้ทุก mini-app)

```tsx
// src/components/ConnectionStatus.tsx
import { useEffect, useState } from 'react';
import { db } from '../firebase';

type ConnState = 'online' | 'offline' | 'syncing';

export function ConnectionStatus() {
  const [state, setState] = useState<ConnState>('online');
  const [lastSync, setLastSync] = useState<string>('');

  useEffect(() => {
    const onOnline  = () => setState('online');
    const onOffline = () => setState('offline');
    window.addEventListener('online',  onOnline);
    window.addEventListener('offline', onOffline);

    const unsub = db.collection('app_settings').doc('inventory_settings')
      .onSnapshot(
        () => {
          setState('online');
          setLastSync(new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }));
        },
        () => setState('offline')
      );

    return () => {
      window.removeEventListener('online',  onOnline);
      window.removeEventListener('offline', onOffline);
      unsub();
    };
  }, []);

  return (
    <div className="conn-wrap">
      <div className={`conn-pill conn-${state}`}>
        <span className={`conn-dot ${state}`} />
        <span className="conn-txt">
          {state === 'online' ? 'Online' : state === 'offline' ? 'Offline' : 'กำลัง sync...'}
        </span>
      </div>
      {state === 'online' && lastSync && (
        <span className="last-sync-txt">อัปเดตล่าสุด {lastSync} น.</span>
      )}
      {state === 'offline' && (
        <span className="last-sync-txt offline">⚠️ ไม่มีสัญญาณ</span>
      )}
    </div>
  );
}
```

**3 States:**
- 🟢 Online — dot สีเขียว + glow + Last sync timestamp (auto-update)
- 🔴 Offline — dot สีแดง + "⚠️ ไม่มีสัญญาณ"
- 🟠 Syncing — dot สีส้ม + blink animation

**ไม่มี Manual Sync button** — Force Refresh อยู่ใน Settings เท่านั้น

---

## 7. Audio Utilities

```js
// src/utils/audio.js
let _ctx = null;
const ctx = () => {
  if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
  return _ctx;
};

export function beepClick() {
  try {
    const o = ctx().createOscillator(), g = ctx().createGain();
    o.connect(g); g.connect(ctx().destination);
    o.frequency.value = 880; o.type = 'sine';
    g.gain.setValueAtTime(.15, ctx().currentTime);
    g.gain.exponentialRampToValueAtTime(.001, ctx().currentTime + .1);
    o.start(); o.stop(ctx().currentTime + .1);
  } catch {}
}

export function beepSuccess() {
  [523, 659, 784].forEach((f, i) => setTimeout(() => beepClick(), i * 90));
}
```

---

## 8. App Structure — 5 Bottom Tabs

```
bottom-nav: แดชบอร์ด | คลัง | ตัดสต็อก | รายงาน | ตั้งค่า
```

ทุกหน้า: `<ConnectionStatus />` ที่ topbar ด้านขวาเสมอ

---

## 9. Tab 1 — แดชบอร์ด

### Topbar
- Title: "แดชบอร์ด"
- Right: `<ConnectionStatus />` + ปุ่มแจ้งเตือน (bell + badge)
- Below: Warehouse segment — ทุกร้าน / คลังกลาง / ร้าน ITU

### Hero Card (gradient ตามสีคลัง)
```
มูลค่าใช้วัตถุดิบวันนี้ — {warehouseName}
฿{totalCost}
เชื่อม Cost Manager · real-time
```
`totalCost` = Σ (qtyUse ตัดวันนี้ × ราคา/หน่วย จาก Cost Manager)

### KPI Grid (2×2)
| ต้นทุนวัตถุดิบ (red card) | ครั้งตัดวันนี้ |
|---|---|
| ใกล้หมด | หมดแล้ว |

### Alert Pills (horizontal scroll)
- ดึงจาก `low_stock_alerts` + `lot_tracking` ที่ใกล้ EXP
- แดง = หมด/EXP แล้ว · เหลือง = ใกล้

### ทำรายการ (2×2 grid)
```
[รับสินค้า]    [โอนสินค้า]
[แจ้งเติมของ]  [บันทึกของเสีย]
```

### แจ้งเติมของ (Notification)
- pulsing red dot
- กด → modal รายการคำขอ → สร้างใบโอน flow

### ใบโอนรอดำเนินการ
- Ticket card: #TF-XXXX · สถานะ badge · รายการแบ่งหมวด
- ปุ่ม "รับสินค้า" → stock ปรับอัตโนมัติทั้งสองฝั่ง

### Modal: รับสินค้าเข้าคลัง
```
วัตถุดิบ  [dropdown]
จำนวน    [number]   หน่วย [dropdown]

วันที่รับ [date] | MFG [date] | EXP [date]   ← 3 ช่องแนวนอน compact

แหล่งที่มา [dropdown]

Label Preview: ชื่อ · วันที่รับ · 1/qty, 2/qty...

[บันทึกรับสินค้า]
```
Action: เพิ่ม `lot_tracking` + `stock_balances` + `stock_movements` type:'receive' + `audit_logs`

### Modal: สร้างใบโอนสินค้า
```
จากคลัง [dropdown]   ไปยัง [dropdown]
คนนำส่ง [text]

⚠️ Banner: FIFO — Lot เก่าสุดออกก่อน · Lot แดง = stock ไม่พอ

เลือกสินค้าและ Lot:
  item → lot buttons (FIFO tag บน Lot แรก) → qty input

[สร้างใบโอน]
```
ID format: `TF-{YYYY}-{4digit}` เช่น `TF-2569-0042`

### Modal: แจ้งเติมของ
```
รายการคำขอ: [checkbox] item + qty + คนขอ + เวลา
เพิ่มรายการเอง: [dropdown] + [qty] + [+ ปุ่ม]
[ปิด]   [สร้างใบโอน →]
```

---

## 10. Tab 2 — คลัง

### Topbar
- Title: "คลังสินค้า"
- Right: `<ConnectionStatus />`

### Scope Selector
```
คลังกลาง | ร้าน ITU | ทั้งหมด
```

### Search Bar + Category Chips
```
ทั้งหมด | 🍓 แยม | 🍋 ผลไม้ | 🍯 ไซรัป | 💎 ท็อปปิ้ง | 🥛 วัตถุดิบ | 🥤 บรรจุ
```

### 2-Column Card Grid (ไม่มี expand dropdown — clean)
```
[emoji]  {itemName}
         {category}
{qty} {unitBase}
[====progress====]
[badge]   [LOT n ⚠️]
ตัด: {unitUse}
```

qty color: แดง=หมด · เหลือง=ใกล้หมด · เขียว=ปกติ

### LOT Popup (Bottom Sheet — แยกออกมา ไม่ใช่ expand)

เปิดจากปุ่ม [LOT n ⚠️]

```
handle bar
[emoji] {itemName}                               [✕ ปิด]
        ตัด: {unitUse} · {unitConversion}
────────────────────────────────────────
[Info box สีฟ้า]
  Stock คงเหลือ     {qty} {unitBase}
  จำนวน Lot         {n} Lot
  Lot ใกล้หมดอายุ   {n} Lot ⚠️

[LOT block ต่อ Lot — เรียง FIFO เก่าสุดขึ้นก่อน]

  LOT {receiveDate}  [FIFO ออกก่อน — เฉพาะ Lot แรก]  {qty} {unitBase}
  MFG {mfgDate} › EXP {expDate} · {days} วัน
  [pill: เขียว>30วัน / เหลือง≤30วัน / แดง=หมด]

  STOCK {unitBase}:
  [piece chips]
    🟢 pc-wh   = คลังกลาง
    🟠 pc-shop = ร้าน/ระหว่างส่ง
    ⬜ pc-used = ใช้แล้ว

  Legend: 🟢 คลัง({n}) · 🟠 ร้าน/ส่ง({n}) · ⬜ ใช้แล้ว({n})
```

---

## 11. Tab 3 — ตัดสต็อก

**⚠️ หน้าร้านเท่านั้น** ไม่ใช้กับคลังกลาง

### Topbar
- Title: "ตัดสต็อก"
- Left: Shop selector pill → modal เลือกสาขา
- Right: Cart button (badge count) + 📊 (Usage Pattern popup)

### Cart Bar (sticky below topbar — แสดงเมื่อมีรายการ)
```
[🛒] ตะกร้า — {n} รายการ · กดเพื่อดูและยืนยันตัดสต็อกค่ะ  [›]
```

### Category Filter Chips
```
⭐ ของฉัน | ทั้งหมด | 🍓 แยม | 🍋 ผลไม้ | 🍯 ไซรัป | 💎 ท็อปปิ้ง | 🥛 วัตถุดิบ | 🥤 บรรจุ
```

**Favorite Items (⭐ "ของฉัน"):**
```js
const FAVES_KEY = `fav_${session.phone}`; // per-device localStorage
const favorites = new Set(JSON.parse(localStorage.getItem(FAVES_KEY) || '[]'));
// กด ☆ = toggle + save
```

### Quick Template Row (horizontal scroll)
```
[☀️ เปิดร้านเช้า  4 รายการ]  [🎉 เช้าวันหยุด  5 รายการ]  [+ เพิ่ม]
```
- ดึงจาก `quick_templates` collection
- กด template → ใส่ทุก item ลงตะกร้า + beepSuccess()
- กด ✏️ → redirect Settings > Quick Template (owner only)

### POS Grid (2-column)
```
☆ (fav toggle)            [qty badge ถ้า > 0]
      {emoji}
      {itemName}
      เหลือ {stock} {unitUse}
  [−]    {qty}    [+]
         {unitUse}
```

- กด card body = +1 + beepClick()
- กด [+] = +1 + beepClick()
- กด [−] = −1 + beepClick() (min 0)
- กด ☆ = toggle favorite + toast
- `pos-card.selected` border แดง ถ้า qty > 0
- `pos-card.out-of-stock` opacity 0.45 + pointer-events none

### Cart Confirm Popup (Bottom Sheet)

```
handle bar
ยืนยันตัดสต็อก                          [✕]
────────────────────────────────────────
[Log info box สีเทา]
  โดย   [dropdown staff]
  สาขา  {shopName} (auto)
  เวลา  {datetime auto}

[รายการแบ่งหมวดหมู่]
  🍓 แยม
    [✓] แยมสตรอว์เบอร์รี  3 ขีด → เหลือ 9 ขีด
    [✓] แยมพีชเหลือง      2 กรัม → เหลือ 850 กรัม
  🍯 ไซรัป
    [✓] ไซรัปบราวน์ชูก้า  500 มล. → เหลือ 23,500 มล.

[⚠️ Pre-cut Warning — section สีเหลือง ถ้ามี]
  แยมสตรอว์เบอร์รี จะเหลือ 2 ขีด (ต่ำกว่า min 3 ขีดค่ะ)
  [checkbox] แจ้งเติม "แยมสตรอว์เบอร์รี"

[ยกเลิก]   [✓ ยืนยันตัดสต็อก]
```

**หลังยืนยัน (ลำดับ):**
1. เพิ่ม `cut_stock_logs`
2. Batch write ลด `stock_balances`
3. เพิ่ม `stock_movements` type:'cut' ต่อรายการ
4. เพิ่ม `audit_logs`
5. เช็ค qty < minQty → เพิ่ม `low_stock_alerts` + `push_queue`
6. beepSuccess()
7. clear cart + close popup

**Auto Alert Toast (ด้านบน topbar):**
```
🔔 แจ้ง stock ต่ำ: {itemNames} → LINE + Hub
```
หายใน 3 วินาที

### Usage Pattern Popup (📊 icon)

```
[เฉลี่ย 7 วัน | เฉลี่ย 30 วัน | แนะนำสั่งซื้อ]

ใช้เฉลี่ยต่อวัน — 7 วันที่ผ่านมา:
  🍓 แยมสตรอว์เบอร์รี  ████░░  4.8 ขีด  ▲
  🍯 ไซรัปบราวน์ชูก้า  ███░░░  620 มล.  →

แนะนำสั่งซื้อ (buffer 20%):
  🍓 แยมฯ  เฉลี่ย 4.8/วัน  →  34 ขีด/สัปดาห์
```

```js
suggestQty = Math.round(avgPerDay * 7 * 1.2)
```

---

## 12. Tab 4 — รายงาน

### Topbar
- Title: "รายงาน"
- Right: Export button → modal เลือก CSV / PDF

### 4 Report Sub-tabs (horizontal scroll ใน topbar)
```
📋 รายวัน | 📅 สัปดาห์+เดือน | 🗑️ ของเสีย | 📊 วิเคราะห์
```
**Default:** รายวัน

---

### Tab A — รายวัน

**Date selector:** วันนี้ · {date thai} + ปุ่ม "เลือกวัน"

**KPI 2×2:**
| ต้นทุนวัตถุดิบ (red card) | ครั้งตัดสต็อก |
|---|---|
| ของเสียวันนี้ | ใบโอน |

**ประวัติตัดสต็อก** (list)
- แต่ละแถว: emoji · ชื่อ · เวลา · คนตัด · จำนวน · 🗑️
- กด 🗑️ → popup ขอเหตุผล ≥5 ตัวอักษร → soft delete (`deletedAt`) + `audit_logs`

**🍋 ผลไม้เสียระหว่างวัน** (section แยก — แสดงก่อน)
- เฉพาะ ส้ม + มะนาว เท่านั้น
- source: `waste_logs` type: 'fruit_daily'

**🌙 ของเสียปิดร้าน** (section แยก — margin ห่างจากส่วนบนชัดเจน)
- ชั่งน้ำหนัก กรัม/มล.
- source: `waste_logs` type: 'closing'

**📦 ใบโอนสินค้า**
- #TF-XXXX · สถานะ badge รับแล้ว ✅ / รอรับ 🟡

**🔍 Audit Log**
- ใคร · ทำอะไร · กี่โมง

---

### Tab B — สัปดาห์+เดือน

**Date tabs:** สัปดาห์นี้ | สัปดาห์ก่อน | เดือนนี้ | 3 เดือน

**KPIs (สัปดาห์):** ต้นทุนรวม · รายรับรวม · ของเสียรวม · Food Cost %

**Stacked Bar Chart (ต้นทุน vs รายรับ รายวัน):**
- แต่ละวัน: แท่งซ้อน · ต้นทุน = แดง (ล่าง) · รายรับ = เขียว (บน)
- วันที่ waste > ค่าเฉลี่ย+30% → ⚠️ dot บนแท่ง
- รายรับดึงจาก `income_records` (Daily Income)

**เปรียบเทียบ ธรรมดา vs วันหยุด:**
```
ต้นทุนเฉลี่ย วันธรรมดา (จ-ศ)  ฿{x}/วัน
ต้นทุนเฉลี่ย วันหยุด (ส-อา)   ฿{y}/วัน   [+{z}%]
Food Cost % วันหยุด             {w}%
```

**Top 5 วัตถุดิบที่ใช้มาก** (progress bars)

**โหมด เดือน/3เดือน:**
- Line chart trend Food Cost %
- Gross Profit ขั้นต้น = รายรับ − ต้นทุนวัตถุดิบ
- สรุป: วันตัดมากสุด · วัตถุดิบแพงสุด · ใบโอนทั้งเดือน

---

### Tab C — ของเสีย

**Date tabs:** 7 วัน | 30 วัน | เดือนนี้

**🎯 Target Waste % Card (ตั้งค่าได้):**
```
เป้า Waste % ของต้นทุน
[{target}%]    [แก้ไข]
[progress: Actual {actual}% / เป้า {target}%]
```
- กด "แก้ไข" → modal preset 5% / 8% / 10% + custom
- บันทึกใน `app_settings.wasteTargetPct`
- progress สีเขียว/ส้ม/แดงตาม % ที่เทียบกับเป้า

**🍋 ผลไม้เสียระหว่างวัน (Block 1 — section แยก):**
```
มูลค่ารวม {n} วัน | เฉลี่ย ฿{x}/วัน    [฿{total}]
  ส้ม     {qty} ลูก  ฿{cost}
  มะนาว   {qty} ลูก  ฿{cost}
```

**🌙 ของเสียปิดร้าน (Block 2 — แยกห่างจาก Block 1 ชัดเจน):**
```
มูลค่ารวม {n} วัน | เฉลี่ย ฿{x}/วัน    [฿{total}]
  [progress bars แต่ละรายการ]
```

**Waste % of Revenue:**
```
ของเสีย ฿{x} ÷ รายรับ ฿{y} = {z}%
เทียบสัปดาห์ก่อน ▼ ดีขึ้น {d}% / ▲ แย่ลง {d}%
```
รายรับจาก `income_records` (Daily Income)

**Insight box (สีเหลือง):**
- วันที่ของเสียสูงสุด + คำแนะนำ

---

### Tab D — วิเคราะห์ (PIN Protected · Owner Only)

**PIN Keypad:** 4 หลัก · dot display · PIN = `app_settings.analyzePin`
- ผิด → dots flash แดง + reset
- ถูก → unlock เฉพาะ session นี้

**Food Cost Dashboard (Green gradient hero card):**
```
Actual Food Cost % · เดือนนี้
{actual}%
ต้นทุน ฿{x} ÷ รายรับ ฿{y}

[Theoretical {t}%]  [เป้า ≤30%]  [เดือนก่อน {p}%]

Variance +{v}% vs ทฤษฎี
ถ้า Variance > +5% → red warning banner
```

**Formulas:**
```
Actual Food Cost %     = Σ(qtyUse × pricePerUnitUse จาก Cost Manager) ÷ income_records × 100
Theoretical Food Cost% = จาก mixue_data.menus[].costPct (Cost Manager)
Variance               = Actual% − Theoretical%
Gross Profit           = รายรับ − ต้นทุนวัตถุดิบ
Gross Margin %         = Gross Profit ÷ รายรับ × 100
```

**Data Sources:**
```
ต้นทุนวัตถุดิบ → stock_movements (type:'cut') × ราคา/หน่วย จาก Cost Manager
รายรับ         → income_records collection (Daily Income) · รวมกะเช้า+บ่าย
Theoretical%   → mixue_data.menus[].costPct (Cost Manager)
```

**Gross Profit KPIs:**
```
Gross Profit ฿{n} (green card) | Gross Margin {m}%
เทียบเดือนก่อน ▲/▼
```

**⚠️ วันที่ Food Cost Spike (list):**
- วันที่ Actual% > 30% หรือ > Theoretical%+5%
- กดแต่ละวัน → drill-down ดูรายการวันนั้น

**Usage Pattern + Variance Alert + แนะนำสั่งซื้อ:**
```
[เฉลี่ย 7 วัน | เฉลี่ย 30 วัน | แนะนำสั่งซื้อ]

Variance Alert:
  🍓 แยมสตรอว์เบอร์รี  ใช้จริง 4.8/วัน vs ทฤษฎี 3.5/วัน  [+37% ⚠️]
  🍯 ไซรัปบราวน์ชูก้า  ใช้จริง 620/วัน vs ทฤษฎี 580/วัน  [+7% ดีค่ะ]
```

---

## 13. Tab 5 — ตั้งค่า

### Topbar
- Title: "ตั้งค่า"
- Right: `<ConnectionStatus />` (pill 3 states)
- Below: Last sync "อัปเดตล่าสุด {HH:MM} น." auto · **ไม่มี Manual Sync button**

### Profile Card (gradient red)
```
[avatar initials]
{name}
[role badge: 👑 Owner | 👤 Staff]
{phone}
[✏️ edit]
```

---

### กลุ่ม 1 — บัญชีผู้ใช้

| Row | Action |
|-----|--------|
| 🔐 เปลี่ยน PIN | modal: PIN เดิม + PIN ใหม่ + ยืนยัน · save `app_settings.analyzePin` |
| 👥 จัดการ Staff | badge "→ Hub" · tap → HUB URL · **ไม่มี staff management ในแอพนี้** |

---

### กลุ่ม 2 — คลัง + วัตถุดิบ

| Row | Action |
|-----|--------|
| 🏪 จัดการคลังสินค้า | modal: list + เพิ่ม (ชื่อ / ประเภท / สี 6 ตัวเลือก) / แก้ไข / ปิด |
| 📦 วัตถุดิบ (Master Data) | modal: search + list + เพิ่ม/แก้ไข ครบ fields |
| 🗑️ โหมดของเสีย | modal: toggle per item |
| ⚡ Quick Template | modal: list + สร้าง/แก้ไข/ลบ (Owner only) |

**เพิ่มวัตถุดิบ form:**
```
ชื่อ        [text]
หมวดหมู่    [dropdown]
Emoji       [text 1 char]
หน่วยหลัก  [text: "กก."]
หน่วยตัด   [text: "ขีด"]
Conversion  [text: "1 กก. = 10 ขีด"]
Min Stock   [number]
Max Stock   [number]
Waste Mode  [toggle]
[บันทึก]
```

**Quick Template form:**
```
ชื่อ   [text]
Icon   [select: ☀️🎉⚡🌙🏖️]
รายการ [checkbox list + qty input ต่อ item]
[บันทึก]
```

---

### กลุ่ม 3 — การแจ้งเตือน

| Row | Type | Default | Action |
|-----|------|---------|--------|
| 📉 Stock ต่ำกว่า min | Toggle | ON | push `push_queue` + Hub ทันทีหลังตัด |
| 📅 แจ้งเตือนก่อน EXP | Value | 7 วัน | modal preset 7/14/30 วัน · save `app_settings.expWarningDays` |
| 🗑️ ของเสียเกิน threshold | Toggle | OFF | แจ้งปลายวันถ้า Waste% > target |

**ไม่มี:** สรุปรายวัน (น้องมี่) — น้องมี่ดึงจาก Firestore เองอัตโนมัติ

---

### กลุ่ม 4 — ระบบ

| Row | Detail |
|-----|--------|
| 🔗 เชื่อมต่อระบบ | modal: 3 ระบบ ด้านล่าง |
| 📊 Opening Stock | modal: กรอกยอดเริ่มต้น → `stock_balances` + `stock_movements` type:'opening' |
| 📤 Export ข้อมูล | modal: CSV / PDF · date range · `cut_stock_logs` + `waste_logs` |
| 🔄 รีเฟรชข้อมูล | Force refresh · re-subscribe listeners · ใช้เมื่อเน็ตหลุดแล้วกลับมา |

**Integration Modal — 3 ระบบ:**
```
🧮 Cost Manager     ✓ เชื่อมต่อ  (shared Firebase · ราคา/หน่วยวัตถุดิบ)
💵 Daily Income     ✓ เชื่อมต่อ  (income_records · Food Cost % Actual)
🤖 น้องมี่ LINE Bot ✓ เชื่อมต่อ  (push_queue · reporter mode)

Firebase: mixue-cost-manager
Last sync: {datetime}
```

**Force Refresh:**
```js
async function forceRefresh() {
  setConnState('syncing');
  await resubscribeAll(); // re-call ทุก onSnapshot listener
  setConnState('online');
  setLastSync(new Date().toLocaleTimeString('th-TH', { hour:'2-digit', minute:'2-digit' }));
}
```

### Danger Zone (Owner only)
```
🗑️ Clear All Data  → ใส่ PIN → ลบ stock_balances + cut_stock_logs
🚪 ออกจากระบบ     → clear bizice_session → redirect HUB
```

---

## 14. Integration — Daily Income

```js
// dateKey format: "2569-05-14"
async function getDailyIncome(dateKey) {
  const doc = await db.collection('income_records').doc(dateKey).get();
  if (!doc.exists) return 0;
  const d = doc.data();
  return (d.morning?.total || 0) + (d.afternoon?.total || 0);
}

async function calcActualFoodCostPct(dateKey) {
  const costTotal = await getTotalCutCost(dateKey); // Σ qtyUse × price
  const revenue   = await getDailyIncome(dateKey);
  if (revenue === 0) return null;
  return (costTotal / revenue * 100).toFixed(1);
}
```

---

## 15. Integration — Cost Manager

```js
let priceCache = {};

async function getItemPrice(itemName) {
  if (priceCache[itemName]) return priceCache[itemName];
  const doc = await db.collection('mixue_data').doc('mixue-cost-manager').get();
  const library = doc.data()?.library || [];
  const item = library.find(i => i.name === itemName);
  const price = item?.unitPrice || item?.total || 0;
  priceCache[itemName] = price;
  return price;
}
```

---

## 16. FIFO Lot Utilities

```js
// src/utils/fifo.js
export function sortLotsFIFO(lots) {
  return [...lots].sort((a, b) => {
    // receiveDate "01/05/69" → parse → sort ascending
    const parse = (s) => {
      const [d, m, y] = s.split('/').map(Number);
      return new Date(2500 + y, m - 1, d);
    };
    return parse(a.receiveDate) - parse(b.receiveDate);
  });
}

export function getExpStatus(expDate) {
  const [d, m, y] = expDate.split('/').map(Number);
  const exp  = new Date(2500 + y, m - 1, d);
  const days = Math.round((exp - new Date()) / 86400000);
  if (days < 0)   return { status: 'expired', days, color: '#FF3B30' };
  if (days <= 30) return { status: 'warning', days, color: '#92600A' };
  return { status: 'ok', days, color: '#1A7F37' };
}
```

---

## 17. Roles & Permissions

| Feature | Owner | Staff | Warehouse |
|---------|-------|-------|-----------|
| ดู Dashboard ทุกสาขา | ✅ | ✅ สาขาตัวเอง | ✅ |
| รับสินค้า / โอน | ✅ | ❌ | ✅ |
| ตัดสต็อก | ✅ | ✅ | ❌ |
| บันทึกของเสีย | ✅ | ✅ | ❌ |
| ลบ log (ต้องมีเหตุผล) | ✅ | ❌ | ❌ |
| Tab วิเคราะห์ (PIN) | ✅ | ❌ | ❌ |
| ตั้งค่า | ✅ | ❌ | ❌ |
| Opening Stock | ✅ | ❌ | ✅ |

---

## 18. Test Accounts

| Role | Phone | Analyze PIN |
|------|-------|-------------|
| Owner (พี่จีโน่) | 0843904727 | 1234 |
| Staff | 0812345678 | — |

---

## 19. Project Structure

```
bizice-inventory/
├── index.html                    ← session guard (ก่อน React)
├── public/
│   └── manifest.json
├── src/
│   ├── main.jsx
│   ├── App.jsx                   ← router + bottom nav
│   ├── firebase.js               ← config + db export
│   ├── hooks/
│   │   ├── useSession.js
│   │   ├── useStock.js           ← onSnapshot stock_balances
│   │   └── useConnection.js      ← online/offline/syncing state
│   ├── components/
│   │   ├── ConnectionStatus.jsx  ← shared · ใช้ทุก mini-app
│   │   ├── BottomNav.jsx
│   │   ├── Modal.jsx             ← reusable bottom sheet
│   │   └── LotPopup.jsx          ← LOT bottom sheet
│   ├── pages/
│   │   ├── Dashboard.jsx
│   │   ├── Warehouse.jsx
│   │   ├── CutStock.jsx
│   │   ├── Report.jsx
│   │   └── Settings.jsx
│   └── utils/
│       ├── audio.js              ← beepClick, beepSuccess
│       ├── fifo.js               ← sortLotsFIFO, getExpStatus
│       └── formatDate.js
├── vite.config.js
└── package.json
```

---

## 20. Build & Deploy

```bash
npm install
npm run dev      # localhost:5173/bizice-inventory/
npm run build
npm run deploy   # gh-pages -d dist
```

**vite.config.js:**
```js
export default {
  base: '/bizice-inventory/',
  build: { outDir: 'dist' }
}
```

**package.json:**
```json
{
  "scripts": {
    "dev":    "vite",
    "build":  "vite build",
    "deploy": "npm run build && gh-pages -d dist"
  }
}
```

---

## 21. Done Criteria (Checklist)

### Core
- [ ] Session guard redirect ไป Hub ถ้าไม่มี session
- [ ] `<ConnectionStatus />` ทำงาน 3 states (Online/Offline/Syncing)
- [ ] Last sync auto-update · ไม่มี Manual Sync button
- [ ] 5 tabs + bottom nav ครบ
- [ ] onSnapshot real-time · ไม่มี Manual Sync · unsubscribe เมื่อออก

### Tab คลัง
- [ ] 2-column card grid สะอาด · ไม่มี expand dropdown
- [ ] ปุ่ม [LOT n] เปิด bottom sheet popup แยกออกมา
- [ ] LOT popup: FIFO sort + piece chips 3 สี + EXP colors
- [ ] กด ✕ ปิด popup

### Tab ตัดสต็อก
- [ ] POS grid 2-col + เสียงทุกครั้ง
- [ ] Favorite Items ⭐ per-device localStorage
- [ ] Quick Template จาก Firestore
- [ ] Cart bar ขึ้นเมื่อมีรายการ
- [ ] Cart popup: แบ่งหมวด + checkbox + log info
- [ ] Pre-cut Warning ⚠️ + checkbox แจ้งเติมในขั้นตอนเดียว
- [ ] Auto Alert toast หลังยืนยัน ถ้า stock ต่ำ
- [ ] Usage Pattern popup (📊)

### Tab รายงาน
- [ ] 4 sub-tabs ครบ
- [ ] ของเสีย 2 block แยก section ห่างกัน (ผลไม้ | ปิดร้าน)
- [ ] Stacked bar chart (ต้นทุน vs รายรับ) + ⚠️ dot วัน waste สูง
- [ ] Waste % of Revenue (ดึง income_records)
- [ ] Target Waste % ตั้งค่าได้
- [ ] Tab วิเคราะห์: PIN keypad + Food Cost Dashboard + Gross Profit
- [ ] Food Cost Spike list + drill-down
- [ ] ลบ log ต้องมีเหตุผล ≥5 ตัวอักษร + audit_logs

### Tab ตั้งค่า
- [ ] Staff row → "→ Hub" badge · ไม่มี staff modal
- [ ] ไม่มี "สรุปรายวัน (น้องมี่)" ในการแจ้งเตือน
- [ ] Integration: Cost Manager ✓ + Daily Income ✓ + น้องมี่ ✓
- [ ] Force Refresh ทำงาน + update last sync
- [ ] Opening Stock modal

### Deploy
- [ ] https://truescale-group.github.io/bizice-inventory/
- [ ] base: '/bizice-inventory/' ใน vite.config.js
- [ ] gh-pages branch
