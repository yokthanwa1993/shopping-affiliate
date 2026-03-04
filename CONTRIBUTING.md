# shopping-affiliate Monorepo Contribution Guide

## โครงสร้างงาน
- `apps/video-affiliate/` และ `apps/browsersaving/` เป็น 2 service หลักที่ทำงานร่วมกันใน repo เดียว
- แก้ไขตามพื้นที่ที่ได้รับผลโดยตรงก่อน (ไม่แก้ข้าม service โดยไม่จำเป็น)

## คำสั่งหลัก (จาก root)
- วางระบบการรัน/Deploy ตาม scripts ใน root `package.json`
- ตัวอย่าง: `npm run start:video-affiliate:worker`, `npm run start:browsersaving:api`

## ข้อควรจำ
- ถ้าข้อผิดพลาดเกิดในระบบข้อมูล/endpoint ให้ trace ตาม request flow และอัปเดตทั้งสองฝั่งที่เกี่ยวข้อง
- เมื่อมีการเปลี่ยน contract (request/response) ให้เพิ่มหมายเหตุสั้น ๆ ใน root `README.md`
