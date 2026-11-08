import Foundation
import Testing
@testable import PorchKit

// Mirrors the etaPhrase / etaSentence cases in apps/web/src/packages/arrival.test.ts
// and the ago / formatting cases in time.test.ts. NOW is Sunday, Nov 8 2026, 10 AM in LA.

private func pkg(_ status: Status = .inTransit, eta: ETA = .none, deliveredAt: String? = nil) -> Package {
    makePackage("x", status: status, eta: eta, deliveredAt: deliveredAt)
}

private func dayETA(_ end: String) -> ETA { .day(start: day(end), end: nil) }

@Suite struct ArrivalPhrasesTests {
    @Test(arguments: [
        ("out for delivery", pkg(.outForDelivery), "Today", false),
        ("out for delivery with a window", pkg(.outForDelivery, eta: .window(start: iso("2026-11-09T04:00:00.000Z"), end: nil)), "By 8:00 PM", false),
        ("out for delivery, window end at midnight UTC", pkg(.outForDelivery, eta: .window(start: iso("2026-11-08T20:00:00.000Z"), end: iso("2026-11-09T00:00:00.000Z"))), "By 4:00 PM", false),
        ("out for delivery, date-only ETA", pkg(.outForDelivery, eta: dayETA("2026-11-08")), "Today", false),
        ("out for delivery, window ends tomorrow", pkg(.outForDelivery, eta: .window(start: iso("2026-11-10T04:00:00.000Z"), end: nil)), "Today", false),
        ("ETA today", pkg(eta: dayETA("2026-11-08")), "Today", false),
        ("ETA tomorrow", pkg(eta: dayETA("2026-11-09")), "Tomorrow", false),
        ("ETA within 6 days", pkg(eta: dayETA("2026-11-12")), "Thursday", false),
        ("ETA later", pkg(eta: dayETA("2026-11-21")), "Nov 21", false),
        ("ETA next year", pkg(eta: dayETA("2027-01-03")), "Jan 3, 2027", false),
        ("overdue", pkg(eta: dayETA("2026-11-03")), "Was due Nov 3", true),
        ("no ETA", pkg(), "No date yet", true),
        ("delivered today", pkg(.delivered, deliveredAt: "2026-11-08T17:14:00.000Z"), "Delivered 9:14 AM", false),
        ("delivered this week", pkg(.delivered, deliveredAt: "2026-11-03T22:14:00.000Z"), "Delivered Tue", false),
        ("delivered earlier", pkg(.delivered, deliveredAt: "2026-10-30T22:14:00.000Z"), "Delivered Oct 30", false),
        ("delivered, no time", pkg(.delivered), "Delivered", false),
        ("delivered late last night is yesterday", pkg(.delivered, deliveredAt: "2026-11-08T07:30:00.000Z"), "Delivered Sat", false),
    ])
    func rowPhrase(_ name: String, _ p: Package, _ text: String, _ muted: Bool) {
        #expect(ArrivalPhrases.rowPhrase(p, now: NOW, timeZone: LA) == ETAPhrase(text: text, muted: muted), "\(name)")
    }

    @Test func rowPhraseKeepsADateOnlyDayInEveryZone() {
        // Nov 9 is tomorrow in LA and already today in Tokyo.
        #expect(ArrivalPhrases.rowPhrase(pkg(eta: dayETA("2026-11-09")), now: NOW, timeZone: LA).text == "Tomorrow")
        #expect(ArrivalPhrases.rowPhrase(pkg(eta: dayETA("2026-11-09")), now: NOW, timeZone: TOKYO).text == "Today")
    }

    @Test(arguments: [
        ("single date", pkg(eta: dayETA("2026-11-12")), "Arriving Thursday, Nov 12"),
        ("tomorrow", pkg(eta: dayETA("2026-11-09")), "Arriving tomorrow"),
        ("today", pkg(eta: dayETA("2026-11-08")), "Arriving today"),
        ("multi-day window", pkg(eta: .day(start: day("2026-11-12"), end: day("2026-11-14"))), "Arriving between Thursday, Nov 12 and Saturday, Nov 14"),
        ("same-day window with times", pkg(eta: .window(start: iso("2026-11-12T22:00:00.000Z"), end: iso("2026-11-13T02:00:00.000Z"))), "Arriving Thursday, Nov 12, 2:00 PM to 6:00 PM"),
        ("window that already started", pkg(eta: .day(start: day("2026-11-06"), end: day("2026-11-10"))), "Arriving between today and Tuesday, Nov 10"),
        ("no ETA", pkg(), "No delivery date from UPS yet"),
        ("overdue", pkg(eta: dayETA("2026-11-03")), "Was due Tuesday, Nov 3"),
        ("out for delivery", pkg(.outForDelivery, eta: .window(start: iso("2026-11-09T04:00:00.000Z"), end: nil)), "Arriving today by 8:00 PM"),
        ("out for delivery, no time", pkg(.outForDelivery), "Arriving today"),
        ("ready for pickup", pkg(.availableForPickup), "Ready for pickup"),
        ("delivered today", pkg(.delivered, deliveredAt: "2026-11-08T17:14:00.000Z"), "Delivered today at 9:14 AM"),
        ("delivered yesterday", pkg(.delivered, deliveredAt: "2026-11-07T22:14:00.000Z"), "Delivered yesterday at 2:14 PM"),
        ("delivered this week", pkg(.delivered, deliveredAt: "2026-11-03T22:14:00.000Z"), "Delivered Tuesday at 2:14 PM"),
        ("delivered earlier", pkg(.delivered, deliveredAt: "2026-10-20T22:14:00.000Z"), "Delivered Oct 20 at 3:14 PM"),
        ("delivered, no time", pkg(.delivered), "Delivered"),
    ])
    func sentence(_ name: String, _ p: Package, _ expected: String) {
        #expect(ArrivalPhrases.sentence(p, now: NOW, timeZone: LA) == expected, "\(name)")
    }

    @Test func dateOnlyRangeNeverShowsTimes() {
        let p = pkg(eta: .day(start: day("2026-11-12"), end: day("2026-11-12")))
        #expect(ArrivalPhrases.sentence(p, now: NOW, timeZone: LA) == "Arriving Thursday, Nov 12")
    }
}

@Suite struct TimeWordsTests {
    @Test(arguments: [
        ("2026-11-08T18:00:00.000Z", "just now"),
        ("2026-11-08T17:59:30.000Z", "just now"),
        ("2026-11-08T18:00:30.000Z", "just now"), // clock skew
        ("2026-11-08T17:46:00.000Z", "14 min ago"),
        ("2026-11-08T17:00:01.000Z", "59 min ago"),
        ("2026-11-08T15:00:00.000Z", "3 h ago"),
        ("2026-11-07T17:00:00.000Z", "1 day ago"),
        ("2026-11-05T18:00:00.000Z", "3 days ago"),
    ])
    func ago(_ then: String, _ expected: String) {
        #expect(TimeWords.ago(iso(then), now: NOW) == expected)
    }

    @Test func formats() {
        #expect(TimeWords.clockTime(iso("2026-11-08T22:14:00.000Z"), timeZone: LA) == "2:14 PM")
        #expect(TimeWords.clockTime(iso("2026-11-08T22:14:00.000Z"), timeZone: TOKYO) == "7:14 AM")
        #expect(TimeWords.weekdayName(day("2026-11-12")) == "Thursday")
        #expect(TimeWords.weekdayShort(day("2026-11-10")) == "Tue")
        #expect(TimeWords.monthDay(day("2026-11-21"), today: day("2026-11-08")) == "Nov 21")
        #expect(TimeWords.monthDay(day("2027-01-03"), today: day("2026-12-30")) == "Jan 3, 2027")
        #expect(TimeWords.weekdayMonthDay(day("2026-11-12"), today: day("2026-11-08")) == "Thursday, Nov 12")
        #expect(TimeWords.shortDayHeader(day("2026-11-08"), today: day("2026-11-08")) == "Sun, Nov 8")
        #expect(TimeWords.fullDateTime(iso("2026-11-08T17:41:00.000Z"), timeZone: LA) == "Nov 8, 2026, 9:41 AM")
    }

    @Test func checkedLine() {
        #expect(TimeWords.checked(iso("2026-11-08T17:46:00.000Z"), now: NOW) == "Checked 14 min ago")
        #expect(TimeWords.checked(nil, now: NOW) == "Not checked yet")
    }
}
