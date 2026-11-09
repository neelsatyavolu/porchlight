import SwiftUI
import WidgetKit

/// The iOS widget extension: the Today widget and the out-for-delivery Live
/// Activity (SPEC §8). It has no local store: the Today widget reads the
/// session from the shared Keychain item and fetches from the API; the Live
/// Activity is started and updated by the app.
@main
struct PorchlightWidgetBundle: WidgetBundle {
    var body: some Widget {
        TodayWidget()
        PackageLiveActivity()
    }
}
