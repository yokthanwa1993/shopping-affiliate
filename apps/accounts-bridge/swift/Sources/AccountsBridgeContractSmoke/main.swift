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
#endif

print("ACCOUNTS_BRIDGE_SWIFT_CONTRACT_OK")
