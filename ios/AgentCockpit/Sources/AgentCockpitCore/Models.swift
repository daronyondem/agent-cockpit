import Foundation

public enum EffortLevel: String, Codable, Sendable {
    case none
    case minimal
    case low
    case medium
    case high
    case xhigh
    case max
}

public enum MessageRole: String, Codable, Sendable {
    case user
    case assistant
    case system
}

public struct Usage: Codable, Equatable, Sendable {
    public var inputTokens: Int
    public var outputTokens: Int
    public var cacheReadTokens: Int
    public var cacheWriteTokens: Int
    public var costUsd: Double
    public var credits: Double?
    public var contextUsagePercentage: Double?

    public init(
        inputTokens: Int = 0,
        outputTokens: Int = 0,
        cacheReadTokens: Int = 0,
        cacheWriteTokens: Int = 0,
        costUsd: Double = 0,
        credits: Double? = nil,
        contextUsagePercentage: Double? = nil
    ) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cacheReadTokens = cacheReadTokens
        self.cacheWriteTokens = cacheWriteTokens
        self.costUsd = costUsd
        self.credits = credits
        self.contextUsagePercentage = contextUsagePercentage
    }
}

public struct ToolActivity: Codable, Equatable, Identifiable, Sendable {
    public var tool: String
    public var description: String
    public var id: String?
    public var duration: Int?
    public var startTime: Int
    public var isAgent: Bool?
    public var subagentType: String?
    public var parentAgentId: String?
    public var outcome: String?
    public var status: String?
    public var batchIndex: Int?

    public init(
        tool: String,
        description: String,
        id: String? = nil,
        duration: Int? = nil,
        startTime: Int,
        isAgent: Bool? = nil,
        subagentType: String? = nil,
        parentAgentId: String? = nil,
        outcome: String? = nil,
        status: String? = nil,
        batchIndex: Int? = nil
    ) {
        self.tool = tool
        self.description = description
        self.id = id
        self.duration = duration
        self.startTime = startTime
        self.isAgent = isAgent
        self.subagentType = subagentType
        self.parentAgentId = parentAgentId
        self.outcome = outcome
        self.status = status
        self.batchIndex = batchIndex
    }
}

public struct QuestionOption: Codable, Equatable, Identifiable, Sendable {
    public var label: String
    public var description: String?

    public var id: String { label }

    public init(label: String, description: String? = nil) {
        self.label = label
        self.description = description
    }
}

public struct UserQuestion: Codable, Equatable, Sendable {
    public var question: String
    public var options: [QuestionOption]?

    public init(question: String, options: [QuestionOption]? = nil) {
        self.question = question
        self.options = options
    }
}

public enum PendingInteraction: Equatable, Sendable {
    case planApproval(planContent: String)
    case userQuestion(question: String, options: [QuestionOption])
}

public enum ContentBlock: Codable, Equatable, Sendable {
    case text(String)
    case thinking(String)
    case tool(ToolActivity)

    private enum CodingKeys: String, CodingKey {
        case type
        case content
        case activity
    }

    private enum BlockType: String, Codable {
        case text
        case thinking
        case tool
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(BlockType.self, forKey: .type) {
        case .text:
            self = .text(try container.decode(String.self, forKey: .content))
        case .thinking:
            self = .thinking(try container.decode(String.self, forKey: .content))
        case .tool:
            self = .tool(try container.decode(ToolActivity.self, forKey: .activity))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .text(let content):
            try container.encode(BlockType.text, forKey: .type)
            try container.encode(content, forKey: .content)
        case .thinking(let content):
            try container.encode(BlockType.thinking, forKey: .type)
            try container.encode(content, forKey: .content)
        case .tool(let activity):
            try container.encode(BlockType.tool, forKey: .type)
            try container.encode(activity, forKey: .activity)
        }
    }
}

public struct StreamError: Codable, Equatable, Sendable {
    public enum Source: String, Codable, Sendable {
        case backend
        case transport
        case abort
        case server
    }

    public var message: String
    public var source: Source?

    public init(message: String, source: Source? = nil) {
        self.message = message
        self.source = source
    }
}

public struct Message: Codable, Equatable, Identifiable, Sendable {
    public enum Turn: String, Codable, Sendable {
        case progress
        case final
    }

    public var id: String
    public var role: MessageRole
    public var content: String
    public var backend: String
    public var timestamp: String
    public var thinking: String?
    public var toolActivity: [ToolActivity]?
    public var contentBlocks: [ContentBlock]?
    public var streamError: StreamError?
    public var turn: Turn?

    public init(
        id: String,
        role: MessageRole,
        content: String,
        backend: String,
        timestamp: String,
        thinking: String? = nil,
        toolActivity: [ToolActivity]? = nil,
        contentBlocks: [ContentBlock]? = nil,
        streamError: StreamError? = nil,
        turn: Turn? = nil
    ) {
        self.id = id
        self.role = role
        self.content = content
        self.backend = backend
        self.timestamp = timestamp
        self.thinking = thinking
        self.toolActivity = toolActivity
        self.contentBlocks = contentBlocks
        self.streamError = streamError
        self.turn = turn
    }
}

public enum AttachmentKind: String, Codable, Sendable {
    case image
    case pdf
    case text
    case code
    case md
    case folder
    case file
}

public struct AttachmentMeta: Codable, Equatable, Sendable {
    public var name: String
    public var path: String
    public var size: Int?
    public var kind: AttachmentKind
    public var meta: String?

    public init(name: String, path: String, size: Int? = nil, kind: AttachmentKind, meta: String? = nil) {
        self.name = name
        self.path = path
        self.size = size
        self.kind = kind
        self.meta = meta
    }
}

public struct QueuedMessage: Codable, Equatable, Sendable {
    public var content: String
    public var attachments: [AttachmentMeta]?

    public init(content: String, attachments: [AttachmentMeta]? = nil) {
        self.content = content
        self.attachments = attachments
    }

    public func wireContent() -> String {
        let paths = (attachments ?? []).map(\.path).filter { !$0.isEmpty }
        guard !paths.isEmpty else {
            return content
        }
        let tag = "[Uploaded files: \(paths.joined(separator: ", "))]"
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            return tag
        }
        return "\(content)\n\n\(tag)"
    }
}

public struct PendingAttachment: Equatable, Identifiable, Sendable {
    public enum Status: Equatable, Sendable {
        case uploading
        case done
        case error(String)
    }

    public var id: UUID
    public var fileName: String
    public var status: Status
    public var result: AttachmentMeta?

    public init(id: UUID = UUID(), fileName: String, status: Status, result: AttachmentMeta? = nil) {
        self.id = id
        self.fileName = fileName
        self.status = status
        self.result = result
    }
}

public struct SessionHistoryItem: Codable, Equatable, Identifiable, Sendable {
    public var number: Int
    public var sessionId: String?
    public var startedAt: String
    public var endedAt: String?
    public var messageCount: Int
    public var summary: String?
    public var isCurrent: Bool

    public var id: Int { number }

    public init(
        number: Int,
        sessionId: String? = nil,
        startedAt: String,
        endedAt: String? = nil,
        messageCount: Int,
        summary: String? = nil,
        isCurrent: Bool
    ) {
        self.number = number
        self.sessionId = sessionId
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.messageCount = messageCount
        self.summary = summary
        self.isCurrent = isCurrent
    }
}

public struct ConversationKbStatus: Codable, Equatable, Sendable {
    public enum DreamingStatus: String, Codable, Sendable {
        case idle
        case running
        case failed
    }

    public var enabled: Bool
    public var dreamingNeeded: Bool
    public var pendingEntries: Int
    public var pendingDigestions: Int?
    public var autoDigest: Bool?
    public var dreamingStatus: DreamingStatus
    public var failedItems: Int
}

public struct ConversationListItem: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var updatedAt: String
    public var backend: String
    public var cliProfileId: String?
    public var model: String?
    public var effort: EffortLevel?
    public var workingDir: String
    public var workspaceHash: String
    public var workspaceKbEnabled: Bool
    public var messageCount: Int
    public var lastMessage: String?
    public var usage: Usage?
    public var archived: Bool?
    public var unread: Bool?
}

public enum WorkspacePathFormatter {
    public static func lastTwoComponents(_ path: String) -> String {
        let components = path
            .split(separator: "/", omittingEmptySubsequences: true)
            .map(String.init)

        guard !components.isEmpty else {
            return path
        }

        return components.suffix(2).joined(separator: "/")
    }
}

public struct Conversation: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var backend: String
    public var cliProfileId: String?
    public var model: String?
    public var effort: EffortLevel?
    public var workingDir: String
    public var workspaceHash: String
    public var currentSessionId: String
    public var sessionNumber: Int
    public var messages: [Message]
    public var usage: Usage?
    public var sessionUsage: Usage?
    public var externalSessionId: String?
    public var messageQueue: [QueuedMessage]?
    public var archived: Bool?
    public var kb: ConversationKbStatus?
}

public struct ConversationListEnvelope: Codable, Equatable, Sendable {
    public var conversations: [ConversationListItem]
}

public struct SendMessageResponse: Codable, Equatable, Sendable {
    public var userMessage: Message
    public var streamReady: Bool
}

public enum InputResponseMode: String, Codable, Sendable {
    case stdin
    case message
}

public struct InputResponse: Codable, Equatable, Sendable {
    public var mode: InputResponseMode
}

public struct SessionsResponse: Codable, Equatable, Sendable {
    public var sessions: [SessionHistoryItem]
}

public struct SessionMessagesResponse: Codable, Equatable, Sendable {
    public var messages: [Message]
}

public struct QueueResponse: Codable, Equatable, Sendable {
    public var queue: [QueuedMessage]
}

public struct UploadFilesResponse: Codable, Equatable, Sendable {
    public var files: [AttachmentMeta]
}

public enum CliVendor: String, Codable, Sendable {
    case codex
    case claudeCode = "claude-code"
    case kiro
}

public enum CliAuthMode: String, Codable, Sendable {
    case serverConfigured = "server-configured"
    case account
}

public struct CliProfile: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var vendor: CliVendor
    public var command: String?
    public var authMode: CliAuthMode
    public var configDir: String?
    public var env: [String: String]?
    public var createdAt: String
    public var updatedAt: String
    public var disabled: Bool?
}

public struct Settings: Codable, Equatable, Sendable {
    public var theme: String?
    public var sendBehavior: String?
    public var systemPrompt: String?
    public var defaultBackend: String?
    public var cliProfiles: [CliProfile]?
    public var defaultCliProfileId: String?
    public var defaultModel: String?
    public var defaultEffort: EffortLevel?
    public var workingDirectory: String?
}

public struct ResetSessionResponse: Codable, Equatable, Sendable {
    public var conversation: Conversation
    public var newSessionNumber: Int
    public var archivedSession: ArchivedSessionSummary?
}

public struct ArchivedSessionSummary: Codable, Equatable, Sendable {
    public var number: Int
    public var sessionId: String?
    public var startedAt: String
    public var endedAt: String
    public var messageCount: Int
    public var summary: String?
}

public struct BasicOKResponse: Codable, Equatable, Sendable {
    public var ok: Bool
}

public struct ActiveStreamsResponse: Codable, Equatable, Sendable {
    public var ids: [String]
    public var streams: [ActiveStreamSummary]
}

public struct ActiveStreamSummary: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var jobId: String?
    public var state: String?
    public var backend: String
    public var startedAt: String?
    public var lastEventAt: String?
    public var connected: Bool
    public var runtimeAttached: Bool?
    public var pending: Bool?
}

public struct CurrentUser: Codable, Equatable, Sendable {
    public enum Provider: String, Codable, Sendable {
        case local
        case google
        case github
    }

    public var displayName: String?
    public var email: String?
    public var provider: Provider?

    public init(displayName: String? = nil, email: String? = nil, provider: Provider? = nil) {
        self.displayName = displayName
        self.email = email
        self.provider = provider
    }
}

public struct MobileDevice: Codable, Equatable, Sendable {
    public var id: String
    public var displayName: String
    public var createdAt: String
    public var lastSeenAt: String
    public var lastIp: String?
    public var lastUserAgent: String?
    public var platform: String?
    public var revokedAt: String?

    public init(
        id: String,
        displayName: String,
        createdAt: String,
        lastSeenAt: String,
        lastIp: String? = nil,
        lastUserAgent: String? = nil,
        platform: String? = nil,
        revokedAt: String? = nil
    ) {
        self.id = id
        self.displayName = displayName
        self.createdAt = createdAt
        self.lastSeenAt = lastSeenAt
        self.lastIp = lastIp
        self.lastUserAgent = lastUserAgent
        self.platform = platform
        self.revokedAt = revokedAt
    }
}

public struct MobileAuthExchangeResponse: Codable, Equatable, Sendable {
    public var user: CurrentUser
    public var csrfToken: String
    public var device: MobileDevice?

    public init(user: CurrentUser, csrfToken: String, device: MobileDevice? = nil) {
        self.user = user
        self.csrfToken = csrfToken
        self.device = device
    }
}

public struct BackendCapabilities: Codable, Equatable, Sendable {
    public var thinking: Bool
    public var planMode: Bool
    public var agents: Bool
    public var toolActivity: Bool
    public var userQuestions: Bool
    public var stdinInput: Bool
}

public struct BackendResumeCapabilities: Codable, Equatable, Sendable {
    public var activeTurnResume: String
    public var activeTurnResumeReason: String
    public var sessionResume: String
    public var sessionResumeReason: String
}

public struct ModelOption: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var label: String
    public var family: String
    public var description: String?
    public var costTier: String?
    public var `default`: Bool?
    public var supportedEffortLevels: [EffortLevel]?
}

public struct BackendMetadata: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var label: String
    public var icon: String?
    public var capabilities: BackendCapabilities
    public var resumeCapabilities: BackendResumeCapabilities?
    public var models: [ModelOption]?
}

public struct BackendsResponse: Codable, Equatable, Sendable {
    public var backends: [BackendMetadata]
}

public struct CliProfileMetadataResponse: Codable, Equatable, Sendable {
    public var profileId: String
    public var backend: BackendMetadata
}

public enum ExplorerEntryType: String, Codable, Sendable {
    case dir
    case file
}

public struct ExplorerEntry: Codable, Equatable, Identifiable, Sendable {
    public var name: String
    public var type: ExplorerEntryType
    public var size: Int?
    public var mtime: Double?

    public var id: String { "\(type.rawValue):\(name)" }
}

public struct ExplorerTreeResponse: Codable, Equatable, Sendable {
    public var path: String
    public var parent: String?
    public var entries: [ExplorerEntry]
}

public struct ExplorerPreviewResponse: Codable, Equatable, Sendable {
    public var content: String
    public var filename: String
    public var language: String?
    public var mimeType: String?
    public var size: Int?
}
