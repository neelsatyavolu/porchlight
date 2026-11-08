import PorchKit
import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// Whole-screen or inline empty state (DESIGN.md §5 EmptyState): a title,
/// one or two sentences, at most one action.
public struct EmptyState<Action: View>: View {
    public enum Size { case page, inline }

    let title: String
    let message: String?
    let size: Size
    let action: Action

    public init(_ title: String, message: String? = nil, size: Size = .page, @ViewBuilder action: () -> Action) {
        self.title = title
        self.message = message
        self.size = size
        self.action = action()
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: PorchSpacing.s) {
            Text(title)
                .font(size == .page ? PorchFont.displaySmall : PorchFont.headingSmall)
                .foregroundStyle(PorchColor.ink)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            if let message {
                Text(message)
                    .font(PorchFont.body)
                    .foregroundStyle(PorchColor.body)
                    .fixedSize(horizontal: false, vertical: true)
            }
            action.padding(.top, PorchSpacing.xs)
        }
        .frame(maxWidth: 480, alignment: .leading)
        .padding(.top, size == .page ? PorchSpacing.page : PorchSpacing.l)
        .padding(.horizontal, PorchSpacing.l)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

extension EmptyState where Action == EmptyView {
    public init(_ title: String, message: String? = nil, size: Size = .page) {
        self.init(title, message: message, size: size) { EmptyView() }
    }
}

/// A form error or failure line in Danger, announced to VoiceOver.
public struct ErrorLine: View {
    let text: String
    public init(_ text: String) { self.text = text }

    public var body: some View {
        Text(text)
            .font(PorchFont.bodySmall)
            .foregroundStyle(PorchColor.danger)
            .fixedSize(horizontal: false, vertical: true)
            .onAppear { announce(text) }
            .onChange(of: text) { _, new in announce(new) }
    }

    private func announce(_ message: String) {
        #if canImport(UIKit)
        UIAccessibility.post(notification: .announcement, argument: message)
        #endif
    }
}

/// A label/value line in the detail view's facts list (DESIGN.md §6 Detail, item 4).
public struct FactRow<Value: View>: View {
    let label: String
    let value: Value
    @Environment(\.dynamicTypeSize) private var typeSize
    /// The label column grows with the text size.
    @ScaledMetric(relativeTo: .subheadline) private var labelWidth: CGFloat = 120

    public init(_ label: String, @ViewBuilder value: () -> Value) {
        self.label = label
        self.value = value()
    }

    public var body: some View {
        // At accessibility sizes the value goes under its label instead of
        // being squeezed into what's left of the row.
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: PorchSpacing.xxs))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: PorchSpacing.m))
        layout {
            Text(label)
                .font(PorchFont.bodySmall)
                .foregroundStyle(PorchColor.mute)
                .frame(width: typeSize.isAccessibilitySize ? nil : labelWidth, alignment: .leading)
            value
                .font(PorchFont.body)
                .foregroundStyle(PorchColor.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, PorchSpacing.s)
        .overlay(alignment: .bottom) { Rectangle().fill(PorchColor.line).frame(height: 1) }
        .accessibilityElement(children: .combine)
    }
}

/// The system pasteboard on either platform.
public enum Clipboard {
    @MainActor public static func copy(_ string: String) {
        #if canImport(UIKit)
        UIPasteboard.general.string = string
        #elseif canImport(AppKit)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(string, forType: .string)
        #endif
    }
}

/// The Appearance setting. Stored in UserDefaults under `storageKey`; the root
/// view applies `colorScheme` with `.preferredColorScheme`.
public enum ThemePreference: String, CaseIterable, Identifiable, Sendable {
    case system, light, dark

    public static let storageKey = "porchlight.theme"

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .system: "Match system"
        case .light: "Light"
        case .dark: "Dark"
        }
    }

    public var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}
