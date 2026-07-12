#!/usr/bin/env python3
"""fb_pull_all.py — ใส่ลิสต์เพจใน pages.json → ดึงโพสต์ทุกเพจทีเดียว + รวมจัดอันดับ

ใช้:
  export FB_TOKEN='EAAD...'
  python3 fb_pull_all.py [--videos] [--csv] [--since 2026-06-01]

output:
  posts_<id>.json            ต่อเพจ (ทุกโพสต์)
  all_pages_ranked.csv/json  รวมทุกเพจ เรียงตาม engagement (มีคอลัมน์ page)
  videos_<id>/*.mp4          ถ้าใส่ --videos (720p token-only)
"""
import os, sys, json, csv, time, argparse
import fb_posts as fp   # reuse: fetch_all, eng, video_src, parse_page, download_videos


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pages", default="pages.json")
    ap.add_argument("--since")
    ap.add_argument("--until")
    ap.add_argument("--videos", action="store_true", help="โหลดวิดีโอ 720p ทุกเพจ")
    ap.add_argument("--hd", action="store_true", help="วิดีโอ 1080p (yt-dlp, เสี่ยง anti-bot)")
    ap.add_argument("--csv", action="store_true")
    ap.add_argument("--token", default=os.environ.get("FB_TOKEN", ""))
    a = ap.parse_args()
    if not a.token:
        print("❌ ต้องมี token: export FB_TOKEN='EAAD...'"); return 1
    if not os.path.exists(a.pages):
        print(f"❌ ไม่เจอ {a.pages} — สร้าง list เพจก่อน"); return 1

    pages = json.load(open(a.pages))
    print(f"📋 มี {len(pages)} เพจใน {a.pages}\n" + "=" * 60)
    all_posts = []
    summary = []

    for entry in pages:
        page = fp.parse_page(entry["page"])
        label = entry.get("label", page)
        cap = entry.get("max", 100)
        print(f"\n📥 {label}  ({page})  — max {cap}")
        try:
            posts = fp.fetch_all(page, a.token, a.since, a.until, cap)
        except Exception as e:
            print(f"   ❌ ดึงไม่ได้: {str(e)[:80]}"); summary.append((label, 0)); continue
        if not posts:
            print("   ⚠️ ไม่ได้โพสต์ (token/PPCA/โปรไฟล์ส่วนตัว)"); summary.append((label, 0)); continue
        for p in posts:
            p["_label"] = label
            p["_page"] = page
        posts.sort(key=lambda p: fp.eng(p)[3], reverse=True)
        json.dump(posts, open(f"posts_{page}.json", "w"), ensure_ascii=False, indent=2)
        all_posts.extend(posts)
        summary.append((label, len(posts)))
        print(f"   ✅ {len(posts)} โพสต์ → posts_{page}.json")
        if a.videos:
            fp.download_videos(posts, page, hd=a.hd)
        time.sleep(0.5)

    # รวมทุกเพจ จัดอันดับ
    all_posts.sort(key=lambda p: fp.eng(p)[3], reverse=True)
    json.dump(all_posts, open("all_pages_ranked.json", "w"), ensure_ascii=False, indent=2)
    if a.csv:
        with open("all_pages_ranked.csv", "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["page", "date", "reactions", "comments", "shares", "total_eng", "video", "message", "permalink"])
            for p in all_posts:
                r, c, s, t = fp.eng(p)
                w.writerow([p.get("_label", ""), p.get("created_time", "")[:10], r, c, s, t,
                            "yes" if fp.video_src(p)[0] else "", (p.get("message", "") or "").replace("\n", " "),
                            p.get("permalink_url", "")])

    print("\n" + "=" * 60)
    print("📊 สรุปต่อเพจ:")
    for label, n in summary:
        print(f"   {label}: {n} โพสต์")
    print(f"\n🔥 ท็อป 15 โพสต์ (รวมทุกเพจ):")
    for i, p in enumerate(all_posts[:15], 1):
        r, c, s, t = fp.eng(p)
        vid = "🎬" if fp.video_src(p)[0] else "  "
        msg = (p.get("message", "") or "(ไม่มีข้อความ)").replace("\n", " ")[:42]
        print(f"{i:2}. {vid} [{p.get('_label','')[:10]:10}] ❤️{r} 💬{c} 🔁{s}  {msg}")
    print(f"\n✅ รวม {len(all_posts)} โพสต์ → all_pages_ranked.json" + (" / .csv" if a.csv else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
