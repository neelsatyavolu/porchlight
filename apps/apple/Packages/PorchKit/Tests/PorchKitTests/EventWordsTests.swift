import Foundation
import Testing
@testable import PorchKit

@Suite struct EventWordsTests {
    @Test func namesTheFacilityTownInsteadOfAGenericFacility() {
        let w = EventWords.describe("Package arrived at an Amazon facility.", location: "Haslet, TX US")
        #expect(w == .init(title: "Package arrived at the Amazon facility in Haslet, TX.", placeInTitle: true))
        #expect(EventWords.describe("Package left the carrier facility", location: "Reno, NV, US").title
            == "Package left the carrier facility in Reno, NV")
    }

    @Test func leavesOtherEventsAndMissingPlacesAlone() {
        #expect(EventWords.describe("Package arrived at an Amazon facility.", location: nil)
            == .init(title: "Package arrived at an Amazon facility.", placeInTitle: false))
        #expect(EventWords.describe("Out for delivery", location: "Oakland, CA")
            == .init(title: "Out for delivery", placeInTitle: false))
    }

    @Test func tidiesPlaceNames() {
        #expect(EventWords.place("Haslet, TX US") == "Haslet, TX")
        #expect(EventWords.place("OAKLAND, CA, US") == "Oakland, CA")
        #expect(EventWords.place("  ") == nil)
        #expect(EventWords.place("Toronto, ON, CA") == "Toronto, ON, CA")
    }

    @Test func theTimelineMovesThePlaceIntoTheSentence() {
        let e = TrackEvent(id: "e", packageId: "p", occurredAt: NOW, status: .inTransit,
                           description: "Package arrived at an Amazon facility.", location: "Haslet, TX US")
        let entry = PackageText.timelineDays([e], now: NOW, timeZone: LA)[0].entries[0]
        #expect(entry.title == "Package arrived at the Amazon facility in Haslet, TX.")
        #expect(entry.meta == entry.time)
    }

    @Test func routeRunsOldestToNewestAndMergesRepeats() {
        func event(_ id: String, minutesAgo: Double, _ location: String?) -> TrackEvent {
            TrackEvent(id: id, packageId: "p", occurredAt: NOW.addingTimeInterval(-minutesAgo * 60),
                       status: .inTransit, description: "Scan", location: location)
        }
        // Newest first, as the store returns them.
        let events = [
            event("e6", minutesAgo: 10, "OAKLAND, CA, US"),
            event("e5", minutesAgo: 20, "Oakland, CA"),
            event("e4", minutesAgo: 30, nil),
            event("e3", minutesAgo: 40, "San Pablo, CA US"),
            event("e2", minutesAgo: 50, "Reno, NV"),
            event("e1", minutesAgo: 60, "Reno, NV"),
        ]
        #expect(EventWords.route(events) == ["Reno, NV", "San Pablo, CA", "Oakland, CA"])
        #expect(EventWords.route(events.reversed()) == ["Reno, NV", "San Pablo, CA", "Oakland, CA"])
    }

    @Test func routeKeepsAReturnToAnEarlierPlace() {
        let a = TrackEvent(id: "a", packageId: "p", occurredAt: NOW.addingTimeInterval(-300), status: .inTransit, description: "x", location: "Reno, NV")
        let b = TrackEvent(id: "b", packageId: "p", occurredAt: NOW.addingTimeInterval(-200), status: .inTransit, description: "x", location: "Sparks, NV")
        let c = TrackEvent(id: "c", packageId: "p", occurredAt: NOW.addingTimeInterval(-100), status: .inTransit, description: "x", location: "Reno, NV")
        #expect(EventWords.route([c, b, a]) == ["Reno, NV", "Sparks, NV", "Reno, NV"])
        #expect(EventWords.route([]) == [])
        #expect(EventWords.route([TrackEvent(id: "n", packageId: "p", occurredAt: NOW, status: .labelCreated, description: "x")]) == [])
    }
}
