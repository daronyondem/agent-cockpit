import Foundation

public struct ConversationStreamState: Equatable, Sendable {
    public var title: String?
    public var messages: [Message]
    public var streamText: String
    public var isStreaming: Bool
    public var errorMessage: String?

    public init(
        title: String? = nil,
        messages: [Message] = [],
        streamText: String = "",
        isStreaming: Bool = false,
        errorMessage: String? = nil
    ) {
        self.title = title
        self.messages = messages
        self.streamText = streamText
        self.isStreaming = isStreaming
        self.errorMessage = errorMessage
    }
}

public struct ConversationStreamReducer: Sendable {
    public init() {}

    public func reduce(_ state: inout ConversationStreamState, event: StreamEvent) {
        switch event {
        case .text(let content, _):
            state.streamText += content
            state.isStreaming = true
        case .thinking:
            break
        case .assistantMessage(let message):
            if let index = state.messages.firstIndex(where: { $0.id == message.id }) {
                state.messages[index] = message
            } else {
                state.messages.append(message)
            }
            state.streamText = ""
        case .titleUpdated(let title):
            state.title = title
        case .error(let message, _, _):
            state.errorMessage = message
            state.isStreaming = false
        case .done:
            state.isStreaming = false
        case .replayStart:
            state.streamText = ""
        default:
            break
        }
    }
}
