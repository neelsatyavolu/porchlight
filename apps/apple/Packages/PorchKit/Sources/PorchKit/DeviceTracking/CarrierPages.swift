import Foundation

/// The carrier pages the device reads, and what the hidden web view may load
/// (docs/research/scraping.md, "Hidden WKWebView setup").
public enum CarrierPages {
    /// The registrable domain each device carrier's pages live under.
    public static func domain(for carrier: Carrier) -> String? {
        switch carrier {
        case .usps: "usps.com"
        case .ups: "ups.com"
        case .fedex: "fedex.com"
        default: nil
        }
    }

    /// The public tracking page for one number. Nil for a carrier the device doesn't read.
    public static func pageURL(for carrier: Carrier, trackingNumber: String) -> URL? {
        let number = trackingNumber.filter { !$0.isWhitespace }
        guard !number.isEmpty, number.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) else { return nil }
        var c: URLComponents
        switch carrier {
        case .usps:
            c = URLComponents(string: "https://tools.usps.com/go/TrackConfirmAction")!
            c.queryItems = [URLQueryItem(name: "tLabels", value: number)]
        case .ups:
            c = URLComponents(string: "https://www.ups.com/track")!
            c.queryItems = [
                URLQueryItem(name: "loc", value: "en_US"), URLQueryItem(name: "tracknum", value: number),
                URLQueryItem(name: "requester", value: "ST/trackdetails"),
            ]
        case .fedex:
            c = URLComponents(string: "https://www.fedex.com/fedextrack/")!
            c.queryItems = [URLQueryItem(name: "trknbr", value: number)]
        default:
            return nil
        }
        return c.url
    }

    /// The API responses worth capturing, matched as substrings of the request URL.
    /// USPS has none: its data is only in the HTML.
    public static func captureURLPatterns(for carrier: Carrier) -> [String] {
        switch carrier {
        case .ups: ["webapis.ups.com/track/api/Track/GetStatus"]
        case .fedex: ["api.fedex.com/track/v2/shipments"]
        default: []
        }
    }

    /// True when `url` is an https URL on one of `carrier`'s hosts and its path matches a capture pattern.
    public static func isCaptureURL(_ url: String, carrier: Carrier) -> Bool {
        guard let parsed = URL(string: url), isCarrierURL(parsed, carrier: carrier) else { return false }
        let rest = ((parsed.host ?? "") + parsed.path).lowercased()
        return captureURLPatterns(for: carrier).contains { rest.hasPrefix($0.lowercased()) }
    }

    /// Captured bodies longer than this (in UTF-8 bytes) are dropped. The
    /// injected script also drops bodies over this many UTF-16 units.
    public static let maxCaptureBytes = 4 * 1024 * 1024

    /// Whether the app takes a capture the injected script posted: from a
    /// frame on the job's carrier, for one of its capture URLs, within the size cap.
    public static func acceptsCapture(frameHost: String?, url: String, body: String, carrier: Carrier) -> Bool {
        isCarrierHost(frameHost, carrier: carrier) && isCaptureURL(url, carrier: carrier) && body.utf8.count <= maxCaptureBytes
    }

    /// True for `host` being `carrier`'s domain or one of its subdomains.
    public static func isCarrierHost(_ host: String?, carrier: Carrier) -> Bool {
        guard let host = host?.lowercased(), let domain = domain(for: carrier) else { return false }
        return host == domain || host.hasSuffix("." + domain)
    }

    /// True for an https URL on `carrier`'s domain or a subdomain of it.
    public static func isCarrierURL(_ url: URL, carrier: Carrier) -> Bool {
        url.scheme?.lowercased() == "https" && isCarrierHost(url.host, carrier: carrier)
    }

    /// Whether the hidden web view may load `url` in any frame while reading
    /// `carrier`: https pages on that carrier's domain, and blank frames.
    public static func allowsNavigation(to url: URL?, carrier: Carrier) -> Bool {
        guard let url else { return false }
        if url.absoluteString == "about:blank" || url.absoluteString == "about:srcdoc" { return true }
        return isCarrierURL(url, carrier: carrier)
    }
}

/// What the hidden web view hands back from one carrier page.
public enum CarrierCapture: Hashable, Sendable {
    /// The first matching API response the page fetched (UPS, FedEx).
    case response(url: String, status: Int, body: String)
    /// The page as rendered: USPS, or a UPS or FedEx page that never made the call.
    case page(url: URL, html: String)
}

/// Bot checks. Porchlight never tries to answer one; the read reports `challenged`.
public enum CarrierChallenge {
    public enum Kind: Hashable, Sendable {
        case none
        /// Akamai's interstitial, which reloads itself into the real page. Keep waiting.
        case interstitial
        /// A CAPTCHA or an access-denied page. Stop.
        case blocked
    }

    /// HTTP statuses that mean the carrier's edge refused the call.
    public static func isChallengeStatus(_ status: Int) -> Bool { [401, 403, 428, 429].contains(status) }

    public static func kind(of html: String) -> Kind {
        let lower = html.lowercased()
        let blocked = ["captcha", "_cf_chl_opt", "cf-turnstile", "sec-if-cpt-container", "<title>access denied</title>"]
        if blocked.contains(where: lower.contains) { return .blocked }
        if lower.contains("bm-verify") || lower.contains("/_sec/verify") || lower.contains("triggerinterstitialchallenge") { return .interstitial }
        return .none
    }
}
