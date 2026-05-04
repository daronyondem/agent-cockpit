import Foundation

public protocol ConversationStreaming {
    func stream(conversationID: String) throws -> AsyncThrowingStream<StreamEvent, Error>
}

public final class URLSessionConversationStreaming: ConversationStreaming {
    private let api: AgentCockpitAPI
    private let session: URLSession
    private let decoder: JSONDecoder

    public init(
        api: AgentCockpitAPI,
        session: URLSession = .shared,
        decoder: JSONDecoder = JSONDecoder()
    ) {
        self.api = api
        self.session = session
        self.decoder = decoder
    }

    public func stream(conversationID: String) throws -> AsyncThrowingStream<StreamEvent, Error> {
        let url = try api.websocketURL(conversationID: conversationID)
        let task = session.webSocketTask(with: url)
        task.resume()

        return AsyncThrowingStream { continuation in
            let receiver = Task {
                do {
                    let decoder = JSONDecoder()
                    try await Self.sendReconnect(on: task)
                    while !Task.isCancelled {
                        let message = try await task.receive()
                        let event = try Self.decode(message, decoder: decoder)
                        continuation.yield(event)
                        if event == .done {
                            continuation.finish()
                            return
                        }
                    }
                } catch {
                    if !Task.isCancelled {
                        continuation.finish(throwing: error)
                    }
                }
            }

            continuation.onTermination = { _ in
                receiver.cancel()
                task.cancel(with: .normalClosure, reason: nil)
            }
        }
    }

    private static func decode(_ message: URLSessionWebSocketTask.Message, decoder: JSONDecoder) throws -> StreamEvent {
        switch message {
        case .string(let text):
            guard let data = text.data(using: .utf8) else {
                throw AgentAPIError.invalidResponse
            }
            return try decoder.decode(StreamEvent.self, from: data)
        case .data(let data):
            return try decoder.decode(StreamEvent.self, from: data)
        @unknown default:
            throw AgentAPIError.invalidResponse
        }
    }

    private static func sendReconnect(on task: URLSessionWebSocketTask) async throws {
        try await task.send(.string(#"{"type":"reconnect"}"#))
    }
}
