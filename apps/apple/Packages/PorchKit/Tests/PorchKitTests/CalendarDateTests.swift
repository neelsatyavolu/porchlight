import Foundation
import Testing
@testable import PorchKit

@Suite struct CalendarDateTests {
    @Test func parsesOnlyStrictDates() {
        #expect(CalendarDate("2026-11-10")?.description == "2026-11-10")
        #expect(CalendarDate("2028-02-29") != nil)
        for bad in ["2026-02-29", "2026-13-01", "2026-11-1", "26-11-10", "2026-11-10T00:00:00Z", "", "2026/11/10", "２０２６-11-10"] {
            #expect(CalendarDate(bad) == nil, "\(bad)")
        }
    }

    @Test func dayNumberRoundTrips() {
        #expect(day("1970-01-01").dayNumber == 0)
        #expect(day("1969-12-31").dayNumber == -1)
        #expect(day("2026-11-08").dayNumber == 20765)
        for n in [-800_000, -1, 0, 59, 60, 20765, 1_000_000] {
            #expect(CalendarDate(dayNumber: n).dayNumber == n)
        }
        #expect(day("2026-12-31").adding(days: 1) == day("2027-01-01"))
    }

    @Test func readsAnInstantInAZone() {
        let instant = iso("2026-11-08T07:30:00.000Z")
        #expect(CalendarDate(instant, in: LA) == day("2026-11-07"))
        #expect(CalendarDate(instant, in: TOKYO) == day("2026-11-08"))
    }

    @Test func codesAsAPlainString() throws {
        let data = try JSONEncoder().encode([day("2026-11-10")])
        #expect(String(decoding: data, as: UTF8.self) == #"["2026-11-10"]"#)
        #expect(throws: DecodingError.self) { try JSONDecoder().decode([CalendarDate].self, from: Data(#"["2026-11-10T00:00:00.000Z"]"#.utf8)) }
    }
}
