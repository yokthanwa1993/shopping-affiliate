import Foundation

// Non-secret value types mirroring the Accounts Bridge v2 v1 API shapes.
//
// NOTE: there is intentionally NO `encryptedBlob` field on any *response* model. Session/cookie
// responses expose only a digest + version + flags. The plaintext never round-trips through the API.

public enum Platform: String, Codable, Sendable {
    case facebook
    case shopee
}

/// The two conceptually-separate Facebook roles. Page posting is Facebook Lite / Token Bridge ONLY;
/// ad creation is Power Editor ONLY.
public enum BridgeRole: String, Codable, Sendable {
    case pagePostingFacebookLite = "page_posting_facebook_lite"
    case adsPowerEditor = "ads_power_editor"
}

public struct Account: Codable, Sendable, Identifiable {
    public let id: String
    public let accountUid: String
    public let platform: Platform
    public let displayLabel: String?
    public let status: String

    enum CodingKeys: String, CodingKey {
        case id
        case accountUid = "account_uid"
        case platform
        case displayLabel = "display_label"
        case status
    }
}

public struct RoleAssignment: Codable, Sendable {
    public let accountUid: String
    public let source: String?
    public let version: String?

    enum CodingKeys: String, CodingKey {
        case accountUid = "account_uid"
        case source
        case version
    }
}

public struct PageBinding: Codable, Sendable, Identifiable {
    public let id: String
    public let pageId: String
    public let platform: Platform
    public let accountUid: String
    public let role: BridgeRole
    public let displayLabel: String?

    enum CodingKeys: String, CodingKey {
        case id
        case pageId = "page_id"
        case platform
        case accountUid = "account_uid"
        case role
        case displayLabel = "display_label"
    }
}

/// Status-only view of a stored session. `blobDigest` + `hasBlob` let the UI show "present / version"
/// without ever seeing the ciphertext, let alone the plaintext.
public struct SessionStatus: Codable, Sendable {
    public let present: Bool
    public let count: Int
    public let latest: SessionMeta?
}

public struct SessionMeta: Codable, Sendable {
    public let accountUid: String
    public let role: BridgeRole
    public let pageId: String?
    public let version: String
    public let source: String
    public let blobDigest: String
    public let hasBlob: Bool
    public let status: String

    enum CodingKeys: String, CodingKey {
        case accountUid = "account_uid"
        case role
        case pageId = "page_id"
        case version
        case source
        case blobDigest = "blob_digest"
        case hasBlob = "has_blob"
        case status
    }
}
