import SwiftUI

public extension View {
    /// Paints the Mac title bar, a sheet's title and button bars, and the sheet
    /// itself in the canvas color, so they don't show the system gray next to
    /// the black canvas. Apply it to the content inside a window or sheet.
    func porchChrome() -> some View {
        #if os(macOS)
        self
            .toolbarBackground(PorchColor.canvas, for: .windowToolbar)
            .toolbarBackgroundVisibility(.visible, for: .windowToolbar)
            .presentationBackground(PorchColor.canvas)
        #else
        self.presentationBackground(PorchColor.canvas)
        #endif
    }
}
