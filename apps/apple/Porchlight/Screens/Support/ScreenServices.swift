import Foundation
import Observation
import PorchKit
import SwiftUI

/// What the screens need from the app: account actions, the sync engine for
/// writes, the repository for reads, the API for Settings, and the detector.
/// Screens get it with `@Environment(ScreenServices.self)` and never reach
/// into AppModel, so previews can pass fakes.
@MainActor
protocol AccountActions: AnyObject {
    /// The signed-in user, nil when signed out.
    var currentUser: User? { get }
    func signInWithApple(identityToken: Data?, nonce: AppleNonce) async throws
    func startEmail(_ email: String) async throws
    func verifyEmail(email: String, code: String) async throws
    /// Never fails: an offline sign-out still signs this device out.
    func signOut() async
    func deleteAccount() async throws
}

@Observable
@MainActor
final class ScreenServices {
    let account: any AccountActions
    let api: any APIClient
    let sync: any SyncEngine
    let repository: any PackageRepository
    let detector: any CarrierDetector
    /// Bumped after every local write or sync so lists reload from the repository.
    private(set) var revision = 0

    init(account: any AccountActions, api: any APIClient, sync: any SyncEngine,
         repository: any PackageRepository, detector: any CarrierDetector) {
        self.account = account
        self.api = api
        self.sync = sync
        self.repository = repository
        self.detector = detector
    }

    /// One-line notes waiting for a package's detail screen, by package id.
    @ObservationIgnored private var notes: [String: String] = [:]

    /// Tells every screen showing packages to read the repository again.
    func didChange() { revision += 1 }

    /// Leaves `text` for the next time `packageId`'s detail screen loads.
    func leaveNote(_ text: String, for packageId: String) { notes[packageId] = text }

    /// The note left for `packageId`, once.
    func takeNote(for packageId: String) -> String? { notes.removeValue(forKey: packageId) }
}
