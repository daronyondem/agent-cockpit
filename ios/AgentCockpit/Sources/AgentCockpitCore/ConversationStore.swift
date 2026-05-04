import Combine
import Foundation

@MainActor
public final class ConversationStore: ObservableObject {
    @Published public private(set) var conversations: [ConversationListItem] = []
    @Published public private(set) var listArchived: Bool = false
    @Published public private(set) var activeConversation: Conversation?
    @Published public private(set) var streamText: String = ""
    @Published public private(set) var isLoading: Bool = false
    @Published public private(set) var isStreaming: Bool = false
    @Published public private(set) var currentUser: CurrentUser?
    @Published public private(set) var sessions: [SessionHistoryItem] = []
    @Published public private(set) var sessionPreviewMessages: [Message] = []
    @Published public private(set) var explorerPath: String = ""
    @Published public private(set) var explorerParent: String?
    @Published public private(set) var explorerEntries: [ExplorerEntry] = []
    @Published public private(set) var explorerPreview: ExplorerPreviewResponse?
    @Published public private(set) var backends: [BackendMetadata] = []
    @Published public private(set) var settings: Settings?
    @Published public private(set) var activeStreamIDs: Set<String> = []
    @Published public private(set) var pendingInteraction: PendingInteraction?
    @Published public private(set) var respondPending: Bool = false
    @Published public private(set) var planModeActive: Bool = false
    @Published public private(set) var requiresAuthentication: Bool = false
    @Published public var selectedCliProfileId: String?
    @Published public var selectedBackend: String?
    @Published public var selectedModel: String?
    @Published public var selectedEffort: EffortLevel?
    @Published public private(set) var pendingAttachments: [PendingAttachment] = []
    @Published public var draft: String = ""
    @Published public var errorMessage: String?

    private var api: AgentCockpitAPI
    private var streaming: ConversationStreaming?
    private var streamTask: Task<Void, Never>?
    private let reducer = ConversationStreamReducer()
    private var profileMetadata: [String: BackendMetadata] = [:]
    private var isDrainingQueue = false

    public init(api: AgentCockpitAPI, streaming: ConversationStreaming? = nil) {
        self.api = api
        self.streaming = streaming
    }

    public convenience init(serverURL: URL) {
        let api = AgentCockpitAPI(configuration: AgentCockpitConfiguration(serverURL: serverURL))
        self.init(api: api, streaming: URLSessionConversationStreaming(api: api))
    }

    deinit {
        streamTask?.cancel()
    }

    public func loadConversations(search: String? = nil, archived: Bool? = nil) async {
        await perform {
            let archivedFlag = archived ?? listArchived
            listArchived = archivedFlag
            currentUser = try? await api.getCurrentUser()
            settings = try? await api.getSettings()
            if backends.isEmpty {
                backends = (try? await api.getBackends()) ?? []
            }
            let activeStreams = try? await api.getActiveStreams()
            activeStreamIDs = Set(activeStreams?.ids ?? [])
            conversations = try await api.listConversations(search: search, archived: archivedFlag)
        }
    }

    public func setArchivedListVisible(_ archived: Bool) async {
        activeConversation = nil
        await loadConversations(archived: archived)
    }

    public func reconnect(serverURL: URL) async {
        streamTask?.cancel()
        streamTask = nil
        streamText = ""
        isStreaming = false
        activeConversation = nil
        conversations = []
        activeStreamIDs = []
        listArchived = false
        settings = nil
        selectedCliProfileId = nil
        pendingInteraction = nil
        respondPending = false
        planModeActive = false
        requiresAuthentication = false
        profileMetadata = [:]

        let nextAPI = AgentCockpitAPI(configuration: AgentCockpitConfiguration(serverURL: serverURL))
        api = nextAPI
        streaming = URLSessionConversationStreaming(api: nextAPI)
        await loadConversations()
    }

    public func openConversation(id: String) async {
        streamTask?.cancel()
        streamText = ""
        sessions = []
        sessionPreviewMessages = []
        explorerPath = ""
        explorerParent = nil
        explorerEntries = []
        explorerPreview = nil
        pendingAttachments = []
        pendingInteraction = nil
        respondPending = false
        planModeActive = false
        await perform {
            activeConversation = try await api.getConversation(id: id)
            hydrateComposerSelection()
            try await hydrateSelectedProfileMetadataIfNeeded()
            reconcileSelectionWithCurrentMetadata()
            if activeStreamIDs.contains(id) {
                startStream(conversationID: id)
            }
        }
    }

    public func loadExplorer(path: String = "") async {
        guard let workspaceHash = activeConversation?.workspaceHash else {
            return
        }

        await perform {
            let response = try await api.getExplorerTree(workspaceHash: workspaceHash, path: path)
            explorerPath = response.path
            explorerParent = response.parent
            explorerEntries = response.entries
            explorerPreview = nil
        }
    }

    public func openExplorerEntry(_ entry: ExplorerEntry) async {
        let entryPath = joinedExplorerPath(base: explorerPath, name: entry.name)
        switch entry.type {
        case .dir:
            await loadExplorer(path: entryPath)
        case .file:
            await previewExplorerFile(path: entryPath)
        }
    }

    public func openExplorerParent() async {
        await loadExplorer(path: explorerParent ?? "")
    }

    public func previewExplorerFile(path: String) async {
        guard let workspaceHash = activeConversation?.workspaceHash else {
            return
        }

        await perform {
            explorerPreview = try await api.getExplorerPreview(workspaceHash: workspaceHash, path: path)
        }
    }

    public func createConversation(title: String? = nil, workingDirectory: String? = nil) async {
        let trimmedTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedWorkingDirectory = workingDirectory?.trimmingCharacters(in: .whitespacesAndNewlines)

        await perform {
            if settings == nil {
                settings = try? await api.getSettings()
            }
            let cliProfileId = settings?.defaultCliProfileId
            let conversation = try await api.createConversation(
                title: trimmedTitle?.isEmpty == false ? trimmedTitle : nil,
                workingDir: trimmedWorkingDirectory?.isEmpty == false ? trimmedWorkingDirectory : nil,
                backend: cliProfileId == nil ? settings?.defaultBackend : nil,
                cliProfileId: cliProfileId,
                model: settings?.defaultModel,
                effort: settings?.defaultEffort
            )
            activeConversation = conversation
            conversations = try await api.listConversations()
            hydrateComposerSelection()
            try await hydrateSelectedProfileMetadataIfNeeded()
            reconcileSelectionWithCurrentMetadata()
        }
    }

    public func renameActiveConversation(title: String) async {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let conversationID = activeConversation?.id, !trimmed.isEmpty else {
            return
        }

        await perform {
            let renamed = try await api.renameConversation(id: conversationID, title: trimmed)
            activeConversation = renamed
            if let index = conversations.firstIndex(where: { $0.id == conversationID }) {
                conversations[index].title = renamed.title
            }
        }
    }

    public func archiveActiveConversation() async {
        guard let conversationID = activeConversation?.id, !isStreaming else {
            return
        }

        await perform {
            _ = try await api.archiveConversation(id: conversationID)
            activeConversation = nil
            streamText = ""
            sessions = []
            sessionPreviewMessages = []
            pendingAttachments = []
            pendingInteraction = nil
            respondPending = false
            planModeActive = false
            conversations = try await api.listConversations(archived: listArchived)
        }
    }

    public func restoreActiveConversation() async {
        guard let conversationID = activeConversation?.id, !isStreaming else {
            return
        }

        await perform {
            _ = try await api.restoreConversation(id: conversationID)
            activeConversation = nil
            streamText = ""
            sessions = []
            sessionPreviewMessages = []
            pendingAttachments = []
            pendingInteraction = nil
            respondPending = false
            planModeActive = false
            conversations = try await api.listConversations(archived: listArchived)
        }
    }

    public func deleteActiveConversation() async {
        guard let conversationID = activeConversation?.id, !isStreaming else {
            return
        }

        await perform {
            _ = try await api.deleteConversation(id: conversationID)
            activeConversation = nil
            streamText = ""
            sessions = []
            sessionPreviewMessages = []
            pendingAttachments = []
            pendingInteraction = nil
            respondPending = false
            planModeActive = false
            conversations = try await api.listConversations(archived: listArchived)
        }
    }

    public func sendDraft() async {
        guard pendingInteraction == nil else {
            errorMessage = "Answer the prompt above to continue."
            return
        }
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let attachments = completedAttachmentMetas()
        guard (!trimmed.isEmpty || !attachments.isEmpty), let conversationID = activeConversation?.id else {
            return
        }
        guard !hasUploadingAttachments else {
            errorMessage = "Wait for attachments to finish uploading."
            return
        }

        if isStreaming {
            await enqueueDraft()
            return
        }

        draft = ""
        await perform {
            let backend = selectedBackend
            let cliProfileId = selectedCliProfileId
            let model = selectedModel
            let effort = selectedEffort
            let message = QueuedMessage(
                content: trimmed,
                attachments: attachments.isEmpty ? nil : attachments
            )
            let response = try await api.sendMessage(
                conversationID: conversationID,
                content: message.wireContent(),
                backend: backend,
                cliProfileId: cliProfileId,
                model: model,
                effort: effort
            )
            activeConversation?.messages.append(response.userMessage)
            draft = ""
            pendingAttachments = []
            if response.streamReady {
                startStream(conversationID: conversationID)
            }
        }
    }

    public func loadSessions() async {
        guard let conversationID = activeConversation?.id else {
            return
        }

        await perform {
            sessions = try await api.getSessions(conversationID: conversationID)
            sessionPreviewMessages = []
        }
    }

    public var selectedBackendMetadata: BackendMetadata? {
        if let selectedCliProfileId, let metadata = profileMetadata[selectedCliProfileId] {
            return metadata
        }
        guard let selectedBackend else {
            return nil
        }
        return backends.first { $0.id == selectedBackend }
    }

    public var selectedModelMetadata: ModelOption? {
        guard let selectedModel else {
            return nil
        }
        return selectedBackendMetadata?.models?.first { $0.id == selectedModel }
    }

    public var supportedEffortsForSelection: [EffortLevel] {
        selectedModelMetadata?.supportedEffortLevels ?? []
    }

    public var availableCliProfiles: [CliProfile] {
        (settings?.cliProfiles ?? []).filter { $0.disabled != true }
    }

    public var profileSelectionLocked: Bool {
        activeConversation?.messages.isEmpty == false
    }

    public var selectedCliProfile: CliProfile? {
        guard let selectedCliProfileId else {
            return nil
        }
        return availableCliProfiles.first { $0.id == selectedCliProfileId }
    }

    public func setSelectedBackend(_ backendID: String) {
        guard !profileSelectionLocked else {
            return
        }
        selectedCliProfileId = nil
        selectedBackend = backendID
        let backend = backends.first { $0.id == backendID }
        selectedModel = backend?.models?.first(where: { $0.default == true })?.id ?? backend?.models?.first?.id
        let supportedEfforts = backend?.models?.first { $0.id == selectedModel }?.supportedEffortLevels ?? []
        selectedEffort = supportedEfforts.contains(.high) ? .high : supportedEfforts.first
    }

    public func setSelectedCliProfile(_ profileID: String) async {
        guard !profileSelectionLocked, let profile = availableCliProfiles.first(where: { $0.id == profileID }) else {
            return
        }

        await perform {
            selectedCliProfileId = profile.id
            selectedBackend = profile.vendor.rawValue
            selectedModel = nil
            selectedEffort = nil
            try await hydrateSelectedProfileMetadataIfNeeded()
            reconcileSelectionWithCurrentMetadata()
        }
    }

    public func setSelectedModel(_ modelID: String?) {
        selectedModel = modelID
        let supportedEfforts = selectedBackendMetadata?.models?.first { $0.id == modelID }?.supportedEffortLevels ?? []
        if let selectedEffort, supportedEfforts.contains(selectedEffort) {
            return
        }
        self.selectedEffort = supportedEfforts.contains(.high) ? .high : supportedEfforts.first
    }

    public func setSelectedEffort(_ effort: EffortLevel?) {
        selectedEffort = effort
    }

    public func previewSession(_ session: SessionHistoryItem) async {
        guard let conversationID = activeConversation?.id else {
            return
        }

        await perform {
            if session.isCurrent {
                sessionPreviewMessages = activeConversation?.messages ?? []
            } else {
                sessionPreviewMessages = try await api.getSessionMessages(
                    conversationID: conversationID,
                    sessionNumber: session.number
                )
            }
        }
    }

    public func resetSession() async {
        guard let conversationID = activeConversation?.id, !isStreaming else {
            return
        }

        await perform {
            let response = try await api.resetConversation(id: conversationID)
            activeConversation = response.conversation
            sessions = []
            sessionPreviewMessages = []
            streamText = ""
            pendingInteraction = nil
            respondPending = false
            planModeActive = false
        }
    }

    public func refreshQueue() async {
        guard let conversationID = activeConversation?.id else {
            return
        }

        await perform {
            activeConversation?.messageQueue = try await api.getQueue(conversationID: conversationID)
        }
    }

    public func enqueueDraft() async {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let attachments = completedAttachmentMetas()
        guard (!trimmed.isEmpty || !attachments.isEmpty), let conversationID = activeConversation?.id else {
            return
        }
        guard !hasUploadingAttachments else {
            errorMessage = "Wait for attachments to finish uploading."
            return
        }

        await perform {
            var queue = activeConversation?.messageQueue ?? []
            queue.append(QueuedMessage(content: trimmed, attachments: attachments.isEmpty ? nil : attachments))
            activeConversation?.messageQueue = try await api.saveQueue(conversationID: conversationID, queue: queue)
            draft = ""
            pendingAttachments = []
        }
    }

    public var hasUploadingAttachments: Bool {
        pendingAttachments.contains { attachment in
            if case .uploading = attachment.status {
                return true
            }
            return false
        }
    }

    public func uploadAttachment(fileURL: URL) async {
        guard let conversationID = activeConversation?.id else {
            return
        }

        let fileName = fileURL.lastPathComponent.isEmpty ? "attachment" : fileURL.lastPathComponent
        let attachmentID = UUID()
        pendingAttachments.append(PendingAttachment(id: attachmentID, fileName: fileName, status: .uploading))

        do {
            let didStartAccessing = fileURL.startAccessingSecurityScopedResource()
            defer {
                if didStartAccessing {
                    fileURL.stopAccessingSecurityScopedResource()
                }
            }
            let data = try Data(contentsOf: fileURL)
            let result = try await api.uploadFile(conversationID: conversationID, fileName: fileName, data: data)
            updatePendingAttachment(id: attachmentID, status: .done, result: result)
        } catch {
            updatePendingAttachment(id: attachmentID, status: .error(error.localizedDescription), result: nil)
        }
    }

    public func removePendingAttachment(id: UUID) async {
        guard let index = pendingAttachments.firstIndex(where: { $0.id == id }) else {
            return
        }
        let attachment = pendingAttachments.remove(at: index)
        guard let name = attachment.result?.name, let conversationID = activeConversation?.id else {
            return
        }
        _ = try? await api.deleteUpload(conversationID: conversationID, filename: name)
    }

    public func removeQueuedMessage(at index: Int) async {
        guard let conversationID = activeConversation?.id else {
            return
        }

        await perform {
            var queue = activeConversation?.messageQueue ?? []
            guard queue.indices.contains(index) else {
                return
            }
            queue.remove(at: index)
            activeConversation?.messageQueue = try await api.saveQueue(conversationID: conversationID, queue: queue)
        }
    }

    public func clearQueue() async {
        guard let conversationID = activeConversation?.id else {
            return
        }

        await perform {
            _ = try await api.clearQueue(conversationID: conversationID)
            activeConversation?.messageQueue = []
        }
    }

    public func stopStream() async {
        guard let conversationID = activeConversation?.id else {
            return
        }
        streamTask?.cancel()
        streamTask = nil
        isStreaming = false
        pendingInteraction = nil
        respondPending = false
        planModeActive = false
        await perform {
            _ = try await api.abortConversation(id: conversationID)
            activeConversation = try await api.getConversation(id: conversationID)
            activeStreamIDs.remove(conversationID)
        }
    }

    public var activeUsage: Usage? {
        activeConversation?.sessionUsage ?? activeConversation?.usage
    }

    public func respondToPendingInteraction(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard
            !trimmed.isEmpty,
            !respondPending,
            pendingInteraction != nil,
            let conversationID = activeConversation?.id
        else {
            return
        }

        respondPending = true
        do {
            let response = try await api.sendInput(
                conversationID: conversationID,
                text: trimmed,
                streamActive: isStreaming || isLoading
            )
            pendingInteraction = nil
            respondPending = false

            if response.mode == .message {
                try await sendInteractionAsMessage(trimmed, conversationID: conversationID)
            }
        } catch {
            respondPending = false
            errorMessage = error.localizedDescription
        }
    }

    private func drainNextQueuedMessageIfNeeded() async {
        guard
            !isDrainingQueue,
            !isStreaming,
            pendingInteraction == nil,
            let conversationID = activeConversation?.id,
            var queue = activeConversation?.messageQueue,
            !queue.isEmpty
        else {
            return
        }

        isDrainingQueue = true
        isLoading = true
        errorMessage = nil
        defer {
            isDrainingQueue = false
            isLoading = false
        }

        let originalQueue = queue
        let nextMessage = queue.removeFirst()
        do {
            activeConversation?.messageQueue = try await api.saveQueue(conversationID: conversationID, queue: queue)
            let response = try await api.sendMessage(
                conversationID: conversationID,
                content: nextMessage.wireContent(),
                backend: selectedBackend,
                cliProfileId: selectedCliProfileId,
                model: selectedModel,
                effort: selectedEffort
            )
            activeConversation?.messages.append(response.userMessage)
            if response.streamReady {
                startStream(conversationID: conversationID)
            }
        } catch {
            activeConversation?.messageQueue = (try? await api.saveQueue(conversationID: conversationID, queue: originalQueue)) ?? originalQueue
            errorMessage = error.localizedDescription
        }
    }

    private func sendInteractionAsMessage(_ content: String, conversationID: String) async throws {
        let response = try await api.sendMessage(
            conversationID: conversationID,
            content: content,
            backend: selectedBackend,
            cliProfileId: selectedCliProfileId,
            model: selectedModel,
            effort: selectedEffort
        )
        activeConversation?.messages.append(response.userMessage)
        if response.streamReady {
            startStream(conversationID: conversationID)
        }
    }

    private func startStream(conversationID: String) {
        guard let streaming else {
            return
        }

        streamTask?.cancel()
        streamText = ""
        isStreaming = true
        activeStreamIDs.insert(conversationID)
        streamTask = Task { [weak self] in
            guard let self else { return }
            do {
                let events = try streaming.stream(conversationID: conversationID)
                for try await event in events {
                    apply(event)
                }
            } catch {
                await MainActor.run {
                    self.errorMessage = error.localizedDescription
                    self.isStreaming = false
                }
            }
        }
    }

    private func hydrateComposerSelection() {
        guard let conversation = activeConversation else {
            selectedCliProfileId = nil
            selectedBackend = nil
            selectedModel = nil
            selectedEffort = nil
            return
        }

        selectedCliProfileId = profileSelectionLocked
            ? conversation.cliProfileId
            : (conversation.cliProfileId ?? settings?.defaultCliProfileId)
        if let profile = selectedCliProfile {
            selectedBackend = profile.vendor.rawValue
        } else {
            selectedBackend = conversation.backend
        }
        selectedModel = conversation.model
        selectedEffort = conversation.effort
    }

    private func hydrateSelectedProfileMetadataIfNeeded() async throws {
        guard let selectedCliProfileId, profileMetadata[selectedCliProfileId] == nil else {
            return
        }
        profileMetadata[selectedCliProfileId] = try await api.getCliProfileMetadata(profileID: selectedCliProfileId)
    }

    private func reconcileSelectionWithCurrentMetadata() {
        guard let backend = selectedBackendMetadata else {
            return
        }

        if let models = backend.models, !models.isEmpty {
            if let selectedModel, models.contains(where: { $0.id == selectedModel }) {
                // Keep the current model.
            } else if let defaultModel = settings?.defaultModel, models.contains(where: { $0.id == defaultModel }) {
                selectedModel = defaultModel
            } else {
                selectedModel = models.first(where: { $0.default == true })?.id ?? models.first?.id
            }
        } else {
            selectedModel = nil
        }

        let supportedEfforts = backend.models?.first(where: { $0.id == selectedModel })?.supportedEffortLevels ?? []
        if supportedEfforts.isEmpty {
            selectedEffort = nil
        } else if let selectedEffort, supportedEfforts.contains(selectedEffort) {
            return
        } else if
            let defaultEffort = settings?.defaultEffort,
            selectedModel == settings?.defaultModel,
            supportedEfforts.contains(defaultEffort)
        {
            selectedEffort = defaultEffort
        } else {
            selectedEffort = supportedEfforts.contains(.high) ? .high : supportedEfforts.first
        }
    }

    private func completedAttachmentMetas() -> [AttachmentMeta] {
        pendingAttachments.compactMap { attachment in
            guard case .done = attachment.status else {
                return nil
            }
            return attachment.result
        }
    }

    private func updatePendingAttachment(id: UUID, status: PendingAttachment.Status, result: AttachmentMeta?) {
        guard let index = pendingAttachments.firstIndex(where: { $0.id == id }) else {
            return
        }
        pendingAttachments[index].status = status
        pendingAttachments[index].result = result
    }

    private func joinedExplorerPath(base: String, name: String) -> String {
        let trimmedBase = base.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if trimmedBase.isEmpty {
            return name
        }
        return "\(trimmedBase)/\(name)"
    }

    private func apply(_ event: StreamEvent) {
        let conversationID = activeConversation?.id
        switch event {
        case .usage(let usage, let sessionUsage):
            activeConversation?.usage = usage
            if let sessionUsage {
                activeConversation?.sessionUsage = sessionUsage
            }
        case .planModeChanged(let active):
            planModeActive = active
        case .planApproval(let planContent):
            pendingInteraction = .planApproval(planContent: planContent)
            planModeActive = false
        case .userQuestion(let question):
            pendingInteraction = .userQuestion(
                question: question.question,
                options: question.options ?? []
            )
        case .error:
            pendingInteraction = nil
            respondPending = false
            planModeActive = false
        case .done:
            planModeActive = false
        default:
            break
        }

        var state = ConversationStreamState(
            title: activeConversation?.title,
            messages: activeConversation?.messages ?? [],
            streamText: streamText,
            isStreaming: isStreaming,
            errorMessage: errorMessage
        )
        reducer.reduce(&state, event: event)
        activeConversation?.title = state.title ?? activeConversation?.title ?? ""
        activeConversation?.messages = state.messages
        streamText = state.streamText
        isStreaming = state.isStreaming
        errorMessage = state.errorMessage
        if let conversationID {
            if state.isStreaming {
                activeStreamIDs.insert(conversationID)
            } else {
                activeStreamIDs.remove(conversationID)
            }
        }
        if case .done = event, pendingInteraction == nil, errorMessage == nil {
            Task { await drainNextQueuedMessageIfNeeded() }
        }
    }

    private func perform(_ operation: () async throws -> Void) async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            try await operation()
            requiresAuthentication = false
        } catch {
            if case AgentAPIError.httpStatus(401, _) = error {
                requiresAuthentication = true
                errorMessage = nil
            } else {
                errorMessage = error.localizedDescription
            }
        }
    }
}
