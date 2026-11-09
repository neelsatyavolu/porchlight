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
    /// Mac: told whether nothing is on the way. The sidebar then stays blank
    /// and the detail pane shows the empty state (`WindowPlaceholder`).
    var onEmptyChange: (Bool) -> Void = { _ in }

    @Environment(ScreenServices.self) private var services
    #if os(macOS)
    /// False when the window is in the background: the selection turns from accent to a quiet fill.
    @Environment(\.appearsActive) private var appearsActive
    #endif
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
        .porchChrome()
        .navigationTitle("Packages")
        .searchable(text: $query, prompt: "Search packages")
        .searchFocused($searchFocused)
        #if os(macOS)
        .background { findShortcut }
        #endif
        .toolbar { toolbar }
        .task(id: services.revision) { await model.load(services) }
        .onChange(of: showsEmptyState, initial: true) { _, empty in onEmptyChange(empty) }
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
            .frame(minWidth: 480, minHeight: 420)
            #endif
        }
        .sheet(isPresented: $showingSettings) {
            NavigationStack {
                SettingsView()
                    .sheetActions(primary: SheetButton("Done") { showingSettings = false })
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
            #if os(iOS)
            ScrollView {
                EmptyState("Nothing on the way", message: emptyMessage) {
                    Button("Add a package") { showingAdd = true }
                        .buttonStyle(.borderedProminent)
                }
            }
            .refreshable { await model.refresh(services) }
            #else
            Color.clear // the detail pane says "Nothing on the way"
            #endif
        } else {
            list(groups, now: now)
        }
    }

    private var showsEmptyState: Bool {
        model.loaded && model.packages.allSatisfy(\.isArchived)
    }

    #if os(iOS)
    private var emptyMessage: String {
        "Paste a tracking number or scan the barcode on a shipping label."
    }
    #endif

    private func list(_ groups: [ArrivalGroup], now: Date) -> some View {
        List {
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
        #else
        .listStyle(.sidebar)
        #endif
        // The canvas shows through on both platforms, so the Mac sidebar and
        // the detail pane read as one black (or white) window.
        .scrollContentBackground(.hidden)
        .listRowSeparatorTint(PorchColor.line)
        .refreshable { await model.refresh(services) }
        #if os(macOS)
        // Up and down move the selection, as the system list's did.
        .focusable()
        .focusEffectDisabled()
        .onMoveCommand { direction in moveSelection(direction, in: groups) }
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

    #if os(macOS)
    private func moveSelection(_ direction: MoveCommandDirection, in groups: [ArrivalGroup]) {
        let ids = groups.flatMap { $0.packages.map(\.id) }
        guard !ids.isEmpty else { return }
        let index = selection.flatMap { ids.firstIndex(of: $0) }
        switch direction {
        case .down: selection = ids[min((index ?? -1) + 1, ids.count - 1)]
        case .up: selection = ids[max((index ?? ids.count) - 1, 0)]
        default: break
        }
    }
    #endif

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
        // The Mac list draws its own selection (SelectionFill) and tells the row,
        // instead of relying on the sidebar's, whose text colors didn't follow.
        PackageRow(pkg, now: now, highlighted: selection == pkg.id && appearsActive)
            .background { if selection == pkg.id { SelectionFill(active: appearsActive) } }
            .contentShape(Rectangle())
            .onTapGesture { selection = pkg.id }
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

#if os(macOS)
/// The selected row's fill: the accent while the window is active (the row's
/// text turns white), an Elev fill with a hairline when it isn't.
private struct SelectionFill: View {
    let active: Bool

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: PorchRadius.control)
        Group {
            if active {
                shape.fill(PorchColor.accent)
            } else {
                shape.fill(PorchColor.elev).strokeBorder(PorchColor.line2)
            }
        }
        .padding(.horizontal, -PorchSpacing.xs)
        .padding(.vertical, -PorchSpacing.xxs)
    }
}
#endif

#if DEBUG // ScreenServices.preview() exists only in Debug builds.
#Preview {
    NavigationStack {
        PackageListView(selection: .constant(nil), open: { _ in })
            .navigationDestination(for: String.self) { PackageDetailView(packageId: $0) }
    }
    .environment(ScreenServices.preview())
}
#endif
