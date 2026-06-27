import Foundation
#if canImport(CryptoKit)
import CryptoKit
#endif

/// Token-free HTTP client for the Accounts Bridge v2 v1 API.
///
/// CONTRACT (mirrors the Worker invariants):
///   * This client only persists/reads durable state. It NEVER mints/refreshes a token, logs in,
///     autofills, submits a form, or opens a browser. Those steps live in the local bridge/native
///     login module; their *outputs* (already encrypted) are pushed here.
///   * Secret blobs are encrypted LOCALLY (see `LocalBlobSealer`) before `storeSession`/`storeCookie`.
///     The Worker stores ciphertext only and returns it to no one.
///   * The shared local-bridge API key is read from the macOS Keychain, never hard-coded.
public struct AccountsBridgeClient: Sendable {
    public let baseURL: URL
    private let apiKey: String
    private let session: URLSession

    public init(baseURL: URL, apiKey: String, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.apiKey = apiKey
        self.session = session
    }

    // MARK: - Read (status/config only)

    public func health() async throws -> Bool {
        let (data, response) = try await get("/health", authed: false)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { return false }
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        return (obj?["ok"] as? Bool) ?? false
    }

    public func listAccounts(platform: Platform? = nil) async throws -> [Account] {
        let path = platform.map { "/v1/accounts?platform=\($0.rawValue)" } ?? "/v1/accounts"
        let (data, _) = try await get(path)
        struct Wrap: Decodable { let accounts: [Account] }
        return try JSONDecoder().decode(Wrap.self, from: data).accounts
    }

    public func facebookRoles() async throws -> [String: RoleAssignment?] {
        let (data, _) = try await get("/v1/roles/facebook")
        struct Wrap: Decodable { let roles: [String: RoleAssignment?] }
        return try JSONDecoder().decode(Wrap.self, from: data).roles
    }

    public func pageBindings(pageId: String, platform: Platform = .facebook) async throws -> [PageBinding] {
        let (data, _) = try await get("/v1/pages/\(escape(pageId))/binding?platform=\(platform.rawValue)")
        struct Wrap: Decodable { let bindings: [PageBinding] }
        return try JSONDecoder().decode(Wrap.self, from: data).bindings
    }

    public func sessionStatus(accountUid: String, role: BridgeRole, platform: Platform = .facebook) async throws -> SessionStatus {
        let q = "account_uid=\(escape(accountUid))&role=\(role.rawValue)&platform=\(platform.rawValue)"
        let (data, _) = try await get("/v1/sessions/status?\(q)")
        return try JSONDecoder().decode(SessionStatus.self, from: data)
    }

    // MARK: - Write (durable state)

    @discardableResult
    public func createAccount(accountUid: String, platform: Platform, displayLabel: String?) async throws -> Account {
        var body: [String: Any] = ["account_uid": accountUid, "platform": platform.rawValue]
        if let displayLabel { body["display_label"] = displayLabel }
        let (data, _) = try await post("/v1/accounts", body: body)
        struct Wrap: Decodable { let account: Account }
        return try JSONDecoder().decode(Wrap.self, from: data).account
    }

    public func assignFacebookRole(_ role: BridgeRole, accountUid: String?, source: String? = nil, version: String? = nil) async throws {
        var body: [String: Any] = ["roles": [role.rawValue: accountUid as Any]]
        if let source { body["source"] = source }
        if let version { body["version"] = version }
        _ = try await put("/v1/roles/facebook", body: body)
    }

    public func bindPage(pageId: String, accountUid: String, role: BridgeRole, platform: Platform = .facebook, source: String? = nil) async throws -> PageBinding {
        var body: [String: Any] = ["account_uid": accountUid, "role": role.rawValue, "platform": platform.rawValue]
        if let source { body["source"] = source }
        let (data, _) = try await put("/v1/pages/\(escape(pageId))/binding?platform=\(platform.rawValue)", body: body)
        struct Wrap: Decodable { let binding: PageBinding }
        return try JSONDecoder().decode(Wrap.self, from: data).binding
    }

    /// Stores an already-encrypted session blob. `sealedBlob` MUST be ciphertext (see `LocalBlobSealer`).
    @discardableResult
    public func storeSession(accountUid: String, role: BridgeRole, sealedBlob: String, version: String, source: String, pageId: String? = nil, platform: Platform = .facebook) async throws -> SessionMeta {
        var body: [String: Any] = [
            "account_uid": accountUid, "role": role.rawValue, "platform": platform.rawValue,
            "version": version, "source": source, "encrypted_blob": sealedBlob
        ]
        if let pageId { body["page_id"] = pageId }
        let (data, _) = try await post("/v1/sessions", body: body)
        struct Wrap: Decodable { let session: SessionMeta }
        return try JSONDecoder().decode(Wrap.self, from: data).session
    }

    public func recordAudit(eventType: String, accountUid: String? = nil, platform: Platform? = nil, role: BridgeRole? = nil, pageId: String? = nil, detail: [String: String]? = nil) async throws {
        var body: [String: Any] = ["event_type": eventType]
        if let accountUid { body["account_uid"] = accountUid }
        if let platform { body["platform"] = platform.rawValue }
        if let role { body["role"] = role.rawValue }
        if let pageId { body["page_id"] = pageId }
        if let detail { body["detail"] = detail }
        _ = try await post("/v1/audit/events", body: body)
    }

    // MARK: - transport

    private func escape(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? s
    }

    private func get(_ path: String, authed: Bool = true) async throws -> (Data, URLResponse) {
        try await send("GET", path, body: nil, authed: authed)
    }
    private func post(_ path: String, body: [String: Any]) async throws -> (Data, URLResponse) {
        try await send("POST", path, body: body)
    }
    private func put(_ path: String, body: [String: Any]) async throws -> (Data, URLResponse) {
        try await send("PUT", path, body: body)
    }

    private func send(_ method: String, _ path: String, body: [String: Any]?, authed: Bool = true) async throws -> (Data, URLResponse) {
        var req = URLRequest(url: baseURL.appendingPathComponent(String(path.split(separator: "?").first ?? "")))
        if let query = path.split(separator: "?", maxSplits: 1).dropFirst().first {
            var comps = URLComponents(url: req.url!, resolvingAgainstBaseURL: false)!
            comps.percentEncodedQuery = String(query)
            req.url = comps.url
        }
        req.httpMethod = method
        if authed { req.setValue(apiKey, forHTTPHeaderField: "x-accounts-bridge-key") }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "content-type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: req)
        if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
            throw BridgeError.http(status: http.statusCode, body: String(data: data, encoding: .utf8) ?? "")
        }
        return (data, response)
    }
}

public enum BridgeError: Error {
    case http(status: Int, body: String)
    case sealingUnavailable
}

/// Seals a secret blob LOCALLY with a symmetric key held on this machine (Keychain/Worker secret),
/// producing the ciphertext string handed to `storeSession`/`storeCookie`. The key never leaves the
/// device and is never sent to the Worker. This is the ONLY place plaintext secret material is
/// handled, and it is on the local native side — never in an API response.
public struct LocalBlobSealer {
    private let key: SymmetricKey

    public init(key: SymmetricKey) { self.key = key }

    public func seal(_ plaintext: Data) throws -> String {
        #if canImport(CryptoKit)
        let box = try AES.GCM.seal(plaintext, using: key)
        guard let combined = box.combined else { throw BridgeError.sealingUnavailable }
        return "enc:gcm:" + combined.base64EncodedString()
        #else
        throw BridgeError.sealingUnavailable
        #endif
    }
}
