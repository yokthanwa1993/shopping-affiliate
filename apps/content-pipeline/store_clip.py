#!/usr/bin/env python3
"""store_clip.py — ทดสอบเก็บ 1 คลิป end-to-end (รันบน mac-mini)
ดึงคลิป top ที่มีลิงก์ Shopee → โหลด 720p → อัปเข้า Discord #คลังต้นฉบับ (admin-media-drive)
→ บันทึกลง SQLite content_items
"""
import os, re, json, sqlite3, subprocess, tempfile, time
import urllib.request, urllib.parse

TOKEN = os.environ["FB_TOKEN"]
PAGE = os.environ.get("PAGE", "100094468737641")
V = "v21.0"
DRIVE = "http://localhost:3100"
HOME = os.path.expanduser("~")
DB = f"{HOME}/Library/Application Support/AffiliateAdmin/content.db"
AMD_ENV = f"{HOME}/Developer/shopping-affiliate/apps/admin-media-drive/.env"
SHOPEE = re.compile(r"https?://s\.shopee\.co\.th/\S+")

os.makedirs(os.path.dirname(DB), exist_ok=True)


def api(path, **p):
    p["access_token"] = TOKEN
    u = f"https://graph.facebook.com/{V}/{path}?" + urllib.parse.urlencode(p)
    req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
    return json.load(urllib.request.urlopen(req, timeout=30))


def source_channel():
    env = open(AMD_ENV).read()
    return re.search(r"SOURCE_CHANNEL_ID=(\S+)", env).group(1).strip()


def init_db():
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
    c.commit()
    return c


def pick_clip():
    d = api(f"{PAGE}/posts",
            fields="message,created_time,permalink_url,shares,"
                   "reactions.limit(0).summary(total_count),"
                   "attachments{media_type,media{source},target{id}},"
                   "comments.limit(30).summary(true){message,from{name}}",
            limit="25")
    best = None
    for p in d.get("data", []):
        atts = p.get("attachments", {}).get("data", [])
        vid = next((a for a in atts if a.get("media_type") in ("video", "video_inline")), None)
        if not vid or not vid.get("media", {}).get("source"):
            continue
        link = None
        for cm in p.get("comments", {}).get("data", []):
            m = SHOPEE.search(cm.get("message", "") or "")
            if m:
                link = m.group(0)
                break
        if not link:
            continue
        r = p.get("reactions", {}).get("summary", {}).get("total_count", 0) or 0
        c = p.get("comments", {}).get("summary", {}).get("total_count", 0) or 0
        s = (p.get("shares", {}) or {}).get("count", 0) or 0
        eng = r + c + s
        cand = {"p": p, "vid": vid, "link": link, "r": r, "c": c, "s": s, "eng": eng}
        if not best or eng > best["eng"]:
            best = cand
    return best


def main():
    print("1) เลือกคลิป top ที่มีลิงก์ Shopee...")
    clip = pick_clip()
    if not clip:
        print("❌ ไม่เจอคลิปที่มีลิงก์"); return 1
    p = clip["p"]
    pid = (clip["vid"].get("target", {}) or {}).get("id") or p.get("id", "")
    print(f"   ✅ {(p.get('message','') or '')[:40]}  ❤️{clip['r']} 💬{clip['c']} 🔁{clip['s']}")
    print(f"      🔗 {clip['link']}")

    print("2) โหลดวิดีโอ 720p...")
    mp4 = f"/tmp/clip_{pid}.mp4"
    urllib.request.urlretrieve(clip["vid"]["media"]["source"], mp4)
    sz = os.path.getsize(mp4) // 1024
    print(f"   ✅ {mp4} ({sz}KB)")

    print("3) อัปเข้า Discord #คลังต้นฉบับ (admin-media-drive)...")
    ch = source_channel()
    out = subprocess.run([
        "curl", "-s", "-X", "POST", f"{DRIVE}/api/upload",
        "-F", f"file=@{mp4};type=video/mp4",
        "-F", f"channelId={ch}",
    ], capture_output=True, text=True)  # ไม่ส่ง caption = Discord เก็บแค่วิดีโอ
    try:
        item = json.loads(out.stdout)
    except Exception:
        print("   ❌ upload response ไม่ใช่ json:", out.stdout[:200]); return 2
    if item.get("error"):
        print("   ❌ upload error:", item["error"]); return 2
    disc_id = item.get("id") or item.get("messageId") or ""
    disc_url = item.get("proxyUrl") or item.get("url") or ""
    print(f"   ✅ อัปแล้ว → Discord id: {disc_id}")

    print("4) บันทึกลง SQLite content_items...")
    conn = init_db()
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    conn.execute("""INSERT OR REPLACE INTO content_items
      (source_page, source_post_id, reel_url, caption, reactions, comments, shares, engagement,
       posted_date, platform, source_link, original_video_id, original_video_url, status,
       created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
      ("ช่างสรรหา", pid, p.get("permalink_url", ""), p.get("message", ""),
       clip["r"], clip["c"], clip["s"], clip["eng"], p.get("created_time", "")[:10],
       "shopee", clip["link"], str(disc_id), disc_url, "downloaded", now, now))
    conn.commit()
    print(f"   ✅ บันทึกแล้ว → {DB}")

    print("\n=== แถวใน SQLite ===")
    for row in conn.execute("SELECT id,caption,engagement,platform,source_link,original_video_id,status FROM content_items ORDER BY id DESC LIMIT 3"):
        print(f"  #{row[0]} | {(row[1] or '')[:30]} | eng {row[2]} | {row[3]} | {row[4][:30]} | disc {row[5]} | {row[6]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
