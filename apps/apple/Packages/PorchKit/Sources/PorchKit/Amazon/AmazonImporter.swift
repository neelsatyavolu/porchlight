import Foundation

/// A page as the web view rendered it: where it ended up after redirects, and its HTML.
public struct AmazonLoadedPage: Sendable {
    public var url: URL
    public var html: String

    public init(url: URL, html: String) {
        self.url = url
        self.html = html
    }
}

/// Loads an amazon.com page in the app's own Amazon web view (its separate
/// data store) and returns `document.documentElement.outerHTML`. The app
/// target implements it with WKWebView; tests replay fixtures.
public protocol AmazonPageLoading: Sendable {
    func load(_ url: URL) async throws -> AmazonLoadedPage
}

/// How one import run ended.
public enum AmazonImportResult: Hashable, Sendable {
    /// `items` were sent; `rejected` of them the server refused.
    case imported(items: Int, rejected: Int)
    case needsSignIn
    /// The pages loaded but held nothing the parser knows.
    case parseFailed(String)
    /// Amazon or Porchlight couldn't be reached. Try again next time.
    case failed(String)
}

/// One import: Your Orders, then the track page of each open shipment, then
/// `POST /v1/imports/amazon` (SPEC §6).
public struct AmazonImporter: Sendable {
    public var loader: any AmazonPageLoading
    public var api: any APIClient
    public var detector: any CarrierDetector
    public var timeZone: TimeZone
    public var now: @Sendable () -> Date
    /// Wait between page loads, to read at a person's pace.
    public var pause: Duration
    /// At most this many track pages per run.
    public var maxTrackPages: Int
    /// No new track page is opened after this time; what was read so far is
    /// still sent. An iOS background refresh gets about 30 seconds in all, and
    /// each page takes a few, so a run there would otherwise be cut off before
    /// it sends anything. The first open shipment is always read.
    public var deadline: Date?

    /// The time an import may spend reading pages in an iOS background refresh.
    public static let backgroundBudget: TimeInterval = 18

    public init(
        loader: any AmazonPageLoading, api: any APIClient, detector: any CarrierDetector = RuleCarrierDetector(),
        timeZone: TimeZone = .current, now: @escaping @Sendable () -> Date = Date.init,
        pause: Duration = .seconds(2), maxTrackPages: Int = 15, deadline: Date? = nil
    ) {
        self.loader = loader
        self.api = api
        self.detector = detector
        self.timeZone = timeZone
        self.now = now
        self.pause = pause
        self.maxTrackPages = maxTrackPages
        self.deadline = deadline
    }

    static let ordersUnreadable = "Couldn't read Your Orders. Amazon may have changed the page."
    static let tracksUnreadable = "Couldn't read Amazon's tracking pages. Amazon may have changed them."
    static let amazonUnreachable = "Couldn't reach Amazon."

    public func run() async -> AmazonImportResult {
        do {
            return try await runThrowing()
        } catch is CancellationError {
            return .failed("The import was stopped before it finished.")
        } catch let error as APIError {
            return .failed("Couldn't send packages to Porchlight. \(error.localizedDescription)")
        } catch {
            return .failed(Self.amazonUnreachable)
        }
    }

    private func runThrowing() async throws -> AmazonImportResult {
        let ordersPage = try await loader.load(AmazonPages.orderHistory)
        let ordersDoc = HTMLDocument.parse(ordersPage.html)
        switch AmazonPages.kind(of: ordersPage.url, document: ordersDoc) {
        case .signIn, .challenge: return .needsSignIn
        default: break
        }
        let list = AmazonOrderList.parse(ordersDoc)
        if list.orderCount == 0 { return list.isEmpty ? .imported(items: 0, rejected: 0) : .parseFailed(Self.ordersUnreadable) }

        let builder = AmazonImportBuilder(text: AmazonText(now: now(), timeZone: timeZone), detector: detector)
        let open = list.shipments.filter(builder.isOpen).prefix(maxTrackPages)
        var items: [AmazonImportItem] = []
        var recognized = 0
        for (index, shipment) in open.enumerated() {
            if index > 0, let deadline, now() >= deadline { break }
            try Task.checkCancellation()
            try await Task.sleep(for: pause)
            let page = try await loader.load(shipment.trackURL)
            let doc = HTMLDocument.parse(page.html)
            switch AmazonPages.kind(of: page.url, document: doc) {
            case .signIn, .challenge: return .needsSignIn
            default: break
            }
            let track = AmazonTrackPage.parse(doc, text: builder.text)
            if track.recognized { recognized += 1 }
            if let item = builder.item(for: shipment, track: track) { items.append(item) }
        }
        if !open.isEmpty, recognized == 0 { return .parseFailed(Self.tracksUnreadable) }

        var rejected = 0
        for start in stride(from: 0, to: items.count, by: 100) {
            let chunk = Array(items[start..<min(start + 100, items.count)])
            let response = try await api.importAmazon(chunk)
            rejected += response.results.filter { $0.outcome == .rejected }.count
        }
        return .imported(items: items.count, rejected: rejected)
    }
}
