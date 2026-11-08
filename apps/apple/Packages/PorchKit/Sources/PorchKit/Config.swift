import Foundation

/// Identifiers shared by the app targets, the extension and PorchKit. They
/// must match project.yml, the entitlements and the Info.plists.
public enum PorchConfig {
    /// BGTaskSchedulerPermittedIdentifiers in the iOS Info.plist.
    public static let refreshTaskIdentifier = "co.xanom.porchlight.refresh"
    /// Production API base (domain not final, docs/API.md).
    public static let productionBaseURL = URL(string: "https://porchlight.xanom.co/v1")!
    /// The host of the emailed sign-in link (APP_ORIGIN in services/api/wrangler.jsonc).
    public static let webHost = "porchlight.xanom.co"
    /// `pnpm dev` in services/api.
    public static let localBaseURL = URL(string: "http://localhost:8787/v1")!
}
