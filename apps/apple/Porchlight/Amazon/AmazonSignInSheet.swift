import PorchKit
import PorchUI
import SwiftUI
import WebKit

/// Settings → Amazon → Connect: Amazon's own sign-in page in a web view that
/// uses the Amazon data store. Two-step codes and captchas happen on
/// Amazon's page. The sheet closes by itself once Your Orders loads.
struct AmazonSignInSheet: View {
    let onSignedIn: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var loading = true
    @State private var closed = false

    var body: some View {
        NavigationStack {
            AmazonWebView(loading: $loading) { url, html in
                // Close only once Your Orders really shows: Amazon can serve a
                // sign-in form or a redirect page at the orders URL first.
                guard !closed, AmazonPages.showsSignedInOrders(url: url, document: HTMLDocument.parse(html)) else { return }
                closed = true
                onSignedIn()
                dismiss()
            }
            .overlay(alignment: .top) {
                if loading { ProgressView().padding(PorchSpacing.m) }
            }
            .navigationTitle("Sign in to Amazon")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .safeAreaInset(edge: .bottom) {
                Text("You sign in on Amazon's page. Your password and cookies stay on this device.")
                    .font(PorchFont.caption)
                    .foregroundStyle(PorchColor.mute)
                    .frame(maxWidth: .infinity)
                    .padding(PorchSpacing.s)
                    .background(PorchColor.canvas)
            }
            .porchChrome()
        }
        #if os(macOS)
        .frame(minWidth: 720, minHeight: 640)
        #endif
    }
}

/// A visible web view on the Amazon data store, reporting each finished page.
@MainActor
private struct AmazonWebView {
    @Binding var loading: Bool
    /// Each finished main-frame page with its rendered HTML.
    let didFinish: (URL, String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    @MainActor
    func makeView(_ coordinator: Coordinator) -> WKWebView {
        let view = WKWebView(frame: .zero, configuration: AmazonWebStore.configuration())
        view.navigationDelegate = coordinator
        view.load(URLRequest(url: AmazonPages.orderHistory))
        return view
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        var parent: AmazonWebView
        init(_ parent: AmazonWebView) { self.parent = parent }

        /// Only amazon.com loads in the sheet. Any other link opens in the
        /// system browser, outside the Amazon data store.
        func webView(
            _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
        ) {
            let mainFrame = navigationAction.targetFrame?.isMainFrame ?? true
            guard mainFrame else { return decisionHandler(.allow) }
            switch AmazonPages.navigationPolicy(for: navigationAction.request.url) {
            case .allow:
                decisionHandler(.allow)
            case .openExternally:
                decisionHandler(.cancel)
                if let url = navigationAction.request.url { Self.openExternally(url) }
            case .block:
                decisionHandler(.cancel)
            }
        }

        private static func openExternally(_ url: URL) {
            #if os(iOS)
            UIApplication.shared.open(url)
            #else
            NSWorkspace.shared.open(url)
            #endif
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            parent.loading = true
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            parent.loading = false
            guard let url = webView.url, AmazonPages.isSignedInPage(url) else { return }
            webView.evaluateJavaScript(AmazonPages.outerHTMLScript) { [weak self] result, _ in
                guard let self, let html = result as? String, webView.url == url else { return }
                self.parent.didFinish(url, html)
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
            parent.loading = false
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
            parent.loading = false
        }
    }
}

#if os(iOS)
extension AmazonWebView: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView { makeView(context.coordinator) }
    func updateUIView(_ view: WKWebView, context: Context) { context.coordinator.parent = self }
}
#else
extension AmazonWebView: NSViewRepresentable {
    func makeNSView(context: Context) -> WKWebView { makeView(context.coordinator) }
    func updateNSView(_ view: WKWebView, context: Context) { context.coordinator.parent = self }
}
#endif
