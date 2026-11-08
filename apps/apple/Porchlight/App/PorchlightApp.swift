import PorchKit
import PorchUI
import SwiftData
import SwiftUI

@main
struct PorchlightApp: App {
    #if os(iOS)
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    #else
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    #endif
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        #if os(iOS)
        mainWindow
            .backgroundTask(.appRefresh(PorchConfig.refreshTaskIdentifier)) { [delegate = appDelegate] in
                await delegate.handleAppRefresh()
            }
        #else
        mainWindow
        MenuBarExtra("Porchlight", systemImage: "shippingbox") {
            MenuBarView()
                .environment(appDelegate.model)
                .environment(appDelegate.router)
                .environment(appDelegate.push)
                .modelContainer(appDelegate.model.container)
        }
        .menuBarExtraStyle(.window)
        #endif
    }

    private var mainWindow: some Scene {
        WindowGroup {
            RootView()
                .environment(appDelegate.model)
                .environment(appDelegate.router)
                .environment(appDelegate.push)
                .onOpenURL { url in appDelegate.openURL(url) }
                .onChange(of: appDelegate.model.phase, initial: true) { _, phase in appDelegate.sessionChanged(phase) }
                .onChange(of: scenePhase, initial: true) { _, phase in appDelegate.scenePhaseChanged(phase) }
        }
        .modelContainer(appDelegate.model.container)
    }
}
