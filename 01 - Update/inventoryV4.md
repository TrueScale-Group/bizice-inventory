# Inventory V4 — LOT Consistency Overhaul

> เป้าหมาย: ปิดต้นเหตุที่ `Inv_lots` กับ `Inv_stock_balances` เพี้ยนออกจากกัน
> อ้างอิง: `LOT_ANALYSIS.md` (root cause = cut/waste/adjust ลด balance แต่ไม่ลด LOT)
> หลักการ: **ทุก operation ที่กระทบ stock ต้องกระทบ LOT แบบ FIFO ใน batch เดียวกัน (atomic)**
> Deploy: `truescale-group/bizice-inventory` · bump version ทุก commit

---

## 0. สรุปขอบเขต (3 เฟส)

| เฟส | งาน | ความเสี่ยง | คุ้มค่า |
|---|---|---|---|
| **P0** | wire cut / waste / adjust → หัก-เพิ่ม LOT แบบ FIFO | กลาง (แตะ stock จริง) | สูงสุด — ปิด divergence |
| **P1** | กัน lotId ชนกัน (PO ซ้ำวัน) + รวมเหลือ schema เดียว | กลาง (ต้อง migrate) | กลาง |
| **P2** | reconciler ตรวจ drift รายวัน + atomicity transaction | ต่ำ | ระยะยาว |

> แนะนำทำ **P0 ก่อน deploy แยก** แล้วค่อย P1/P2 — เพราะ P0 หยุดเลือดได้ทันที

---

## 1. รากปัญหา (ย้ำสั้น)

- `utils/cutStock.js` → `increment(-qtyUse)` ที่ `STOCK_BALANCES` เท่านั้น **ไม่แตะ `LOT_TRACKING`**
- `utils/adjustStock.js` → เหมือนกัน
- Dashboard waste-deduct → เหมือนกัน
- ผล: `lot.inWarehouse` ไม่เคยลด → EXP alert หลอน + FIFO โอนจากล็อตที่ของจริงหมด + `Σlot ≠ balance`
- ที่ทำถูกแล้ว = `submitTransfer` (Dashboard `1488–1557`) มี FIFO consume + dest upsert ครบ → **ใช้เป็นต้นแบบ**

---

## 2. P0 — ทำให้ทุกการลด stock หัก LOT แบบ FIFO

### 2.1 สร้าง util กลาง `src/utils/lotFifo.js` (ใหม่)

แยก logic การหัก/เพิ่ม LOT ออกจาก page ให้ reuse ได้ทุกที่ (transfer ก็ย้ายมาใช้ได้ภายหลัง)

```
// pseudo-API — ทุกฟังก์ชันรับ batch มาเขียนต่อ (ไม่ commit เอง) เพื่อ atomic ร่วมกับ balance

planFifoConsume(lots, { itemId, warehouseId, qtyUse })
  → คืน { allocations: [{lotId, take, lot}], shortage }
     (เรียง sortLotsFIFO, ข้าม status==='split', อ่าน inWarehouse||0; รองรับ qty/locationQty ด้วย getLotAvail())

applyFifoConsume(batch, allocations, { reasonType, note, ... })
  → batch.update แต่ละ lot: inWarehouse -= take (+ ถ้าใช้ locationQty ก็ลด map)
  → ไม่แตะ balance (ให้ caller ทำ)

addLot(batch, { itemId, itemName, warehouseId, qtyUse, receiveDate, expDate, source, ... })
  → upsert ล็อตใหม่ (สำหรับ adjust +)

getLotAvail(lot, warehouseId)  // helper อ่านยอดคงเหลือ รองรับทั้ง 2 schema
```

**กฎ shortage:** ถ้า LOT รวมไม่พอกับ qty ที่ตัด (เพราะข้อมูลเก่าเพี้ยน) → หักเท่าที่มี + `console.warn` + เขียน movement `lot_shortage` ไว้ debug **แต่ไม่ block** การตัด (balance ยังตัดได้ตามจริง) เพื่อไม่ให้หน้างานสะดุด

### 2.2 แก้ `utils/cutStock.js`

ใน loop `for (const cut of cuts)` (`40–85`) เพิ่มหลัง update balance:

```
const alloc = planFifoConsume(lotsSnapshot, { itemId, warehouseId, qtyUse })
applyFifoConsume(batch, alloc.allocations, { reasonType: 'cut', note })
if (alloc.shortage > 0) batch.set(movement 'lot_shortage' ...)
```

- ต้องส่ง **lots ปัจจุบัน** เข้ามา → เพิ่ม param `lots` ใน `cutStock({...})`
- **caller** `CutStock.jsx` ต้องส่ง `lots` (มี onSnapshot อยู่แล้ว — ส่งต่อ)
- ⚠️ FIFO อ่านจาก snapshot ใน memory → ถ้าตัดหลายรายการในใบเดียวกัน item ซ้ำ ต้องหักยอด allocation สะสมใน loop (กันหักล็อตเดิมเกิน) → ให้ `planFifoConsume` รับ `pendingTakes` map หรือ clone lots แล้วลด avail ระหว่าง loop

### 2.3 แก้ `utils/adjustStock.js`

```
if (direction === 'add') {
  addLot(batch, { ...,, qtyUse: qty, receiveDate: today, source: 'ปรับยอด(+)', pendingInfo: true })
} else {  // 'remove'
  const alloc = planFifoConsume(lots, { itemId, warehouseId, qtyUse: qty })
  applyFifoConsume(batch, alloc.allocations, { reasonType: 'adjust', note: reason })
}
```
- เพิ่ม param `lots` เช่นกัน · caller `AdjustStockModal.jsx` ส่ง lots เข้า

### 2.4 แก้ waste-deduct (Dashboard) — section `~443–469`

flow `fruit_daily` / closing ที่ `needDeductStock`:
```
const alloc = planFifoConsume(lots, { itemId, warehouseId: targetWh, qtyUse: qtyInUse })
applyFifoConsume(batch, alloc.allocations, { reasonType: 'waste', note })
```
อยู่ใน batch เดียวกับ balance อยู่แล้ว → atomic ได้

### 2.5 (แนะนำ) refactor `submitTransfer` ให้เรียก util กลาง
ไม่บังคับใน P0 แต่ทำเลยจะลดโค้ดซ้ำ — ย้าย block `1488–1557` มาใช้ `planFifoConsume`/`addLot`

### ✅ Done criteria P0
- ตัด 1 กระป๋อง → ทั้ง `balance.qty` และ `lot.inWarehouse` (ล็อตเก่าสุด) ลด 1 พร้อมกัน
- ปรับยอด − → หัก FIFO · ปรับยอด + → เกิดล็อตใหม่
- EXP alert ไม่โชว์ล็อตที่ของหมดแล้ว
- `Σ lot.inWarehouse(per wh) == balance.qty` ทุก item (ของใหม่ที่เกิดหลัง deploy)

---

## 3. P1 — กัน lotId ชน + รวม schema

### 3.1 กัน PO รับซ้ำวันเดียวกันเขียนทับ (`submitReceivePO` ~846)
ปัญหา: `lotId=`${itemId}_${YYYYMMDD}`` + `set({inWarehouse: qtyUse}, merge)` → ครั้งหลังทับครั้งแรก
แก้ทางใดทางหนึ่ง:
- **(ก)** เติม suffix กันชน: `` `${itemId}_${YYYYMMDD}_${poRef.replace(/\W/g,'')}` ``
- **(ข)** เปลี่ยนเป็นอ่าน `getDoc` ก่อนแล้ว `increment` (เหมือน dest lot ใน transfer)
> แนะนำ (ก) — ง่าย+trace กลับ PO ได้

### 3.2 รวมเหลือ schema เดียว
เลือกมาตรฐาน: **`qty` + `locationQty: {whId: n}`** (schema B — ยืดหยุ่นข้ามคลัง)
- เขียน `scripts/migrateLotSchema.mjs` (read-only ก่อน → `--commit`):
  `inWarehouse/inShop` → `locationQty: { [warehouseId]: inWarehouse, __shop__: inShop }`, set `qty = inWarehouse+inShop`
- อัปเดตจุดอ่าน LOT ทั้งหมด (EXP alert Dashboard `~621`, transfer FIFO) ให้ใช้ `getLotAvail()` แทนอ่าน `inWarehouse` ตรง ๆ
- ⚠️ ต้องทำ **หลัง** P0 และทดสอบหนัก — แตะหลายจุด

---

## 4. P2 — ความถูกต้องระยะยาว

### 4.1 Reconciler (script + ตัวเลือกทำเป็น scheduled)
`scripts/reconcileLotVsBalance.mjs` (read-only):
- รวม `Σ lot.qty(per warehouse,item)` เทียบกับ `balance.qty`
- รายงาน item ที่ drift เกิน threshold → ไฟล์ CSV / log
- (ภายหลัง) แปลงเป็น Cloud Function รายวัน ส่งเข้า `hub_notifications` ถ้าเจอ drift

### 4.2 Atomicity
- flow ที่แตะทั้ง balance + lot ครอบด้วย `runTransaction` (ตอนนี้ใช้ `writeBatch` ซึ่ง atomic แต่ไม่ re-read) — transaction สำคัญเฉพาะจุดที่ต้องอ่านยอดล่าสุดก่อนเขียน (เช่น FIFO ที่ race ได้)
- ขั้นต่ำ: ให้แน่ใจว่า balance + lot อยู่ **batch เดียว** ทุกที่ (P0 ทำให้แล้ว)

---

## 5. ไฟล์ที่ต้องแตะ (เช็คลิสต์)

| ไฟล์ | เฟส | งาน |
|---|---|---|
| `src/utils/lotFifo.js` *(ใหม่)* | P0 | planFifoConsume / applyFifoConsume / addLot / getLotAvail |
| `src/utils/cutStock.js` | P0 | + param `lots`, หัก FIFO ใน batch |
| `src/utils/adjustStock.js` | P0 | + param `lots`, add/remove ล็อต |
| `src/pages/CutStock.jsx` | P0 | ส่ง `lots` เข้า cutStock |
| `src/components/AdjustStockModal.jsx` | P0 | ส่ง `lots` เข้า adjustStock |
| `src/pages/Dashboard.jsx` | P0 | waste-deduct หัก FIFO · (opt) refactor transfer |
| `src/pages/Dashboard.jsx` | P1 | lotId suffix กันชน (`submitReceivePO`) |
| จุดอ่าน LOT ทั้งหมด | P1 | ใช้ `getLotAvail()` |
| `scripts/migrateLotSchema.mjs` *(ใหม่)* | P1 | migrate schema A→B |
| `scripts/reconcileLotVsBalance.mjs` *(ใหม่)* | P2 | ตรวจ drift |

---

## 6. แผนทดสอบ (manual หลัง deploy P0)

- [ ] ตัด 1 กระป๋อง item ที่มี 2 ล็อต (เก่า/ใหม่) → ล็อตเก่าลดก่อน, balance ลดเท่ากัน
- [ ] ตัดจนล็อตเก่าหมด → ลามไปล็อตถัดไป (FIFO ต่อเนื่อง)
- [ ] ตัด item เดียวกัน 2 บรรทัดในใบเดียว → ไม่หักล็อตเดิมซ้ำเกิน
- [ ] ปรับยอด +5 → เกิดล็อตใหม่ (source 'ปรับยอด')
- [ ] ปรับยอด −3 → หัก FIFO, balance ตรง
- [ ] ของเสีย fruit_daily หักสต็อก → ล็อตลดด้วย
- [ ] EXP alert: ล็อตที่ตัดหมดแล้ว **หายจาก** การเตือน
- [ ] เทียบ `Σlot == balance` ด้วย reconciler → drift = 0 สำหรับธุรกรรมหลัง deploy
- [ ] โอน + ยกเลิกใบโอน ยังทำงานปกติ (ไม่ regress)

---

## 7. ความเสี่ยง & ข้อควรระวัง

- **ข้อมูลเก่าก่อน P0 ยัง drift อยู่** — P0 หยุด drift ใหม่ แต่ของเดิมต้อง reconcile/ปรับยอดครั้งเดียวหลัง migrate
- **FIFO ขาด LOT** (ข้อมูลเก่าเพี้ยน): ห้าม block การตัด — หักเท่าที่มี + log ไว้ ไม่ให้หน้างานพัง
- **กฎเดิมเรื่อง stock จริง:** การ migrate/แก้ย้อนหลังให้รัน script **read-only ก่อน** แล้วขอยืนยันก่อน `--commit` เสมอ
- bump `package.json` + `Settings.jsx` v-tag ทุก deploy

---

## 8. ลำดับลงมือแนะนำ
1. `lotFifo.js` + unit ทดสอบ logic (snapshot ลด avail สะสม)
2. wire `cutStock` + `CutStock.jsx` → deploy → ทดสอบหนักสุด (ใช้บ่อยสุด)
3. wire `adjustStock` + waste → deploy
4. P1 lotId suffix → deploy
5. migrate schema (read-only → commit) + อัปเดตจุดอ่าน → deploy
6. reconciler → ตั้ง schedule

---

## 9. LOT — UX & Behavior Requirements (จากหน้างานจริง)

> เพิ่มเติมจากเจ้าของร้าน — เน้นประสบการณ์ใช้งานจริง: พนักงานสาขาไม่ต้องรู้เรื่อง LOT,
> คลังกลางต้อง monitor วันหมดอายุของกองสินค้าได้, การเลือก LOT เกิดตอน "โอน" ไม่ใช่ตอน "ตัด"

### 9.1 ล็อตที่ค้างข้อมูล (pendingInfo) — กรอกได้ทั้ง วันที่รับ + วันหมดอายุ
- ตอนนี้ popup "เพิ่มข้อมูล LOT" ให้กรอกแค่ `expDate`
- **ต้องการ:** ให้กรอก **วันที่รับ (receiveDate)** ได้ด้วยในแถวเดียวกัน
  - default `receiveDate` = วันที่กดรับ (ที่เลือกในตรวจรับ) แต่แก้ได้
  - บันทึก → set `receiveDate` + `expDate` + `pendingInfo:false`
- กระทบ: `saveLotInfo` (Dashboard) + UI popup lotInfo

### 9.2 หน้าคลัง: LOT list ต้อง scope ตามคลังที่กำลังดู
ปัจจุบัน LotPopup โชว์ LOT ทุกคลังปนกัน (เห็น "คลังกลาง" + "Mixue-509" ในใบเดียว)
- **ต้องการ:** filter ตาม tab คลังหลักที่เลือก (สาขา / คลังกลาง)
  - อยู่หน้า **สาขา** → แสดงเฉพาะ LOT ที่มียอดอยู่ในสาขานั้น
  - อยู่หน้า **คลังกลาง** → แสดงเฉพาะ LOT คลังกลาง ไม่ปน LOT สาขา
- **LOT ลูกที่สาขา:** ระบุชัดว่า "เป็น LOT ลูกจาก LOT แม่ไหนของคลังกลาง + มีกี่ชิ้น (หน่วยตัดใช้)"
  - เช่น `🔗 มาจาก LOT แม่ #20260609 · 2 ถุง · ใบโอน TF-06.26-72`
- กระทบ: `LotPopup` (Warehouse) — เพิ่ม filter ตาม `lockedWh`/active warehouse + render สาย parent

### 9.3 คลังกลาง: LOT แม่ที่ถูกตัดออกไปสาขา → เปลี่ยน "สี" แทนการซ่อน
แทนที่จะหายไป ให้แสดงสถานะของยอดในล็อตแม่ด้วยสี (ดูแล้วรู้ทันที):
| สถานะส่วนของล็อต | สี | ความหมาย |
|---|---|---|
| ยังอยู่คลังกลาง (ยังไม่แตะ) | 🟢 เขียว | พร้อมใช้/โอน |
| ถูกโอนออกไปสาขาแล้ว | 🟠 ส้ม | ย้ายไปสาขา (ของไม่ได้อยู่คลังกลางแล้ว) |
| ใช้/ตัดไปแล้ว | ⚪ เทา | consumed |
- คลังกลางจึงเห็นภาพล็อตเดียว: เขียว = เหลือจริง, ส้ม = กระจายไปสาขา, เทา = หมด
- กระทบ: `LotPopup` stock-dot rendering — map ยอดต่อสถานะเป็นสี (ใช้ `locationQty` + `used`)

### 9.4 จุดที่ "เลือก LOT" — ตอนโอน ไม่ใช่ตอนตัด
- **ตัดสต็อก (cut):** ระบบเลือก LOT ให้อัตโนมัติแบบ FIFO หลังบ้าน — **พนักงานสาขาไม่ต้องรู้/ไม่ต้องเลือก** (สาขาเก็บน้อย ใช้แล้วหมดไป)
  - = ตรงกับ P0 (cut หัก FIFO อัตโนมัติ) → ไม่มี UI เลือกล็อตในหน้าตัด
- **โอนสินค้า (transfer):** ✅ **ให้มี UI เลือกว่าจะเอา LOT ของวันไหน** + รายละเอียดสั้น ๆ (EXP/วันรับ)
  - เหตุผล: ของจริงมีสติกเกอร์ติดที่วัตถุดิบ → คนโอนหยิบใบไหนก็เลือกใบนั้น
  - ประโยชน์: คลังกลาง **monitor** ได้ว่ากองสินค้าแต่ละล็อตจะหมดอายุวันไหน + ตัดสินใจระบายล็อตใกล้หมดก่อน
  - default = FIFO (แนะนำล็อตเก่าสุด) แต่ override เลือกเองได้
  - กระทบ: `submitTransfer` modal (Dashboard) — เพิ่ม dropdown/chip เลือก LOT ต่อ item พร้อมโชว์ `EXP · เหลือ N วัน · รับ DD-MM`

### 9.5 สรุปไฟล์ที่กระทบเพิ่ม (จาก §9)
| ไฟล์ | ข้อ | งาน |
|---|---|---|
| `Dashboard.jsx` `saveLotInfo` + lotInfo popup | 9.1 | เพิ่มช่อง receiveDate |
| `Warehouse.jsx` `LotPopup` | 9.2 / 9.3 | filter ตามคลัง + สาย parent + สีตามสถานะ |
| `Dashboard.jsx` `submitTransfer` modal | 9.4 | UI เลือก LOT ตอนโอน (default FIFO) |
| `CutStock.jsx` | 9.4 | ไม่มี UI เลือกล็อต — auto FIFO หลังบ้าน (= P0) |

> หมายเหตุ: §9.4 ผูกกับ P0 โดยตรง — ตอน wire FIFO เข้า cut ให้คงเป็น "auto เงียบ ๆ",
> ส่วน transfer ให้ "เลือกได้" (ขยายจาก FIFO ปัจจุบันที่ auto อยู่แล้วให้ override ได้)
