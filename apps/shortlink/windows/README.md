# Windows Shortlink Runtime

รัน Shopee shortlink Electron 4 account บน Windows Server แบบ native

โครงสร้างบนเครื่อง:

```text
C:\shortlink-native\
├── electron\
│   ├── main.js
│   ├── main-neezs.js     ← compatibility wrapper (legacy only)
│   ├── package.json
│   ├── package-lock.json
│   ├── icons\
│   └── node_modules\
├── data\
│   ├── chearb
│   ├── neezs
│   ├── golf
│   └── first
├── logs\
└── scripts\
    ├── Install-ShortlinkTasks.ps1
    ├── Start-ShortlinkAll.ps1
    ├── Start-ShortlinkInstance.ps1
    └── Stop-ShortlinkAll.ps1
```

สคริปต์:

- `Install-ShortlinkTasks.ps1` ติดตั้ง Scheduled Tasks แบบ interactive สำหรับ 4 account
- `Start-ShortlinkAll.ps1` สั่งรัน task ทั้ง 4
- `Start-ShortlinkInstance.ps1 -Account chearb|neezs|golf|first` รันทีละตัว
- `Stop-ShortlinkAll.ps1` หยุด Electron ทั้งหมด

หมายเหตุ:

- `chearb` และ `neezs` มี credential default ในสคริปต์
- `golf` และ `first` ไม่มี credential default ต้องอาศัย session เดิมจาก user-data ที่ย้ายมาจาก Ubuntu
- Worker URLs เดิมไม่ต้องเปลี่ยน
- ตอนนี้ทุก account รันผ่าน `main.js` ตัวเดียว โดย inject ค่า account ผ่าน env ใน `Start-ShortlinkInstance.ps1`
