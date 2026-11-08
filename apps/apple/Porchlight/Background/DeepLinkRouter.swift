import Foundation
import Observation
import PorchKit

/// Where `porchlight://p/<id>` links and notification taps land. The package
/// list (UI work) reads `pendingPackageId`, shows that package, then sets it
/// back to nil.
@Observable
@MainActor
final class DeepLinkRouter {
    var pendingPackageId: String?

    /// Ignores links that aren't Porchlight's.
    func open(_ url: URL) {
        guard let link = DeepLink(url: url) else { return }
        open(link)
    }

    func open(_ link: DeepLink) {
        switch link {
        case let .package(id): pendingPackageId = id
        }
    }
}
