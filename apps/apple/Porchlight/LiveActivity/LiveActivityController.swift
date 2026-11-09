#if os(iOS)
import ActivityKit
import Foundation
import OSLog
import PorchKit

/// Applies LiveActivityPlanner's plan with ActivityKit after each sync. Which
/// packages get an activity, and when one is updated or ended, is decided in
/// PorchKit and tested there. Not on the main actor: ActivityKit's
/// `Activity` isn't Sendable, so each run keeps its activities in one task.
enum LiveActivityController {
    /// The Settings toggle (LiveActivitySection). On unless turned off.
    static let enabledKey = "liveActivitiesEnabled"
    /// Package ids that already had an activity in this out-for-delivery run.
    private static let startedKey = "liveActivityStartedPackageIds"
    private static let log = Logger(subsystem: "co.xanom.porchlight", category: "live-activity")

    static var isEnabled: Bool {
        UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true
    }

    static func apply(_ packages: [Package]) async {
        var byId: [String: Activity<PackageActivityAttributes>] = [:]
        for activity in Activity<PackageActivityAttributes>.activities
        where activity.activityState == .active || activity.activityState == .stale {
            if byId[activity.attributes.packageId] == nil {
                byId[activity.attributes.packageId] = activity
            } else {
                await activity.end(nil, dismissalPolicy: .immediate) // a duplicate from an overlapping run
            }
        }

        let enabled = isEnabled && ActivityAuthorizationInfo().areActivitiesEnabled
        let plan = LiveActivityPlanner.plan(
            packages: packages, running: byId.mapValues(\.content.state), started: started, enabled: enabled
        )
        var nowStarted = plan.started
        for action in plan.actions {
            switch action {
            case let .start(attributes, state):
                do {
                    _ = try Activity.request(attributes: attributes, content: ActivityContent(state: state, staleDate: nil), pushType: nil)
                } catch {
                    // iOS refuses to start one while the app is in the background;
                    // leaving it out of `started` retries on the next sync.
                    nowStarted.remove(attributes.packageId)
                    log.info("couldn't start a Live Activity: \(String(describing: error), privacy: .public)")
                }
            case let .update(id, state):
                await byId[id]?.update(ActivityContent(state: state, staleDate: nil))
            case let .end(id, state, dismissal):
                let policy: ActivityUIDismissalPolicy = dismissal == .immediately ? .immediate : .default
                await byId[id]?.end(state.map { ActivityContent(state: $0, staleDate: nil) }, dismissalPolicy: policy)
            }
        }
        started = nowStarted
    }

    /// Sign-out, or the Settings toggle turned off.
    static func endAll() async {
        for activity in Activity<PackageActivityAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
        started = []
    }

    private static var started: Set<String> {
        get { Set(UserDefaults.standard.stringArray(forKey: startedKey) ?? []) }
        set { UserDefaults.standard.set(newValue.sorted(), forKey: startedKey) }
    }
}
#endif
