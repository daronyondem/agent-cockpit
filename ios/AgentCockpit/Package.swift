// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AgentCockpitIOS",
    defaultLocalization: "en",
    platforms: [
        .iOS(.v18),
        .macOS(.v15)
    ],
    products: [
        .library(name: "AgentCockpitCore", targets: ["AgentCockpitCore"]),
        .library(name: "AgentCockpitUI", targets: ["AgentCockpitUI"]),
        .executable(name: "AgentCockpitCoreSmokeTests", targets: ["AgentCockpitCoreSmokeTests"])
    ],
    targets: [
        .target(name: "AgentCockpitCore"),
        .target(name: "AgentCockpitUI", dependencies: ["AgentCockpitCore"]),
        .executableTarget(name: "AgentCockpitCoreSmokeTests", dependencies: ["AgentCockpitCore"], path: "SmokeTests")
    ]
)
