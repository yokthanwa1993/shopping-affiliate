import XCTest
@testable import AccountsBridgeKit

// Lightweight contract checks. These do NOT hit the network — they assert the client encodes the
// API contract correctly and that the local sealer only ever emits ciphertext (never plaintext).
final class ContractTests: XCTestCase {
    func testRoleRawValuesMatchApiContract() {
        XCTAssertEqual(BridgeRole.pagePostingFacebookLite.rawValue, "page_posting_facebook_lite")
        XCTAssertEqual(BridgeRole.adsPowerEditor.rawValue, "ads_power_editor")
        XCTAssertEqual(Platform.facebook.rawValue, "facebook")
    }

    func testSessionMetaHasNoPlaintextBlobField() throws {
        // Decoding a status payload must succeed WITHOUT any encrypted/plaintext blob field present.
        let json = """
        {"account_uid":"uid","role":"page_posting_facebook_lite","page_id":null,"version":"v1",
         "source":"facebook_lite_bridge","blob_digest":"abc","has_blob":true,"status":"active"}
        """.data(using: .utf8)!
        let meta = try JSONDecoder().decode(SessionMeta.self, from: json)
        XCTAssertTrue(meta.hasBlob)
        XCTAssertEqual(meta.blobDigest, "abc")
    }

    func testLocalSealerEmitsCiphertextPrefix() throws {
        #if canImport(CryptoKit)
        let sealer = LocalBlobSealer(key: .init(size: .bits256))
        let sealed = try sealer.seal(Data("c_user=123; xs=secret".utf8))
        XCTAssertTrue(sealed.hasPrefix("enc:gcm:"))
        XCTAssertFalse(sealed.contains("c_user="), "sealed blob must not contain plaintext")
        #endif
    }
}
