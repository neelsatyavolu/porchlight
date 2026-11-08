import PorchKit
import SwiftUI

// CONTRACT: the SwiftUI side of DESIGN.md §9. Screens use these names, never
// raw colors, font names or magic numbers.

/// Color tokens from Resources/Colors.xcassets (DESIGN.md §2). Each has a light
/// (Any) and Dark value; Mute, Line and Line2 also have Increase Contrast values.
public enum PorchColor {
    public static let canvas = named("Canvas")
    public static let card = named("Card")
    public static let elev = named("Elev")
    public static let ink = named("Ink")
    public static let body = named("Body")
    public static let mute = named("Mute")
    public static let stone = named("Stone")
    public static let line = named("Line")
    public static let line2 = named("Line2")
    /// The app's AccentColor uses the same values; system controls pick it up from there.
    public static let accent = named("Accent")
    public static let tint = named("Tint")
    public static let ok = named("Ok")
    public static let warn = named("Warn")
    /// Destructive actions and form errors. Never a package status.
    public static let danger = named("Danger")

    public static func tone(_ tone: StatusTone) -> Color {
        switch tone {
        case .out: accent
        case .delivered: ok
        case .exception: warn
        case .neutral: mute
        }
    }

    private static func named(_ name: String) -> Color { Color(name, bundle: .module) }
}

/// Content fonts (DESIGN.md §9). Chrome (nav bars, toolbars, section headers,
/// buttons, alerts, the menu-bar item) stays on the system font: don't use
/// these there. The Geist files are bundled by the app targets and registered
/// through Info.plist (UIAppFonts / ATSApplicationFontsPath). Where they aren't
/// registered (the share extension), SwiftUI falls back to the system font.
public enum PorchFont {
    public enum Name {
        public static let regular = "Geist-Regular"
        public static let medium = "Geist-Medium"
        public static let mono = "GeistMono-Regular"
        public static let serif = "GeistSerif-Regular"
    }

    /// Display 48: the sign-in wordmark only.
    public static let display = Font.custom(Name.serif, size: 48, relativeTo: .largeTitle)
    /// Display small 40: whole-screen empty states only. Never smaller.
    public static let displaySmall = Font.custom(Name.serif, size: 40, relativeTo: .largeTitle)
    /// Heading 22/500: detail title.
    public static let heading = Font.custom(Name.medium, size: 22, relativeTo: .title2)
    /// Heading small 18/500: inline empty states.
    public static let headingSmall = Font.custom(Name.medium, size: 18, relativeTo: .title3)
    /// Row title 15/500.
    public static let rowTitle = Font.custom(Name.medium, size: 15, relativeTo: .body)
    /// Body 15.
    public static let body = Font.custom(Name.regular, size: 15, relativeTo: .body)
    /// Body small 14: row meta, ETA phrase, timeline location and time.
    public static let bodySmall = Font.custom(Name.regular, size: 14, relativeTo: .subheadline)
    /// Caption 12: hints, "Last checked", badges.
    public static let caption = Font.custom(Name.regular, size: 12, relativeTo: .caption)
    /// Mono 13: tracking numbers, order ids, pairing codes.
    public static let mono = Font.custom(Name.mono, size: 13, relativeTo: .footnote)
    /// Pairing code shown large (22px Mono, DESIGN.md §7 Settings).
    public static let monoLarge = Font.custom(Name.mono, size: 22, relativeTo: .title2)
    /// Group headers ("Today 3") are section headers, so system: chrome.
    public static let label = Font.footnote.weight(.medium)
}

/// The 4pt grid (DESIGN.md §8).
public enum PorchSpacing {
    public static let xxs: CGFloat = 4
    public static let xs: CGFloat = 8
    public static let s: CGFloat = 12
    public static let m: CGFloat = 16
    public static let l: CGFloat = 24
    public static let xl: CGFloat = 32
    public static let xxl: CGFloat = 48
    public static let page: CGFloat = 96
    /// Package rows are at least this tall.
    public static let rowMinHeight: CGFloat = 64
}

public enum PorchRadius {
    public static let badge: CGFloat = 6
    public static let control: CGFloat = 8
    public static let card: CGFloat = 12
}

extension View {
    /// Mono text styling for tracking numbers and codes: Geist Mono, 0.02em tracking.
    public func porchMono(size: CGFloat = 13) -> some View {
        font(size == 13 ? PorchFont.mono : Font.custom(PorchFont.Name.mono, size: size, relativeTo: .footnote))
            .tracking(size * 0.02)
            .monospacedDigit()
    }
}
