import PorchKit
import PorchUI
import SwiftUI

/// Switches between sign-in and the package list, and applies the Appearance setting.
struct RootView: View {
    @Environment(AppModel.self) private var model
    @AppStorage(ThemePreference.storageKey) private var theme = ThemePreference.system

    var body: some View {
        Group {
            switch model.phase {
            case .signedOut:
                SignInView()
            case .signedIn:
                SignedInView()
            }
        }
        .background(PorchColor.canvas)
        .porchChrome()
        .environment(model.screens)
        .preferredColorScheme(theme.colorScheme)
    }
}

/// iPhone: a navigation stack. Mac: a two-pane window (SPEC §8).
private struct SignedInView: View {
    @Environment(DeepLinkRouter.self) private var router
    @Environment(ScreenServices.self) private var services
    @State private var selection: String?
    @State private var listEmpty = false
    #if os(iOS)
    @State private var path: [String] = []
    #endif

    var body: some View {
        #if os(macOS)
        NavigationSplitView {
            PackageListView(selection: $selection, open: { selection = $0 }, onEmptyChange: { listEmpty = $0 })
                .navigationSplitViewColumnWidth(min: 300, ideal: 360, max: 480)
        } detail: {
            if let selection {
                PackageDetailView(packageId: selection)
                    .id(selection)
            } else {
                WindowPlaceholder(listEmpty: listEmpty, open: { selection = $0 })
            }
        }
        .frame(minWidth: 720, minHeight: 480)
        .task(id: router.pendingPackageId) { await openPendingLink() }
        #else
        NavigationStack(path: $path) {
            PackageListView(selection: $selection, open: { path = [$0] })
                .navigationDestination(for: String.self) { PackageDetailView(packageId: $0) }
        }
        .task(id: router.pendingPackageId) { await openPendingLink() }
        #endif
    }

    /// A `porchlight://p/<id>` link or a notification tap.
    private func openPendingLink() async {
        guard let id = router.pendingPackageId else { return }
        router.pendingPackageId = nil
        // A push can name a package this device hasn't synced yet.
        if (try? await services.repository.package(id: id)) == nil {
            _ = try? await services.sync.sync()
            services.didChange()
        }
        #if os(macOS)
        selection = id
        #else
        path = [id]
        #endif
    }
}

#if os(macOS)
/// The Mac detail pane with nothing selected: "Select a package", or, when
/// nothing is on the way, the empty state, here in the wide pane rather than
/// squeezed into the sidebar.
struct WindowPlaceholder: View {
    let listEmpty: Bool
    /// Selects a package after Add.
    var open: (String) -> Void
    @State private var showingAdd = false

    var body: some View {
        if listEmpty {
            ScrollView {
                EmptyState("Nothing on the way", message: "Paste a tracking number to start tracking a package.") {
                    Button("Add a package") { showingAdd = true }
                        .buttonStyle(.borderedProminent)
                }
            }
            .background(PorchColor.canvas)
            .sheet(isPresented: $showingAdd) {
                NavigationStack {
                    AddPackageView { id in
                        showingAdd = false
                        if let id { open(id) }
                    }
                }
                .frame(minWidth: 480, minHeight: 420)
            }
        } else {
            Text("Select a package")
                .font(PorchFont.body)
                .foregroundStyle(PorchColor.mute)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(PorchColor.canvas)
        }
    }
}
#endif
