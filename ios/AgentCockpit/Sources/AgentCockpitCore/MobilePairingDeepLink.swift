import Foundation

public enum MobilePairingDeepLinkError: Error, Equatable, LocalizedError {
    case invalidURL
    case unsupportedScheme
    case unsupportedAction
    case missingServer
    case missingChallengeId
    case missingCode

    public var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "The scanned QR code is not a valid Agent Cockpit pairing URL."
        case .unsupportedScheme:
            return "The scanned QR code does not use the Agent Cockpit URL scheme."
        case .unsupportedAction:
            return "The scanned Agent Cockpit URL is not a pairing URL."
        case .missingServer:
            return "The pairing URL does not include a server URL."
        case .missingChallengeId:
            return "The pairing URL does not include a challenge ID."
        case .missingCode:
            return "The pairing URL does not include a pairing code."
        }
    }
}

public struct MobilePairingDeepLink: Equatable, Sendable {
    public let serverURL: URL
    public let challengeId: String
    public let code: String

    public init(rawValue: String) throws {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed) else {
            throw MobilePairingDeepLinkError.invalidURL
        }
        try self.init(url: url)
    }

    public init(url: URL) throws {
        guard
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
            components.scheme?.lowercased() == AgentCockpitConfiguration.mobileAuthCallbackScheme
        else {
            throw MobilePairingDeepLinkError.unsupportedScheme
        }

        let action = components.host ?? components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard action == "pair" else {
            throw MobilePairingDeepLinkError.unsupportedAction
        }

        guard let server = components.queryItems?.first(where: { $0.name == "server" })?.value, !server.isEmpty else {
            throw MobilePairingDeepLinkError.missingServer
        }
        guard let challengeId = components.queryItems?.first(where: { $0.name == "challengeId" })?.value, !challengeId.isEmpty else {
            throw MobilePairingDeepLinkError.missingChallengeId
        }
        guard let code = components.queryItems?.first(where: { $0.name == "code" })?.value, !code.isEmpty else {
            throw MobilePairingDeepLinkError.missingCode
        }

        self.serverURL = try AgentCockpitConfiguration.parseServerURL(server)
        self.challengeId = challengeId
        self.code = code
    }
}
