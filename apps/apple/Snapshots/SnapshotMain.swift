#if DEBUG
import AppKit
import PorchKit
import PorchUI
import SwiftUI

// Porchlight-Snapshots: renders the Mac screens with sample data into PNGs
// without showing anything on screen, so a UI change can be looked at
// without driving the app. Debug only; never shipped.
//
//   PORCHLIGHT_SNAPSHOTS=/path/to/dir <built>/Porchlight-Snapshots.app/Contents/MacOS/Porchlight-Snapshots
//
// Writes <screen>-<dark|light>.png for every screen in `screens`.

@main
@MainActor
enum SnapshotMain {
    struct Screen {
        let name: String
        let size: CGSize
        let view: () -> AnyView
    }

    static func main() {
        // PORCHLIGHT_NAMES_TEST="<listing name>": time OnDeviceItemNames on one name and exit.
        if let name = ProcessInfo.processInfo.environment["PORCHLIGHT_NAMES_TEST"] {
            Task {
                let start = Date()
                let short = await OnDeviceItemNames().shortName(name)
                print("names: \(short) (\(String(format: "%.1f", Date().timeIntervalSince(start))) s)")
                exit(0)
            }
            RunLoop.main.run()
        }
        // PORCHLIGHT_CARRIER_TEST="fedex:<number>": read one carrier page the way the app does, print the result and exit.
        if let spec = ProcessInfo.processInfo.environment["PORCHLIGHT_CARRIER_TEST"],
           let colon = spec.firstIndex(of: ":"), let carrier = Carrier(rawValue: String(spec[..<colon])) {
            let number = String(spec[spec.index(after: colon)...])
            Task {
                let job = DeviceJob(packageId: "test", carrier: carrier, trackingNumber: number, reason: .manual)
                do {
                    let capture = try await CarrierWebEngine().read(job, timeout: .seconds(40))
                    switch capture {
                    case let .response(url, status, body): print("carrier: response \(status) from \(url): \(body.prefix(600))")
                    case let .page(url, html): print("carrier: page only from \(url), \(html.count) chars: \(html.prefix(300))")
                    }
                    print("carrier: read \(DeviceTrackingParser.read(capture, carrier: carrier, trackingNumber: number, now: Date(), timeZone: .current))")
                } catch {
                    print("carrier: error \(error)")
                }
                exit(0)
            }
            RunLoop.main.run()
        }
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        let out = URL(fileURLWithPath: ProcessInfo.processInfo.environment["PORCHLIGHT_SNAPSHOTS"] ?? FileManager.default.currentDirectoryPath)
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let only = ProcessInfo.processInfo.environment["PORCHLIGHT_SNAPSHOT_ONLY"].flatMap { $0.isEmpty ? nil : $0 }
        for screen in screens where only == nil || screen.name.contains(only!) {
            for dark in [true, false] {
                let url = out.appending(path: "\(screen.name)-\(dark ? "dark" : "light").png")
                render(screen, dark: dark, to: url)
            }
        }
        print("snapshots: wrote \(screens.count * 2) files to \(out.path)")
        exit(0)
    }

    static func render(_ screen: Screen, dark: Bool, to url: URL) {
        let root = screen.view()
            .environment(\.colorScheme, dark ? .dark : .light)
            .preferredColorScheme(dark ? .dark : .light)
            .frame(width: screen.size.width, height: screen.size.height)
        let host = NSHostingView(rootView: root)
        host.frame = CGRect(origin: .zero, size: screen.size)
        // Off screen: never ordered front, so nothing appears on the display.
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        window.contentView = host
        // Let SwiftUI lay out, run its .task loads, and settle.
        for _ in 0..<6 {
            host.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.25))
        }
        guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
            print("snapshots: no bitmap for \(url.lastPathComponent)")
            return
        }
        host.cacheDisplay(in: host.bounds, to: rep)
        guard let png = rep.representation(using: .png, properties: [:]) else {
            print("snapshots: no PNG for \(url.lastPathComponent)")
            return
        }
        do {
            try png.write(to: url)
        } catch {
            print("snapshots: couldn't write \(url.path): \(error)")
        }
    }

    static let services = ScreenServices.preview()
    static let amazon = AmazonModel(api: PreviewAPI(), signedIn: { true })

    static func env(_ v: some View, services: ScreenServices = services) -> AnyView {
        AnyView(v.environment(services).environment(amazon).background(PorchColor.canvas))
    }

    static let screens: [Screen] = [
        Screen(name: "window-list-detail", size: CGSize(width: 1100, height: 720)) {
            env(SplitPreview(selected: "p1"))
        },
        // As if the window were in front: the list draws the accent selection.
        Screen(name: "window-active-selection", size: CGSize(width: 1100, height: 720)) {
            env(SplitPreview(selected: "p1").environment(\.appearsActive, true))
        },
        Screen(name: "window-amazon-detail", size: CGSize(width: 1100, height: 720)) {
            env(SplitPreview(selected: "p4"))
        },
        Screen(name: "window-nothing-selected", size: CGSize(width: 1100, height: 720)) {
            env(SplitPreview(selected: nil))
        },
        Screen(name: "window-empty", size: CGSize(width: 1100, height: 720)) {
            env(SplitPreview(selected: nil), services: .preview(packages: []))
        },
        // The whole package page, scrolled content included, wide and at iPhone width.
        Screen(name: "detail-full", size: CGSize(width: 760, height: 1500)) {
            env(NavigationStack { PackageDetailView(packageId: "p1") })
        },
        Screen(name: "detail-narrow", size: CGSize(width: 375, height: 1500)) {
            env(NavigationStack { PackageDetailView(packageId: "p4") })
        },
        Screen(name: "detail-noscans", size: CGSize(width: 760, height: 900)) {
            env(NavigationStack { PackageDetailView(packageId: "p5") })
        },
        Screen(name: "sheet-add", size: CGSize(width: 520, height: 520)) {
            env(NavigationStack { AddPackageView { _ in } })
        },
        Screen(name: "sheet-add-one", size: CGSize(width: 480, height: 420)) {
            env(NavigationStack { AddPackageView(text: "1Z999AA10123456784") { _ in } })
        },
        Screen(name: "sheet-add-ambiguous", size: CGSize(width: 480, height: 420)) {
            env(NavigationStack { AddPackageView(text: "LB123456789US") { _ in } })
        },
        Screen(name: "sheet-add-several", size: CGSize(width: 480, height: 420)) {
            env(NavigationStack { AddPackageView(text: "1Z999AA10123456784\nTBA123456789012\nLB123456789US\n9400100000000000004784") { _ in } })
        },
        Screen(name: "sheet-settings", size: CGSize(width: 560, height: 900)) {
            env(NavigationStack { SettingsView() })
        },
        Screen(name: "sheet-delete-account", size: CGSize(width: 460, height: 340)) {
            env(DeleteAccountSheet())
        },
        Screen(name: "signin", size: CGSize(width: 900, height: 640)) {
            env(SignInView(), services: .preview(signedIn: false))
        },
        Screen(name: "menubar", size: CGSize(width: 360, height: 420)) {
            env(MenuBarContent(signedIn: true))
        },
        Screen(name: "rows-selected", size: CGSize(width: 360, height: 300)) {
            env(SelectedRowsPreview())
        },
    ]
}

/// Package rows as the key window's selection draws them (an accent fill and
/// `.increased` prominence), which the off-screen window can't show.
private struct SelectedRowsPreview: View {
    var body: some View {
        let now = Date()
        VStack(spacing: PorchSpacing.xs) {
            ForEach([Status.outForDelivery, .exception, .delivered], id: \.self) { status in
                PackageRow(Package(id: status.rawValue, carrier: .ups, trackingNumber: "1Z999AA10123456784",
                                   title: "Headphones", status: status, statusDetail: "On vehicle, Oakland",
                                   lastCheckedAt: now.addingTimeInterval(-840), updatedAt: now), now: now)
                    .padding(.horizontal, PorchSpacing.s)
                    .background(PorchColor.accent, in: RoundedRectangle(cornerRadius: PorchRadius.control))
                    .environment(\.backgroundProminence, .increased)
            }
        }
        .padding(PorchSpacing.s)
    }
}

/// The signed-in window: the list and the selected package side by side.
private struct SplitPreview: View {
    @State var selected: String?
    @State private var listEmpty = false

    var body: some View {
        NavigationSplitView {
            PackageListView(selection: $selected, open: { selected = $0 }, onEmptyChange: { listEmpty = $0 })
                .navigationSplitViewColumnWidth(min: 300, ideal: 360, max: 480)
        } detail: {
            if let selected {
                PackageDetailView(packageId: selected).id(selected)
            } else {
                WindowPlaceholder(listEmpty: listEmpty, open: { selected = $0 })
            }
        }
    }
}
#endif
