import SwiftUI
import AppKit
import WebKit

/// IDBridge — tray เดียว รวมทุกแพลตฟอร์ม (Shopee / Facebook / Higgsfield)
/// กด icon → เลือกแพลตฟอร์ม+บัญชี → เปิดหน้าเว็บ (seed cookie จาก bridge) + sync cookie สดตอนโหลดเสร็จ
/// ยุบจาก FacebookBridge + HiggsfieldBridge (+ shopee) มาเป็นแอพเดียว คู่กับ iOS "IDLogin"
@main
struct IDBridgeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    var body: some Scene { Settings { EmptyView() } }
}

struct Site {
    let key, title, host, iconRes: String
    let home: URL
    let accountsPath, idKey, cookieGet, postPath, loginCookie: String
    let extraCookies: [String: String]
    func domain(for name: String) -> String {
        if key == "hf" && name == "__client" { return ".clerk.higgsfield.ai" }
        if key == "hf" { return ".higgsfield.ai" }
        if key == "shopee" { return ".shopee.co.th" }
        return ".facebook.com"
    }
    // เรียงลำดับที่โชว์ในเมนู
    static let order = ["shopee", "fb", "hf"]
    static let all: [String: Site] = [
        "shopee": Site(key: "shopee", title: "Shopee", host: "shopee", iconRes: "shopee",
                       home: URL(string: "https://affiliate.shopee.co.th/offer/custom_link")!,
                       accountsPath: "/accounts", idKey: "spc_u", cookieGet: "/cookie?account=",
                       postPath: "/session", loginCookie: "SPC_ST", extraCookies: ["language": "th"]),
        "fb": Site(key: "fb", title: "Facebook", host: "facebook", iconRes: "facebook",
                   home: URL(string: "https://www.facebook.com/")!,
                   accountsPath: "/fb-accounts", idKey: "c_user", cookieGet: "/fb-cookie?account=",
                   postPath: "/fb-session", loginCookie: "c_user", extraCookies: [:]),
        "hf": Site(key: "hf", title: "Higgsfield", host: "higgsfield", iconRes: "higgsfield",
                   home: URL(string: "https://higgsfield.ai/")!,
                   accountsPath: "/hf-accounts", idKey: "hf_id", cookieGet: "/hf-cookie?account=",
                   postPath: "/hf-session", loginCookie: "__client", extraCookies: [:]),
    ]
}

@MainActor
final class Acct: NSObject, WKNavigationDelegate, WKUIDelegate {
    let site: Site; let uid: String; let name: String
    private var webView: WKWebView?
    private var window: NSWindow?
    init(site: Site, uid: String, name: String) { self.site = site; self.uid = uid; self.name = name }

    func open() {
        if window == nil { build() }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }
    private func build() {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .nonPersistent()
        let wv = WKWebView(frame: NSRect(x: 0, y: 0, width: 1100, height: 760), configuration: cfg)
        wv.navigationDelegate = self; wv.uiDelegate = self
        wv.customUserAgent = AppDelegate.ua
        webView = wv
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 760),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        w.title = "\(site.title) • \(name)"; w.center(); w.contentView = wv; w.isReleasedWhenClosed = false
        window = w
        seedAndLoad(wv)
    }
    private func seedAndLoad(_ wv: WKWebView) {
        var req = URLRequest(url: URL(string: AppDelegate.bridge + site.cookieGet + uid)!)
        req.setValue(AppDelegate.token, forHTTPHeaderField: "X-Bridge-Token")
        req.setValue(AppDelegate.ua, forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: req) { data, _, _ in
            var cookies: [String: String] = [:]
            if let data, let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let c = j["cookies"] as? [String: String] { cookies = c }
            for (k, v) in self.site.extraCookies where cookies[k] == nil { cookies[k] = v }
            Task { @MainActor in
                let store = wv.configuration.websiteDataStore.httpCookieStore
                let g = DispatchGroup()
                for (n, v) in cookies {
                    if let ck = HTTPCookie(properties: [.domain: self.site.domain(for: n), .path: "/",
                                                        .name: n, .value: v, .secure: "TRUE"]) {
                        g.enter(); store.setCookie(ck) { g.leave() }
                    }
                }
                g.notify(queue: .main) { wv.load(URLRequest(url: self.site.home)) }
            }
        }.resume()
    }
    nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Task { @MainActor in self.capture(webView) }
    }
    private func capture(_ wv: WKWebView) {
        wv.configuration.websiteDataStore.httpCookieStore.getAllCookies { cookies in
            var dict: [String: String] = [:]
            for c in cookies where c.domain.contains(self.site.host) { dict[c.name] = c.value }
            Task { @MainActor in
                guard dict[self.site.loginCookie] != nil else { return }
                var req = URLRequest(url: URL(string: AppDelegate.bridge + self.site.postPath)!); req.httpMethod = "POST"
                req.setValue("application/json", forHTTPHeaderField: "content-type")
                req.setValue(AppDelegate.token, forHTTPHeaderField: "X-Bridge-Token")
                req.httpBody = try? JSONSerialization.data(withJSONObject: ["cookies": dict])
                URLSession.shared.dataTask(with: req).resume()
            }
        }
    }
    nonisolated func webView(_ webView: WKWebView, createWebViewWith c: WKWebViewConfiguration,
                             for a: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let u = a.request.url { DispatchQueue.main.async { webView.load(URLRequest(url: u)) } }
        return nil
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    static let bridge = "https://shopee.oomnn.com"
    static let token = "6d0018a333c475bc20681251e0e4dd7c"
    static let ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"

    var statusItem: NSStatusItem!
    private var accts: [String: [Acct]] = [:]   // key = site.key

    func applicationDidFinishLaunching(_ n: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = trayIcon()
        let menu = NSMenu(); menu.delegate = self; statusItem.menu = menu
        for key in Site.order { loadAccounts(Site.all[key]!) }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { false }

    private func trayIcon() -> NSImage {
        let cfg = NSImage.SymbolConfiguration(pointSize: 15, weight: .semibold)
        if let img = NSImage(systemSymbolName: "key.horizontal.fill", accessibilityDescription: "IDBridge")?
            .withSymbolConfiguration(cfg) {
            img.isTemplate = true
            return img
        }
        return NSImage(systemSymbolName: "key.fill", accessibilityDescription: "IDBridge") ?? NSImage()
    }

    private func loadAccounts(_ site: Site) {
        var req = URLRequest(url: URL(string: Self.bridge + site.accountsPath)!)
        req.setValue(Self.token, forHTTPHeaderField: "X-Bridge-Token")
        req.setValue(Self.ua, forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
            guard let self, let data,
                  let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return }
            Task { @MainActor in
                var arr = self.accts[site.key] ?? []
                for item in list {
                    guard let uid = item[site.idKey] as? String, !uid.isEmpty else { continue }
                    if arr.contains(where: { $0.uid == uid }) { continue }
                    arr.append(Acct(site: site, uid: uid, name: (item["name"] as? String) ?? uid))
                }
                self.accts[site.key] = arr
            }
        }.resume()
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        var any = false
        for key in Site.order {
            let site = Site.all[key]!
            let arr = accts[key] ?? []
            // หัวข้อแพลตฟอร์ม
            let header = NSMenuItem(title: site.title.uppercased(), action: nil, keyEquivalent: "")
            header.isEnabled = false; menu.addItem(header)
            if arr.isEmpty {
                let m = NSMenuItem(title: "   รอ cookie...", action: nil, keyEquivalent: ""); m.isEnabled = false
                menu.addItem(m)
            } else {
                any = true
                for a in arr {
                    let m = NSMenuItem(title: "   " + a.name, action: #selector(openAcct(_:)), keyEquivalent: "")
                    m.target = self; m.representedObject = a; menu.addItem(m)
                }
            }
            menu.addItem(.separator())
        }
        if !any {
            let m = NSMenuItem(title: "ยังไม่มีบัญชี — login ที่มือถือ IDLogin ก่อน", action: nil, keyEquivalent: "")
            m.isEnabled = false; menu.addItem(m); menu.addItem(.separator())
        }
        let refresh = NSMenuItem(title: "โหลดบัญชีใหม่", action: #selector(reload), keyEquivalent: "r")
        refresh.target = self; menu.addItem(refresh)
        let quit = NSMenuItem(title: "Quit", action: #selector(quitApp), keyEquivalent: "q"); quit.target = self
        menu.addItem(quit)
    }
    @objc private func openAcct(_ s: NSMenuItem) { (s.representedObject as? Acct)?.open() }
    @objc private func reload() { for key in Site.order { loadAccounts(Site.all[key]!) } }
    @objc private func quitApp() { NSApp.terminate(nil) }
}
