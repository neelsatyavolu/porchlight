import Foundation

/// One change to make to the running Live Activities.
public enum LiveActivityAction: Hashable, Sendable {
    case start(PackageActivityAttributes, PackageActivityAttributes.ContentState)
    case update(packageId: String, PackageActivityAttributes.ContentState)
    case end(packageId: String, PackageActivityAttributes.ContentState?, LiveActivityDismissal)

    public var packageId: String {
        switch self {
        case let .start(attributes, _): attributes.packageId
        case let .update(id, _), let .end(id, _, _): id
        }
    }
}

public enum LiveActivityDismissal: Hashable, Sendable {
    /// Leave the final state on the Lock Screen for the system's default time.
    case afterFinalState
    /// Remove it now: the package is gone, or Live Activities were turned off.
    case immediately
}

public struct LiveActivityPlan: Hashable, Sendable {
    public var actions: [LiveActivityAction]
    /// Packages that already had an activity during this out-for-delivery run.
    /// Saved by the app and passed back next time, so an activity the person
    /// swiped away isn't started again on the next sync.
    public var started: Set<String>
}

/// Decides, after each sync, which packages get a Live Activity. Pure; the app
/// (Porchlight/LiveActivity) applies the plan with ActivityKit.
///
/// - A package that is `out_for_delivery` and has no activity yet gets one,
///   unless one was already started for it in this run, or Live Activities are off.
/// - A running activity whose package changed is updated.
/// - It ends with a final state when the package is delivered, has a problem
///   or is returned; it ends right away when the package is deleted or archived,
///   or when Live Activities are off.
public enum LiveActivityPlanner {
    public static func plan(
        packages: [Package],
        running: [String: PackageActivityAttributes.ContentState],
        started: Set<String>,
        enabled: Bool
    ) -> LiveActivityPlan {
        let live = Dictionary(packages.filter { !$0.isArchived }.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var actions: [LiveActivityAction] = []
        var stillRunning: Set<String> = []

        for (id, current) in running.sorted(by: { $0.key < $1.key }) {
            guard enabled, let pkg = live[id] else {
                actions.append(.end(packageId: id, nil, .immediately))
                continue
            }
            let state = PackageActivityAttributes.ContentState(pkg)
            if isFinal(pkg.status) {
                actions.append(.end(packageId: id, state, .afterFinalState))
            } else {
                stillRunning.insert(id)
                if state != current { actions.append(.update(packageId: id, state)) }
            }
        }

        var startedNow: Set<String> = []
        if enabled {
            let candidates = live.values
                .filter { $0.status == .outForDelivery && running[$0.id] == nil && !started.contains($0.id) }
                .sorted { $0.id < $1.id }
            for pkg in candidates {
                actions.append(.start(PackageActivityAttributes(pkg), PackageActivityAttributes.ContentState(pkg)))
                startedNow.insert(pkg.id)
            }
        }

        // Forget a package once it is no longer out for delivery and has no
        // activity, so a second delivery attempt gets a new one. Turning Live
        // Activities off forgets them all, so turning them on again restarts them.
        guard enabled else { return LiveActivityPlan(actions: actions, started: []) }
        let kept = started.union(startedNow).filter { id in
            stillRunning.contains(id) || startedNow.contains(id) || live[id]?.status == .outForDelivery
        }
        return LiveActivityPlan(actions: actions, started: kept)
    }

    /// Statuses that end an activity with a final state.
    public static func isFinal(_ status: Status) -> Bool {
        status == .delivered || status == .exception || status == .returned
    }
}
