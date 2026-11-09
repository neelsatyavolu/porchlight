import Foundation

/// One shipment on Your Orders that has a "Track package" link.
public struct AmazonShipment: Hashable, Sendable {
    public var orderId: String
    /// Amazon's shipment id from the track link, plus "-<n>" for the n-th
    /// package of a split shipment, so each package gets its own import key.
    public var shipmentId: String
    public var trackURL: URL
    /// The shipment's line on Your Orders: "Arriving tomorrow", "Delivered November 7".
    public var headline: String
    public var items: [PackageItem]
}

/// What Your Orders shows (amazon.com/gp/your-account/order-history).
public struct AmazonOrderList: Hashable, Sendable {
    /// Order cards found, with or without a track link.
    public var orderCount: Int
    public var shipments: [AmazonShipment]
    /// Amazon said there are no orders in the chosen period.
    public var isEmpty: Bool

    /// Reads the order cards. Selectors lean on Amazon's stable `yohtmlc-*`
    /// and `order-card` classes and fall back to text cues (an order-id
    /// pattern, a /progress-tracker/ link).
    public static func parse(_ document: HTMLNode) -> AmazonOrderList {
        // The page also carries a hidden "Test: .js-order-card" probe; a real card has a header.
        let cards = document.elements { $0.hasClass("order-card") || $0.hasClass("js-order-card") }
            .filter { $0.first(class: "order-header") != nil || $0.first(class: "yohtmlc-order-id") != nil }
        var shipments: [AmazonShipment] = []
        for card in cards {
            guard let orderId = orderId(in: card) else { continue }
            let boxes = card.all(class: "delivery-box")
            for box in boxes.isEmpty ? [card] : boxes {
                if let shipment = shipment(in: box, orderId: orderId) { shipments.append(shipment) }
            }
        }
        let pageText = HTMLText.collapse(document.first(id: "ordersContainer")?.textContent ?? "")
        let empty = cards.isEmpty && (pageText.contains("You have not placed any orders") || pageText.contains("looks like you haven't placed an order")
            || document.first(class: "your-orders-content-empty") != nil)
        return AmazonOrderList(orderCount: cards.count, shipments: shipments, isEmpty: empty)
    }

    nonisolated(unsafe) static let orderIdPattern = #/\b\d{3}-\d{7}-\d{7}\b/#

    static func orderId(in card: HTMLNode) -> String? {
        let header = card.first(class: "yohtmlc-order-id")?.textContent ?? card.first(class: "order-header")?.textContent ?? ""
        if let m = header.firstMatch(of: orderIdPattern) { return String(m.output) }
        return card.textContent.firstMatch(of: orderIdPattern).map { String($0.output) }
    }

    static func shipment(in box: HTMLNode, orderId: String) -> AmazonShipment? {
        guard let link = box.first(where: { $0.tag == "a" && isTrackLink($0[attribute: "href"]) }),
              let href = link[attribute: "href"], let url = URL(string: href, relativeTo: AmazonPages.origin)?.absoluteURL,
              AmazonPages.isAmazonURL(url) else { return nil }
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func param(_ name: String) -> String? { query.first { $0.name == name }?.value.flatMap { $0.isEmpty ? nil : $0 } }
        guard let shipmentId = param("shipmentId") ?? param("shipmentID") else { return nil }
        let packageIndex = param("packageIndex").flatMap(Int.init) ?? 0
        let headline = (box.first(class: "delivery-box__primary-text") ?? box.first(class: "yohtmlc-shipment-status-primaryText"))?.textContent ?? ""
        return AmazonShipment(
            orderId: param("orderId") ?? orderId,
            shipmentId: packageIndex > 0 ? "\(shipmentId)-\(packageIndex)" : shipmentId,
            trackURL: url,
            headline: headline,
            items: items(in: box)
        )
    }

    static func isTrackLink(_ href: String?) -> Bool {
        guard let href else { return false }
        return href.contains("/progress-tracker/") || href.contains("ship-track")
    }

    static func items(in box: HTMLNode) -> [PackageItem] {
        var nodes = box.all(class: "yo-enhanced-flex-card")
        if nodes.isEmpty { nodes = box.all(class: "item-box") }
        return nodes.compactMap { node in
            let title = (node.first(class: "yo-enhanced-title") ?? node.first(class: "yohtmlc-product-title"))?.textContent
                ?? node.first(where: { $0.tag == "a" && ($0[attribute: "href"] ?? "").contains("/dp/") && !$0.textContent.isEmpty })?.textContent
            guard let name = title, !name.isEmpty else { return nil }
            let image = node.all(tag: "img").compactMap { $0[attribute: "src"] }.first { $0.hasPrefix("https://") }
            let qtyText = node.first(class: "product-image__qty")?.textContent ?? ""
            let quantity = Int(qtyText.filter(\.isNumber)).flatMap { $0 > 0 ? $0 : nil } ?? 1
            return PackageItem(name: name, imageUrl: image, quantity: quantity)
        }
    }
}
