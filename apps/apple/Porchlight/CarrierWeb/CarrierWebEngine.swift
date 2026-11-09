import Foundation
import OSLog
import PorchKit
import WebKit
#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// The carriers' web data store: one persistent store for USPS, UPS and
/// FedEx, apart from the Amazon one. It is never cleared between lookups,
/// because the carriers' bot checks score a browser with cookies it has seen
/// before better (docs/research/scraping.md). It holds no Porchlight data.
enum CarrierWebStore {
    /// Fixed so the same store opens on every launch. Not AmazonWebStore's.
    static let identifier = UUID(uuidString: "C7A3F1E2-4B6D-4E0A-8F59-3D2B7C1A6E94")!

    @MainActor static func configuration(handler: any WKScriptMessageHandler) -> WKWebViewConfiguration {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = WKWebsiteDataStore(forIdentifier: identifier)
        config.applicationNameForUserAgent = "Version/18.6 Safari/605.1.15"
        let content = WKUserContentController()
        content.addUserScript(WKUserScript(source: CarrierCaptureScript.source, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        content.add(handler, name: CarrierCaptureScript.handlerName)
        config.userContentController = content
        return config
    }
}

/// Reads one carrier page at a time in a web view nobody sees. It stays in
/// the view hierarchy at 1×1 points and alpha 0.01, because a detached web
/// view has its timers throttled and the carriers' bot checks stall.
///
/// UPS and FedEx: the page's own tracking call is captured by the injected
/// script. USPS: the rendered HTML, once the tracking layout is there. A bot
/// check or CAPTCHA is never answered; the read comes back as a challenge.
@MainActor
final class CarrierWebEngine: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    /// How long USPS gets to finish rendering once its layout appears.
    private static let settle: Duration = .milliseconds(1500)
    /// FedEx: when its page hasn't made the call by then, submit its search form.
    private static let fedExFormAfter: Duration = .seconds(10)
    private static let tick: Duration = .seconds(1)

    private var webView: WKWebView?
    #if os(macOS)
    private var hostWindow: NSWindow?
    #endif
    private var job: DeviceJob?
    private var pending: CheckedContinuation<CarrierCapture, any Error>?
    private let log = Logger(subsystem: "co.xanom.porchlight", category: "carriers")

    func read(_ job: DeviceJob, timeout: Duration) async throws -> CarrierCapture {
        guard let url = CarrierPages.pageURL(for: job.carrier, trackingNumber: job.trackingNumber) else {
            throw CarrierReadError.failed("no tracking page for this carrier")
        }
        finish(.failure(CancellationError()))
        let view = webView ?? makeWebView()
        attach(view)
        self.job = job
        let watcher = Task { [weak self] in await self?.watch(job, timeout: timeout) }
        defer {
            watcher.cancel()
            self.job = nil
            view.stopLoading()
            // Leave the carrier page so its scripts stop running between lookups.
            view.load(URLRequest(url: URL(string: "about:blank")!))
        }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<CarrierCapture, any Error>) in
                pending = cont
                view.load(URLRequest(url: url))
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.finish(.failure(CancellationError())) }
        }
    }

    // MARK: Watching the page

    /// USPS: waits for the layout, then takes the HTML. FedEx: submits the
    /// form once if its call hasn't come. At the timeout: a challenge page is
    /// returned as such, anything else is a timeout.
    private func watch(_ job: DeviceJob, timeout: Duration) async {
        let clock = ContinuousClock()
        let start = clock.now
        var submittedForm = false
        while !Task.isCancelled, clock.now - start < timeout {
            try? await Task.sleep(for: Self.tick)
            guard !Task.isCancelled, let view = webView, self.job == job else { return }
            switch job.carrier {
            case .usps:
                if (try? await view.evaluateJavaScript(CarrierCaptureScript.uspsReady)) as? Bool == true {
                    try? await Task.sleep(for: Self.settle)
                    guard !Task.isCancelled, self.job == job else { return }
                    if let html = await outerHTML(view) {
                        finish(.success(.page(url: view.url ?? URL(string: "https://tools.usps.com/")!, html: html)))
                        return
                    }
                }
            case .fedex where !submittedForm && clock.now - start >= Self.fedExFormAfter:
                submittedForm = true
                _ = try? await view.evaluateJavaScript(CarrierCaptureScript.fedExSubmit(job.trackingNumber))
            default:
                break
            }
        }
        guard !Task.isCancelled, let view = webView, self.job == job else { return }
        if let html = await outerHTML(view), CarrierChallenge.kind(of: html) != .none, let pageURL = view.url {
            finish(.success(.page(url: pageURL, html: html)))
        } else {
            finish(.failure(CarrierReadError.timedOut))
        }
    }

    private func outerHTML(_ view: WKWebView) async -> String? {
        (try? await view.evaluateJavaScript("document.documentElement.outerHTML")) as? String
    }

    private func finish(_ result: Result<CarrierCapture, any Error>) {
        guard let cont = pending else { return }
        pending = nil
        cont.resume(with: result)
    }

    // MARK: The view

    private func makeWebView() -> WKWebView {
        let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 1, height: 1), configuration: CarrierWebStore.configuration(handler: WeakMessageHandler(self)))
        view.navigationDelegate = self
        #if os(iOS)
        view.alpha = 0.01
        view.isUserInteractionEnabled = false
        view.accessibilityElementsHidden = true
        #else
        view.alphaValue = 0.01
        view.setAccessibilityElement(false)
        #endif
        webView = view
        return view
    }

    #if os(iOS)
    /// Into the app's window, behind everything. In a background refresh with
    /// no window yet, the read still runs, only slower.
    private func attach(_ view: WKWebView) {
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        guard let window = windows.first(where: \.isKeyWindow) ?? windows.first else { return }
        if view.superview !== window {
            view.removeFromSuperview()
            window.insertSubview(view, at: 0)
        }
    }
    #else
    /// Into a 1×1 borderless window of its own that takes no clicks, so it
    /// works with the main window closed and only the menu-bar item running.
    private func attach(_ view: WKWebView) {
        if let hostWindow, view.superview != nil {
            hostWindow.orderFrontRegardless()
            return
        }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1, height: 1), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.ignoresMouseEvents = true
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.isExcludedFromWindowsMenu = true
        window.collectionBehavior = [.transient, .ignoresCycle, .stationary, .canJoinAllSpaces]
        window.contentView = view
        window.orderFrontRegardless()
        hostWindow = window
    }
    #endif

    // MARK: WKScriptMessageHandler

    /// A capture from the injected script. Only one from a carrier frame, for
    /// the job's carrier and one of its capture URLs, is taken.
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let job, message.name == CarrierCaptureScript.handlerName,
              let body = message.body as? [String: Any], let url = body["url"] as? String, let text = body["body"] as? String,
              CarrierPages.acceptsCapture(frameHost: message.frameInfo.securityOrigin.host, url: url, body: text, carrier: job.carrier)
        else { return }
        let status = (body["status"] as? NSNumber)?.intValue ?? 0
        finish(.success(.response(url: url, status: status, body: text)))
    }

    // MARK: WKNavigationDelegate

    /// Every frame stays on the job's carrier, over https. A main frame sent
    /// anywhere else ends the read.
    func webView(
        _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
    ) {
        let url = navigationAction.request.url
        let allowed = job.map { CarrierPages.allowsNavigation(to: url, carrier: $0.carrier) } ?? (url?.absoluteString == "about:blank")
        guard allowed else {
            decisionHandler(.cancel)
            if navigationAction.targetFrame?.isMainFrame ?? true, job != nil {
                log.error("blocked a navigation away from the carrier's site")
                finish(.failure(CarrierReadError.failed("the page went to another site")))
            }
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
        failed(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
        failed(error)
    }

    /// A redirect or a cancelled navigation reports "cancelled"; the watcher carries on.
    private func failed(_ error: any Error) {
        let ns = error as NSError
        if ns.code == NSURLErrorCancelled || (ns.domain == "WebKitErrorDomain" && ns.code == 102) { return }
        guard job != nil else { return }
        log.error("carrier page failed: \(ns.code, privacy: .public)")
        finish(.failure(CarrierReadError.failed(ns.localizedDescription)))
    }
}

/// WKUserContentController keeps its handlers alive; this keeps the engine out of that cycle.
@MainActor
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: (any WKScriptMessageHandler)?

    init(_ target: any WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}

/// PorchKit's reader seam, backed by the engine on the main actor.
struct CarrierWebPageReader: CarrierPageReading {
    let engine: CarrierWebEngine

    func read(_ job: DeviceJob, timeout: Duration) async throws -> CarrierCapture {
        try await engine.read(job, timeout: timeout)
    }
}
