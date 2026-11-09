import PorchKit
import PorchUI
import SwiftUI

/// Package detail (DESIGN.md §6 "Detail"): title, status and ETA sentence,
/// the route map when a stop could be located, timeline, facts, items,
/// then Refresh, Archive and Delete.
struct PackageDetailView: View {
    let packageId: String

    @Environment(ScreenServices.self) private var services
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    @State private var pkg: Package?
    @State private var events: [TrackEvent] = []
    @State private var loaded = false
    @State private var message: String?
    @State private var error: String?
    @State private var refreshing = false
    @State private var renaming = false
    @State private var draftTitle = ""
    @State private var confirmingDelete = false
    @State private var copied = false
    @State private var route: [RouteStop] = []

    var body: some View {
        Group {
            if let pkg {
                TimelineView(.periodic(from: .now, by: 60)) { context in
                    content(pkg, now: context.date)
                }
            } else if loaded {
                ScrollView {
                    EmptyState("This package isn't here", message: "It may have been deleted on another device.") {
                        #if os(iOS)
                        Button("Back to packages") { dismiss() }.buttonStyle(.bordered)
                        #endif
                    }
                }
            } else {
                Color.clear
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(PorchColor.canvas)
        .porchChrome()
        #if os(iOS)
        // The 22pt heading already names the package; a nav title would repeat it.
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        #else
        .navigationTitle(pkg?.displayTitle ?? "")
        #endif
        .toolbar { toolbar }
        .task(id: TaskKey(id: packageId, revision: services.revision)) { await load() }
        .task(id: routePlaces) { route = await PlaceLocator.locate(routePlaces) }
        .alert("Rename package", isPresented: $renaming) {
            TextField(pkg.map(Self.untitledName) ?? "Title", text: $draftTitle)
            Button("Cancel", role: .cancel) {}
            Button("Save") { Task { await saveTitle() } }
        } message: {
            Text("Leave it empty to use the merchant or carrier name.")
        }
        .confirmationDialog("Delete this package?", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("Delete package", role: .destructive) { Task { await delete() } }
        } message: {
            Text("It stops being tracked on all your devices.")
        }
    }

    private struct TaskKey: Hashable {
        var id: String
        var revision: Int
    }

    private var routePlaces: [String] { EventWords.route(events) }

    /// What the package is called with no title: the rename field's placeholder.
    private static func untitledName(_ pkg: Package) -> String {
        var untitled = pkg
        untitled.title = nil
        return untitled.displayTitle
    }

    /// 24pt gutters on the Mac, 16pt on the narrow iPhone column (DESIGN.md §8).
    private var gutter: CGFloat {
        #if os(iOS)
        PorchSpacing.m
        #else
        PorchSpacing.l
        #endif
    }

    // MARK: Content

    private func content(_ pkg: Package, now: Date) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PorchSpacing.l) {
                header(pkg, now: now)
                timeline(pkg, now: now)
                // The route under the scans it was drawn from (the owner's pick, after Parcel).
                if !route.isEmpty { RouteMap(stops: route) }
                facts(pkg, now: now)
                if !pkg.items.isEmpty { items(pkg) }
                actions(pkg)
            }
            .frame(maxWidth: 720, alignment: .leading)
            .padding(.horizontal, gutter)
            .padding(.vertical, PorchSpacing.l)
            .frame(maxWidth: .infinity)
        }
        .refreshable { await refresh() }
    }

    private func header(_ pkg: Package, now: Date) -> some View {
        VStack(alignment: .leading, spacing: PorchSpacing.xs) {
            Button {
                draftTitle = pkg.title ?? ""
                renaming = true
            } label: {
                Text(pkg.displayTitle)
                    .font(PorchFont.heading)
                    .foregroundStyle(PorchColor.ink)
                    .multilineTextAlignment(.leading)
            }
            .buttonStyle(.plain)
            .help("Rename")
            .accessibilityHint("Renames the package")
            .accessibilityAddTraits(.isHeader)

            // One line when it fits; on a narrow iPhone the sentence goes
            // under the status instead of wrapping in a column beside it.
            let sentence = Text(ArrivalPhrases.sentence(pkg, now: now, timeZone: .current))
                .font(PorchFont.body)
                .monospacedDigit()
                .foregroundStyle(PorchColor.body)
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline, spacing: PorchSpacing.xs) {
                    StatusDot(pkg.status, withLabel: true)
                    Text("·").foregroundStyle(PorchColor.mute).accessibilityHidden(true)
                    sentence.fixedSize()
                }
                VStack(alignment: .leading, spacing: PorchSpacing.xxs) {
                    StatusDot(pkg.status, withLabel: true)
                    sentence.fixedSize(horizontal: false, vertical: true)
                }
            }
            if let detail = pkg.statusDetail, !detail.isEmpty {
                Text(detail)
                    .font(PorchFont.bodySmall)
                    .foregroundStyle(PorchColor.mute)
            }
            if let message {
                Text(message).font(PorchFont.bodySmall).foregroundStyle(PorchColor.mute)
            }
            if let error { ErrorLine(error) }
        }
    }

    private func facts(_ pkg: Package, now: Date) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            sectionLabel("Details")
            FactRow("Carrier") { CarrierBadge(pkg.carrier) }
            FactRow("Tracking number") {
                HStack(alignment: .firstTextBaseline, spacing: PorchSpacing.xs) {
                    Text(pkg.trackingNumber)
                        .porchMono()
                        .textSelection(.enabled)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                    Spacer(minLength: 0)
                    Button(copied ? "Copied" : "Copy") {
                        Clipboard.copy(pkg.trackingNumber)
                        copied = true
                        Task {
                            try? await Task.sleep(for: .seconds(2))
                            copied = false
                        }
                    }
                    // Accent text, like the carrier link below: keeps the row as tall as its neighbours.
                    .buttonStyle(.borderless)
                    .font(PorchFont.bodySmall)
                    .foregroundStyle(PorchColor.accent)
                    .accessibilityLabel(copied ? "Copied" : "Copy tracking number")
                }
            }
            if let merchant = pkg.merchant, !merchant.isEmpty {
                FactRow("Merchant") { Text(merchant) }
            }
            if let order = pkg.orderId, !order.isEmpty {
                FactRow("Order") { Text(order).porchMono().textSelection(.enabled) }
            }
            FactRow("Source") { Text(pkg.source.label) }
            FactRow("Last checked") {
                Text(pkg.lastCheckedAt.map { TimeWords.ago($0, now: now) } ?? "Not yet")
                    .monospacedDigit()
                    .help(pkg.lastCheckedAt.map { TimeWords.fullDateTime($0, timeZone: .current) } ?? "")
            }
            if let url = PackageText.trackingURL(pkg.carrier, pkg.trackingNumber) {
                FactRow("Carrier site") {
                    Button("Open \(pkg.carrier.displayName) tracking") { openURL(url) }
                        .buttonStyle(.borderless)
                        .foregroundStyle(PorchColor.accent) // a link; FactRow paints values Ink
                }
            }
        }
    }

    /// Names and quantities only. No product images in v1: the URLs point at
    /// Amazon's CDN and loading them would tell Amazon when you look (DESIGN.md §6).
    private func items(_ pkg: Package) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            sectionLabel("Items")
            ForEach(Array(pkg.items.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .firstTextBaseline) {
                    Text(item.name).font(PorchFont.body).foregroundStyle(PorchColor.ink)
                    Spacer()
                    if item.quantity > 1 {
                        Text("\u{00D7}\(item.quantity)")
                            .font(PorchFont.bodySmall)
                            .monospacedDigit()
                            .foregroundStyle(PorchColor.mute)
                            .accessibilityLabel("Quantity \(item.quantity)")
                    }
                }
                .padding(.vertical, PorchSpacing.s) // same row height as the facts above
                .overlay(alignment: .bottom) { Rectangle().fill(PorchColor.line).frame(height: 1) }
            }
        }
    }

    @ViewBuilder
    private func timeline(_ pkg: Package, now: Date) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            sectionLabel("Timeline")
            if events.isEmpty {
                Text("No scans yet. \(SourceText.noScansText(pkg))")
                    .font(PorchFont.body)
                    .foregroundStyle(PorchColor.mute)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                EventTimeline(days: PackageText.timelineDays(events, now: now, timeZone: .current), newestStatus: pkg.status)
            }
            provenance(pkg, now: now)
        }
    }

    /// The device hint, where the status came from, and any line the
    /// carrier's terms require (DHL API), under the timeline.
    @ViewBuilder
    private func provenance(_ pkg: Package, now: Date) -> some View {
        let hint = SourceText.deviceHint(pkg, now: now)
        let source = SourceText.sourceLine(pkg, now: now)
        if hint != nil || source != nil || pkg.attribution != nil {
            VStack(alignment: .leading, spacing: PorchSpacing.xs) {
                if let hint { Text(hint).foregroundStyle(PorchColor.body) }
                if let source { Text(source).monospacedDigit().foregroundStyle(PorchColor.mute) }
                if let attribution = pkg.attribution { Text(attribution).foregroundStyle(PorchColor.body) }
            }
            .font(PorchFont.bodySmall)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, PorchSpacing.s)
        }
    }

    /// Refresh and Archive on the left, Delete on the right; when they don't
    /// fit on one line (large text on an iPhone), they stack instead of clipping.
    private func actions(_ pkg: Package) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: PorchSpacing.xs) {
                refreshButton
                archiveButton(pkg)
                Spacer(minLength: PorchSpacing.m)
                deleteButton
            }
            VStack(alignment: .leading, spacing: PorchSpacing.xs) {
                refreshButton
                archiveButton(pkg)
                deleteButton
            }
        }
        .buttonStyle(.bordered)
        .padding(.top, PorchSpacing.xs)
        .padding(.bottom, PorchSpacing.m)
    }

    private var refreshButton: some View {
        Button {
            Task { await refresh() }
        } label: {
            Label("Refresh", systemImage: "arrow.clockwise")
        }
        .disabled(refreshing)
        .fixedSize()
    }

    private func archiveButton(_ pkg: Package) -> some View {
        Button(pkg.isArchived ? "Unarchive" : "Archive", systemImage: "archivebox") {
            Task { await setArchived(!pkg.isArchived) }
        }
        .fixedSize()
    }

    private var deleteButton: some View {
        Button("Delete", systemImage: "trash", role: .destructive) { confirmingDelete = true }
            .buttonStyle(.porchDanger)
            .fixedSize()
    }

    /// A step above the timeline's Label-style day headers, so sections read as sections.
    private func sectionLabel(_ text: String) -> some View {
        Text(text)
            .font(PorchFont.headingSmall)
            .foregroundStyle(PorchColor.ink)
            .frame(minHeight: 32, alignment: .leading)
            .accessibilityAddTraits(.isHeader)
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        if let pkg {
            ToolbarItem(placement: .primaryAction) {
                Menu("More", systemImage: "ellipsis.circle") {
                    Button("Rename", systemImage: "pencil") {
                        draftTitle = pkg.title ?? ""
                        renaming = true
                    }
                    Button("Copy tracking number", systemImage: "doc.on.doc") { Clipboard.copy(pkg.trackingNumber) }
                    if let url = PackageText.trackingURL(pkg.carrier, pkg.trackingNumber) {
                        Button("Open \(pkg.carrier.displayName) tracking", systemImage: "safari") { openURL(url) }
                    }
                    Divider()
                    Button(pkg.isArchived ? "Unarchive" : "Archive", systemImage: "archivebox") {
                        Task { await setArchived(!pkg.isArchived) }
                    }
                    Button("Delete", systemImage: "trash", role: .destructive) { confirmingDelete = true }
            #if os(macOS)
            // The Mac draws a destructive bordered button like any other; Delete is red text (DESIGN.md §5).
            .foregroundStyle(PorchColor.danger)
            #endif
                }
            }
        }
    }

    // MARK: Actions

    private func load() async {
        do {
            pkg = try await services.repository.package(id: packageId)
            events = pkg == nil ? [] : try await services.repository.events(packageId: packageId)
            if let note = services.takeNote(for: packageId) { message = note }
        } catch {
            self.error = ErrorText.sentence(error)
        }
        loaded = true
    }

    private func refresh() async {
        guard !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        error = nil
        message = nil
        do {
            _ = try await services.sync.refresh(packageId: packageId)
            message = pkg.map(SourceText.refreshText) ?? "Asked the carrier for an update. New scans appear here when it answers."
            _ = try? await services.sync.sync()
            services.didChange()
        } catch {
            self.error = PackageText.refreshErrorText(error)
        }
    }

    private func saveTitle() async {
        let trimmed = draftTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        await write { try await services.sync.update(packageId: packageId, PackagePutRequest(title: .some(trimmed.isEmpty ? nil : trimmed))) }
    }

    private func setArchived(_ archived: Bool) async {
        await write { try await services.sync.update(packageId: packageId, PackagePutRequest(archived: archived)) }
    }

    private func delete() async {
        await write { try await services.sync.delete(packageId: packageId) }
        if error == nil { dismiss() }
    }

    private func write(_ work: () async throws -> Void) async {
        error = nil
        do {
            try await work()
            services.didChange()
        } catch {
            self.error = ErrorText.sentence(error)
        }
    }
}

#if DEBUG // ScreenServices.preview() exists only in Debug builds.
#Preview("Out for delivery") {
    NavigationStack { PackageDetailView(packageId: "p1") }.environment(ScreenServices.preview())
}

#Preview("No scans") {
    NavigationStack { PackageDetailView(packageId: "p5") }.environment(ScreenServices.preview())
}

#Preview("Missing") {
    NavigationStack { PackageDetailView(packageId: "nope") }.environment(ScreenServices.preview())
}
#endif
