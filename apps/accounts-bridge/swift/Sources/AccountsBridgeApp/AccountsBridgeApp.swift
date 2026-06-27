import SwiftUI
import AccountsBridgeKit

// Status/config-ONLY operator shell.
//
// Hard rule: rendering this view must NOT mint a token, refresh, log in, autofill, submit, or open a
// browser. `.task` only performs READ calls (health + role/binding/session STATUS). All mutating
// actions are explicit, operator-initiated buttons that call the durable-state write APIs — they
// still never drive a browser here; native login/token-mint lives in a separate module.

@main
struct AccountsBridgeApp: App {
    var body: some Scene {
        WindowGroup("Accounts Bridge") {
            StatusView()
        }
    }
}

@MainActor
final class StatusModel: ObservableObject {
    @Published var healthy = false
    @Published var accounts: [Account] = []
    @Published var roles: [String: RoleAssignment?] = [:]
    @Published var lastError: String?

    let client: AccountsBridgeClient

    init(client: AccountsBridgeClient) { self.client = client }

    /// Read-only refresh. Safe to call on view appear — performs no login/token/browser action.
    func refreshStatus() async {
        do {
            healthy = try await client.health()
            accounts = try await client.listAccounts(platform: .facebook)
            roles = try await client.facebookRoles()
            lastError = nil
        } catch {
            lastError = "\(error)"
        }
    }
}

struct StatusView: View {
    @StateObject private var model = StatusModel(
        client: AccountsBridgeClient(
            baseURL: URL(string: ProcessInfo.processInfo.environment["ACCOUNTS_BRIDGE_URL"] ?? "http://127.0.0.1:8787")!,
            apiKey: KeychainKey.read("accounts-bridge-api-key") ?? ""
        )
    )

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Accounts Bridge v2 — status").font(.headline)
            Label(model.healthy ? "Worker reachable" : "Worker unreachable",
                  systemImage: model.healthy ? "checkmark.seal" : "xmark.seal")
            Text("Facebook page-posting owner: \(ownerLabel(.pagePostingFacebookLite))")
            Text("Facebook ads owner: \(ownerLabel(.adsPowerEditor))")
            if let err = model.lastError { Text(err).font(.caption).foregroundStyle(.red) }
        }
        .padding()
        // READ-ONLY on appear. No login, no token mint, no browser.
        .task { await model.refreshStatus() }
    }

    private func ownerLabel(_ role: BridgeRole) -> String {
        (model.roles[role.rawValue] ?? nil)?.accountUid ?? "—"
    }
}

/// Placeholder for the macOS Keychain read used to fetch the shared local-bridge API key. The real
/// implementation uses SecItemCopyMatching; the key value is NEVER hard-coded or logged.
enum KeychainKey {
    static func read(_ name: String) -> String? {
        // Wired to the macOS Keychain in the shipping app. Returns nil in the scaffold.
        ProcessInfo.processInfo.environment["ACCOUNTS_BRIDGE_API_KEY"]
    }
}
