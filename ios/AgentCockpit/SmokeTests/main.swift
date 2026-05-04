import AgentCockpitCore
import Foundation

@main
struct SmokeTests {
    static func main() async throws {
        try buildsChatURLsUnderBasePath()
        try buildsWebSocketURLUnderBasePath()
        try buildsMobileWebLoginURLUnderBasePath()
        try parsesServerURLs()
        try parsesMobilePairingDeepLinks()
        try decodesOrderedContentBlocks()
        try decodesStreamEvents()
        try appliesStreamReducerEvents()
        try replacesDuplicateAssistantMessagesDuringStreamReplay()
        try formatsWorkspacePathsForConversationRows()
        try decodesCurrentUser()
        try decodesBackends()
        try decodesSettingsAndProfiles()
        try decodesSessionsAndQueue()
        try composesAttachmentWireContent()
        try await listConversationsDecodesEnvelope()
        try await createConversationUsesExpectedRoute()
        try await conversationManagementUsesExpectedRoutes()
        try await backendsRequestUsesExpectedRoute()
        try await settingsAndProfileMetadataUseExpectedRoutes()
        try await explorerRequestsUseExpectedRoutes()
        try await sessionAndQueueRequestsUseExpectedRoutes()
        try await uploadRequestsUseMultipartAndCSRF()
        try await sendMessageFetchesAndAppliesCSRFToken()
        try await exchangesMobileAuthCode()
        try await exchangesMobilePairingCode()
        try await interactionInputUsesExpectedRoute()
        try await queueAutoDrainsAfterDoneFrame()
        try await pendingInteractionBlocksQueueDrainUntilAnswered()
        print("AgentCockpitCoreSmokeTests passed")
    }

    private static func buildsChatURLsUnderBasePath() throws {
        let api = AgentCockpitAPI(
            configuration: AgentCockpitConfiguration(serverURL: URL(string: "https://example.com/cockpit")!),
            transport: MockTransport()
        )

        let request = try api.makeRequest(.get, path: "/api/chat/conversations", queryItems: [
            URLQueryItem(name: "q", value: "hello world")
        ])

        try expect(request.url?.absoluteString == "https://example.com/cockpit/api/chat/conversations?q=hello%20world")
        try expect(request.httpMethod == "GET")
    }

    private static func buildsWebSocketURLUnderBasePath() throws {
        let api = AgentCockpitAPI(
            configuration: AgentCockpitConfiguration(serverURL: URL(string: "http://localhost:3334/proxy")!),
            transport: MockTransport()
        )

        let url = try api.websocketURL(conversationID: "conv-1")

        try expect(url.absoluteString == "ws://localhost:3334/proxy/api/chat/conversations/conv-1/ws")
    }

    private static func buildsMobileWebLoginURLUnderBasePath() throws {
        let api = AgentCockpitAPI(
            configuration: AgentCockpitConfiguration(serverURL: URL(string: "https://example.com/cockpit")!),
            transport: MockTransport()
        )

        let url = try api.mobileWebLoginURL()

        try expect(url.absoluteString == "https://example.com/cockpit/auth/mobile-login")
    }

    private static func parsesServerURLs() throws {
        let localURL = try AgentCockpitConfiguration.parseServerURL("localhost:3334")
        let lanURL = try AgentCockpitConfiguration.parseServerURL("192.168.1.20:3335")
        let tunnelURL = try AgentCockpitConfiguration.parseServerURL(" https://example.com/cockpit ")
        try expect(localURL.absoluteString == "http://localhost:3334")
        try expect(lanURL.absoluteString == "http://192.168.1.20:3335")
        try expect(tunnelURL.absoluteString == "https://example.com/cockpit")
        let bareTunnelURL = try AgentCockpitConfiguration.parseServerURL("chat-dev.dytunnel.work")
        try expect(bareTunnelURL.absoluteString == "https://chat-dev.dytunnel.work")
        do {
            _ = try AgentCockpitConfiguration.parseServerURL("ftp://example.com")
            throw SmokeTestError.failure("Expected unsupported scheme to fail")
        } catch AgentAPIError.invalidBaseURL {
            // Expected.
        }
    }

    private static func parsesMobilePairingDeepLinks() throws {
        let link = try MobilePairingDeepLink(rawValue: "agentcockpit://pair?server=https%3A%2F%2Fchat-dev.dytunnel.work&challengeId=challenge-1&code=ABCD-2345")

        try expect(link.serverURL.absoluteString == "https://chat-dev.dytunnel.work")
        try expect(link.challengeId == "challenge-1")
        try expect(link.code == "ABCD-2345")

        do {
            _ = try MobilePairingDeepLink(rawValue: "https://chat-dev.dytunnel.work")
            throw SmokeTestError.failure("Expected non-Agent Cockpit URL to fail")
        } catch MobilePairingDeepLinkError.unsupportedScheme {
            // Expected.
        }
    }

    private static func listConversationsDecodesEnvelope() async throws {
        let transport = MockTransport()
        transport.enqueue(json: """
        {
          "conversations": [
            {
              "id": "c1",
              "title": "Build iOS",
              "updatedAt": "2026-05-02T00:00:00.000Z",
              "backend": "codex",
              "workingDir": "/Users/daron/repo",
              "workspaceHash": "abc123",
              "workspaceKbEnabled": true,
              "messageCount": 2,
              "lastMessage": "Done",
              "usage": {
                "inputTokens": 1,
                "outputTokens": 2,
                "cacheReadTokens": 3,
                "cacheWriteTokens": 4,
                "costUsd": 0,
                "contextUsagePercentage": 1.4035999774932861
              },
              "unread": true
            }
          ]
        }
        """)
        let api = AgentCockpitAPI(transport: transport)

        let conversations = try await api.listConversations(search: "ios")

        try expect(conversations.count == 1)
        try expect(conversations[0].title == "Build iOS")
        try expect(conversations[0].workspaceKbEnabled)
        try expect(conversations[0].usage?.contextUsagePercentage == 1.4035999774932861)
        try expect(conversations[0].unread == true)
        try expect(transport.requests.last?.url?.absoluteString == "http://localhost:3334/api/chat/conversations?q=ios")
    }

    private static func sendMessageFetchesAndAppliesCSRFToken() async throws {
        let transport = MockTransport()
        transport.enqueue(json: #"{"csrfToken":"token-123"}"#)
        transport.enqueue(json: """
        {
          "userMessage": {
            "id": "m1",
            "role": "user",
            "content": "hello",
            "backend": "codex",
            "timestamp": "2026-05-02T00:00:00.000Z"
          },
          "streamReady": true
        }
        """)
        let api = AgentCockpitAPI(transport: transport)

        let response = try await api.sendMessage(
            conversationID: "c1",
            content: "hello",
            backend: "codex",
            cliProfileId: "profile-codex-main",
            model: "gpt-5.2",
            effort: .high
        )

        try expect(response.streamReady)
        try expect(transport.requests.count == 2)
        try expect(transport.requests[0].url?.path == "/api/csrf-token")
        try expect(transport.requests[1].url?.path == "/api/chat/conversations/c1/message")
        try expect(transport.requests[1].value(forHTTPHeaderField: "x-csrf-token") == "token-123")
        try expect(transport.requests[1].httpMethod == "POST")
        let body = String(data: transport.requests[1].httpBody ?? Data(), encoding: .utf8) ?? ""
        try expect(body.contains(#""backend":"codex""#))
        try expect(body.contains(#""cliProfileId":"profile-codex-main""#))
        try expect(body.contains(#""model":"gpt-5.2""#))
        try expect(body.contains(#""effort":"high""#))
    }

    private static func exchangesMobileAuthCode() async throws {
        let transport = MockTransport()
        transport.enqueue(json: """
        {
          "user": {
            "displayName": "Octocat",
            "email": "octocat@github.com",
            "provider": "github"
          },
          "csrfToken": "mobile-token"
        }
        """)
        let api = AgentCockpitAPI(transport: transport)

        let response = try await api.exchangeMobileAuthCode("one-time-code")
        let request = transport.requests.last

        try expect(response.user.provider == .github)
        try expect(response.csrfToken == "mobile-token")
        try expect(request?.url?.path == "/api/mobile-auth/exchange")
        try expect(request?.httpMethod == "POST")
        try expect(String(data: request?.httpBody ?? Data(), encoding: .utf8)?.contains("one-time-code") == true)
        try expect(String(data: request?.httpBody ?? Data(), encoding: .utf8)?.contains("Agent Cockpit iOS") == true)

        _ = try await api.fetchCSRFToken()
        try expect(transport.requests.count == 1)
    }

    private static func exchangesMobilePairingCode() async throws {
        let transport = MockTransport()
        transport.enqueue(json: """
        {
          "user": {
            "displayName": "Owner",
            "email": "owner@example.com",
            "provider": "local"
          },
          "csrfToken": "pair-token",
          "device": {
            "id": "device-1",
            "displayName": "Agent Cockpit iOS",
            "createdAt": "2026-05-03T00:00:00.000Z",
            "lastSeenAt": "2026-05-03T00:00:00.000Z",
            "platform": "iOS"
          }
        }
        """)
        let api = AgentCockpitAPI(transport: transport)

        let response = try await api.exchangeMobilePairingCode(challengeId: "challenge-1", code: "ABCD-2345")
        let request = transport.requests.last

        try expect(response.user.provider == .local)
        try expect(response.device?.id == "device-1")
        try expect(response.csrfToken == "pair-token")
        try expect(request?.url?.path == "/api/mobile-pairing/exchange")
        try expect(request?.httpMethod == "POST")
        let body = String(data: request?.httpBody ?? Data(), encoding: .utf8) ?? ""
        try expect(body.contains(#""challengeId":"challenge-1""#))
        try expect(body.contains(#""code":"ABCD-2345""#))

        _ = try await api.fetchCSRFToken()
        try expect(transport.requests.count == 1)
    }

    private static func interactionInputUsesExpectedRoute() async throws {
        let transport = MockTransport()
        transport.enqueue(json: #"{"csrfToken":"input-token"}"#)
        transport.enqueue(json: #"{"mode":"stdin"}"#)
        transport.enqueue(json: #"{"mode":"message"}"#)

        let api = AgentCockpitAPI(transport: transport)
        let stdinResponse = try await api.sendInput(conversationID: "c1", text: "yes", streamActive: true)
        let messageResponse = try await api.sendInput(conversationID: "c1", text: "answer", streamActive: false)

        try expect(stdinResponse.mode == .stdin)
        try expect(messageResponse.mode == .message)
        try expect(transport.requests[1].url?.path == "/api/chat/conversations/c1/input")
        try expect(transport.requests[1].httpMethod == "POST")
        try expect(transport.requests[1].value(forHTTPHeaderField: "x-csrf-token") == "input-token")
        let body = String(data: transport.requests[1].httpBody ?? Data(), encoding: .utf8) ?? ""
        try expect(body.contains(#""text":"yes""#))
        try expect(body.contains(#""streamActive":true"#))
    }

    private static func createConversationUsesExpectedRoute() async throws {
        let transport = MockTransport()
        transport.enqueue(json: #"{"csrfToken":"create-token"}"#)
        transport.enqueue(json: """
        {
          "id": "c-new",
          "title": "iOS Native",
          "backend": "codex",
          "cliProfileId": "profile-codex-main",
          "model": "gpt-5.2",
          "effort": "high",
          "workingDir": "/Users/daron/repo",
          "workspaceHash": "abc123",
          "currentSessionId": "s1",
          "sessionNumber": 1,
          "messages": []
        }
        """)

        let api = AgentCockpitAPI(transport: transport)
        let conversation = try await api.createConversation(
            title: "iOS Native",
            workingDir: "/Users/daron/repo",
            cliProfileId: "profile-codex-main",
            model: "gpt-5.2",
            effort: .high
        )

        try expect(conversation.id == "c-new")
        try expect(conversation.cliProfileId == "profile-codex-main")
        try expect(transport.requests[1].url?.path == "/api/chat/conversations")
        try expect(transport.requests[1].httpMethod == "POST")
        try expect(transport.requests[1].value(forHTTPHeaderField: "x-csrf-token") == "create-token")
        let body = String(data: transport.requests[1].httpBody ?? Data(), encoding: .utf8) ?? ""
        try expect(body.contains(#""title":"iOS Native""#))
        try expect(body.contains(#""workingDir":"\/Users\/daron\/repo""#) || body.contains(#""workingDir":"/Users/daron/repo""#))
        try expect(body.contains(#""cliProfileId":"profile-codex-main""#))
    }

    private static func conversationManagementUsesExpectedRoutes() async throws {
        let transport = MockTransport()
        transport.enqueue(json: #"{"csrfToken":"manage-token"}"#)
        transport.enqueue(json: """
        {
          "id": "c1",
          "title": "Renamed",
          "backend": "codex",
          "workingDir": "/Users/daron/repo",
          "workspaceHash": "abc123",
          "currentSessionId": "s1",
          "sessionNumber": 1,
          "messages": []
        }
        """)
        transport.enqueue(json: #"{"ok":true}"#)
        transport.enqueue(json: #"{"ok":true}"#)
        transport.enqueue(json: #"{"ok":true}"#)

        let api = AgentCockpitAPI(transport: transport)
        let renamed = try await api.renameConversation(id: "c1", title: "Renamed")
        let archived = try await api.archiveConversation(id: "c1")
        let restored = try await api.restoreConversation(id: "c1")
        let deleted = try await api.deleteConversation(id: "c1")

        try expect(renamed.title == "Renamed")
        try expect(archived)
        try expect(restored)
        try expect(deleted)
        try expect(transport.requests[1].url?.path == "/api/chat/conversations/c1")
        try expect(transport.requests[1].httpMethod == "PUT")
        try expect(transport.requests[1].value(forHTTPHeaderField: "x-csrf-token") == "manage-token")
        try expect(transport.requests[2].url?.path == "/api/chat/conversations/c1/archive")
        try expect(transport.requests[2].httpMethod == "PATCH")
        try expect(transport.requests[3].url?.path == "/api/chat/conversations/c1/restore")
        try expect(transport.requests[3].httpMethod == "PATCH")
        try expect(transport.requests[4].url?.path == "/api/chat/conversations/c1")
        try expect(transport.requests[4].httpMethod == "DELETE")
    }

    private static func backendsRequestUsesExpectedRoute() async throws {
        let transport = MockTransport()
        transport.enqueue(json: """
        {
          "backends": [
            {
              "id": "codex",
              "label": "Codex",
              "icon": null,
              "capabilities": {
                "thinking": true,
                "planMode": false,
                "agents": true,
                "toolActivity": true,
                "userQuestions": true,
                "stdinInput": true
              },
              "resumeCapabilities": {
                "activeTurnResume": "unsupported",
                "activeTurnResumeReason": "No active turn resume",
                "sessionResume": "supported",
                "sessionResumeReason": "Thread history resumes"
              },
              "models": [
                {
                  "id": "gpt-5.2",
                  "label": "GPT-5.2",
                  "family": "gpt",
                  "default": true,
                  "supportedEffortLevels": ["low", "medium", "high"]
                }
              ]
            }
          ]
        }
        """)

        let api = AgentCockpitAPI(transport: transport)
        let backends = try await api.getBackends()

        try expect(backends.count == 1)
        try expect(backends[0].id == "codex")
        try expect(backends[0].models?.first?.supportedEffortLevels == [.low, .medium, .high])
        try expect(transport.requests.last?.url?.path == "/api/chat/backends")
    }

    private static func settingsAndProfileMetadataUseExpectedRoutes() async throws {
        let transport = MockTransport()
        transport.enqueue(json: """
        {
          "theme": "system",
          "sendBehavior": "enter",
          "systemPrompt": "",
          "defaultBackend": "codex",
          "defaultCliProfileId": "profile-codex-main",
          "cliProfiles": [
            {
              "id": "profile-codex-main",
              "name": "Codex Main",
              "vendor": "codex",
              "authMode": "account",
              "configDir": "/Users/daron/.codex-main",
              "createdAt": "2026-05-02T00:00:00.000Z",
              "updatedAt": "2026-05-02T00:00:00.000Z"
            }
          ],
          "defaultModel": "gpt-5.2",
          "defaultEffort": "high"
        }
        """)
        transport.enqueue(json: """
        {
          "profileId": "profile-codex-main",
          "backend": {
            "id": "codex",
            "label": "Codex",
            "icon": null,
            "capabilities": {
              "thinking": true,
              "planMode": false,
              "agents": true,
              "toolActivity": true,
              "userQuestions": true,
              "stdinInput": true
            },
            "resumeCapabilities": {
              "activeTurnResume": "unsupported",
              "activeTurnResumeReason": "No active turn resume",
              "sessionResume": "supported",
              "sessionResumeReason": "Thread history resumes"
            },
            "models": [
              {
                "id": "gpt-5.2",
                "label": "GPT-5.2",
                "family": "gpt",
                "default": true,
                "supportedEffortLevels": ["medium", "high"]
              }
            ]
          }
        }
        """)

        let api = AgentCockpitAPI(transport: transport)
        let settings = try await api.getSettings()
        let backend = try await api.getCliProfileMetadata(profileID: "profile-codex-main")

        try expect(settings.defaultCliProfileId == "profile-codex-main")
        try expect(settings.cliProfiles?.first?.vendor == .codex)
        try expect(settings.cliProfiles?.first?.authMode == .account)
        try expect(backend.id == "codex")
        try expect(backend.models?.first?.supportedEffortLevels == [.medium, .high])
        try expect(transport.requests[0].url?.path == "/api/chat/settings")
        try expect(transport.requests[1].url?.path == "/api/chat/cli-profiles/profile-codex-main/metadata")
    }

    private static func explorerRequestsUseExpectedRoutes() async throws {
        let transport = MockTransport()
        transport.enqueue(json: """
        {
          "path": "src",
          "parent": "",
          "entries": [
            { "name": "App.swift", "type": "file", "size": 120, "mtime": 1770000000000 },
            { "name": "Views", "type": "dir", "size": 0, "mtime": 1770000000001 }
          ]
        }
        """)
        transport.enqueue(json: """
        {
          "content": "print(1)",
          "filename": "App.swift",
          "language": "swift",
          "mimeType": "text/plain",
          "size": 8
        }
        """)

        let api = AgentCockpitAPI(transport: transport)
        let tree = try await api.getExplorerTree(workspaceHash: "abc123", path: "src")
        let preview = try await api.getExplorerPreview(workspaceHash: "abc123", path: "src/App.swift")

        try expect(tree.path == "src")
        try expect(tree.parent == "")
        try expect(tree.entries.count == 2)
        try expect(tree.entries[0].type == .file)
        try expect(preview.filename == "App.swift")
        try expect(preview.language == "swift")
        try expect(transport.requests[0].url?.path == "/api/chat/workspaces/abc123/explorer/tree")
        try expect(transport.requests[0].url?.query?.contains("path=src") == true)
        try expect(transport.requests[1].url?.path == "/api/chat/workspaces/abc123/explorer/preview")
        try expect(transport.requests[1].url?.query?.contains("mode=view") == true)
    }

    private static func sessionAndQueueRequestsUseExpectedRoutes() async throws {
        let transport = MockTransport()
        transport.enqueue(json: """
        {
          "sessions": [
            {
              "number": 1,
              "sessionId": "s1",
              "startedAt": "2026-05-02T00:00:00.000Z",
              "endedAt": null,
              "messageCount": 4,
              "summary": null,
              "isCurrent": true
            }
          ]
        }
        """)
        transport.enqueue(json: """
        {
          "messages": [
            {
              "id": "m1",
              "role": "user",
              "content": "hello",
              "backend": "codex",
              "timestamp": "2026-05-02T00:00:00.000Z"
            }
          ]
        }
        """)
        transport.enqueue(json: #"{"queue":[{"content":"next"}]}"#)
        transport.enqueue(json: #"{"csrfToken":"token-456"}"#)
        transport.enqueue(json: #"{"ok":true}"#)
        transport.enqueue(json: #"{"ok":true}"#)

        let api = AgentCockpitAPI(transport: transport)
        let sessions = try await api.getSessions(conversationID: "c1")
        let messages = try await api.getSessionMessages(conversationID: "c1", sessionNumber: 1)
        let queue = try await api.getQueue(conversationID: "c1")
        let savedQueue = try await api.saveQueue(conversationID: "c1", queue: queue + [QueuedMessage(content: "after")])
        let cleared = try await api.clearQueue(conversationID: "c1")

        try expect(sessions.count == 1)
        try expect(messages.first?.content == "hello")
        try expect(queue == [QueuedMessage(content: "next")])
        try expect(savedQueue == [QueuedMessage(content: "next"), QueuedMessage(content: "after")])
        try expect(cleared)
        try expect(transport.requests[0].url?.path == "/api/chat/conversations/c1/sessions")
        try expect(transport.requests[1].url?.path == "/api/chat/conversations/c1/sessions/1/messages")
        try expect(transport.requests[2].url?.path == "/api/chat/conversations/c1/queue")
        try expect(transport.requests[4].url?.path == "/api/chat/conversations/c1/queue")
        try expect(transport.requests[4].httpMethod == "PUT")
        try expect(transport.requests[4].value(forHTTPHeaderField: "x-csrf-token") == "token-456")
        try expect(transport.requests[5].httpMethod == "DELETE")
    }

    private static func uploadRequestsUseMultipartAndCSRF() async throws {
        let transport = MockTransport()
        transport.enqueue(json: #"{"csrfToken":"upload-token"}"#)
        transport.enqueue(json: """
        {
          "files": [
            {
              "name": "notes.txt",
              "path": "/tmp/artifacts/c1/notes.txt",
              "size": 5,
              "kind": "text",
              "meta": "1 lines"
            }
          ]
        }
        """)
        transport.enqueue(json: #"{"ok":true}"#)

        let api = AgentCockpitAPI(transport: transport)
        let uploaded = try await api.uploadFile(
            conversationID: "c1",
            fileName: "notes.txt",
            data: Data("hello".utf8),
            mimeType: "text/plain"
        )
        let deleted = try await api.deleteUpload(conversationID: "c1", filename: "notes.txt")

        try expect(uploaded.kind == .text)
        try expect(uploaded.meta == "1 lines")
        try expect(deleted)
        try expect(transport.requests.count == 3)
        try expect(transport.requests[1].url?.path == "/api/chat/conversations/c1/upload")
        try expect(transport.requests[1].value(forHTTPHeaderField: "x-csrf-token") == "upload-token")
        try expect(transport.requests[1].value(forHTTPHeaderField: "Content-Type")?.contains("multipart/form-data; boundary=") == true)
        let body = String(data: transport.requests[1].httpBody ?? Data(), encoding: .utf8) ?? ""
        try expect(body.contains(#"name="files"; filename="notes.txt""#))
        try expect(body.contains("hello"))
        try expect(transport.requests[2].httpMethod == "DELETE")
        try expect(transport.requests[2].url?.path == "/api/chat/conversations/c1/upload/notes.txt")
    }

    private static func decodesOrderedContentBlocks() throws {
        let data = Data("""
        {
          "id": "m1",
          "role": "assistant",
          "content": "I checked.",
          "backend": "codex",
          "timestamp": "2026-05-02T00:00:00.000Z",
          "contentBlocks": [
            { "type": "text", "content": "I will inspect." },
            {
              "type": "tool",
              "activity": {
                "tool": "Bash",
                "description": "Running tests",
                "id": "tool-1",
                "duration": 1200,
                "startTime": 1770000000000,
                "status": "success",
                "batchIndex": 2
              }
            },
            { "type": "text", "content": "I checked." }
          ],
          "turn": "final"
        }
        """.utf8)

        let message = try JSONDecoder().decode(Message.self, from: data)

        try expect(message.contentBlocks?.count == 3)
        try expect(message.contentBlocks?[0] == .text("I will inspect."))
        guard case .tool(let activity) = message.contentBlocks?[1] else {
            throw SmokeTestError.failure("Expected tool content block")
        }
        try expect(activity.tool == "Bash")
        try expect(activity.batchIndex == 2)
    }

    private static func decodesStreamEvents() throws {
        let decoder = JSONDecoder()

        let text = try decoder.decode(StreamEvent.self, from: Data(#"{"type":"text","content":"hi","streaming":true}"#.utf8))
        let error = try decoder.decode(StreamEvent.self, from: Data(#"{"type":"error","error":"Aborted by user","source":"abort"}"#.utf8))
        let done = try decoder.decode(StreamEvent.self, from: Data(#"{"type":"done"}"#.utf8))
        let planEnter = try decoder.decode(StreamEvent.self, from: Data(#"{"type":"tool_activity","tool":"EnterPlanMode","isPlanMode":true,"planAction":"enter"}"#.utf8))
        let planExit = try decoder.decode(StreamEvent.self, from: Data(#"{"type":"tool_activity","tool":"ExitPlanMode","isPlanMode":true,"planAction":"exit","planContent":"Run tests first."}"#.utf8))
        let question = try decoder.decode(StreamEvent.self, from: Data("""
        {
          "type": "tool_activity",
          "tool": "AskUserQuestion",
          "isQuestion": true,
          "questions": [
            {
              "question": "Which profile?",
              "options": [
                { "label": "Codex", "description": "Use Codex" }
              ]
            }
          ]
        }
        """.utf8))
        let usage = try decoder.decode(StreamEvent.self, from: Data("""
        {
          "type": "usage",
          "usage": {
            "inputTokens": 10,
            "outputTokens": 5,
            "cacheReadTokens": 2,
            "cacheWriteTokens": 1,
            "costUsd": 0.01
          },
          "sessionUsage": {
            "inputTokens": 7,
            "outputTokens": 3,
            "cacheReadTokens": 0,
            "cacheWriteTokens": 0,
            "costUsd": 0.005,
            "contextUsagePercentage": 12.5
          }
        }
        """.utf8))

        try expect(text == .text(content: "hi", streaming: true))
        try expect(error == .error(message: "Aborted by user", terminal: nil, source: .abort))
        try expect(done == .done)
        try expect(planEnter == .planModeChanged(active: true))
        try expect(planExit == .planApproval(planContent: "Run tests first."))
        try expect(question == .userQuestion(UserQuestion(question: "Which profile?", options: [QuestionOption(label: "Codex", description: "Use Codex")])))
        guard case .usage(let total, let session) = usage else {
            throw SmokeTestError.failure("Expected usage event")
        }
        try expect(total.inputTokens == 10)
        try expect(session?.contextUsagePercentage == 12.5)
    }

    private static func appliesStreamReducerEvents() throws {
        let reducer = ConversationStreamReducer()
        var state = ConversationStreamState(title: "Old")

        reducer.reduce(&state, event: .titleUpdated("New"))
        reducer.reduce(&state, event: .text(content: "hel", streaming: true))
        reducer.reduce(&state, event: .text(content: "lo", streaming: true))

        try expect(state.title == "New")
        try expect(state.streamText == "hello")
        try expect(state.isStreaming)

        let assistant = Message(
            id: "a1",
            role: .assistant,
            content: "hello",
            backend: "codex",
            timestamp: "2026-05-02T00:00:00.000Z",
            turn: .final
        )
        reducer.reduce(&state, event: .assistantMessage(assistant))
        try expect(state.streamText.isEmpty)
        try expect(state.messages == [assistant])

        reducer.reduce(&state, event: .done)
        try expect(!state.isStreaming)
    }

    private static func replacesDuplicateAssistantMessagesDuringStreamReplay() throws {
        let reducer = ConversationStreamReducer()
        let original = Message(
            id: "a1",
            role: .assistant,
            content: "old",
            backend: "codex",
            timestamp: "2026-05-02T00:00:00.000Z",
            turn: .final
        )
        let replayed = Message(
            id: "a1",
            role: .assistant,
            content: "new",
            backend: "codex",
            timestamp: "2026-05-02T00:00:01.000Z",
            turn: .final
        )
        var state = ConversationStreamState(
            messages: [original],
            streamText: "stale replay text",
            isStreaming: true
        )

        reducer.reduce(&state, event: .replayStart(bufferedEvents: 3))
        try expect(state.streamText.isEmpty)

        reducer.reduce(&state, event: .assistantMessage(replayed))
        try expect(state.messages == [replayed])
        try expect(state.streamText.isEmpty)
    }

    private static func formatsWorkspacePathsForConversationRows() throws {
        try expect(WorkspacePathFormatter.lastTwoComponents("/Users/daronyondem/github/agent-cockpit") == "github/agent-cockpit")
        try expect(WorkspacePathFormatter.lastTwoComponents("github/agent-cockpit") == "github/agent-cockpit")
        try expect(WorkspacePathFormatter.lastTwoComponents("/repo") == "repo")
        try expect(WorkspacePathFormatter.lastTwoComponents("") == "")
    }

    private static func decodesCurrentUser() throws {
        let user = try JSONDecoder().decode(
            CurrentUser.self,
            from: Data(#"{"displayName":"Daron","email":"daron@example.com","provider":"github"}"#.utf8)
        )

        try expect(user.displayName == "Daron")
        try expect(user.email == "daron@example.com")
        try expect(user.provider == .github)

        let localUser = try JSONDecoder().decode(
            CurrentUser.self,
            from: Data(#"{"displayName":"Owner","email":"owner@example.com","provider":"local"}"#.utf8)
        )
        try expect(localUser.provider == .local)
    }

    private static func decodesBackends() throws {
        let response = try JSONDecoder().decode(
            BackendsResponse.self,
            from: Data("""
            {
              "backends": [
                {
                  "id": "claude-code",
                  "label": "Claude Code",
                  "icon": "claude",
                  "capabilities": {
                    "thinking": true,
                    "planMode": true,
                    "agents": true,
                    "toolActivity": true,
                    "userQuestions": true,
                    "stdinInput": true
                  },
                  "resumeCapabilities": {
                    "activeTurnResume": "unsupported",
                    "activeTurnResumeReason": "No active turn resume",
                    "sessionResume": "supported",
                    "sessionResumeReason": "Claude session resumes"
                  },
                  "models": [
                    {
                      "id": "claude-opus-4-7",
                      "label": "Opus 4.7",
                      "family": "claude",
                      "costTier": "high",
                      "default": true,
                      "supportedEffortLevels": ["high", "xhigh", "max"]
                    }
                  ]
                }
              ]
            }
            """.utf8)
        )

        try expect(response.backends.first?.label == "Claude Code")
        try expect(response.backends.first?.models?.first?.supportedEffortLevels == [.high, .xhigh, .max])
    }

    private static func decodesSettingsAndProfiles() throws {
        let settings = try JSONDecoder().decode(
            Settings.self,
            from: Data("""
            {
              "theme": "system",
              "sendBehavior": "enter",
              "systemPrompt": "",
              "defaultBackend": "claude-code",
              "defaultCliProfileId": "server-configured-claude-code",
              "cliProfiles": [
                {
                  "id": "server-configured-claude-code",
                  "name": "Claude Code (Server Configured)",
                  "vendor": "claude-code",
                  "authMode": "server-configured",
                  "createdAt": "2026-04-29T00:00:00.000Z",
                  "updatedAt": "2026-04-29T00:00:00.000Z"
                }
              ],
              "defaultModel": "claude-sonnet-4-6",
              "defaultEffort": "high"
            }
            """.utf8)
        )

        try expect(settings.defaultCliProfileId == "server-configured-claude-code")
        try expect(settings.cliProfiles?.first?.vendor == .claudeCode)
        try expect(settings.cliProfiles?.first?.authMode == .serverConfigured)
        try expect(settings.defaultEffort == .high)
    }


    private static func decodesSessionsAndQueue() throws {
        let sessions = try JSONDecoder().decode(
            SessionsResponse.self,
            from: Data("""
            {
              "sessions": [
                {
                  "number": 2,
                  "sessionId": "s2",
                  "startedAt": "2026-05-02T00:00:00.000Z",
                  "endedAt": null,
                  "messageCount": 1,
                  "summary": "Current work",
                  "isCurrent": true
                }
              ]
            }
            """.utf8)
        )
        let queue = try JSONDecoder().decode(QueueResponse.self, from: Data(#"{"queue":[{"content":"follow up"}]}"#.utf8))

        try expect(sessions.sessions.first?.number == 2)
        try expect(sessions.sessions.first?.summary == "Current work")
        try expect(queue.queue == [QueuedMessage(content: "follow up")])
    }

    private static func composesAttachmentWireContent() throws {
        let attachment = AttachmentMeta(
            name: "notes.txt",
            path: "/tmp/artifacts/c1/notes.txt",
            size: 5,
            kind: .text,
            meta: "1 lines"
        )

        try expect(QueuedMessage(content: "Read this", attachments: [attachment]).wireContent() == "Read this\n\n[Uploaded files: /tmp/artifacts/c1/notes.txt]")
        try expect(QueuedMessage(content: "", attachments: [attachment]).wireContent() == "[Uploaded files: /tmp/artifacts/c1/notes.txt]")
        try expect(QueuedMessage(content: "Plain").wireContent() == "Plain")
    }

    @MainActor
    private static func queueAutoDrainsAfterDoneFrame() async throws {
        let transport = MockTransport()
        transport.enqueue(json: #"{"displayName":null,"email":null,"provider":null}"#)
        transport.enqueue(json: #"{}"#)
        transport.enqueue(json: #"{"backends":[]}"#)
        transport.enqueue(json: #"{"ids":["c1"],"streams":[]}"#)
        transport.enqueue(json: """
        {
          "conversations": [
            {
              "id": "c1",
              "title": "Queued",
              "updatedAt": "2026-05-02T00:00:00.000Z",
              "backend": "codex",
              "workingDir": "/Users/daron/repo",
              "workspaceHash": "abc123",
              "workspaceKbEnabled": false,
              "messageCount": 0,
              "lastMessage": null,
              "usage": null
            }
          ]
        }
        """)
        transport.enqueue(json: """
        {
          "id": "c1",
          "title": "Queued",
          "backend": "codex",
          "workingDir": "/Users/daron/repo",
          "workspaceHash": "abc123",
          "currentSessionId": "s1",
          "sessionNumber": 1,
          "messages": [],
          "messageQueue": [
            { "content": "follow up" }
          ]
        }
        """)
        transport.enqueue(json: #"{"csrfToken":"queue-token"}"#)
        transport.enqueue(json: #"{"ok":true}"#)
        transport.enqueue(json: """
        {
          "userMessage": {
            "id": "m-drained",
            "role": "user",
            "content": "follow up",
            "backend": "codex",
            "timestamp": "2026-05-02T00:00:00.000Z"
          },
          "streamReady": false
        }
        """)

        let api = AgentCockpitAPI(transport: transport)
        let store = ConversationStore(
            api: api,
            streaming: MockStreaming(events: [.done])
        )

        await store.loadConversations()
        try expect(store.activeStreamIDs == ["c1"])
        await store.openConversation(id: "c1")
        try await Task.sleep(nanoseconds: 100_000_000)

        try expect(store.activeConversation?.messageQueue?.isEmpty == true)
        try expect(store.activeConversation?.messages.first?.id == "m-drained")
        try expect(transport.requests.contains { $0.url?.path == "/api/chat/active-streams" })
        try expect(transport.requests.contains { $0.url?.path == "/api/chat/conversations/c1/queue" && $0.httpMethod == "PUT" })
        try expect(transport.requests.contains { $0.url?.path == "/api/chat/conversations/c1/message" && $0.httpMethod == "POST" })
    }

    @MainActor
    private static func pendingInteractionBlocksQueueDrainUntilAnswered() async throws {
        let transport = MockTransport()
        transport.enqueue(json: #"{"displayName":null,"email":null,"provider":null}"#)
        transport.enqueue(json: #"{}"#)
        transport.enqueue(json: #"{"backends":[]}"#)
        transport.enqueue(json: #"{"ids":["c1"],"streams":[]}"#)
        transport.enqueue(json: """
        {
          "conversations": [
            {
              "id": "c1",
              "title": "Plan",
              "updatedAt": "2026-05-02T00:00:00.000Z",
              "backend": "codex",
              "workingDir": "/Users/daron/repo",
              "workspaceHash": "abc123",
              "workspaceKbEnabled": false,
              "messageCount": 0,
              "lastMessage": null,
              "usage": null
            }
          ]
        }
        """)
        transport.enqueue(json: """
        {
          "id": "c1",
          "title": "Plan",
          "backend": "codex",
          "workingDir": "/Users/daron/repo",
          "workspaceHash": "abc123",
          "currentSessionId": "s1",
          "sessionNumber": 1,
          "messages": [],
          "messageQueue": [
            { "content": "queued after plan" }
          ]
        }
        """)
        transport.enqueue(json: #"{"csrfToken":"input-token"}"#)
        transport.enqueue(json: #"{"mode":"stdin"}"#)

        let api = AgentCockpitAPI(transport: transport)
        let store = ConversationStore(
            api: api,
            streaming: MockStreaming(events: [
                .planApproval(planContent: "Review before running."),
                .done
            ])
        )

        await store.loadConversations()
        await store.openConversation(id: "c1")
        try await Task.sleep(nanoseconds: 100_000_000)

        try expect(store.pendingInteraction == .planApproval(planContent: "Review before running."))
        try expect(store.activeConversation?.messageQueue == [QueuedMessage(content: "queued after plan")])
        try expect(!transport.requests.contains { $0.url?.path == "/api/chat/conversations/c1/message" })

        await store.respondToPendingInteraction("yes")

        try expect(store.pendingInteraction == nil)
        try expect(transport.requests.contains { $0.url?.path == "/api/chat/conversations/c1/input" && $0.httpMethod == "POST" })
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ message: String = "Expectation failed") throws {
        if !condition() {
            throw SmokeTestError.failure(message)
        }
    }
}

private struct MockStreaming: ConversationStreaming {
    var events: [StreamEvent]

    func stream(conversationID: String) throws -> AsyncThrowingStream<StreamEvent, Error> {
        AsyncThrowingStream { continuation in
            Task {
                for event in events {
                    continuation.yield(event)
                }
                continuation.finish()
            }
        }
    }
}

private enum SmokeTestError: Error, CustomStringConvertible {
    case failure(String)

    var description: String {
        switch self {
        case .failure(let message):
            return message
        }
    }
}

private final class MockTransport: AgentHTTPTransport, @unchecked Sendable {
    struct Response {
        var data: Data
        var statusCode: Int
    }

    private(set) var requests: [URLRequest] = []
    private var responses: [Response] = []

    func enqueue(json: String, statusCode: Int = 200) {
        responses.append(Response(data: Data(json.utf8), statusCode: statusCode))
    }

    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        let response = responses.isEmpty ? Response(data: Data("{}".utf8), statusCode: 200) : responses.removeFirst()
        let http = HTTPURLResponse(
            url: request.url!,
            statusCode: response.statusCode,
            httpVersion: nil,
            headerFields: nil
        )!
        return (response.data, http)
    }
}
