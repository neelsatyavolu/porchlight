import PorchUI
import SwiftUI

/// One button in a sheet's action bar.
struct SheetButton {
    var title: String
    var role: ButtonRole?
    var disabled = false
    var action: () -> Void

    init(_ title: String, role: ButtonRole? = nil, disabled: Bool = false, action: @escaping () -> Void) {
        self.title = title
        self.role = role
        self.disabled = disabled
        self.action = action
    }
}

extension View {
    /// A sheet's Cancel and main buttons. On the Mac they sit in a bar inside
    /// the sheet, on the canvas color with a hairline above (the system's bottom
    /// toolbar draws its own gray). On iPhone they go in the navigation bar.
    func sheetActions(cancel: SheetButton? = nil, primary: SheetButton? = nil) -> some View {
        modifier(SheetActions(cancel: cancel, primary: primary))
    }
}

private struct SheetActions: ViewModifier {
    let cancel: SheetButton?
    let primary: SheetButton?

    func body(content: Content) -> some View {
        #if os(macOS)
        content.safeAreaInset(edge: .bottom, spacing: 0) {
            HStack(spacing: PorchSpacing.s) {
                Spacer()
                if let cancel {
                    Button(cancel.title, role: cancel.role, action: cancel.action)
                        .keyboardShortcut(.cancelAction)
                        .disabled(cancel.disabled)
                }
                if let primary { primaryButton(primary) }
            }
            .controlSize(.large)
            .buttonBorderShape(.roundedRectangle(radius: PorchRadius.control))
            .padding(.horizontal, PorchSpacing.l)
            .padding(.vertical, PorchSpacing.s)
            .background(PorchColor.canvas)
            .overlay(alignment: .top) { Rectangle().fill(PorchColor.line).frame(height: 1) }
        }
        #else
        content.toolbar {
            if let cancel {
                ToolbarItem(placement: .cancellationAction) {
                    Button(cancel.title, role: cancel.role, action: cancel.action).disabled(cancel.disabled)
                }
            }
            if let primary {
                ToolbarItem(placement: primary.role == .destructive ? .destructiveAction : .confirmationAction) {
                    primaryButton(primary)
                }
            }
        }
        #endif
    }

    /// Return triggers it, except for a destructive one, which needs a click
    /// and takes the Danger style (DESIGN.md §5): red text on a hairline. In
    /// the iPhone navigation bar it stays a red bar button.
    @ViewBuilder
    private func primaryButton(_ b: SheetButton) -> some View {
        if b.role == .destructive {
            #if os(macOS)
            Button(b.title, role: b.role, action: b.action)
                .buttonStyle(.porchDanger)
                .disabled(b.disabled)
            #else
            Button(role: b.role, action: b.action) {
                Text(b.title).foregroundStyle(b.disabled ? PorchColor.stone : PorchColor.danger)
            }
            .disabled(b.disabled)
            #endif
        } else {
            Button(b.title, role: b.role, action: b.action)
                .disabled(b.disabled)
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
        }
    }
}
