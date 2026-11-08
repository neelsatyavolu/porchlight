import Foundation

/// Why a shared number didn't get added.
public enum ShareFailure: Hashable, Sendable {
    /// 401: the saved session is gone or expired.
    case signedOut
    case offline
    case rateLimited
    case server
}

public enum ShareOutcome: Hashable, Sendable {
    case added(packageId: String)
    /// 409 duplicate: the person already tracks this number.
    case alreadyTracked(packageId: String)
    case failed(ShareFailure)

    public var isFailure: Bool {
        if case .failed = self { return true }
        return false
    }

    /// True when every number was added or was already tracked.
    public static func allSucceeded(_ outcomes: [ShareOutcome]) -> Bool {
        !outcomes.isEmpty && !outcomes.contains(where: \.isFailure)
    }

    /// One line for the share sheet after submitting.
    public static func summary(_ outcomes: [ShareOutcome]) -> String {
        var added = 0, already = 0
        var failure: ShareFailure?
        for o in outcomes {
            switch o {
            case .added: added += 1
            case .alreadyTracked: already += 1
            case let .failed(f): failure = failure ?? f
            }
        }

        if let failure {
            let reason = switch failure {
            case .signedOut: "Open Porchlight and sign in, then share again."
            case .offline: "Couldn't reach Porchlight. Check your connection and try again."
            case .rateLimited: "Too many requests. Wait a minute and try again."
            case .server: "Porchlight couldn't add this right now. Try again later."
            }
            return added > 0 ? "Added \(added). \(reason)" : reason
        }
        switch (added, already) {
        case (_, 0): return added == 1 ? "Added to Porchlight." : "Added \(added) packages to Porchlight."
        case (0, _): return already == 1 ? "Porchlight is already tracking this package." : "Porchlight is already tracking these packages."
        default: return "Added \(added). \(already) \(already == 1 ? "was" : "were") already tracked."
        }
    }
}

/// Creates packages from the share sheet: one `PUT /v1/packages/:id` per
/// number, with a new client id, the top carrier and `source: "share"`.
/// The app picks them up on its next sync.
public struct ShareSubmitter: Sendable {
    private let api: any APIClient
    private let newId: @Sendable () -> String

    public init(api: any APIClient, newId: @escaping @Sendable () -> String = PackageID.make) {
        self.api = api
        self.newId = newId
    }

    /// One outcome per number, in the same order.
    public func submit(_ numbers: [SharedNumber]) async -> [ShareOutcome] {
        var outcomes: [ShareOutcome] = []
        for number in numbers {
            outcomes.append(await submit(number))
        }
        return outcomes
    }

    public static func request(for number: SharedNumber) -> PackagePutRequest {
        PackagePutRequest(trackingNumber: number.number, carrier: number.candidates.first?.carrier, source: .share)
    }

    private func submit(_ number: SharedNumber) async -> ShareOutcome {
        let id = newId()
        do {
            let result = try await api.putPackage(id: id, Self.request(for: number))
            return .added(packageId: result.package.id)
        } catch let error as APIError {
            if case let .duplicate(existingId) = error.conflict { return .alreadyTracked(packageId: existingId) }
            switch error {
            case .network: return .failed(.offline)
            case .server(status: 401, _, _): return .failed(.signedOut)
            case .server where error.code == .rateLimited: return .failed(.rateLimited)
            default: return .failed(.server)
            }
        } catch {
            return .failed(.server)
        }
    }
}
