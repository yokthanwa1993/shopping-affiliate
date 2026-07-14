import SwiftUI
import WebKit

// MARK: - แพลตฟอร์ม (config ต่อแพลตฟอร์ม)
enum Platform: String, CaseIterable, Identifiable {
    case shopee, facebook, higgsfield
    var id: String { rawValue }

    var title: String {
        switch self {
        case .shopee: return "Shopee"
        case .facebook: return "Facebook"
        case .higgsfield: return "Higgsfield"
        }
    }
    var subtitle: String {
        switch self {
        case .shopee: return "affiliate + ย่อลิงก์"
        case .facebook: return "หลายบัญชี"
        case .higgsfield: return "เจนวิดีโอ"
        }
    }
    var host: String {          // domain contains
        switch self {
        case .shopee: return "shopee"
        case .facebook: return "facebook"
        case .higgsfield: return "higgsfield"
        }
    }
    var cookieDomain: String {
        switch self {
        case .shopee: return ".shopee.co.th"
        case .facebook: return ".facebook.com"
        case .higgsfield: return ".higgsfield.ai"
        }
    }
    var homeURL: URL {
        switch self {
        case .shopee: return URL(string: "https://affiliate.shopee.co.th/offer/custom_link")!
        case .facebook: return URL(string: "https://www.facebook.com/")!
        case .higgsfield: return URL(string: "https://higgsfield.ai/")!
        }
    }
    var loginCookie: String {   // มี = login แล้ว
        switch self {
        case .shopee: return "SPC_ST"
        case .facebook: return "c_user"
        case .higgsfield: return "__client"
        }
    }
    var bridgePath: String {    // POST session
        switch self {
        case .shopee: return "/session"
        case .facebook: return "/fb-session"
        case .higgsfield: return "/hf-session"
        }
    }
    var accountsPath: String? { // GET รายชื่อบัญชี (auto-import)
        switch self {
        case .shopee: return "/accounts"
        case .facebook: return "/fb-accounts"
        case .higgsfield: return "/hf-accounts"
        }
    }
    var accountsIdKey: String {
        switch self {
        case .shopee: return "spc_u"
        case .facebook: return "c_user"
        case .higgsfield: return "hf_id"
        }
    }
    var cookieQueryPath: String? {  // GET cookie ต่อบัญชี
        switch self {
        case .shopee: return "/cookie?account="
        case .facebook: return "/fb-cookie?account="
        case .higgsfield: return "/hf-cookie?account="
        }
    }
    var accent: Color {
        switch self {
        case .shopee: return Color(red: 238/255, green: 77/255, blue: 45/255)
        case .facebook: return Color(red: 24/255, green: 119/255, blue: 242/255)
        case .higgsfield: return Color(red: 206/255, green: 242/255, blue: 60/255)
        }
    }
    var symbol: String {
        switch self {
        case .shopee: return "bag.fill"
        case .facebook: return "person.2.fill"
        case .higgsfield: return "sparkles"
        }
    }
    var logoAsset: String {   // โลโก้แบรนด์จริง (imageset)
        switch self {
        case .shopee: return "ShopeeLogo"
        case .facebook: return "FacebookLogo"
        case .higgsfield: return "HiggsfieldLogo"
        }
    }
    var darkGlyph: Bool { self == .higgsfield }   // ไอคอนสีเข้มบนพื้นไลม์
    var ua: String {
        switch self {
        case .facebook: return "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1"
        default: return "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15"
        }
    }
    var extraCookies: [(String, String)] {
        switch self {
        case .shopee: return [("language", "th")]
        default: return []
        }
    }
    // domain ที่ถูกต้องต่อ cookie (Higgsfield: __client อยู่บน clerk.higgsfield.ai)
    func domain(for cookieName: String) -> String {
        if self == .higgsfield && cookieName == "__client" { return ".clerk.higgsfield.ai" }
        return cookieDomain
    }
    func accountId(from c: [String: String]) -> String {
        switch self {
        case .shopee: return c["SPC_U"] ?? ""
        case .facebook: return c["c_user"] ?? ""
        case .higgsfield: return c["__client"] != nil || c["__session"] != nil ? "main" : ""   // id คงที่ (session หมุนไม่นับ)
        }
    }
}

struct Account: Identifiable, Codable, Equatable {
    var id: UUID
    var name: String
    var accId: String = ""
    var pic: String = ""       // รูปโปรไฟล์จริง (FB)
    var label: String = ""     // ชื่อที่ผู้ใช้ตั้งเอง (เช่น อีเมล)
    // --- master credential (non-secret; ความลับ password/2FA/datr อยู่ Keychain) ---
    var uid: String = ""       // UID (= c_user สำหรับ FB)
    var email: String = ""
    var phone: String = ""
    enum CodingKeys: String, CodingKey { case id, name, accId, pic, label, uid, email, phone }
    init(id: UUID, name: String, accId: String = "", pic: String = "", label: String = "") {
        self.id = id; self.name = name; self.accId = accId; self.pic = pic; self.label = label
    }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        accId = try c.decodeIfPresent(String.self, forKey: .accId) ?? ""
        pic = try c.decodeIfPresent(String.self, forKey: .pic) ?? ""
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? ""
        uid = try c.decodeIfPresent(String.self, forKey: .uid) ?? ""
        email = try c.decodeIfPresent(String.self, forKey: .email) ?? ""
        phone = try c.decodeIfPresent(String.self, forKey: .phone) ?? ""
    }
}

// MARK: - Keychain (เก็บความลับ: password / 2FA secret / datr)
enum Keychain {
    @discardableResult
    static func set(_ value: String, _ key: String) -> Bool {
        let data = Data(value.utf8)
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                kSecAttrAccount as String: key]
        SecItemDelete(q as CFDictionary)
        if value.isEmpty { return true }
        var add = q; add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }
    static func get(_ key: String) -> String {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                kSecAttrAccount as String: key,
                                kSecReturnData as String: true,
                                kSecMatchLimit as String: kSecMatchLimitOne]
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
              let d = out as? Data else { return "" }
        return String(data: d, encoding: .utf8) ?? ""
    }
}

// ความลับ 1 บัญชี
struct Secret: Equatable {
    var password = ""
    var twoFA = ""     // 2FA secret (TOTP base32)
    var datr = ""
    var isEmpty: Bool { password.isEmpty && twoFA.isEmpty && datr.isEmpty }
}

// MARK: - จัดการบัญชีของ 1 แพลตฟอร์ม (ใช้ร่วมทุกแพลตฟอร์ม)
@MainActor
final class SessionStore: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate {
    let platform: Platform
    @Published var accounts: [Account] = []
    @Published var currentID: UUID?
    @Published var toast = ""

    static let bridgeBase = "https://shopee.oomnn.com"
    static let token = "6d0018a333c475bc20681251e0e4dd7c"
    private static let browserUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"

    private var webViews: [UUID: WKWebView] = [:]

    init(_ platform: Platform) {
        self.platform = platform
        super.init()
        loadAccounts()
        // ลบ placeholder ว่าง "บัญชี N" ถ้ามีบัญชีจริงแล้ว (กันขึ้น 2 อัน)
        if accounts.contains(where: { !$0.accId.isEmpty }) {
            accounts.removeAll { $0.accId.isEmpty && $0.name.hasPrefix("บัญชี") }
            saveAccounts()
        }
        if accounts.isEmpty { accounts = [Account(id: UUID(), name: "บัญชี 1")]; saveAccounts() }
        currentID = accounts.first?.id
        importFromBridge()
    }

    private var storeKey: String { "acc_\(platform.rawValue)" }
    private func ckKey(_ id: UUID) -> String { "ck_\(platform.rawValue)_\(id.uuidString)" }

    func webView(for id: UUID) -> WKWebView {
        if let wv = webViews[id] { return wv }
        let cfg = WKWebViewConfiguration()
        if #available(iOS 17.0, *) { cfg.websiteDataStore = WKWebsiteDataStore(forIdentifier: id) }
        else { cfg.websiteDataStore = .default() }
        let wv = WKWebView(frame: .zero, configuration: cfg)
        wv.navigationDelegate = self; wv.uiDelegate = self
        wv.customUserAgent = platform.ua
        webViews[id] = wv
        let store = wv.configuration.websiteDataStore.httpCookieStore
        var pairs = platform.extraCookies
        if let saved = UserDefaults.standard.dictionary(forKey: ckKey(id)) as? [String: String],
           saved[platform.loginCookie] != nil {
            for (k, v) in saved { pairs.append((k, v)) }
        }
        let g = DispatchGroup()
        for (n, v) in pairs {
            if let c = HTTPCookie(properties: [.domain: platform.domain(for: n), .path: "/", .name: n, .value: v, .secure: "TRUE"]) {
                g.enter(); store.setCookie(c) { g.leave() }
            }
        }
        g.notify(queue: .main) { wv.load(URLRequest(url: self.platform.homeURL)) }
        return wv
    }

    nonisolated func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                             for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { DispatchQueue.main.async { webView.load(URLRequest(url: url)) } }
        return nil
    }
    var currentWebView: WKWebView? { currentID.flatMap { webViews[$0] } }

    func addAccount() {
        let a = Account(id: UUID(), name: "บัญชี \(accounts.count + 1)")
        accounts.append(a); currentID = a.id; saveAccounts()
    }
    func setLabel(_ id: UUID, _ label: String) {
        if let i = accounts.firstIndex(where: { $0.id == id }) {
            accounts[i].label = label.trimmingCharacters(in: .whitespacesAndNewlines)
            saveAccounts()
        }
    }
    func removeAccount(_ id: UUID) {
        webViews[id]?.stopLoading(); webViews[id] = nil
        UserDefaults.standard.removeObject(forKey: ckKey(id))
        accounts.removeAll { $0.id == id }
        if currentID == id { currentID = accounts.first?.id }
        saveAccounts()
    }

    nonisolated func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                             decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let s = navigationAction.request.url?.scheme?.lowercased(),
           !["http","https","about","data","file","blob"].contains(s) { decisionHandler(.cancel); return }
        decisionHandler(.allow)
    }

    nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Task { @MainActor in self.syncCurrent() }
    }

    func syncCurrent() {
        guard let wv = currentWebView, let id = currentID else { return }
        let host = platform.host, login = platform.loginCookie
        wv.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
            guard let self else { return }
            var dict: [String: String] = [:]
            for c in cookies where c.domain.contains(host) { dict[c.name] = c.value }
            Task { @MainActor in
                guard dict[login] != nil else { return }
                let aid = self.platform.accountId(from: dict)
                if let i = self.accounts.firstIndex(where: { $0.id == id }) {
                    self.accounts[i].accId = aid
                    if self.accounts[i].name.hasPrefix("บัญชี"), !aid.isEmpty {
                        self.accounts[i].name = self.platform.title + " " + String(aid.prefix(10))
                    }
                    self.saveAccounts()
                }
                UserDefaults.standard.set(dict, forKey: self.ckKey(id))
                self.post(dict)
            }
        }
    }

    private func post(_ cookies: [String: String]) {
        guard let url = URL(string: Self.bridgeBase + platform.bridgePath) else { return }
        var req = URLRequest(url: url); req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.setValue(Self.token, forHTTPHeaderField: "X-Bridge-Token")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["cookies": cookies])
        let cid = currentID
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
            Task { @MainActor in
                guard let self else { return }
                if (resp as? HTTPURLResponse)?.statusCode == 200 {
                    self.showToast("✅ ส่ง session แล้ว (\(cookies.count))")
                    // FB ตอบชื่อ+รูปจริงกลับมา -> อัปเดตการ์ด
                    if let data, let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                       let id = cid, let i = self.accounts.firstIndex(where: { $0.id == id }) {
                        if let nm = j["name"] as? String, !nm.isEmpty { self.accounts[i].name = nm }
                        if let pic = j["pic"] as? String, !pic.isEmpty { self.accounts[i].pic = pic }
                        self.saveAccounts()
                    }
                }
            }
        }.resume()
    }

    // auto-import บัญชีจาก bridge (ไม่ต้อง login ใหม่)
    func importFromBridge() {
        guard let ap = platform.accountsPath, let url = URL(string: Self.bridgeBase + ap) else { return }
        var req = URLRequest(url: url)
        req.setValue(Self.token, forHTTPHeaderField: "X-Bridge-Token")
        req.setValue(Self.browserUA, forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
            guard let self, let data,
                  let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return }
            Task { @MainActor in
                for item in list {
                    guard let uid = item[self.platform.accountsIdKey] as? String, !uid.isEmpty else { continue }
                    let nm = (item["name"] as? String) ?? ""
                    let pic = (item["pic"] as? String) ?? ""
                    let lbl = (item["label"] as? String) ?? ""
                    if let i = self.accounts.firstIndex(where: { $0.accId == uid }) {
                        if !nm.isEmpty { self.accounts[i].name = nm }
                        if !lbl.isEmpty && self.accounts[i].label.isEmpty { self.accounts[i].label = lbl }
                        self.saveAccounts()
                    }
                    // เรียกเสมอ (ทั้งใหม่+เก่า) เพื่อดึง cookie สดมาทับ
                    self.fetchCookieAndAdd(uid: uid, name: nm.isEmpty ? "\(self.platform.title) \(uid)" : nm, pic: pic, label: lbl)
                }
            }
        }.resume()
    }

    private func fetchCookieAndAdd(uid: String, name: String, pic: String, label: String = "") {
        guard let cq = platform.cookieQueryPath, let url = URL(string: Self.bridgeBase + cq + uid) else { return }
        var req = URLRequest(url: url)
        req.setValue(Self.token, forHTTPHeaderField: "X-Bridge-Token")
        req.setValue(Self.browserUA, forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
            guard let self, let data,
                  let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let cookies = j["cookies"] as? [String: String], cookies[self.platform.loginCookie] != nil else { return }
            Task { @MainActor in
                if let i = self.accounts.firstIndex(where: { $0.accId == uid }) {
                    UserDefaults.standard.set(cookies, forKey: self.ckKey(self.accounts[i].id))  // cookie สดทับ
                    if !pic.isEmpty { self.accounts[i].pic = pic }
                    if !label.isEmpty && self.accounts[i].label.isEmpty { self.accounts[i].label = label }
                    self.webViews[self.accounts[i].id] = nil   // reset ให้ seed cookie ใหม่ตอนเปิด
                    self.saveAccounts()
                } else {
                    let a = Account(id: UUID(), name: name, accId: uid, pic: pic, label: label)
                    UserDefaults.standard.set(cookies, forKey: self.ckKey(a.id))
                    self.accounts.removeAll { $0.accId.isEmpty && $0.name.hasPrefix("บัญชี") }
                    self.accounts.append(a)
                    if self.currentID == nil { self.currentID = a.id }
                    self.saveAccounts()
                }
            }
        }.resume()
    }

    // MARK: - master credential (Keychain + sync bridge)
    private func secKey(_ id: UUID, _ f: String) -> String { "cred_\(platform.rawValue)_\(id.uuidString)_\(f)" }

    func secret(for id: UUID) -> Secret {
        Secret(password: Keychain.get(secKey(id, "password")),
               twoFA:    Keychain.get(secKey(id, "twoFA")),
               datr:     Keychain.get(secKey(id, "datr")))
    }

    // อ่าน datr จาก cookie ที่เก็บไว้ (ถ้ามี) เผื่อกรอกอัตโนมัติ
    func datrFromCookie(_ id: UUID) -> String {
        (UserDefaults.standard.dictionary(forKey: ckKey(id)) as? [String: String])?["datr"] ?? ""
    }

    func setInfo(_ id: UUID, uid: String, email: String, phone: String) {
        guard let i = accounts.firstIndex(where: { $0.id == id }) else { return }
        accounts[i].uid = uid.trimmingCharacters(in: .whitespacesAndNewlines)
        accounts[i].email = email.trimmingCharacters(in: .whitespacesAndNewlines)
        accounts[i].phone = phone.trimmingCharacters(in: .whitespacesAndNewlines)
        saveAccounts()
    }

    func setSecret(_ id: UUID, _ s: Secret) {
        Keychain.set(s.password, secKey(id, "password"))
        Keychain.set(s.twoFA, secKey(id, "twoFA"))
        Keychain.set(s.datr, secKey(id, "datr"))
    }

    // ส่ง credential ครบชุดขึ้น bridge (mac mini) — bridge เก็บ + ใช้ mint FB Lite token
    func syncCredentials(_ id: UUID, done: ((Bool) -> Void)? = nil) {
        guard let a = accounts.first(where: { $0.id == id }),
              let url = URL(string: Self.bridgeBase + "/fb-credentials") else { done?(false); return }
        let s = secret(for: id)
        let uid = a.uid.isEmpty ? a.accId : a.uid
        let body: [String: Any] = [
            "uid": uid, "email": a.email, "phone": a.phone,
            "password": s.password, "twofa": s.twoFA, "datr": s.datr,
            "label": a.label, "name": a.name,
        ]
        var req = URLRequest(url: url); req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.setValue(Self.token, forHTTPHeaderField: "X-Bridge-Token")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: req) { [weak self] _, resp, _ in
            Task { @MainActor in
                let ok = (resp as? HTTPURLResponse)?.statusCode == 200
                self?.showToast(ok ? "✅ ส่งข้อมูล login ขึ้น bridge แล้ว" : "❌ ส่งไม่สำเร็จ (bridge)")
                done?(ok)
            }
        }.resume()
    }

    // สั่ง bridge login FB Lite ใหม่จาก uid/password/2FA/datr → mint token (ตอน session หลุด)
    func reLogin(_ id: UUID, done: ((Bool, String) -> Void)? = nil) {
        guard let a = accounts.first(where: { $0.id == id }),
              let url = URL(string: Self.bridgeBase + "/fb-relogin") else { done?(false, "no url"); return }
        let s = secret(for: id)
        let uid = a.uid.isEmpty ? a.accId : a.uid
        let body: [String: Any] = ["uid": uid, "email": a.email, "phone": a.phone,
                                   "password": s.password, "twofa": s.twoFA, "datr": s.datr]
        var req = URLRequest(url: url); req.httpMethod = "POST"; req.timeoutInterval = 60
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.setValue(Self.token, forHTTPHeaderField: "X-Bridge-Token")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        showToast("🔄 กำลัง re-login FB Lite...")
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
            Task { @MainActor in
                let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                var msg = "HTTP \(code)"
                if let data, let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    if let e = j["error"] as? String { msg = e }
                    else if j["access_token"] != nil || (j["ok"] as? Bool) == true { msg = "ได้ token แล้ว" }
                }
                let ok = code == 200
                self?.showToast(ok ? "✅ re-login สำเร็จ (\(msg))" : "❌ re-login: \(msg)")
                done?(ok, msg)
            }
        }.resume()
    }

    private func showToast(_ m: String) {
        toast = m
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in if self?.toast == m { self?.toast = "" } }
    }
    private func saveAccounts() {
        if let d = try? JSONEncoder().encode(accounts) { UserDefaults.standard.set(d, forKey: storeKey) }
    }
    private func loadAccounts() {
        if let d = UserDefaults.standard.data(forKey: storeKey),
           let a = try? JSONDecoder().decode([Account].self, from: d) { accounts = a }
        // dedup: accId ซ้ำเก็บอันเดียว + ลบ placeholder ว่างถ้ามีบัญชีจริง
        var seen = Set<String>(); var out: [Account] = []
        for acc in accounts {
            if acc.accId.isEmpty { out.append(acc) }
            else if !seen.contains(acc.accId) { seen.insert(acc.accId); out.append(acc) }
        }
        if platform == .higgsfield {
            out.removeAll { $0.accId.hasPrefix("sess_") }   // ล้าง session เก่าที่หมุน (ใช้ id "main" คงที่แทน)
        }
        if out.contains(where: { !$0.accId.isEmpty }) {
            out.removeAll { $0.accId.isEmpty && $0.name.hasPrefix("บัญชี") }
        }
        accounts = out
    }
}

// เก็บ SessionStore ต่อแพลตฟอร์ม (สร้างครั้งเดียว lazy)
@MainActor
final class Hub: ObservableObject {
    private var stores: [Platform: SessionStore] = [:]
    func store(for p: Platform) -> SessionStore {
        if let s = stores[p] { return s }
        let s = SessionStore(p); stores[p] = s; return s
    }
}
