#!/usr/bin/env python3
"""fb_posts.py — ดึงโพสต์ทั้งหมดของเพจ Facebook (public) ผ่าน Graph API
ต้องใช้ token จากแอปที่มี Page Public Content Access (PPCA)

ใช้:
  export FB_TOKEN='EAAD...'
  python3 fb_posts.py <page_id|url> [--since 2026-01-01] [--until 2026-07-12] [--max 500] [--csv]

ตัวอย่าง:
  python3 fb_posts.py 100094468737641 --max 200 --csv
  python3 fb_posts.py "https://www.facebook.com/profile.php?id=100094468737641"
"""
import os, sys, json, csv, time, argparse, urllib.request, urllib.parse, re

V = "v21.0"
FIELDS = ("message,created_time,shares,permalink_url,"
          "reactions.limit(0).summary(total_count),"
          "comments.limit(0).summary(total_count),"
          "attachments{media_type,unshimmed_url,title,media{source},target{id,url}}")


def video_src(p):
    """คืน (mp4_url, reel_id) ถ้าโพสต์นี้เป็นวิดีโอ ไม่งั้น (None, None)"""
    for a in p.get("attachments", {}).get("data", []):
        if a.get("media_type") in ("video", "video_inline"):
            src = (a.get("media", {}) or {}).get("source")
            rid = (a.get("target", {}) or {}).get("id", "")
            if src:
                return src, rid
    return None, None


def reel_url(p):
    """คืน URL reel/วิดีโอ (สำหรับ yt-dlp ดึง HD)"""
    for a in p.get("attachments", {}).get("data", []):
        if a.get("media_type") in ("video", "video_inline"):
            return (a.get("target", {}) or {}).get("url") or a.get("unshimmed_url")
    return None


def download_videos(posts, page, hd=True):
    """โหลดวิดีโอทุกโพสต์
       hd=True  → yt-dlp ดึง 1080p (best) จากหน้า reel
       hd=False → API source 720p (เร็ว แต่ cap 720p)"""
    import os, subprocess, shutil
    d = f"videos_{page}"
    os.makedirs(d, exist_ok=True)
    ytdlp = shutil.which("yt-dlp") or os.path.expanduser("~/.local/bin/yt-dlp")
    use_hd = hd and os.path.exists(ytdlp)
    if hd and not use_hd:
        print("⚠️ ไม่เจอ yt-dlp → fallback API source 720p (ติดตั้ง: ~/.local/bin/yt-dlp)")
    vids = [(i, p) for i, p in enumerate(posts, 1) if video_src(p)[0]]
    print(f"\n📹 โหลดวิดีโอ {len(vids)} คลิป → {d}/  ({'1080p yt-dlp' if use_hd else '720p API'})")
    ok = 0
    for rank, p in vids:
        src, rid = video_src(p)
        r, c, s, t = eng(p)
        base = f"{d}/{rank:03d}_eng{t}_{rid or 'vid'}"
        try:
            if use_hd and reel_url(p):
                subprocess.run([ytdlp, "-q", "-f", "bv*+ba/b", "--merge-output-format", "mp4",
                                "-o", base + ".%(ext)s", reel_url(p)], check=True, timeout=120)
                fn = base + ".mp4"
            else:
                fn = base + ".mp4"
                urllib.request.urlretrieve(src, fn)
            sz = os.path.getsize(fn) // 1024
            print(f"  ✅ {fn}  ({sz}KB)")
            ok += 1
        except Exception as e:
            print(f"  ❌ {rid}: {str(e)[:60]}")
        time.sleep(0.3)
    print(f"โหลดสำเร็จ {ok}/{len(vids)} คลิป")


def parse_page(s):
    """รับ id หรือ url → คืน page id"""
    m = re.search(r"profile\.php\?id=(\d+)", s)
    if m:
        return m.group(1)
    if s.isdigit():
        return s
    m = re.search(r"facebook\.com/([^/?#]+)", s)
    return m.group(1) if m else s


def api(path, token, **params):
    params["access_token"] = token
    url = f"https://graph.facebook.com/{V}/{path}?" + urllib.parse.urlencode(params)
    try:
        return json.load(urllib.request.urlopen(url, timeout=30))
    except urllib.error.HTTPError as e:
        return {"__error__": json.loads(e.read().decode())}


def fetch_all(page, token, since=None, until=None, cap=500):
    """ตาม paging ดึงทุกโพสต์ (สูงสุด cap)"""
    params = {"fields": FIELDS, "limit": "50"}
    if since:
        params["since"] = since
    if until:
        params["until"] = until
    out = []
    d = api(f"{page}/posts", token, **params)
    while True:
        if "__error__" in d:
            print("❌ error:", d["__error__"].get("error", {}).get("message", d["__error__"]))
            break
        out.extend(d.get("data", []))
        print(f"  ...ดึงแล้ว {len(out)} โพสต์", flush=True)
        nxt = d.get("paging", {}).get("next")
        if not nxt or len(out) >= cap:
            break
        time.sleep(0.4)  # กัน rate limit
        try:
            d = json.load(urllib.request.urlopen(nxt, timeout=30))
        except Exception as e:
            print("  หยุด (paging):", e)
            break
    return out[:cap]


def eng(p):
    r = (p.get("reactions", {}).get("summary", {}) or {}).get("total_count", 0) or 0
    c = (p.get("comments", {}).get("summary", {}) or {}).get("total_count", 0) or 0
    s = (p.get("shares", {}) or {}).get("count", 0) or 0
    return r, c, s, r + c + s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("page")
    ap.add_argument("--since")
    ap.add_argument("--until")
    ap.add_argument("--max", type=int, default=500)
    ap.add_argument("--csv", action="store_true")
    ap.add_argument("--videos", action="store_true", help="โหลดวิดีโอทุกโพสต์ (720p ผ่าน token = ปลอดภัย โหลดเยอะได้)")
    ap.add_argument("--hd", action="store_true", help="โหลด 1080p ผ่าน yt-dlp แทน (เสี่ยง anti-bot — ใช้เฉพาะคลิปสำคัญ)")
    ap.add_argument("--token", default=os.environ.get("FB_TOKEN", ""))
    a = ap.parse_args()
    if not a.token:
        print("❌ ต้องมี token: export FB_TOKEN='EAAD...' หรือ --token"); return 1

    page = parse_page(a.page)
    print(f"📥 ดึงโพสต์เพจ {page} (max {a.max})...")
    posts = fetch_all(page, a.token, a.since, a.until, a.max)
    if not posts:
        print("ไม่ได้โพสต์ (token หมดอายุ / ไม่มี PPCA / เป็นโปรไฟล์ส่วนตัว)"); return 2

    posts.sort(key=lambda p: eng(p)[3], reverse=True)
    out = f"posts_{page}.json"
    json.dump(posts, open(out, "w"), ensure_ascii=False, indent=2)
    print(f"\n✅ ได้ {len(posts)} โพสต์ → {out}")

    if a.csv:
        cf = f"posts_{page}.csv"
        with open(cf, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["date", "reactions", "comments", "shares", "total_eng", "message", "permalink"])
            for p in posts:
                r, c, s, t = eng(p)
                w.writerow([p.get("created_time", "")[:10], r, c, s, t,
                            (p.get("message", "") or "").replace("\n", " "), p.get("permalink_url", "")])
        print(f"   + CSV → {cf}")

    print("\n🔥 ท็อป 10 โพสต์ (engagement สูงสุด):")
    for i, p in enumerate(posts[:10], 1):
        r, c, s, t = eng(p)
        vid = "🎬" if video_src(p)[0] else "  "
        msg = (p.get("message", "") or "(ไม่มีข้อความ)").replace("\n", " ")[:48]
        print(f"{i:2}. {vid} [{p.get('created_time','')[:10]}] ❤️{r} 💬{c} 🔁{s}  {msg}")

    if a.videos:
        download_videos(posts, page, hd=a.hd)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
