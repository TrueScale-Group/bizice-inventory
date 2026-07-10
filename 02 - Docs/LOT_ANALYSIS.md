# 📦 LOT Tracking — Engineering Analysis

> BizICE Inventory (React 18 + Vite 5 + Firebase 10 / Firestore)
> Collection: `Inv_lots` (`COL.LOT_TRACKING`)
> Reviewer note: analysis only — no code changed.

---

## 1. Data Model

LOT docs ปัจจุบันมี **2 schema ปนกัน** ในคอลเลกชันเดียว:

### Schema A — "qty/quantity model" (PO receive, transfer, EXP alerts)
```
itemId, itemName, warehouseId
receiveDate (YYYY-MM-DD), expDate, pendingInfo
totalQty, inWarehouse, inShop, used        ← ยอดแยกตามที่อยู่
source, poRef, parentLotId, transferTfId, createdAt
```
สร้างโดย: `submitReceivePO` (Dashboard), transfer in/out (Dashboard)

### Schema B — "locationQty model" (Warehouse manual add / split)
```
itemId, itemName, warehouseId
lotNo, receiveDate, mfgDate, expDate
qty, locationQty: { [warehouseId]: qty }   ← map ต่อคลัง
status: 'active' | 'split', splitInto[], subLotSuffix, parentLotId
```
สร้างโดย: `saveAddLot`, `confirmSplit` (Warehouse)

> **ปัญหา:** สอง schema นี้แทน "ยอดคงเหลือของล็อต" คนละ field (`inWarehouse/inShop` vs `qty/locationQty`). Warehouse.jsx มี fallback อ่านได้ทั้งคู่ (`getLotQty`, `getLocationBreakdown`, `getUsed`) แต่โค้ดที่อื่น (EXP alert, transfer FIFO) อ่านเฉพาะ `inWarehouse/inShop` → ถ้าล็อตถูกสร้างแบบ B จะถูกมองข้าม/คำนวณผิด

---

## 2. Doc-ID strategy (ไม่สม่ำเสมอ)

| ที่สร้าง | doc id | deterministic? |
|---|---|---|
| `submitReceivePO` | `` `${itemId}_${YYYYMMDD}` `` | ✅ (merge รวมการรับวันเดียวกัน) |
| transfer (dest lot) | คำนวณ id เอง + `getDoc` ก่อน | ✅ |
| `saveAddLot` (manual) | `doc(collection(...))` auto-id | ❌ |
| `confirmSplit` (A/B) | auto-id | ❌ |

ผลข้างเคียง: ล็อต PO ใช้ id แบบ `itemId_วันที่` → ถ้ารับ item เดียวกันหลายใบ PO **ในวันเดียวกัน** จะ **merge ทับกันเป็นล็อตเดียว** (totalQty/inWarehouse ถูก `set` ใหม่ ไม่ใช่ `increment`) → **ยอดล็อตอาจถูกเขียนทับหาย** ดูข้อ 4.3

---

## 3. ใครเขียน/อ่าน LOT บ้าง (map)

| Operation | ไฟล์ | แตะ LOT? | ผลต่อ qty ล็อต |
|---|---|---|---|
| รับเข้า PO | Dashboard `submitReceivePO` | ✅ create | set inWarehouse |
| เติม exp ทีหลัง | Dashboard `saveLotInfo` | ✅ update | expDate, pendingInfo=false |
| ถอนการรับ PO | Dashboard `undoReceivePO` | ✅ delete (by poRef) | ลบล็อตทั้งใบ |
| โอนออก | Dashboard `submitTransfer` | ✅ FIFO −take | decrement inWarehouse |
| โอนเข้า | Dashboard `submitTransfer` | ✅ create/increment | +take ปลายทาง |
| ยกเลิกใบโอน | Report `cancelTransfer` | ✅ delete child + คืน parent | reverse |
| เพิ่ม/แก้/split/ลบ ล็อต | Warehouse LotPopup | ✅ | schema B |
| EXP alert | Dashboard (onSnapshot) | read | ใช้ `inWarehouse+inShop` |
| **ตัดสต็อก (cut)** | **utils/cutStock.js** | **❌ ไม่แตะเลย** | **— ล็อตไม่ลด** |
| **ปรับยอด (adjust)** | **utils/adjustStock.js** | **❌ ไม่แตะเลย** | **— ล็อตไม่เปลี่ยน** |
| **ของเสีย (waste)** | **Dashboard waste** | **❌ ไม่แตะเลย** | **— ล็อตไม่ลด** |

---

## 4. 🔴 ปัญหาหลัก (เรียงตามความรุนแรง)

### 4.1 [CRITICAL] cut/adjust/waste ลด `stock_balances` แต่ไม่ลด LOT
`cutStock.js` และ `adjustStock.js` แตะแค่ `STOCK_BALANCES` (`increment(-qty)`) **ไม่แตะ `LOT_TRACKING`**
→ `balances.qty` ลด แต่ `lot.inWarehouse` ยังเท่าเดิม → **2 แหล่งข้อมูลแยกจากกันถาวร**

**ผลกระทบจริง:**
- **EXP alert หลอน** — ล็อตที่ของจริงถูกตัดหมดแล้ว ยังโชว์ "ใกล้หมดอายุ X ชิ้น" เพราะ `inWarehouse` ไม่เคยลด
- **FIFO โอนผิด** — `submitTransfer` หยิบจากล็อตเก่าตาม `inWarehouse` ที่ยังค้าง(ของจริงไม่มีแล้ว) → โอน "บนกระดาษ" จากล็อตที่ควรหมดไปแล้ว
- **Σ lot ≠ balance** — ยอดรวมล็อตคลาดจาก balance เรื่อย ๆ ตามจำนวนครั้งที่ตัด/ปรับ

> นี่คือ root cause ที่ทำให้ LOT view กับ stock จริง "เพี้ยน" สะสม

### 4.2 [HIGH] ไม่มี atomicity ระหว่าง balance กับ lot
แต่ละ flow เขียนคนละ batch / คนละเวลา ถ้า crash กลางคัน (เช่น โอน: ลด lot ต้นทางสำเร็จ แต่ commit balance ล้ม) จะ diverge ทันที — ไม่มี transaction ครอบ และไม่มี reconciler มาตรวจสอบย้อนหลัง

### 4.3 [HIGH] PO รับซ้ำวันเดียวกัน → ล็อตถูกเขียนทับ
`lotId = itemId_YYYYMMDD` + `batch.set({ totalQty: qtyUse, inWarehouse: qtyUse }, {merge:true})`
ถ้ารับ item เดียวกัน 2 ครั้งในวันเดียว (เช่น PO คนละใบ หรือ partial 2 รอบ) ครั้งหลัง **เซ็ตทับ** ไม่ใช่บวกเพิ่ม → ยอดล็อตของครั้งแรกหาย (แต่ balance ใช้ `increment` ถูก → ยิ่ง diverge)

### 4.4 [MEDIUM] สอง schema (A vs B) ปนกัน
EXP alert + transfer FIFO อ่านเฉพาะ `inWarehouse/inShop` → ล็อตที่สร้างจาก Warehouse manual (schema B = `qty/locationQty`) **ไม่เข้าระบบ FIFO/EXP** เลย จะถูกมองข้าม

### 4.5 [MEDIUM] `used` เป็นค่าคำนวณ ไม่ใช่ค่าจริง
Warehouse `getUsed() = total − Σ active locations` — สมมติว่า "หายไป = ถูกใช้" แต่เพราะ cut ไม่ลด lot ค่านี้จึงมักเป็น 0 ทั้งที่ของถูกตัดไปแล้ว → รายงาน "ใช้ไปเท่าไร" ต่อล็อตไม่น่าเชื่อถือ

### 4.6 [LOW] expDate ว่างได้ (pendingInfo) ไม่มี validation
ล็อต PO สร้างด้วย `expDate:''` ตั้ง `pendingInfo:true` รอเติมทีหลัง ถ้าไม่มีใครเติม → FIFO ยังจัดลำดับได้ (ใช้ receiveDate) แต่ EXP alert มองข้ามถาวร (`if(!lot.expDate) return false`)

---

## 5. สิ่งที่ทำถูกแล้ว ✅
- **FIFO sort** (`sortLotsFIFO`) robust — เรียง `receiveDate` เก่า→ใหม่ จัดการ date ว่างถูกต้อง (ดันไปท้าย)
- **Transfer** sync ล็อต 2 ฝั่งถูกต้อง (decrement ต้นทาง + create/increment ปลายทาง + `parentLotId`/`transferTfId` ครบ)
- **cancelTransfer / undoReceivePO** reverse ล็อตได้ตรง (ลบ child, คืน parent, ลบ by poRef)
- **Lineage** — `parentLotId` ทำให้ trace ต้นทางล็อตได้

---

## 6. ข้อเสนอแนะ (ตามลำดับความคุ้มค่า)

**P0 — ปิด divergence ที่ source**
1. ให้ `cutStock` / waste-deduct **หัก LOT แบบ FIFO** เหมือน transfer (reuse logic เดียวกัน) — ตัด balance พร้อมตัด `inWarehouse` ในล็อตเก่าสุดก่อน ใน batch เดียว
2. `adjustStock` (ปรับยอด): เพิ่ม → สร้าง/บวกล็อต adjust, ลด → หัก FIFO เช่นกัน

**P1 — กันเขียนทับ + รวม schema**
3. PO lotId เติม suffix กัน collision (เช่น `${itemId}_${YYYYMMDD}_${poRef}`) หรือเปลี่ยนเป็น `increment` แทน `set` ทับ
4. รวมเหลือ schema เดียว (แนะนำ `qty + locationQty`) + เขียน migration ครั้งเดียว map `inWarehouse/inShop` → `locationQty`

**P2 — ความถูกต้องระยะยาว**
5. เพิ่ม **reconciler** (script/Cloud Function) เทียบ `Σ lot.qty(per wh) == balance.qty` รายวัน → แจ้งเตือนถ้า drift
6. ครอบ flow ที่แตะทั้ง balance+lot ด้วย `runTransaction` เพื่อ atomicity
7. ทำให้ `expDate`/`pendingInfo` มี reminder ปิดงาน (มี FlowCard "รอเพิ่มข้อมูล LOT" อยู่แล้ว — ดีแล้ว)

---

## 7. สรุปสั้นสำหรับวิศวกร
> ระบบ LOT **ออกแบบดีในฝั่ง transfer** (FIFO + lineage + reverse ครบ) แต่ **ไม่ถูก wire เข้ากับ cut/adjust/waste** ทำให้ `Inv_lots` กับ `Inv_stock_balances` กลายเป็น 2 source of truth ที่ค่อย ๆ เพี้ยนออกจากกัน. งานสำคัญสุดคือ **P0: ให้ทุก operation ที่ลด stock ลด LOT แบบ FIFO ใน batch เดียว** แล้วค่อยตามด้วยการรวม schema + reconciler.
