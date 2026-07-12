#!/usr/bin/env python3
"""store_local.py — เก็บคลิป (ที่โหลดไว้แล้ว) เข้า Discord #คลังต้นฉบับ + SQLite
ข้าม FB API (โดน rate-limit) — ใช้ข้อมูลที่ดึงไว้ก่อนหน้า
env: MP4, REEL, CAPTION, LINK, ENG, REACT, COMM, SHARE, DATE, URL
"""
import os, re, json, sqlite3, subprocess, time

HOME = os.path.expanduser("~")
DB = f"{HOME}/Library/Application Support/AffiliateAdmin/content.db"
AMD_ENV = f"{HOME}/Developer/shopping-affiliate/apps/admin-media-drive/.env"
DRIVE = "http://localhost:3100"
os.makedirs(os.path.dirname(DB), exist_ok=True)

mp4 = os.environ["MP4"]
reel = os.environ["REEL"]
cap = os.environ.get("CAPTION", "")
link = os.environ["LINK"]
react = int(os.environ.get("REACT", "0"))
comm = int(os.environ.get("COMM", "0"))
share = int(os.environ.get("SHARE", "0"))
eng = react + comm + share
date = os.environ.get("DATE", "")
url = os.environ.get("URL", "")

ch = re.search(r"SOURCE_CHANNEL_ID=(\S+)", open(AMD_ENV).read()).group(1).strip()

print("1) อัปเข้า Discord #คลังต้นฉบับ (เฉพาะไฟล์วิดีโอ ไม่ใส่แคปชั่น)...")
out = subprocess.run([
    "curl", "-s", "-X", "POST", f"{DRIVE}/api/upload",
    "-F", f"file=@{mp4};type=video/mp4",
    "-F", f"channelId={ch}",
], capture_output=True, text=True)  # ไม่ส่ง caption = Discord เก็บแค่วิดีโอ
try:
    item = json.loads(out.stdout)
except Exception:
    print("   ❌ response:", out.stdout[:250]); raise SystemExit(1)
if item.get("error"):
    print("   ❌ error:", item["error"]); raise SystemExit(1)
disc_id = str(item.get("id") or item.get("messageId") or "")
disc_url = item.get("proxyUrl") or item.get("url") or ""
print(f"   ✅ อัปแล้ว → Discord id: {disc_id}")
print(f"      channel(#คลังต้นฉบับ): {ch}")

print("2) บันทึกลง SQLite content_items...")
c = sqlite3.connect(DB)
c.execute("""CREATE TABLE IF NOT EXISTS content_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_page TEXT, source_post_id TEXT UNIQUE, reel_url TEXT, caption TEXT,
  reactions INT, comments INT, shares INT, engagement INT, posted_date TEXT,
  platform TEXT, source_link TEXT,
  original_video_id TEXT, original_video_url TEXT,
  generated_video_id TEXT, our_affiliate_link TEXT,
  status TEXT DEFAULT 'new', posted_to TEXT, posted_at TEXT,
  created_at TEXT, updated_at TEXT)""")
now = time.strftime("%Y-%m-%dT%H:%M:%S")
c.execute("""INSERT OR REPLACE INTO content_items
  (source_page, source_post_id, reel_url, caption, reactions, comments, shares, engagement,
   posted_date, platform, source_link, original_video_id, original_video_url, status,
   created_at, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
  ("ช่างสรรหา", reel, url, cap, react, comm, share, eng, date,
   "shopee", link, disc_id, disc_url, "downloaded", now, now))
c.commit()
print(f"   ✅ บันทึกแล้ว → {DB}")

print("\n=== 🗃 แถวใน SQLite (content_items) ===")
for r in c.execute("SELECT id,source_post_id,substr(caption,1,26),engagement,platform,source_link,substr(original_video_id,1,20),status FROM content_items ORDER BY id DESC LIMIT 5"):
    print(f"  #{r[0]} | reel {r[1]} | {r[2]} | eng {r[3]} | {r[4]} | {r[5]} | disc {r[6]} | {r[7]}")
print(f"\nรวมในคลัง: {c.execute('SELECT count(*) FROM content_items').fetchone()[0]} คลิป")
