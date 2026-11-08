import Foundation
import Testing
@testable import PorchKit

// Mirrors apps/web/src/packages/arrival.test.ts (groupOf, groupPackages), with
// date-only ETAs written the etaDateOnly way.

private func ids(_ list: [Package]) -> [String] { list.map(\.id) }

@Suite struct ArrivalGroupingTests {
    @Test(arguments: [
        ("out for delivery, any ETA", makePackage("x", status: .outForDelivery, eta: .day(start: day("2026-11-12"), end: nil)), ArrivalGroupID.today),
        ("ready for pickup", makePackage("x", status: .availableForPickup), .today),
        ("ETA today (date only)", makePackage("x", eta: .day(start: day("2026-11-08"), end: nil)), .today),
        ("late and not delivered", makePackage("x", eta: .day(start: day("2026-11-03"), end: nil)), .today),
        ("ETA tomorrow (date only)", makePackage("x", eta: .day(start: day("2026-11-09"), end: nil)), .tomorrow),
        ("ETA in 2 days", makePackage("x", eta: .day(start: day("2026-11-10"), end: nil)), .week),
        ("ETA in 6 days", makePackage("x", eta: .day(start: day("2026-11-14"), end: nil)), .week),
        ("ETA in 7 days", makePackage("x", eta: .day(start: day("2026-11-15"), end: nil)), .later),
        ("no ETA", makePackage("x"), .later),
        ("delivered", makePackage("x", status: .delivered, eta: .day(start: day("2026-11-20"), end: nil), deliveredAt: "2026-11-08T16:00:00.000Z"), .delivered),
        ("exception due tomorrow keeps the date rule", makePackage("x", status: .exception, eta: .day(start: day("2026-11-09"), end: nil)), .tomorrow),
        ("returned, no ETA", makePackage("x", status: .returned), .later),
    ])
    func groupOf(_ name: String, _ pkg: Package, _ expected: ArrivalGroupID) {
        #expect(Arrival.group(of: pkg, now: NOW, timeZone: LA) == expected, "\(name)")
    }

    @Test func usesTheEndOfARange() {
        let pkg = makePackage("x", eta: .day(start: day("2026-11-08"), end: day("2026-11-10")))
        #expect(Arrival.group(of: pkg, now: NOW, timeZone: LA) == .week)
        let window = makePackage("y", eta: .window(start: iso("2026-11-08T20:00:00.000Z"), end: iso("2026-11-10T20:00:00.000Z")))
        #expect(Arrival.group(of: window, now: NOW, timeZone: LA) == .week)
    }

    @Test func dateOnlyKeepsItsDateInEveryZone() {
        // Nov 9 is tomorrow in LA (Sunday morning) and today in Tokyo (already Monday).
        let pkg = makePackage("x", eta: .day(start: day("2026-11-09"), end: nil))
        #expect(Arrival.group(of: pkg, now: NOW, timeZone: LA) == .tomorrow)
        #expect(Arrival.group(of: pkg, now: NOW, timeZone: TOKYO) == .today)
    }

    @Test func readsATimedEtaInTheViewersZone() {
        // Nov 9, 4 AM UTC = Nov 8, 8 PM in LA and Nov 9, 1 PM in Tokyo: today in both.
        let pkg = makePackage("x", eta: .window(start: iso("2026-11-09T04:00:00.000Z"), end: nil))
        #expect(Arrival.group(of: pkg, now: NOW, timeZone: LA) == .today)
        #expect(Arrival.group(of: pkg, now: NOW, timeZone: TOKYO) == .today)
        // Nov 10, 4 AM UTC is Nov 9 (tomorrow) in LA.
        let next = makePackage("y", eta: .window(start: iso("2026-11-10T04:00:00.000Z"), end: nil))
        #expect(Arrival.group(of: next, now: NOW, timeZone: LA) == .tomorrow)
    }

    @Test func movesToTodayAtLocalMidnight() {
        let pkg = makePackage("x", eta: .window(start: iso("2026-11-09T18:00:00.000Z"), end: nil)) // Nov 9, 10 AM in LA
        #expect(Arrival.group(of: pkg, now: iso("2026-11-09T07:59:00.000Z"), timeZone: LA) == .tomorrow)
        #expect(Arrival.group(of: pkg, now: iso("2026-11-09T08:00:00.000Z"), timeZone: LA) == .today)
    }

    @Test func dateOnlyIsNotShiftedAcrossADstChange() {
        // US DST ended Nov 1 2026. A date-only ETA a week out stays 7 days away.
        let pkg = makePackage("x", eta: .day(start: day("2026-11-01"), end: nil))
        #expect(Arrival.etaOffset(pkg, now: iso("2026-10-25T18:00:00.000Z"), timeZone: LA) == 7)
    }

    @Test func returnsGroupsInOrderAndHidesEmptyOnes() {
        let groups = Arrival.groups([
            makePackage("later"),
            makePackage("done", status: .delivered, deliveredAt: "2026-11-07T20:00:00.000Z"),
            makePackage("today", eta: .day(start: day("2026-11-08"), end: nil)),
        ], now: NOW, timeZone: LA)
        #expect(groups.map(\.label) == ["Today", "Later", "Delivered"])
    }

    @Test func pinsProblemsThenOutForDeliveryThenSoonestThenNewest() {
        let groups = Arrival.groups([
            makePackage("late-old", eta: .day(start: day("2026-11-05"), end: nil), updatedAt: "2026-11-01T00:00:00.000Z"),
            makePackage("due-today-new", eta: .day(start: day("2026-11-08"), end: nil), updatedAt: "2026-11-08T17:00:00.000Z"),
            makePackage("due-today-old", eta: .day(start: day("2026-11-08"), end: nil), updatedAt: "2026-11-08T09:00:00.000Z"),
            makePackage("out", status: .outForDelivery),
            makePackage("problem", status: .exception, eta: .day(start: day("2026-11-08"), end: nil)),
        ], now: NOW, timeZone: LA)
        #expect(groups.first.map { ids($0.packages) } == ["problem", "out", "late-old", "due-today-new", "due-today-old"])
    }

    @Test func putsNoEtaAfterDatedInLater() {
        let groups = Arrival.groups([makePackage("none"), makePackage("dated", eta: .day(start: day("2026-11-30"), end: nil))], now: NOW, timeZone: LA)
        #expect(groups.first.map { ids($0.packages) } == ["dated", "none"])
    }

    @Test func sortsDeliveredNewestFirst() {
        let groups = Arrival.groups([
            makePackage("older", status: .delivered, deliveredAt: "2026-11-02T20:00:00.000Z"),
            makePackage("newer", status: .delivered, deliveredAt: "2026-11-08T16:00:00.000Z"),
        ], now: NOW, timeZone: LA)
        #expect(groups.first.map { ids($0.packages) } == ["newer", "older"])
    }
}
