import PorchKit
import PorchUI
import SwiftUI

/// The package list (DESIGN.md §6): five arrival-day sections, problems pinned
/// first, search, pull to refresh. iPhone: rows push the detail and swipe to
/// archive or delete. Mac: the sidebar of a split view, with a context menu.
struct PackageListView: View {
    /// Mac: the selected package shown in the detail pane. iPhone: unused.
    @Binding var selection: String?
    /// Opens a package after Add (iPhone pushes it, the Mac selects it).
    var open: (String) -> Void

    @Environment(ScreenServices.self) private var services
    @State private var model = PackageListModel()
    @State private var query = ""
    @State private var showingAdd = false
    @State private var showingSettings = false
    @State private var confirmingDelete: Package?
    @State private var didFirstSync = false
    @FocusState private var searchFocused: Bool

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            content(now: context.date)
        }
        .background(PorchColor.canvas)
        .navigationTitle("Packages")
        .searchable(text: $query, prompt: "Search packages")
        .searchFocused($searchFocused)
        #if os(macOS)
        .background { findShortcut }
        #endif
        .toolbar { toolbar }
        .task(id: services.revision) { await model.load(services) }
        .task {
            guard !didFirstSync else { return }
            didFirstSync = true
            await model.refresh(services)
        }
        .sheet(isPresented: $showingAdd) {
            NavigationStack {
                AddPackageView { id in
                    showingAdd = false
                    if let id { open(id) }
                }
            }
            #if os(macOS)
            .frame(minWidth: 460, minHeight: 420)
            #endif
        }
        .sheet(isPresented: $showingSettings) {
            NavigationStack {
                SettingsView()
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) { Button("Done") { showingSettings = false } }
                    }
            }
            #if os(macOS)
            .frame(minWidth: 520, minHeight: 560)
            #endif
        }
        .confirmationDialog(
            confirmingDelete.map { "Delete \($0.displayTitle)?" } ?? "",
            isPresented: Binding(get: { confirmingDelete != nil }, set: { if !$0 { confirmingDelete = nil } }),
            titleVisibility: .visible,
            presenting: confirmingDelete
        ) { pkg in
            Button("Delete package", role: .destructive) {
                if selection == pkg.id { selection = nil }
                Task { await model.delete(pkg, services) }
            }
        } message: { _ in
            Text("It stops being tracked on all your devices.")
        }
    }

    // MARK: Content

    @ViewBuilder
    private func content(now: Date) -> some View {
        let groups = model.groups(query: query, now: now)
        if !model.loaded {
            Color.clear // loading is a blank space that fills (DESIGN.md §8)
        } else if model.packages.isEmpty, let failure = model.loadError ?? model.syncError {
            ScrollView {
                EmptyState("Couldn't reach Porchlight", message: failure) {
                    Button("Try again") { Task { await model.refresh(services) } }
                        .buttonStyle(.bordered)
                }
            }
        } else if model.packages.allSatisfy(\.isArchived), query.isEmpty {
            ScrollView {
                EmptyState("Nothing on the way", message: emptyMessage) {
                    Button("Add a package") { showingAdd = true }
                        .buttonStyle(.borderedProminent)
                }
            }
            .refreshable { await model.refresh(services) }
        } else {
            list(groups, now: now)
        }
    }

    private var emptyMessage: String {
        #if os(iOS)
        "Paste a tracking number or scan the barcode on a shipping label."
        #else
        "Paste a tracking number to start tracking a package."
        #endif
    }

    private func list(_ groups: [ArrivalGroup], now: Date) -> some View {
        List(selection: listSelection) {
            if let stale = model.staleLine(now: now) {
                HStack(spacing: PorchSpacing.xs) {
                    Text(stale).font(PorchFont.bodySmall).foregroundStyle(PorchColor.mute)
                    Button("Try again") { Task { await model.refresh(services) } }
                        .buttonStyle(.borderless)
                        .font(PorchFont.bodySmall)
                }
                .listRowSeparator(.hidden)
            }
            if let failure = model.actionError {
                ErrorLine(failure).listRowSeparator(.hidden)
            }
            if groups.isEmpty {
                EmptyState("No matches", message: "Nothing matches \u{201C}\(query.trimmingCharacters(in: .whitespaces))\u{201D}.", size: .inline)
                    .listRowSeparator(.hidden)
            }
            ForEach(groups) { group in
                Section {
                    ForEach(group.packages) { pkg in
                        row(pkg, now: now)
                    }
                } header: {
                    HStack(spacing: PorchSpacing.xxs) {
                        Text(group.label)
                        Text("\(group.packages.count)").monospacedDigit()
                    }
                    .font(PorchFont.label)
                    .foregroundStyle(PorchColor.mute)
                    .accessibilityElement(children: .combine)
                }
            }
        }
        #if os(iOS)
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        #else
        .listStyle(.sidebar)
        #endif
        .listRowSeparatorTint(PorchColor.line)
        .refreshable { await model.refresh(services) }
        #if os(macOS)
        // The Delete key (and Edit > Delete) on the selected row asks first.
        .onDeleteCommand {
            guard let selection, let pkg = model.packages.first(where: { $0.id == selection }) else { return }
            confirmingDelete = pkg
        }
        #endif
    }

    #if os(macOS)
    /// ⌘F moves focus to the search field. The button has no size and no
    /// accessibility element; it exists only for its shortcut.
    private var findShortcut: some View {
        Button("Search packages") { searchFocused = true }
            .keyboardShortcut("f", modifiers: .command)
            .frame(width: 0, height: 0)
            .opacity(0)
            .accessibilityHidden(true)
    }
    #endif

    private var listSelection: Binding<String?>? {
        #if os(macOS)
        $selection
        #else
        nil
        #endif
    }

    @ViewBuilder
    private func row(_ pkg: Package, now: Date) -> some View {
        #if os(iOS)
        NavigationLink(value: pkg.id) { PackageRow(pkg, now: now) }
            .listRowBackground(PorchColor.canvas)
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                Button("Delete", systemImage: "trash", role: .destructive) { confirmingDelete = pkg }
                Button("Archive", systemImage: "archivebox") { Task { await model.setArchived(pkg, true, services) } }
            }
            .contextMenu { rowMenu(pkg) }
        #else
        PackageRow(pkg, now: now)
            .tag(pkg.id)
            .contextMenu { rowMenu(pkg) }
        #endif
    }

    @ViewBuilder
    private func rowMenu(_ pkg: Package) -> some View {
        Button("Copy tracking number", systemImage: "doc.on.doc") { Clipboard.copy(pkg.trackingNumber) }
        Button("Archive", systemImage: "archivebox") {
            if selection == pkg.id { selection = nil }
            Task { await model.setArchived(pkg, true, services) }
        }
        Divider()
        Button("Delete", systemImage: "trash", role: .destructive) { confirmingDelete = pkg }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            Button("Add package", systemImage: "plus") { showingAdd = true }
                .keyboardShortcut("n", modifiers: .command)
        }
        #if os(macOS)
        ToolbarItem {
            Button("Refresh", systemImage: "arrow.clockwise") { Task { await model.refresh(services) } }
                .keyboardShortcut("r", modifiers: .command)
                .disabled(model.syncing)
        }
        #endif
        ToolbarItem(placement: settingsPlacement) {
            Button("Settings", systemImage: "gearshape") { showingSettings = true }
                .keyboardShortcut(",", modifiers: .command)
        }
    }

    private var settingsPlacement: ToolbarItemPlacement {
        #if os(iOS)
        .topBarLeading
        #else
        .automatic
        #endif
    }
}

#if DEBUG // ScreenServices.preview() exists only in Debug builds.
#Preview {
    NavigationStack {
        PackageListView(selection: .constant(nil), open: { _ in })
            .navigationDestination(for: String.self) { PackageDetailView(packageId: $0) }
    }
    .environment(ScreenServices.preview())
}
#endif
