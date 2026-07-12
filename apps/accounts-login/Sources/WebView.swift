import SwiftUI
import WebKit

/// ห่อ WKWebView ให้ SwiftUI ใช้ (ใช้ instance เดียวจาก AppModel เพื่อเข้าถึง cookie store ได้)
struct WebView: UIViewRepresentable {
    let webView: WKWebView

    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
