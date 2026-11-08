// swift-tools-version: 6.0
// PorchKit: shared Swift for the Porchlight apps (SPEC §2).
//
// - PorchKit:   models, wire types (docs/API.md), arrival grouping, and the
//               protocols the apps are built against. Foundation only.
// - PorchStore: the SwiftData store (@Model types, PackageRepository).
// - PorchUI:    SwiftUI theme and small shared views (DESIGN.md §9).
import PackageDescription

let package = Package(
    name: "PorchKit",
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [
        .library(name: "PorchKit", targets: ["PorchKit"]),
        .library(name: "PorchStore", targets: ["PorchStore"]),
        .library(name: "PorchUI", targets: ["PorchUI"]),
    ],
    targets: [
        .target(name: "PorchKit"),
        .target(name: "PorchStore", dependencies: ["PorchKit"]),
        .target(
            name: "PorchUI",
            dependencies: ["PorchKit"],
            resources: [.process("Resources")]
        ),
        .testTarget(name: "PorchKitTests", dependencies: ["PorchKit"]),
        .testTarget(name: "PorchStoreTests", dependencies: ["PorchStore"]),
    ],
    swiftLanguageModes: [.v6]
)
