# inventoryV5.md
# 📦 โจทย์ปรับปรุง Mini App — Inventory System (BizICE APP)
> **Project:** BizICE APP | Firebase Project: `mixue-cost-manager`
> **วันที่ออกโจทย์:** 30 มิถุนายน 2026
> **ระดับความสำคัญ:** 🔴 High Priority
> **ผู้ออกโจทย์:** Database Analyst Team

---

## 🎯 บริบทและที่มา

จากการวิเคราะห์ Firestore Query Insights (24 ชั่วโมงที่ผ่านมา) พบว่าระบบ Inventory มีปัญหา **Read Operations สูงผิดปกติ** โดยมีอัตราส่วน Read : Write อยู่ที่ **256:1** (Read 242,000 ครั้ง / Write 943 ครั้ง) ซึ่งส่งผลโดยตรงต่อค่าใช้จ่ายของ Firebase Blaze Plan

Collections ที่พบปัญหาหลัก:

| Collection | Executions | Read ops | ปัญหา |
|---|---|---|---|
| `Inv_audit_logs` | 1 | 200 | Full Collection Scan ไม่มี limit/filter |
| `Inv_stock_balances` | 1 | 150 | ดึงทุก Document ทีเดียว |
| `Inv_items` (x2 queries) | 3 | 222 | Paginate ไม่มีประสิทธิภาพ |
| `push_tokens` | 5 | 118 | ดึงซ้ำทุกครั้งที่ส่ง Notification |
| `Inv_stock_movements` | 1 | 32 | ไม่มี Date Range filter |
| `Inv_warehouses` | 5 | 20 | ดึงซ้ำไม่จำเป็น |

---

## 🗂️ โครงสร้างฐานข้อมูลปัจจุบัน (Firestore Collections)

```
Inv_alerts          — แจ้งเตือนสต็อกต่ำ
Inv_audit_logs      — บันทึก log การตรวจสอบ
Inv_cut_logs        — บันทึกการตัดสต็อก
Inv_items           — รายการสินค้า
Inv_lots            — การจัดการ Lot สินค้า
Inv_purchase_orders — ใบสั่งซื้อ
Inv_push_queue      — คิว Push notification
Inv_refill_requests — คำขอเติมสินค้า
Inv_settings        — การตั้งค่าระบบ
Inv_stock_balances  — ยอดคงเหลือสต็อก ⚠️ Read สูง
Inv_stock_movements — การเคลื่อนไหวสต็อก
Inv_transfers       — การโอนย้ายสินค้า
Inv_warehouses      — ข้อมูลคลังสินค้า
Inv_waste_logs      — บันทึกของเสีย
```

ตัวอย่าง Document structure ของ `Inv_alerts`:
```json
{
  "itemId": "WoPvjmVFZKTyMNwhleqH",
  "itemName": "กีซุ่พนักงาน",
  "currentQty": 10,
  "minQty": 20,
  "status": "low",
  "unit": "แพ็ค",
  "warehouseId": "N9DVUuD7HhgPJdQ38TNr",
  "sentAt": "June 30, 2026 at 11:18:51 AM UTC+7",
  "read": false
}
```

---

## 📋 โจทย์หลัก — สิ่งที่ต้องปรับปรุง

### โจทย์ที่ 1 — ลด Read บน `Inv_stock_balances` 🔴

**ปัญหา:** ปัจจุบัน Query ดึง Stock Balance ของสินค้าทุกชิ้นพร้อมกันทีเดียว (150 Documents / 1 Query) ทุกครั้งที่เปิดหน้า Dashboard

**สิ่งที่ต้องทำ:**
- [ ] เพิ่ม Summary Document ชื่อ `Inv_stock_balances/_summary` ที่เก็บยอดรวมแบบ Pre-aggregated
- [ ] แก้ไข Query ให้ดึงเฉพาะ `warehouseId` ที่ User กำลังดูอยู่ (ไม่ดึง Cross-warehouse)
- [ ] ใช้ `.where('warehouseId', '==', currentWarehouse)` แทนการดึงทั้ง Collection

**Acceptance Criteria:**
- Read ops ต่อ 1 Execution ลดลงเหลือไม่เกิน **30 Documents**
- หน้า Dashboard แสดงยอดรวมได้โดยไม่ต้อง Query ทุก Document

---

### โจทย์ที่ 2 — แก้ `Inv_audit_logs` Full Scan 🔴

**ปัญหา:** Query ดึง Audit Log 200 Documents ใน 1 Execution โดยไม่มี Date Filter หรือ Limit ทำให้ยิ่งมีข้อมูลมาก ยิ่งช้าและแพงขึ้นเรื่อยๆ

**สิ่งที่ต้องทำ:**
- [ ] เพิ่ม `.where('createdAt', '>=', startOfDay)` เพื่อกรองเฉพาะวันที่ต้องการ
- [ ] เพิ่ม `.limit(50)` บังคับทุก Query ที่ดึง audit_logs
- [ ] เพิ่ม Pagination ที่ใช้ `startAfter(lastDoc)` แทนการโหลดทีเดียว
- [ ] สร้าง Composite Index: `warehouseId ASC` + `createdAt DESC`

**Acceptance Criteria:**
- Read ops ต่อ 1 Execution ไม่เกิน **50 Documents**
- มี Pagination control ที่ใช้งานได้ (Next / Previous)
- Query ต้องมี Date Range Filter บังคับ (default: วันนี้)

---

### โจทย์ที่ 3 — ปรับปรุง `Inv_items` Pagination 🟠

**ปัญหา:** มี 2 Query Pattern สำหรับ `Inv_items` ที่ทับซ้อนกัน รวม Read 222 ops จาก 3 Executions

**สิ่งที่ต้องทำ:**
- [ ] รวม Query ให้เหลือ Pattern เดียว
- [ ] ใช้ `startAfter()` Cursor-based Pagination แทน Offset
- [ ] กำหนด Page Size = 20 items ต่อหน้าอย่างเคร่งครัด
- [ ] เพิ่ม Search/Filter ฝั่ง Client สำหรับชื่อสินค้า แทนการดึงทั้งหมดมา Filter เอง

**Acceptance Criteria:**
- แต่ละ Page Load ดึงไม่เกิน **20 Documents**
- มีปุ่ม Load More หรือ Infinite Scroll ที่ใช้ `startAfter()`
- ไม่มี Query 2 แบบที่ทับซ้อนกัน (เลือก 1 Pattern เท่านั้น)

---

### โจทย์ที่ 4 — แก้ `push_tokens` Repeated Query 🟠

**ปัญหา:** ระบบ Push Notification ดึง Token ทั้งหมดทุกครั้งที่ส่งแจ้งเตือน (5 ครั้ง/วัน = 118 Reads)

**สิ่งที่ต้องทำ:**
- [ ] Cache Token List ไว้ใน Cloud Function Memory (ใช้ Module-level Variable)
- [ ] กำหนด Cache TTL = 30 นาที (Refresh เมื่อ Token เปลี่ยน)
- [ ] หรือ ย้ายไปใช้ **FCM Topics** แทน Manual Token Management
- [ ] เพิ่ม `.where('isActive', '==', true)` กรองเฉพาะ Token ที่ยังใช้งานได้

**Acceptance Criteria:**
- Read ต่อ Push Notification Session ลดลง > **60%**
- ไม่ Query `push_tokens` ซ้ำภายใน 30 นาที หากข้อมูลไม่เปลี่ยน

---

### โจทย์ที่ 5 — ลด Snapshot Listeners ที่ไม่จำเป็น 🟡

**ปัญหา:** มี Snapshot Listeners peak ถึง **165 Listeners** และ Active Connections **16** พร้อมกัน ซึ่งสูงเกินความจำเป็นสำหรับระบบ Inventory

**สิ่งที่ต้องทำ:**
- [ ] ตรวจสอบและปิด Listener ทุกตัวเมื่อ Component Unmount (`onSnapshot` → ต้อง call `unsubscribe()`)
- [ ] เปลี่ยน Real-time Listener เป็น `getDocs()` (One-time Fetch) สำหรับข้อมูลที่ไม่ต้องอัปเดต Real-time เช่น `Inv_items`, `Inv_warehouses`
- [ ] คงไว้ซึ่ง Snapshot Listener เฉพาะ `Inv_alerts` และ `Inv_stock_balances` (ที่ต้องการ Real-time จริงๆ)

**Acceptance Criteria:**
- Active Snapshot Listeners ลดลงเหลือไม่เกิน **50 Listeners** peak
- ทุก Listener ต้องมีการ Cleanup เมื่อออกจากหน้า (ตรวจสอบด้วย Chrome DevTools)

---

## 🏗️ สิ่งที่ต้องส่งมอบ (Deliverables)

1. **Source Code** — แก้ไข Query/Listener ตามโจทย์ทั้ง 5 ข้อ
2. **Firestore Index Config** — ไฟล์ `firestore.indexes.json` ที่อัปเดตแล้ว
3. **ผล Query Insights** — Screenshot หลังแก้ไข เปรียบเทียบ Before/After
4. **เอกสารอธิบาย** — สรุปว่าแก้อะไร อย่างไร และ Read ลดลงเท่าไร

---

## 📏 เป้าหมาย KPI

| Metric | ก่อนแก้ไข | เป้าหมาย |
|---|---|---|
| Read ops / 24hr | 242,000 | < 80,000 |
| Read:Write Ratio | 256:1 | < 80:1 |
| Snapshot Listeners Peak | 165 | < 50 |
| Max Reads / Single Query | 200 docs | < 50 docs |
| Avg Latency (Inv_stock_balances) | 56ms | < 20ms |

---

## 🔧 Tech Stack ที่ใช้

- **Database:** Cloud Firestore (asia-southeast3)
- **Backend:** Cloud Functions — Node.js 20 (v2)
- **Auth:** Firebase Authentication — Google Sign-In
- **Plan:** Firebase Blaze (Pay-as-you-go)

---

## 📝 หมายเหตุสำหรับนักพัฒนา

> ⚠️ ห้ามแก้ไข Security Rules โดยไม่ได้รับอนุมัติ
> ⚠️ ทุกการเพิ่ม Index ต้องทดสอบบน Staging ก่อน Deploy Production
> ✅ ใช้ `explain()` API เพื่อ Debug Query Plan ก่อน Optimize
> ✅ อ้างอิง Query Insights ที่ fingerprint: `7412416986210913857` สำหรับ `Inv_stock_balances`

---

*เอกสารนี้จัดทำโดย Database Analyst | BizICE APP Project | 30 มิถุนายน 2026*
