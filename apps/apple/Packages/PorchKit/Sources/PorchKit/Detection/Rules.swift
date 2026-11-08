// Format + checksum rules. Swift twin of packages/carriers/src/detect/rules.ts:
// same patterns (kept in the JavaScript dialect, see JSRegex), same order, same
// confidence grades. Regexes and checksum parameters there are derived from
// jkeen/tracking_number_data (MIT, (c) 2017 Jeff Keen) at commit 03af203
// (v2.0.0), anchored and with the `\s*` fragments removed because input is
// normalized first. Change both files together; the shared fixtures and
// Tests/Fixtures/detect-expected.json catch drift.

struct DetectionRule: Sendable {
    let name: String
    let carrier: Carrier
    let pattern: JSRegex
    /// Confidence for a match, or nil to reject it (failed check digit etc).
    let grade: @Sendable (JSRegex.Match) -> Confidence?

    init(_ name: String, _ carrier: Carrier, _ pattern: String,
         grade: @escaping @Sendable (JSRegex.Match) -> Confidence?) {
        self.name = name
        self.carrier = carrier
        self.pattern = JSRegex(pattern)
        self.grade = grade
    }
}

private func digitIs(_ expected: Int, _ check: String?) -> Bool {
    guard let check, let n = Int(check) else { return false }
    return n == expected
}

/// Grade `conf` when the check passes, else reject.
private func checked(_ conf: Confidence, _ check: @escaping @Sendable (JSRegex.Match) -> Bool)
    -> @Sendable (JSRegex.Match) -> Confidence? {
    { m in check(m) ? conf : nil }
}

private func always(_ conf: Confidence) -> @Sendable (JSRegex.Match) -> Confidence? {
    { _ in conf }
}

private let wFedEx12 = [3, 1, 7, 3, 1, 7, 3, 1, 7, 3, 1]
private let wFedEx34 = [1, 7, 3, 1, 7, 3, 1, 7, 3, 1, 7, 3, 1]

private let impbN =
    #"^(?:420\d{5}(?=\d{22}$|\d{26}$)(?:\d{4}(?=\d{22}$))?)?(?<serial>94\d{3}(?=9\d{8}(?:\d{15}|\d{11}|\d{7})\d$|[0-8]\d{5}(?:\d{14}|\d{10})\d$)(?:9\d{8}|[0-8]\d{5})(?:\d{15}|\d{14}|\d{11}|\d{10}|\d{7}))(?<check>\d)$"#
private let impbC =
    #"^(?:420\d{5}(?:\d{4}(?=\d{22}$))?)?(?<serial>(?:92(?=\d{3}9)|93(?=\d{3}[0-8])|95)\d{3}(?=9\d{8}(?:\d{11}|\d{7})\d$|[0-8]\d{5}(?:\d{14}|\d{10})\d$)(?:9\d{8}|[0-8]\d{5})(?:\d{14}|\d{11}|\d{10}|\d{7}))(?<check>\d)$"#

private let uspsRules: [DetectionRule] = [
    DetectionRule("usps_impb_n", .usps, impbN,
                  grade: checked(.high) { digitIs(Checksums.mod10($0["serial"]!, evenMul: 3, oddMul: 1, reverse: true), $0["check"]) }),
    DetectionRule("usps_impb_c", .usps, impbC,
                  grade: checked(.high) { digitIs(Checksums.mod10($0["serial"]!, evenMul: 3, oddMul: 1), $0["check"]) }),
    DetectionRule("usps_legacy", .usps, #"^(?<prefix>420\d{5}(?:\d{4})?)?(?<serial>(?:91)?\d{19})(?<check>\d)$"#) { m in
        let raw = m["serial"]!
        let serial = raw.hasPrefix("91") ? raw : "91\(raw)"
        guard digitIs(Checksums.mod10(serial, evenMul: 3, oddMul: 1), m["check"]) else { return nil }
        return m.length > 20 ? .high : .medium
    },
    DetectionRule("usps_20", .usps, #"^(?<serial>\d{19})(?<check>\d)$"#,
                  grade: checked(.medium) { digitIs(Checksums.mod10($0["serial"]!, evenMul: 3, oddMul: 1), $0["check"]) }),
    DetectionRule("s10", .usps, #"^[A-Z]{2}(?<serial>\d{8})(?<check>\d)(?<country>[A-Z]{2})$"#) { m in
        let country = m["country"]!
        guard S10Countries.all.contains(country), digitIs(Checksums.s10(m["serial"]!), m["check"]) else { return nil }
        return country == "US" ? .high : .medium
    },
]

private let upsRules: [DetectionRule] = [
    DetectionRule("ups_1z", .ups, #"^1Z(?<serial>[0-9A-Z]{15})(?<check>\d)$"#,
                  grade: checked(.high) { digitIs(Checksums.mod10($0["serial"]!, evenMul: 1, oddMul: 2), $0["check"]) }),
    DetectionRule("ups_waybill", .ups, #"^[AHJKTV](?<serial>\d{9})(?<check>\d)$"#,
                  grade: checked(.medium) { digitIs(Checksums.mod10($0["serial"]!, evenMul: 1, oddMul: 2), $0["check"]) }),
    DetectionRule("ups_mail_innovations", .ups, #"^MI\d{6}[0-9A-Z]{1,22}$"#, grade: always(.medium)),
]

private let fedexRules: [DetectionRule] = [
    DetectionRule("fedex_ground_96", .fedex, #"^96\d{5}(?<serial>\d{14})(?<check>\d)$"#,
                  grade: checked(.high) { digitIs(Checksums.mod10($0["serial"]!, evenMul: 1, oddMul: 3), $0["check"]) }),
    DetectionRule("fedex_ground_gsn", .fedex, #"^96\d{18}(?<serial>\d{13})(?<check>\d)$"#,
                  grade: checked(.high) { digitIs(Checksums.weighted11($0["serial"]!, weights: wFedEx34), $0["check"]) }),
    DetectionRule("fedex_34", .fedex, #"^[0-8]\d{19}(?<serial>\d{13})(?<check>\d)$"#,
                  grade: checked(.medium) { digitIs(Checksums.weighted11($0["serial"]!, weights: wFedEx34), $0["check"]) }),
    DetectionRule("fedex_astra_32", .fedex, #"^3\d{15}(?<serial>\d{11})(?<check>\d)\d{4}$"#,
                  grade: checked(.medium) { digitIs(Checksums.weighted11($0["serial"]!, weights: wFedEx12), $0["check"]) }),
    DetectionRule("fedex_ground", .fedex, #"^(?<serial>\d{14})(?<check>\d)$"#,
                  grade: checked(.medium) { digitIs(Checksums.mod10($0["serial"]!, evenMul: 1, oddMul: 3), $0["check"]) }),
    // Real FedEx 12-digit IDs often fail this check, so it only boosts confidence.
    DetectionRule("fedex_12", .fedex, #"^(?<serial>\d{11})(?<check>\d)$"#) { m in
        digitIs(Checksums.weighted11(m["serial"]!, weights: wFedEx12), m["check"]) ? .medium : .low
    },
]

private let dhlRules: [DetectionRule] = [
    DetectionRule("dhl_express", .dhl, #"^(?<serial>\d{9,10})(?<check>\d)$"#,
                  grade: checked(.low) { digitIs(Checksums.mod7($0["serial"]!), $0["check"]) }),
    DetectionRule("dhl_express_piece_id", .dhl, #"^J[A-Z]{2,3}\d{9,10}$"#, grade: always(.medium)),
    DetectionRule("dhl_ecommerce", .dhlEcommerce,
                  #"^(?:GM|LX|RX|UV|CN|SG|TH|IN|HK|MY)(?=[0-9A-Z]*\d)[0-9A-Z]{10,39}$"#, grade: always(.medium)),
]

private let otherRules: [DetectionRule] = [
    DetectionRule("amazon_logistics", .amazon, #"^TB[ACM]\d{12}$"#, grade: always(.high)),
    // OnTrac C/D: the letter counts as 4 / 5 in the check.
    DetectionRule("ontrac_c", .ontrac, #"^C(?<serial>\d{13})(?<check>\d)$"#,
                  grade: checked(.high) { digitIs(Checksums.mod10("4" + $0["serial"]!, evenMul: 1, oddMul: 2), $0["check"]) }),
    DetectionRule("ontrac_d", .ontrac, #"^D(?<serial>\d{13})(?<check>\d)$"#,
                  grade: checked(.high) { digitIs(Checksums.mod10("5" + $0["serial"]!, evenMul: 1, oddMul: 2), $0["check"]) }),
    // LaserShip merged into OnTrac; Porchlight reports its numbers as ontrac.
    DetectionRule("lasership_1ls7", .ontrac, #"^1LS7[12](?:\d{10}|\d{2}01[1-4]\d{6})$"#, grade: always(.medium)),
    DetectionRule("lasership_1lscx", .ontrac, #"^1LSCX[0-9A-Z]{10}$"#, grade: always(.medium)),
    DetectionRule("lasership_lx", .ontrac, #"^L[AIEHNX][1-3]\d{7}$"#, grade: always(.medium)),
    DetectionRule("uniuni_uus", .uniuni, #"^UUS[0-9A-Z]{13,16}$"#, grade: always(.high)),
    DetectionRule("uniuni_ur", .uniuni, #"^UR\d{17}$"#, grade: always(.high)),
    DetectionRule("uniuni_unia", .uniuni, #"^UNIA\d{9}(?:YQ)?$"#, grade: always(.medium)),
    // Jitsu: no format-only rule in v1; detected from mail context instead.
]

let detectionRules: [DetectionRule] = uspsRules + upsRules + fedexRules + dhlRules + otherRules
