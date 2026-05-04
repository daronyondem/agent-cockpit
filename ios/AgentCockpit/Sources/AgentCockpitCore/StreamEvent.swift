import Foundation

public enum StreamEvent: Equatable, Sendable {
    case text(content: String, streaming: Bool?)
    case thinking(content: String, streaming: Bool?)
    case toolActivity(ToolActivity)
    case assistantMessage(Message)
    case titleUpdated(String)
    case usage(Usage, sessionUsage: Usage?)
    case planModeChanged(active: Bool)
    case planApproval(planContent: String)
    case userQuestion(UserQuestion)
    case error(message: String, terminal: Bool?, source: StreamError.Source?)
    case done
    case replayStart(bufferedEvents: Int?)
    case replayEnd
    case turnComplete
    case unknown(type: String)

    private enum CodingKeys: String, CodingKey {
        case type
        case content
        case streaming
        case message
        case title
        case usage
        case sessionUsage
        case error
        case terminal
        case source
        case bufferedEvents
        case tool
        case description
        case id
        case duration
        case startTime
        case isAgent
        case subagentType
        case parentAgentId
        case outcome
        case status
        case batchIndex
        case isPlanMode
        case planAction
        case planContent
        case isQuestion
        case questions
    }
}

extension StreamEvent: Decodable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)

        switch type {
        case "text":
            self = .text(
                content: try container.decodeIfPresent(String.self, forKey: .content) ?? "",
                streaming: try container.decodeIfPresent(Bool.self, forKey: .streaming)
            )
        case "thinking":
            self = .thinking(
                content: try container.decodeIfPresent(String.self, forKey: .content) ?? "",
                streaming: try container.decodeIfPresent(Bool.self, forKey: .streaming)
            )
        case "tool_activity":
            let isPlanMode = try container.decodeIfPresent(Bool.self, forKey: .isPlanMode) ?? false
            if isPlanMode {
                switch try container.decodeIfPresent(String.self, forKey: .planAction) {
                case "enter":
                    self = .planModeChanged(active: true)
                    return
                case "exit":
                    self = .planApproval(
                        planContent: try container.decodeIfPresent(String.self, forKey: .planContent) ?? ""
                    )
                    return
                default:
                    break
                }
            }

            if try container.decodeIfPresent(Bool.self, forKey: .isQuestion) == true {
                let questions = try container.decodeIfPresent([UserQuestion].self, forKey: .questions) ?? []
                if let question = questions.first {
                    self = .userQuestion(question)
                    return
                }
            }

            let activity = ToolActivity(
                tool: try container.decodeIfPresent(String.self, forKey: .tool) ?? "Tool",
                description: try container.decodeIfPresent(String.self, forKey: .description) ?? "",
                id: try container.decodeIfPresent(String.self, forKey: .id),
                duration: try container.decodeIfPresent(Int.self, forKey: .duration),
                startTime: try container.decodeIfPresent(Int.self, forKey: .startTime) ?? 0,
                isAgent: try container.decodeIfPresent(Bool.self, forKey: .isAgent),
                subagentType: try container.decodeIfPresent(String.self, forKey: .subagentType),
                parentAgentId: try container.decodeIfPresent(String.self, forKey: .parentAgentId),
                outcome: try container.decodeIfPresent(String.self, forKey: .outcome),
                status: try container.decodeIfPresent(String.self, forKey: .status),
                batchIndex: try container.decodeIfPresent(Int.self, forKey: .batchIndex)
            )
            self = .toolActivity(activity)
        case "assistant_message":
            self = .assistantMessage(try container.decode(Message.self, forKey: .message))
        case "title_updated":
            self = .titleUpdated(try container.decodeIfPresent(String.self, forKey: .title) ?? "")
        case "usage":
            self = .usage(
                try container.decode(Usage.self, forKey: .usage),
                sessionUsage: try container.decodeIfPresent(Usage.self, forKey: .sessionUsage)
            )
        case "error":
            self = .error(
                message: try container.decodeIfPresent(String.self, forKey: .error) ?? "Unknown stream error",
                terminal: try container.decodeIfPresent(Bool.self, forKey: .terminal),
                source: try container.decodeIfPresent(StreamError.Source.self, forKey: .source)
            )
        case "done":
            self = .done
        case "replay_start":
            self = .replayStart(bufferedEvents: try container.decodeIfPresent(Int.self, forKey: .bufferedEvents))
        case "replay_end":
            self = .replayEnd
        case "turn_complete":
            self = .turnComplete
        default:
            self = .unknown(type: type)
        }
    }
}
