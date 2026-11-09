import Foundation

/// The amazon.com pages the importer reads, and how to tell them apart.
public enum AmazonPages {
    public static let origin = URL(string: "https://www.amazon.com")!
    /// Your Orders. Signed out, Amazon redirects it to /ap/signin, so the
    /// Connect sheet opens it too and lands here once the sign-in is done.
    public static let orderHistory = URL(string: "https://www.amazon.com/gp/your-account/order-history")!

    /// The only script the app injects. It returns the page as rendered; all
    /// parsing happens in Swift (AmazonOrderList, AmazonTrackPage).
    public static let outerHTMLScript = "document.documentElement.outerHTML"

    public enum Kind: Hashable, Sendable {
        case orders
        case track
        /// Amazon wants the person to sign in again.
        case signIn
        /// A captcha or other challenge. Only the person can answer it, in the Connect sheet.
        case challenge
        case other
    }

    public static func kind(of url: URL, document: HTMLNode) -> Kind {
        let path = url.path.lowercased()
        if path.hasPrefix("/ap/signin") || path.hasPrefix("/ap/mfa") || path.hasPrefix("/ap/cvf") || path.hasPrefix("/ax/claim") { return .signIn }
        if path.hasPrefix("/errors/validatecaptcha") { return .challenge }
        if document.first(where: { $0.tag == "form" && ($0[attribute: "name"] == "signIn" || ($0[attribute: "action"] ?? "").contains("/ap/signin")) }) != nil
            || document.first(id: "ap_email") != nil || document.first(id: "ap_password") != nil {
            return .signIn
        }
        if document.first(id: "captchacharacters") != nil
            || document.first(where: { $0.tag == "form" && ($0[attribute: "action"] ?? "").contains("validateCaptcha") }) != nil {
            return .challenge
        }
        if path.hasPrefix("/progress-tracker") || path.contains("ship-track") { return .track }
        if path.contains("order-history") || path.hasPrefix("/your-orders") { return .orders }
        return .other
    }

    /// True for an https page on amazon.com or one of its subdomains. The
    /// Amazon web views load nothing else in the main frame (SPEC §6).
    public static func isAmazonURL(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https", let host = url.host?.lowercased() else { return false }
        return host == "amazon.com" || host.hasSuffix(".amazon.com")
    }

    /// What an Amazon web view does with a main-frame navigation.
    public enum NavigationPolicy: Hashable, Sendable {
        case allow
        /// Not Amazon: cancel it. The visible sign-in sheet hands http(s)
        /// links to the system browser; the hidden importer drops them.
        case openExternally
        case block
    }

    public static func navigationPolicy(for url: URL?) -> NavigationPolicy {
        guard let url else { return .block }
        if url.absoluteString == "about:blank" || isAmazonURL(url) { return .allow }
        let scheme = url.scheme?.lowercased()
        return scheme == "https" || scheme == "http" ? .openExternally : .block
    }

    /// True when `url` is a signed-in Amazon page (not sign-in, not a challenge).
    /// The Connect sheet closes on the first one.
    public static func isSignedInPage(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased(), host == "www.amazon.com" || host == "amazon.com" else { return false }
        let path = url.path.lowercased()
        return path.contains("order-history") || path.hasPrefix("/your-orders")
    }
}
