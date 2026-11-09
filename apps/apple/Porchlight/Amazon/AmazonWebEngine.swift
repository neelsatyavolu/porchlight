import Foundation
import OSLog
import PorchKit
import WebKit

/// The Amazon web data store and the hidden web view that reads pages with it.
///
/// Amazon's cookies live only in this persistent `WKWebsiteDataStore`, kept
/// apart from every other web view in the app (SPEC §6). Porchlight never
/// reads the cookies and never sends them anywhere: the only thing taken from
/// a page is its rendered HTML, which PorchKit parses on the device.
enum AmazonWebStore {
    /// Fixed so the same store opens on every launch.
    static let identifier = UUID(uuidString: "6E2C1D1A-7B0F-4F4B-9C55-0F3E8A2B9D41")!

    @MainActor static func dataStore() -> WKWebsiteDataStore { WKWebsiteDataStore(forIdentifier: identifier) }

    @MainActor static func configuration() -> WKWebViewConfiguration {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = dataStore()
        // Amazon's desktop pages are the ones the parser knows; iOS asks for them too.
        config.defaultWebpagePreferences.preferredContentMode = .desktop
        return config
    }

    /// Deletes the store and with it the Amazon sign-in. No web view may be using it.
    /// If the store can't be removed (still in use), its cookies and other
    /// data are cleared instead, so Disconnect always signs out of Amazon.
    @MainActor static func remove() async throws {
        do {
            try await WKWebsiteDataStore.remove(forIdentifier: identifier)
        } catch {
            let store = dataStore()
            await store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
            throw error
        }
    }
}

enum AmazonLoadError: Error {
    case timedOut
    case noHTML
    case failed(String)
}

/// Loads one page at a time in a web view that is never on screen.
@MainActor
final class AmazonWebEngine: NSObject, WKNavigationDelegate {
    /// How long a page may take, and how long to let its scripts render after it loads.
    private static let timeout: Duration = .seconds(30)
    private static let settle: Duration = .milliseconds(1500)

    private var webView: WKWebView?
    private var pending: CheckedContinuation<Void, any Error>?
    /// Set by `tearDown` (Disconnect) so an import still running can't open
    /// the store again while it is being removed. `reopen` clears it.
    private var closed = false
    private let log = Logger(subsystem: "co.xanom.porchlight", category: "amazon")

    func load(_ url: URL) async throws -> AmazonLoadedPage {
        guard !closed else { throw CancellationError() }
        guard AmazonPages.isAmazonURL(url) else { throw AmazonLoadError.failed("Not an Amazon page") }
        let view = webView ?? makeWebView()
        try await navigate(view, to: url)
        try await Task.sleep(for: Self.settle)
        guard !closed, let html = try await view.evaluateJavaScript(AmazonPages.outerHTMLScript) as? String else { throw AmazonLoadError.noHTML }
        return AmazonLoadedPage(url: view.url ?? url, html: html)
    }

    /// Drops the web view so the data store can be removed.
    func tearDown() {
        closed = true
        webView?.stopLoading()
        webView?.navigationDelegate = nil
        webView = nil
        finish(.failure(CancellationError()))
    }

    /// After a new Connect.
    func reopen() {
        closed = false
    }

    private func makeWebView() -> WKWebView {
        let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 1280, height: 900), configuration: AmazonWebStore.configuration())
        view.navigationDelegate = self
        webView = view
        return view
    }

    private func navigate(_ view: WKWebView, to url: URL) async throws {
        finish(.failure(CancellationError()))
        let timer = Task { [weak self] in
            try await Task.sleep(for: Self.timeout)
            self?.webView?.stopLoading()
            self?.finish(.failure(AmazonLoadError.timedOut))
        }
        defer { timer.cancel() }
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, any Error>) in
            pending = cont
            view.load(URLRequest(url: url))
        }
    }

    private func finish(_ result: Result<Void, any Error>) {
        guard let cont = pending else { return }
        pending = nil
        cont.resume(with: result)
    }

    // MARK: WKNavigationDelegate

    /// The hidden view only ever loads amazon.com; a redirect anywhere else is dropped.
    func webView(
        _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
    ) {
        let mainFrame = navigationAction.targetFrame?.isMainFrame ?? true
        if mainFrame, AmazonPages.navigationPolicy(for: navigationAction.request.url) != .allow {
            log.error("blocked a navigation away from amazon.com")
            decisionHandler(.cancel)
            finish(.failure(AmazonLoadError.failed("Amazon sent the page somewhere else")))
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        finish(.success(()))
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
        failed(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
        failed(error)
    }

    /// A navigation replaced by a redirect reports "cancelled"; the next one finishes.
    private func failed(_ error: any Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        log.error("amazon page failed: \((error as NSError).code, privacy: .public)")
        finish(.failure(AmazonLoadError.failed((error as NSError).localizedDescription)))
    }
}

/// PorchKit's loader seam, backed by the engine on the main actor.
struct AmazonWebPageLoader: AmazonPageLoading {
    let engine: AmazonWebEngine

    func load(_ url: URL) async throws -> AmazonLoadedPage {
        try await engine.load(url)
    }
}
