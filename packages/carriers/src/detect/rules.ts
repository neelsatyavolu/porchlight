// Format + checksum rules for detectCarrier (docs/research/number-formats.md).
// Regexes and checksum parameters are derived from jkeen/tracking_number_data
// (MIT, (c) 2017 Jeff Keen) at commit 03af203 (v2.0.0), anchored and with the
// `\s*` fragments removed because input is normalized first.
import type { CarrierId, Confidence } from "../types.js";
import { mod7, mod10, s10, weighted11 } from "./checksums.js";
import { S10_COUNTRIES } from "./countries.js";

export interface Rule {
  name: string;
  carrier: CarrierId;
  pattern: RegExp;
  /** Confidence for a match, or null to reject it (failed check digit etc). */
  grade: (m: RegExpExecArray) => Confidence | null;
}

type Groups = Record<string, string>;
const g = (m: RegExpExecArray): Groups => (m.groups ?? {}) as Groups;
const digitIs = (expected: number, check: string | undefined) => check !== undefined && Number(check) === expected;

/** Grade `conf` when the check passes, else reject. */
const checked =
  (conf: Confidence, check: (x: Groups) => boolean) =>
  (m: RegExpExecArray): Confidence | null =>
    check(g(m)) ? conf : null;

const always = (conf: Confidence) => (): Confidence => conf;

const W_FEDEX_12 = [3, 1, 7, 3, 1, 7, 3, 1, 7, 3, 1] as const;
const W_FEDEX_34 = [1, 7, 3, 1, 7, 3, 1, 7, 3, 1, 7, 3, 1] as const;

const IMPB_N =
  /^(?:420\d{5}(?=\d{22}$|\d{26}$)(?:\d{4}(?=\d{22}$))?)?(?<serial>94\d{3}(?=9\d{8}(?:\d{15}|\d{11}|\d{7})\d$|[0-8]\d{5}(?:\d{14}|\d{10})\d$)(?:9\d{8}|[0-8]\d{5})(?:\d{15}|\d{14}|\d{11}|\d{10}|\d{7}))(?<check>\d)$/;
const IMPB_C =
  /^(?:420\d{5}(?:\d{4}(?=\d{22}$))?)?(?<serial>(?:92(?=\d{3}9)|93(?=\d{3}[0-8])|95)\d{3}(?=9\d{8}(?:\d{11}|\d{7})\d$|[0-8]\d{5}(?:\d{14}|\d{10})\d$)(?:9\d{8}|[0-8]\d{5})(?:\d{14}|\d{11}|\d{10}|\d{7}))(?<check>\d)$/;

const USPS: Rule[] = [
  { name: "usps_impb_n", carrier: "usps", pattern: IMPB_N, grade: checked("high", (x) => digitIs(mod10(x.serial!, 3, 1, true), x.check)) },
  { name: "usps_impb_c", carrier: "usps", pattern: IMPB_C, grade: checked("high", (x) => digitIs(mod10(x.serial!, 3, 1), x.check)) },
  {
    name: "usps_legacy",
    carrier: "usps",
    pattern: /^(?<prefix>420\d{5}(?:\d{4})?)?(?<serial>(?:91)?\d{19})(?<check>\d)$/,
    grade: (m) => {
      const x = g(m);
      const serial = x.serial!.startsWith("91") ? x.serial! : `91${x.serial}`;
      if (!digitIs(mod10(serial, 3, 1), x.check)) return null;
      return m[0].length > 20 ? "high" : "medium";
    },
  },
  { name: "usps_20", carrier: "usps", pattern: /^(?<serial>\d{19})(?<check>\d)$/, grade: checked("medium", (x) => digitIs(mod10(x.serial!, 3, 1), x.check)) },
  {
    name: "s10",
    carrier: "usps",
    pattern: /^[A-Z]{2}(?<serial>\d{8})(?<check>\d)(?<country>[A-Z]{2})$/,
    grade: (m) => {
      const x = g(m);
      if (!S10_COUNTRIES.has(x.country!) || !digitIs(s10(x.serial!), x.check)) return null;
      return x.country === "US" ? "high" : "medium";
    },
  },
];

const UPS: Rule[] = [
  { name: "ups_1z", carrier: "ups", pattern: /^1Z(?<serial>[0-9A-Z]{15})(?<check>\d)$/, grade: checked("high", (x) => digitIs(mod10(x.serial!, 1, 2), x.check)) },
  { name: "ups_waybill", carrier: "ups", pattern: /^[AHJKTV](?<serial>\d{9})(?<check>\d)$/, grade: checked("medium", (x) => digitIs(mod10(x.serial!, 1, 2), x.check)) },
  { name: "ups_mail_innovations", carrier: "ups", pattern: /^MI\d{6}[0-9A-Z]{1,22}$/, grade: always("medium") },
];

const FEDEX: Rule[] = [
  { name: "fedex_ground_96", carrier: "fedex", pattern: /^96\d{5}(?<serial>\d{14})(?<check>\d)$/, grade: checked("high", (x) => digitIs(mod10(x.serial!, 1, 3), x.check)) },
  { name: "fedex_ground_gsn", carrier: "fedex", pattern: /^96\d{18}(?<serial>\d{13})(?<check>\d)$/, grade: checked("high", (x) => digitIs(weighted11(x.serial!, W_FEDEX_34), x.check)) },
  { name: "fedex_34", carrier: "fedex", pattern: /^[0-8]\d{19}(?<serial>\d{13})(?<check>\d)$/, grade: checked("medium", (x) => digitIs(weighted11(x.serial!, W_FEDEX_34), x.check)) },
  { name: "fedex_astra_32", carrier: "fedex", pattern: /^3\d{15}(?<serial>\d{11})(?<check>\d)\d{4}$/, grade: checked("medium", (x) => digitIs(weighted11(x.serial!, W_FEDEX_12), x.check)) },
  { name: "fedex_ground", carrier: "fedex", pattern: /^(?<serial>\d{14})(?<check>\d)$/, grade: checked("medium", (x) => digitIs(mod10(x.serial!, 1, 3), x.check)) },
  // Real FedEx 12-digit IDs often fail this check, so it only boosts confidence.
  {
    name: "fedex_12",
    carrier: "fedex",
    pattern: /^(?<serial>\d{11})(?<check>\d)$/,
    grade: (m) => (digitIs(weighted11(g(m).serial!, W_FEDEX_12), g(m).check) ? "medium" : "low"),
  },
];

const DHL: Rule[] = [
  { name: "dhl_express", carrier: "dhl", pattern: /^(?<serial>\d{9,10})(?<check>\d)$/, grade: checked("low", (x) => digitIs(mod7(x.serial!), x.check)) },
  { name: "dhl_express_piece_id", carrier: "dhl", pattern: /^J[A-Z]{2,3}\d{9,10}$/, grade: always("medium") },
  {
    name: "dhl_ecommerce",
    carrier: "dhl_ecommerce",
    pattern: /^(?:GM|LX|RX|UV|CN|SG|TH|IN|HK|MY)(?=[0-9A-Z]*\d)[0-9A-Z]{10,39}$/,
    grade: always("medium"),
  },
];

const OTHERS: Rule[] = [
  { name: "amazon_logistics", carrier: "amazon", pattern: /^TB[ACM]\d{12}$/, grade: always("high") },
  // OnTrac C/D: the letter counts as 4 / 5 in the check.
  { name: "ontrac_c", carrier: "ontrac", pattern: /^C(?<serial>\d{13})(?<check>\d)$/, grade: checked("high", (x) => digitIs(mod10(`4${x.serial}`, 1, 2), x.check)) },
  { name: "ontrac_d", carrier: "ontrac", pattern: /^D(?<serial>\d{13})(?<check>\d)$/, grade: checked("high", (x) => digitIs(mod10(`5${x.serial}`, 1, 2), x.check)) },
  // LaserShip merged into OnTrac; Porchlight reports its numbers as ontrac.
  { name: "lasership_1ls7", carrier: "ontrac", pattern: /^1LS7[12](?:\d{10}|\d{2}01[1-4]\d{6})$/, grade: always("medium") },
  { name: "lasership_1lscx", carrier: "ontrac", pattern: /^1LSCX[0-9A-Z]{10}$/, grade: always("medium") },
  { name: "lasership_lx", carrier: "ontrac", pattern: /^L[AIEHNX][1-3]\d{7}$/, grade: always("medium") },
  { name: "uniuni_uus", carrier: "uniuni", pattern: /^UUS[0-9A-Z]{13,16}$/, grade: always("high") },
  { name: "uniuni_ur", carrier: "uniuni", pattern: /^UR\d{17}$/, grade: always("high") },
  { name: "uniuni_unia", carrier: "uniuni", pattern: /^UNIA\d{9}(?:YQ)?$/, grade: always("medium") },
  // Jitsu: no format-only rule in v1; detected from mail context instead.
];

export const RULES: readonly Rule[] = [...USPS, ...UPS, ...FEDEX, ...DHL, ...OTHERS];
