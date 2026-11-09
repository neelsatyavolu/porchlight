import SwiftUI

public extension View {
    /// Paints the Mac title bar, a sheet's title and button bars, and the sheet
    /// itself in the canvas color, so they don't show the system gray next to
    /// the black canvas. On iPhone it does the same for the navigation bar.
    /// Apply it to the content inside a window, sheet or NavigationStack.
    func porchChrome() -> some View {
        #if os(macOS)
        self
            .toolbarBackground(PorchColor.canvas, for: .windowToolbar)
            .toolbarBackgroundVisibility(.visible, for: .windowToolbar)
            .presentationBackground(PorchColor.canvas)
        #else
        // The navigation bar takes the canvas once content scrolls under it.
        // It only takes effect inside a NavigationStack's content.
        self
            .toolbarBackground(PorchColor.canvas, for: .navigationBar)
            .presentationBackground(PorchColor.canvas)
        #endif
    }
}

/// A grouped Form on the canvas with rows the same on Mac and iPhone: Card on
/// the dark canvas, Elev on the light one, where a white Card row would vanish
/// for want of the hairline a Form row can't have. That is what the Mac's
/// grouped Form draws by itself; iPhone would otherwise draw its system gray
/// (#1C1C1E) rows on the black canvas.
public struct PorchForm<Content: View>: View {
    let content: Content

    public init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    public var body: some View {
        Form {
            // A Group hands the modifier to each Section, which hands it to its rows.
            Group { content }.porchFormRow()
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
        .background(PorchColor.canvas)
    }
}

public extension View {
    /// PorchForm's row fill, for a List's rows too. The Mac's grouped Form
    /// ignores it and draws its own, which matches.
    func porchFormRow() -> some View {
        listRowBackground(FormRowFill())
    }

    /// DESIGN.md §5 Input: 40pt tall, Card fill, Line2 hairline, 8pt radius;
    /// the hairline turns accent while the field has focus.
    func porchInput(focused: Bool) -> some View {
        textFieldStyle(.plain)
            .padding(.horizontal, PorchSpacing.s)
            .padding(.vertical, PorchSpacing.xs)
            .frame(minHeight: 40)
            .background(PorchColor.card, in: RoundedRectangle(cornerRadius: PorchRadius.control, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: PorchRadius.control, style: .continuous)
                    .strokeBorder(focused ? PorchColor.accent : PorchColor.line2, lineWidth: 1)
            )
    }
}

private struct FormRowFill: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        colorScheme == .dark ? PorchColor.card : PorchColor.elev
    }
}

/// DESIGN.md §5 Danger: red text on a Line2 hairline, 8pt radius. For Delete
/// and other destructive actions only; give the Button `role: .destructive`.
public struct PorchDangerButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.controlSize) private var controlSize

    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: PorchRadius.control, style: .continuous)
        configuration.label
            .foregroundStyle(isEnabled ? PorchColor.danger : PorchColor.stone)
            .lineLimit(1)
            .padding(.horizontal, PorchSpacing.s)
            .frame(minHeight: height)
            .background(configuration.isPressed ? PorchColor.elev : Color.clear, in: shape)
            .overlay(shape.strokeBorder(PorchColor.line2, lineWidth: 1))
            .contentShape(shape)
    }

    /// The system bordered button's height at the same control size, so a
    /// Danger button lines up with its neighbors.
    private var height: CGFloat {
        #if os(macOS)
        controlSize == .large ? 28 : 24
        #else
        controlSize == .large ? 50 : 34
        #endif
    }
}

public extension ButtonStyle where Self == PorchDangerButtonStyle {
    static var porchDanger: PorchDangerButtonStyle { PorchDangerButtonStyle() }
}
