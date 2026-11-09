#if os(macOS)
import Sparkle
import SwiftUI

/// Mac auto-update through Sparkle. Checks the feed in Info-macOS.plist
/// (SUFeedURL) on its own schedule, and on demand from the app menu.
@MainActor
final class Updater {
    private let controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)

    func checkForUpdates() {
        controller.checkForUpdates(nil)
    }
}

/// Porchlight → Check for Updates…, under About.
struct UpdaterCommands: Commands {
    let updater: Updater

    var body: some Commands {
        CommandGroup(after: .appInfo) {
            Button("Check for Updates…") { updater.checkForUpdates() }
        }
    }
}
#endif
