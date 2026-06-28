import Foundation
#if canImport(CryptoKit)
import CryptoKit
#endif
import AccountsBridgeKit

func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() {
        fputs("FAIL: \(message)\n", stderr)
        exit(1)
    }
}

check(BridgeRole.pagePostingFacebookLite.rawValue == "page_posting_facebook_lite", "Facebook Lite role key drifted")
check(BridgeRole.adsPowerEditor.rawValue == "ads_power_editor", "Power Editor role key drifted")
check(Platform.facebook.rawValue == "facebook", "facebook platform key drifted")

let json = """
{"account_uid":"uid","role":"page_posting_facebook_lite","page_id":null,"version":"v1",
 "source":"facebook_lite_bridge","blob_digest":"abc","has_blob":true,"status":"active"}
""".data(using: .utf8)!
let meta = try JSONDecoder().decode(SessionMeta.self, from: json)
check(meta.hasBlob == true, "session meta hasBlob decode failed")
check(meta.blobDigest == "abc", "session meta digest decode failed")

#if canImport(CryptoKit)
let sealer = LocalBlobSealer(key: SymmetricKey(size: .bits256))
let sealed = try sealer.seal(Data("c_user=123; xs=secret".utf8))
check(sealed.hasPrefix("enc:gcm:"), "sealed blob missing ciphertext prefix")
check(!sealed.contains("c_user="), "sealed blob leaked plaintext")

// Profile-archive envelope: sealArchive must prefix the ABENC1 magic, hide the plaintext, and
// round-trip back to the original bytes via unsealArchive.
let fakeArchive = Data("\u{1f}\u{8b}fake-tar-gz-bytes-c_user=plaintext".utf8)
let envelope = try sealer.sealArchive(fakeArchive)
check(envelope.prefix(6) == Data("ABENC1".utf8), "sealed archive missing ABENC1 magic")
check(envelope.count > fakeArchive.count, "sealed archive should add envelope overhead")
let restored = try sealer.unsealArchive(envelope)
check(restored == fakeArchive, "archive did not round-trip through seal/unseal")

// Manifest safety: the essential-paths allowlist must contain no absolute paths or `..` traversal.
for p in ProfileArchive.essentialPaths + ProfileArchive.userDataRootPaths {
    check(!p.hasPrefix("/"), "essential path must be relative: \(p)")
    check(!p.contains(".."), "essential path must not traverse: \(p)")
}
check(ProfileArchive.essentialPaths.contains("Cookies"), "essential paths must include Cookies")

// ProfileArchiveMeta decode is non-secret-only (no ciphertext field).
let metaJson = """
{"platform":"facebook","role":"page_posting_facebook_lite","account_uid":"uid",
 "blob_digest":"abc","byte_size":1234,"cipher":"aesgcm","version":"v1","source":"local",
 "status":"active","has_archive":true}
""".data(using: .utf8)!
let archMeta = try JSONDecoder().decode(ProfileArchiveMeta.self, from: metaJson)
check(archMeta.hasArchive == true && archMeta.byteSize == 1234, "ProfileArchiveMeta decode failed")
#endif

print("ACCOUNTS_BRIDGE_SWIFT_CONTRACT_OK")
