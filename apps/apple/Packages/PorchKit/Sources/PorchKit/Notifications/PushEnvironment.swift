import Foundation

/// What a device sends with `PUT /v1/devices/:id`: which APNs host its token
/// belongs to, the token as hex, and the app version.
public enum PushEnvironment {
    /// The APNs environment of this build, from its embedded provisioning
    /// profile (`embedded.mobileprovision` on iOS, `Contents/embedded.provisionprofile`
    /// on macOS).
    ///
    /// - No profile: an App Store or TestFlight install, so production.
    /// - A profile naming `aps-environment`: that value.
    /// - A profile that can't be read: sandbox for debug builds, else production.
    public static func resolve(provisioningProfile: Data?, isDebugBuild: Bool) -> APNSEnvironment {
        guard let provisioningProfile else { return .production }
        switch apsEnvironment(inProfile: provisioningProfile) {
        case "development": return .sandbox
        case "production": return .production
        default: return isDebugBuild ? .sandbox : .production
        }
    }

    /// The `aps-environment` entitlement inside a profile. The profile is a
    /// signed CMS blob, but its property list sits in it as plain XML.
    static func apsEnvironment(inProfile data: Data) -> String? {
        guard let start = data.range(of: Data("<?xml".utf8)),
              let end = data.range(of: Data("</plist>".utf8), in: start.lowerBound..<data.endIndex) else { return nil }
        let xml = data[start.lowerBound..<end.upperBound]
        guard let plist = try? PropertyListSerialization.propertyList(from: xml, format: nil) as? [String: Any],
              let entitlements = plist["Entitlements"] as? [String: Any] else { return nil }
        return (entitlements["aps-environment"] ?? entitlements["com.apple.developer.aps-environment"]) as? String
    }

    /// Lowercase hex, as APNs and `devices.apns_token` expect.
    public static func hexToken(_ token: Data) -> String {
        token.map { String(format: "%02x", $0) }.joined()
    }

    /// "1.0 (12)" from CFBundleShortVersionString and CFBundleVersion.
    public static func appVersion(short: String?, build: String?) -> String? {
        guard let short, !short.isEmpty else { return nil }
        guard let build, !build.isEmpty else { return short }
        return "\(short) (\(build))"
    }

    /// `appVersion(short:build:)` for a bundle's Info.plist.
    public static func appVersion(of bundle: Bundle) -> String? {
        appVersion(short: bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
                   build: bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String)
    }
}
