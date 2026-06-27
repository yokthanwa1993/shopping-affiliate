// swift-tools-version:5.9
// Accounts Bridge v2 — native macOS operator app scaffold.
//
// This is the SIDE-BY-SIDE native direction for the local operator app. It is API-first: the app
// performs login / token-mint / browser steps locally (in the existing facebook-token-cloak bridge
// or a future native module), encrypts any secret blob LOCALLY, and persists ONLY durable,
// ownership-explicit state to the Accounts Bridge v2 Worker over the v1 HTTP API.
//
// AccountsBridgeKit is the token-free API client. AccountsBridgeApp is a status/config-only SwiftUI
// shell — opening it must never mint a token, refresh, log in, autofill, submit, or open Chrome.
import PackageDescription

let package = Package(
    name: "AccountsBridge",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "AccountsBridgeKit", targets: ["AccountsBridgeKit"]),
        .executable(name: "AccountsBridgeApp", targets: ["AccountsBridgeApp"])
    ],
    targets: [
        .target(name: "AccountsBridgeKit"),
        .executableTarget(
            name: "AccountsBridgeApp",
            dependencies: ["AccountsBridgeKit"]
        ),
        .testTarget(
            name: "AccountsBridgeKitTests",
            dependencies: ["AccountsBridgeKit"]
        )
    ]
)
