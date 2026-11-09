import Foundation
import Testing
@testable import PorchKit

private let a = "00000000-0000-4000-8000-00000000000a"
private let b = "00000000-0000-4000-8000-00000000000b"

private typealias State = PackageActivityAttributes.ContentState

private func out(_ id: String, detail: String? = "On vehicle") -> Package {
    var pkg = makePackage(id, status: .outForDelivery, eta: .window(start: iso("2026-11-08T22:00:00.000Z"), end: iso("2026-11-09T04:00:00.000Z")))
    pkg.statusDetail = detail
    pkg.title = "Headphones"
    return pkg
}

@Suite struct LiveActivityPlannerTests {
    @Test func startsForANewOutForDeliveryPackage() {
        let pkg = out(a)
        let plan = LiveActivityPlanner.plan(packages: [pkg, makePackage(b)], running: [:], started: [], enabled: true)
        #expect(plan.actions == [.start(PackageActivityAttributes(packageId: a, title: "Headphones", carrier: .ups), State(pkg))])
        #expect(plan.started == [a])
    }

    @Test func doesNotRestartOneThePersonDismissed() {
        let plan = LiveActivityPlanner.plan(packages: [out(a)], running: [:], started: [a], enabled: true)
        #expect(plan.actions.isEmpty)
        #expect(plan.started == [a])
    }

    @Test func updatesOnlyWhenTheStateChanged() {
        let unchanged = LiveActivityPlanner.plan(packages: [out(a)], running: [a: State(out(a))], started: [a], enabled: true)
        #expect(unchanged.actions.isEmpty)

        let moved = out(a, detail: "Arriving soon")
        let changed = LiveActivityPlanner.plan(packages: [moved], running: [a: State(out(a))], started: [a], enabled: true)
        #expect(changed.actions == [.update(packageId: a, State(moved))])
    }

    @Test(arguments: [Status.delivered, .exception, .returned])
    func endsWithAFinalState(_ status: Status) {
        var pkg = out(a)
        pkg.status = status
        let plan = LiveActivityPlanner.plan(packages: [pkg], running: [a: State(out(a))], started: [a], enabled: true)
        #expect(plan.actions == [.end(packageId: a, State(pkg), .afterFinalState)])
        #expect(plan.started.isEmpty)
    }

    @Test func endsRightAwayWhenThePackageIsGone() {
        var archived = out(b)
        archived.archivedAt = NOW
        let plan = LiveActivityPlanner.plan(packages: [archived], running: [a: State(out(a)), b: State(out(b))], started: [a, b], enabled: true)
        #expect(plan.actions == [.end(packageId: a, nil, .immediately), .end(packageId: b, nil, .immediately)])
        #expect(plan.started.isEmpty)
    }

    @Test func turnedOffEndsEverythingAndStartsNothing() {
        let plan = LiveActivityPlanner.plan(packages: [out(a), out(b)], running: [a: State(out(a))], started: [a], enabled: false)
        #expect(plan.actions == [.end(packageId: a, nil, .immediately)])
        #expect(plan.started.isEmpty)
    }

    @Test func keepsRunningWhenRescheduledAndForgetsItOnceEnded() {
        var back = out(a)
        back.status = .inTransit
        let running = LiveActivityPlanner.plan(packages: [back], running: [a: State(out(a))], started: [a], enabled: true)
        #expect(running.actions == [.update(packageId: a, State(back))])
        #expect(running.started == [a])

        // Swiped away while in transit: a later out-for-delivery starts a new one.
        let idle = LiveActivityPlanner.plan(packages: [back], running: [:], started: [a], enabled: true)
        #expect(idle.started.isEmpty)
        let again = LiveActivityPlanner.plan(packages: [out(a)], running: [:], started: idle.started, enabled: true)
        #expect(again.actions.count == 1)
    }

    @Test func pickupIsNotStartedButKeepsARunningOne() {
        var pickup = out(a)
        pickup.status = .availableForPickup
        #expect(LiveActivityPlanner.plan(packages: [pickup], running: [:], started: [], enabled: true).actions.isEmpty)
        let plan = LiveActivityPlanner.plan(packages: [pickup], running: [a: State(out(a))], started: [a], enabled: true)
        #expect(plan.actions == [.update(packageId: a, State(pickup))])
    }
}

@Suite struct PackageActivityTests {
    @Test func stateKeepsADateOnlyETA() throws {
        let state = State(status: .inTransit, statusDetail: nil, eta: .day(start: day("2026-11-10"), end: nil))
        let decoded = try JSONDecoder().decode(State.self, from: JSONEncoder().encode(state))
        #expect(decoded.eta == .day(start: day("2026-11-10"), end: nil))
    }

    @Test func text() {
        let pkg = out(a)
        let attributes = PackageActivityAttributes(pkg)
        #expect(PackageActivityText.statusLine(State(pkg)) == "Out for delivery · On vehicle")
        #expect(PackageActivityText.phrase(attributes, State(pkg), now: NOW, timeZone: LA).text == "By 8:00 PM")
        var done = pkg
        done.status = .delivered
        #expect(PackageActivityText.phrase(attributes, State(done), now: NOW, timeZone: LA).text == "Delivered")
        #expect(attributes.url == URL(string: "porchlight://p/\(a)"))
    }
}
