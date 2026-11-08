import PorchKit
import PorchUI
import SwiftUI

/// Package detail (DESIGN.md §6 "Detail"): title, status and ETA sentence,
/// facts, items, timeline, then Refresh, Archive and Delete.
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
        .navigationTitle(pkg?.displayTitle ?? "")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar { toolbar }
        .task(id: TaskKey(id: packageId, revision: services.revision)) { await load() }
        .alert("Rename package", isPresented: $renaming) {
            TextField("Title", text: $draftTitle)
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

    // MARK: Content

    private func content(_ pkg: Package, now: Date) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PorchSpacing.l) {
                header(pkg, now: now)
                facts(pkg, now: now)
                if !pkg.items.isEmpty { items(pkg) }
                timeline(pkg, now: now)
                actions(pkg)
            }
            .frame(maxWidth: 720, alignment: .leading)
            .padding(.horizontal, PorchSpacing.l)
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
            .accessibilityHint("Renames the package")
            .accessibilityAddTraits(.isHeader)

            HStack(alignment: .firstTextBaseline, spacing: PorchSpacing.xs) {
                StatusDot(pkg.status, withLabel: true)
                Text("·").foregroundStyle(PorchColor.mute).accessibilityHidden(true)
                Text(ArrivalPhrases.sentence(pkg, now: now, timeZone: .current))
                    .font(PorchFont.body)
                    .monospacedDigit()
                    .foregroundStyle(PorchColor.body)
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
            FactRow("Carrier") { CarrierBadge(pkg.carrier) }
            FactRow("Tracking number") {
                HStack(spacing: PorchSpacing.xs) {
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
                    .buttonStyle(.bordered)
                    .controlSize(.small)
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
                .padding(.vertical, PorchSpacing.xs)
                .overlay(alignment: .bottom) { Rectangle().fill(PorchColor.line).frame(height: 1) }
            }
        }
    }

    @ViewBuilder
    private func timeline(_ pkg: Package, now: Date) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            sectionLabel("Timeline")
            if events.isEmpty {
                EmptyState(
                    "No scans yet",
                    message: "\(pkg.carrier.displayName) hasn't reported this number. Porchlight checks again within the hour.",
                    size: .inline
                )
                .padding(.horizontal, -PorchSpacing.l)
                .padding(.top, -PorchSpacing.l)
            } else {
                EventTimeline(days: PackageText.timelineDays(events, now: now, timeZone: .current), newestStatus: pkg.status)
            }
        }
    }

    private func actions(_ pkg: Package) -> some View {
        HStack(spacing: PorchSpacing.xs) {
            Button {
                Task { await refresh() }
            } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
            }
            .buttonStyle(.bordered)
            .disabled(refreshing)

            Button(pkg.isArchived ? "Unarchive" : "Archive") {
                Task { await setArchived(!pkg.isArchived) }
            }
            .buttonStyle(.bordered)

            Spacer()

            Button("Delete", role: .destructive) { confirmingDelete = true }
                .buttonStyle(.bordered)
        }
        .padding(.top, PorchSpacing.xs)
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text)
            .font(PorchFont.label)
            .foregroundStyle(PorchColor.mute)
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
            message = "Asked \(pkg?.carrier.displayName ?? "the carrier") for an update. New scans appear here when it answers."
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
