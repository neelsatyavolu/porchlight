#if os(macOS)
import AppKit
import PorchKit
import PorchUI
import SwiftUI

/// The menu-bar item's window: today's deliveries (SPEC §8), the same Today
/// group the list shows, plus Open, Refresh and Quit.
struct MenuBarView: View {
    @Environment(AppModel.self) private var model
    @AppStorage(ThemePreference.storageKey) private var theme = ThemePreference.system

    var body: some View {
        MenuBarContent(signedIn: model.phase != .signedOut)
            .environment(model.screens)
            .preferredColorScheme(theme.colorScheme)
    }
}

struct MenuBarContent: View {
    let signedIn: Bool

    @Environment(ScreenServices.self) private var services
    @State private var model = PackageListModel()

    var body: some View {
        VStack(alignment: .leading, spacing: PorchSpacing.xs) {
            if signedIn {
                TimelineView(.periodic(from: .now, by: 60)) { context in
                    VStack(alignment: .leading, spacing: PorchSpacing.xs) {
                        today(now: context.date)
                    }
                }
            } else {
                Text("Open Porchlight to sign in.")
                    .font(PorchFont.body)
                    .foregroundStyle(PorchColor.body)
            }
            Spacer(minLength: 0)
            Divider().overlay(PorchColor.line)
            HStack {
                Button("Open Porchlight") { openMainWindow() }
                Spacer()
                if signedIn {
                    Button("Refresh", systemImage: "arrow.clockwise") { Task { await model.refresh(services) } }
                        .labelStyle(.iconOnly)
                        .disabled(model.syncing)
                        .help("Refresh")
                }
                Button("Quit") { NSApplication.shared.terminate(nil) }
            }
            .buttonStyle(.borderless)
        }
        .padding(PorchSpacing.s)
        .frame(width: 320, alignment: .leading)
        .background(PorchColor.canvas)
        .task(id: services.revision) { if signedIn { await model.load(services) } }
    }

    @ViewBuilder
    private func today(now: Date) -> some View {
        let todays = model.groups(query: "", now: now).first { $0.id == .today }?.packages ?? []
        HStack(spacing: PorchSpacing.xxs) {
            Text("Today")
            if !todays.isEmpty { Text("\(todays.count)").monospacedDigit() }
        }
        .font(PorchFont.label)
        .foregroundStyle(PorchColor.mute)

        if !model.loaded {
            Color.clear.frame(height: PorchSpacing.rowMinHeight)
        } else if todays.isEmpty {
            Text(model.loadError ?? "Nothing arriving today.")
                .font(PorchFont.body)
                .foregroundStyle(PorchColor.body)
                .padding(.vertical, PorchSpacing.xs)
        } else {
            // A few rows take only their own height; a long day scrolls past 360.
            ViewThatFits(in: .vertical) {
                rows(todays, now: now)
                ScrollView { rows(todays, now: now) }
            }
            .frame(maxHeight: 360, alignment: .top)
        }
        if let stale = model.staleLine(now: now) {
            Text(stale).font(PorchFont.caption).foregroundStyle(PorchColor.mute)
        }
    }

    private func rows(_ todays: [Package], now: Date) -> some View {
        VStack(spacing: 0) {
            ForEach(todays) { pkg in
                PackageRow(pkg, now: now, showsChecked: false)
                if pkg.id != todays.last?.id { Divider().overlay(PorchColor.line) }
            }
        }
    }

    private func openMainWindow() {
        NSApplication.shared.activate()
        let window = NSApplication.shared.windows.first { $0.canBecomeMain }
        window?.makeKeyAndOrderFront(nil)
    }
}
#endif
