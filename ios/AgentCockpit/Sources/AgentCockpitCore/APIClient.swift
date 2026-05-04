import Foundation

public protocol AgentHTTPTransport: Sendable {
    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

extension URLSession: AgentHTTPTransport {
    public func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw AgentAPIError.invalidResponse
        }
        return (data, httpResponse)
    }
}

public enum AgentAPIError: Error, Equatable, LocalizedError {
    case invalidBaseURL
    case invalidResponse
    case httpStatus(Int, String?)
    case csrfTokenMissing

    public var errorDescription: String? {
        switch self {
        case .invalidBaseURL:
            return "The Agent Cockpit server URL is invalid."
        case .invalidResponse:
            return "The server returned a non-HTTP response."
        case .httpStatus(let status, let message):
            if let message, !message.isEmpty {
                return "Agent Cockpit request failed with HTTP \(status): \(message)"
            }
            return "Agent Cockpit request failed with HTTP \(status)."
        case .csrfTokenMissing:
            return "The server did not return a CSRF token."
        }
    }
}

public struct AgentCockpitConfiguration: Equatable, Sendable {
    public static let defaultServerURL = URL(string: "http://localhost:3334")!
    public static let mobileAuthCallbackScheme = "agentcockpit"

    public var serverURL: URL

    public init(serverURL: URL = Self.defaultServerURL) {
        self.serverURL = serverURL
    }

    public static func parseServerURL(_ rawValue: String) throws -> URL {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw AgentAPIError.invalidBaseURL
        }

        let value = trimmed.contains("://") ? trimmed : "\(defaultScheme(for: trimmed))://\(trimmed)"
        guard
            let components = URLComponents(string: value),
            let scheme = components.scheme?.lowercased(),
            scheme == "http" || scheme == "https",
            components.host?.isEmpty == false,
            let url = components.url
        else {
            throw AgentAPIError.invalidBaseURL
        }

        return url
    }

    private static func defaultScheme(for hostValue: String) -> String {
        let host = host(from: hostValue).lowercased()
        if host == "localhost"
            || host == "127.0.0.1"
            || host == "::1"
            || host.hasSuffix(".local")
            || host.hasPrefix("10.")
            || host.hasPrefix("192.168.")
            || isPrivate172Address(host) {
            return "http"
        }
        return "https"
    }

    private static func host(from hostValue: String) -> String {
        let authority = hostValue.split(separator: "/", maxSplits: 1, omittingEmptySubsequences: true).first.map(String.init) ?? hostValue
        let hostPort = authority.split(separator: "@", maxSplits: 1, omittingEmptySubsequences: true).last.map(String.init) ?? authority
        if hostPort.hasPrefix("[") {
            return hostPort.dropFirst().split(separator: "]", maxSplits: 1, omittingEmptySubsequences: true).first.map(String.init) ?? hostPort
        }
        return hostPort.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: true).first.map(String.init) ?? hostPort
    }

    private static func isPrivate172Address(_ host: String) -> Bool {
        let parts = host.split(separator: ".")
        guard
            parts.count == 4,
            parts[0] == "172",
            let second = Int(parts[1])
        else {
            return false
        }
        return (16...31).contains(second)
    }
}

public final class AgentCockpitAPI: @unchecked Sendable {
    public enum HTTPMethod: String {
        case get = "GET"
        case post = "POST"
        case put = "PUT"
        case patch = "PATCH"
        case delete = "DELETE"
    }

    private struct CSRFTokenResponse: Decodable {
        var csrfToken: String
    }

    private struct SendMessageBody: Encodable {
        var content: String
        var backend: String?
        var cliProfileId: String?
        var model: String?
        var effort: EffortLevel?
    }

    private struct InputBody: Encodable {
        var text: String
        var streamActive: Bool
    }

    private struct CreateConversationBody: Encodable {
        var title: String?
        var workingDir: String?
        var backend: String?
        var cliProfileId: String?
        var model: String?
        var effort: EffortLevel?
    }

    private struct RenameConversationBody: Encodable {
        var title: String
    }

    private struct QueueBody: Encodable {
        var queue: [QueuedMessage]
    }

    private struct MobileAuthExchangeBody: Encodable {
        var code: String
        var deviceName: String
        var platform: String
    }

    private struct MobilePairingExchangeBody: Encodable {
        var challengeId: String
        var code: String
        var deviceName: String
        var platform: String
    }

    private let configuration: AgentCockpitConfiguration
    private let transport: AgentHTTPTransport
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder
    private var csrfToken: String?

    public init(
        configuration: AgentCockpitConfiguration = AgentCockpitConfiguration(),
        transport: AgentHTTPTransport = URLSession.shared,
        decoder: JSONDecoder = JSONDecoder(),
        encoder: JSONEncoder = JSONEncoder()
    ) {
        self.configuration = configuration
        self.transport = transport
        self.decoder = decoder
        self.encoder = encoder
    }

    public static func defaultMobileDeviceName() -> String {
        "Agent Cockpit iOS"
    }

    public func invalidateCSRFToken() {
        csrfToken = nil
    }

    public func listConversations(search: String? = nil, archived: Bool = false) async throws -> [ConversationListItem] {
        var queryItems: [URLQueryItem] = []
        if let search, !search.isEmpty {
            queryItems.append(URLQueryItem(name: "q", value: search))
        }
        if archived {
            queryItems.append(URLQueryItem(name: "archived", value: "true"))
        }
        let envelope: ConversationListEnvelope = try await request(
            .get,
            path: "/api/chat/conversations",
            queryItems: queryItems
        )
        return envelope.conversations
    }

    public func getConversation(id: String) async throws -> Conversation {
        try await request(.get, path: "/api/chat/conversations/\(id)")
    }

    public func renameConversation(id: String, title: String) async throws -> Conversation {
        try await request(
            .put,
            path: "/api/chat/conversations/\(id)",
            csrf: true,
            body: RenameConversationBody(title: title)
        )
    }

    @discardableResult
    public func archiveConversation(id: String) async throws -> Bool {
        let response: BasicOKResponse = try await request(
            .patch,
            path: "/api/chat/conversations/\(id)/archive",
            csrf: true,
            body: Optional<String>.none
        )
        return response.ok
    }

    @discardableResult
    public func restoreConversation(id: String) async throws -> Bool {
        let response: BasicOKResponse = try await request(
            .patch,
            path: "/api/chat/conversations/\(id)/restore",
            csrf: true,
            body: Optional<String>.none
        )
        return response.ok
    }

    @discardableResult
    public func deleteConversation(id: String) async throws -> Bool {
        let response: BasicOKResponse = try await request(
            .delete,
            path: "/api/chat/conversations/\(id)",
            csrf: true,
            body: Optional<String>.none
        )
        return response.ok
    }

    public func getActiveStreams() async throws -> ActiveStreamsResponse {
        try await request(.get, path: "/api/chat/active-streams")
    }

    public func createConversation(
        title: String? = nil,
        workingDir: String? = nil,
        backend: String? = nil,
        cliProfileId: String? = nil,
        model: String? = nil,
        effort: EffortLevel? = nil
    ) async throws -> Conversation {
        let body = CreateConversationBody(
            title: title,
            workingDir: workingDir,
            backend: backend,
            cliProfileId: cliProfileId,
            model: model,
            effort: effort
        )
        return try await request(
            .post,
            path: "/api/chat/conversations",
            csrf: true,
            body: body
        )
    }

    public func getCurrentUser() async throws -> CurrentUser {
        try await request(.get, path: "/api/me")
    }

    public func mobileWebLoginURL() throws -> URL {
        guard let url = try makeRequest(
            .get,
            path: "/auth/mobile-login"
        ).url else {
            throw AgentAPIError.invalidBaseURL
        }
        return url
    }

    public func exchangeMobileAuthCode(
        _ code: String,
        deviceName: String = AgentCockpitAPI.defaultMobileDeviceName(),
        platform: String = "iOS"
    ) async throws -> MobileAuthExchangeResponse {
        let response: MobileAuthExchangeResponse = try await request(
            .post,
            path: "/api/mobile-auth/exchange",
            body: MobileAuthExchangeBody(code: code, deviceName: deviceName, platform: platform)
        )
        csrfToken = response.csrfToken
        return response
    }

    public func exchangeMobilePairingCode(
        challengeId: String,
        code: String,
        deviceName: String = AgentCockpitAPI.defaultMobileDeviceName(),
        platform: String = "iOS"
    ) async throws -> MobileAuthExchangeResponse {
        let response: MobileAuthExchangeResponse = try await request(
            .post,
            path: "/api/mobile-pairing/exchange",
            body: MobilePairingExchangeBody(
                challengeId: challengeId,
                code: code,
                deviceName: deviceName,
                platform: platform
            )
        )
        csrfToken = response.csrfToken
        return response
    }

    public func getBackends() async throws -> [BackendMetadata] {
        let response: BackendsResponse = try await request(.get, path: "/api/chat/backends")
        return response.backends
    }

    public func getSettings() async throws -> Settings {
        try await request(.get, path: "/api/chat/settings")
    }

    public func getCliProfileMetadata(profileID: String) async throws -> BackendMetadata {
        let response: CliProfileMetadataResponse = try await request(
            .get,
            path: "/api/chat/cli-profiles/\(profileID)/metadata"
        )
        return response.backend
    }

    public func getExplorerTree(workspaceHash: String, path: String = "") async throws -> ExplorerTreeResponse {
        try await request(
            .get,
            path: "/api/chat/workspaces/\(workspaceHash)/explorer/tree",
            queryItems: [URLQueryItem(name: "path", value: path)]
        )
    }

    public func getExplorerPreview(workspaceHash: String, path: String) async throws -> ExplorerPreviewResponse {
        try await request(
            .get,
            path: "/api/chat/workspaces/\(workspaceHash)/explorer/preview",
            queryItems: [
                URLQueryItem(name: "path", value: path),
                URLQueryItem(name: "mode", value: "view")
            ]
        )
    }

    public func getSessions(conversationID: String) async throws -> [SessionHistoryItem] {
        let response: SessionsResponse = try await request(.get, path: "/api/chat/conversations/\(conversationID)/sessions")
        return response.sessions
    }

    public func getSessionMessages(conversationID: String, sessionNumber: Int) async throws -> [Message] {
        let response: SessionMessagesResponse = try await request(
            .get,
            path: "/api/chat/conversations/\(conversationID)/sessions/\(sessionNumber)/messages"
        )
        return response.messages
    }

    public func sessionDownloadURL(conversationID: String, sessionNumber: Int) throws -> URL {
        guard let url = try makeRequest(
            .get,
            path: "/api/chat/conversations/\(conversationID)/sessions/\(sessionNumber)/download"
        ).url else {
            throw AgentAPIError.invalidBaseURL
        }
        return url
    }

    public func getQueue(conversationID: String) async throws -> [QueuedMessage] {
        let response: QueueResponse = try await request(.get, path: "/api/chat/conversations/\(conversationID)/queue")
        return response.queue
    }

    public func uploadFile(
        conversationID: String,
        fileName: String,
        data: Data,
        mimeType: String = "application/octet-stream"
    ) async throws -> AttachmentMeta {
        let boundary = "Boundary-\(UUID().uuidString)"
        var request = try makeRequest(.post, path: "/api/chat/conversations/\(conversationID)/upload")
        request.setValue(try await fetchCSRFToken(), forHTTPHeaderField: "x-csrf-token")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.httpBody = makeMultipartBody(
            boundary: boundary,
            fieldName: "files",
            fileName: fileName,
            mimeType: mimeType,
            data: data
        )

        let (responseData, response) = try await transport.perform(request)
        guard (200..<300).contains(response.statusCode) else {
            throw AgentAPIError.httpStatus(response.statusCode, decodeErrorMessage(from: responseData))
        }
        let envelope = try decoder.decode(UploadFilesResponse.self, from: responseData)
        guard let file = envelope.files.first else {
            throw AgentAPIError.invalidResponse
        }
        return file
    }

    @discardableResult
    public func deleteUpload(conversationID: String, filename: String) async throws -> Bool {
        let response: BasicOKResponse = try await request(
            .delete,
            path: "/api/chat/conversations/\(conversationID)/upload/\(filename)",
            csrf: true,
            body: Optional<String>.none
        )
        return response.ok
    }

    public func saveQueue(conversationID: String, queue: [QueuedMessage]) async throws -> [QueuedMessage] {
        let response: BasicOKResponse = try await request(
            .put,
            path: "/api/chat/conversations/\(conversationID)/queue",
            csrf: true,
            body: QueueBody(queue: queue)
        )
        return response.ok ? queue : []
    }

    @discardableResult
    public func clearQueue(conversationID: String) async throws -> Bool {
        let response: BasicOKResponse = try await request(
            .delete,
            path: "/api/chat/conversations/\(conversationID)/queue",
            csrf: true,
            body: Optional<String>.none
        )
        return response.ok
    }

    public func resetConversation(id: String) async throws -> ResetSessionResponse {
        try await request(
            .post,
            path: "/api/chat/conversations/\(id)/reset",
            csrf: true,
            body: Optional<String>.none
        )
    }

    public func sendInput(conversationID: String, text: String, streamActive: Bool) async throws -> InputResponse {
        try await request(
            .post,
            path: "/api/chat/conversations/\(conversationID)/input",
            csrf: true,
            body: InputBody(text: text, streamActive: streamActive)
        )
    }

    @discardableResult
    public func sendMessage(
        conversationID: String,
        content: String,
        backend: String? = nil,
        cliProfileId: String? = nil,
        model: String? = nil,
        effort: EffortLevel? = nil
    ) async throws -> SendMessageResponse {
        let body = SendMessageBody(
            content: content,
            backend: backend,
            cliProfileId: cliProfileId,
            model: model,
            effort: effort
        )
        return try await request(
            .post,
            path: "/api/chat/conversations/\(conversationID)/message",
            csrf: true,
            body: body
        )
    }

    @discardableResult
    public func abortConversation(id: String) async throws -> Bool {
        struct AbortResponse: Decodable {
            var aborted: Bool
        }
        let response: AbortResponse = try await request(
            .post,
            path: "/api/chat/conversations/\(id)/abort",
            csrf: true,
            body: Optional<String>.none
        )
        return response.aborted
    }

    public func fetchCSRFToken() async throws -> String {
        if let csrfToken {
            return csrfToken
        }

        let response: CSRFTokenResponse = try await request(.get, path: "/api/csrf-token")
        guard !response.csrfToken.isEmpty else {
            throw AgentAPIError.csrfTokenMissing
        }
        csrfToken = response.csrfToken
        return response.csrfToken
    }

    public func request<Response: Decodable, Body: Encodable>(
        _ method: HTTPMethod,
        path: String,
        queryItems: [URLQueryItem] = [],
        csrf: Bool = false,
        body: Body? = Optional<String>.none
    ) async throws -> Response {
        var request = try makeRequest(method, path: path, queryItems: queryItems)
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        if csrf {
            request.setValue(try await fetchCSRFToken(), forHTTPHeaderField: "x-csrf-token")
        }

        if let body {
            request.httpBody = try encoder.encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let (data, response) = try await transport.perform(request)
        guard (200..<300).contains(response.statusCode) else {
            throw AgentAPIError.httpStatus(response.statusCode, decodeErrorMessage(from: data))
        }
        return try decoder.decode(Response.self, from: data)
    }

    public func makeRequest(
        _ method: HTTPMethod,
        path: String,
        queryItems: [URLQueryItem] = []
    ) throws -> URLRequest {
        guard var components = URLComponents(url: configuration.serverURL, resolvingAgainstBaseURL: false) else {
            throw AgentAPIError.invalidBaseURL
        }
        components.path = joinedPath(base: components.path, path: path)
        components.queryItems = queryItems.isEmpty ? nil : queryItems

        guard let url = components.url else {
            throw AgentAPIError.invalidBaseURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = method.rawValue
        return request
    }

    public func websocketURL(conversationID: String) throws -> URL {
        guard var components = URLComponents(url: configuration.serverURL, resolvingAgainstBaseURL: false) else {
            throw AgentAPIError.invalidBaseURL
        }
        switch components.scheme {
        case "https":
            components.scheme = "wss"
        case "http":
            components.scheme = "ws"
        default:
            throw AgentAPIError.invalidBaseURL
        }
        components.path = joinedPath(base: components.path, path: "/api/chat/conversations/\(conversationID)/ws")

        guard let url = components.url else {
            throw AgentAPIError.invalidBaseURL
        }
        return url
    }

    private func joinedPath(base: String, path: String) -> String {
        let base = base.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let path = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if base.isEmpty {
            return "/" + path
        }
        if path.isEmpty {
            return "/" + base
        }
        return "/" + base + "/" + path
    }

    private func decodeErrorMessage(from data: Data) -> String? {
        guard !data.isEmpty else {
            return nil
        }
        struct ErrorEnvelope: Decodable {
            var error: String?
        }
        return try? decoder.decode(ErrorEnvelope.self, from: data).error
    }

    private func makeMultipartBody(
        boundary: String,
        fieldName: String,
        fileName: String,
        mimeType: String,
        data: Data
    ) -> Data {
        var body = Data()
        body.appendString("--\(boundary)\r\n")
        body.appendString("Content-Disposition: form-data; name=\"\(fieldName)\"; filename=\"\(escapedMultipartValue(fileName))\"\r\n")
        body.appendString("Content-Type: \(mimeType)\r\n\r\n")
        body.append(data)
        body.appendString("\r\n--\(boundary)--\r\n")
        return body
    }

    private func escapedMultipartValue(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\r", with: "")
            .replacingOccurrences(of: "\n", with: "")
    }
}

private extension Data {
    mutating func appendString(_ string: String) {
        append(Data(string.utf8))
    }
}
