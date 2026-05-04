import AgentCockpitCore
import AuthenticationServices
import Foundation
import SwiftUI
import UniformTypeIdentifiers
#if os(iOS)
@preconcurrency import AVFoundation
#endif
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

public struct AgentCockpitRootView: View {
    @StateObject private var settings: AgentCockpitSettingsStore
    @StateObject private var store: ConversationStore
    @State private var connectionPresented: Bool
    @State private var settingsPresented = false
    @State private var newConversationPresented = false

    public init(serverURL: URL = AgentCockpitConfiguration.defaultServerURL) {
        let settings = AgentCockpitSettingsStore(initialServerURL: serverURL)
        _settings = StateObject(wrappedValue: settings)
        _store = StateObject(wrappedValue: ConversationStore(serverURL: settings.serverURL))
        _connectionPresented = State(initialValue: !settings.hasSavedServerURL)
    }

    public var body: some View {
        NavigationSplitView {
            List(store.conversations, selection: conversationSelection) { conversation in
                ConversationRow(
                    conversation: conversation,
                    isStreaming: store.activeStreamIDs.contains(conversation.id)
                )
                    .tag(conversation.id)
            }
            .safeAreaInset(edge: .bottom) {
                CurrentUserFooter(user: store.currentUser)
            }
            .navigationTitle(store.listArchived ? "Archived" : "Agent Cockpit")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        newConversationPresented = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("New conversation")
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        Task { await store.setArchivedListVisible(!store.listArchived) }
                    } label: {
                        Image(systemName: store.listArchived ? "tray.full" : "archivebox")
                    }
                    .accessibilityLabel(store.listArchived ? "Show active conversations" : "Show archived conversations")
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        settingsPresented = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("Settings")
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        Task { await store.loadConversations() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .accessibilityLabel("Refresh conversations")
                }
            }
        } detail: {
            ChatDetailView(store: store)
        }
        .task {
            if settings.hasSavedServerURL {
                await store.loadConversations()
            }
        }
        .onChange(of: store.requiresAuthentication) { _, requiresAuthentication in
            if requiresAuthentication {
                settingsPresented = false
                connectionPresented = true
            }
        }
        .sheet(isPresented: $connectionPresented) {
            ServerSettingsView(
                title: "Connect",
                showsCancelButton: false,
                settings: settings
            ) { url in
                Task {
                    await store.reconnect(serverURL: url)
                }
                connectionPresented = false
            }
            .interactiveDismissDisabled()
        }
        .sheet(isPresented: $settingsPresented) {
            ServerSettingsView(title: "Server", showsCancelButton: true, settings: settings) { url in
                Task {
                    await store.reconnect(serverURL: url)
                }
            }
        }
        .sheet(isPresented: $newConversationPresented) {
            NewConversationView(store: store)
        }
        .alert("Agent Cockpit", isPresented: errorPresented) {
            Button("OK", role: .cancel) {
                store.errorMessage = nil
            }
        } message: {
            Text(store.errorMessage ?? "")
        }
    }

    private var conversationSelection: Binding<String?> {
        Binding(
            get: { store.activeConversation?.id },
            set: { id in
                guard let id else { return }
                Task { await store.openConversation(id: id) }
            }
        )
    }

    private var errorPresented: Binding<Bool> {
        Binding(
            get: { store.errorMessage != nil },
            set: { isPresented in
                if !isPresented {
                    store.errorMessage = nil
                }
            }
        )
    }
}

private struct NewConversationView: View {
    @ObservedObject var store: ConversationStore
    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var workingDirectory: String

    init(store: ConversationStore) {
        self.store = store
        _title = State(initialValue: "")
        _workingDirectory = State(initialValue: store.settings?.workingDirectory ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Title", text: $title)
                    #if os(iOS)
                    TextField("Working directory", text: $workingDirectory)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    #else
                    TextField("Working directory", text: $workingDirectory)
                        .textFieldStyle(.roundedBorder)
                    #endif
                } footer: {
                    Text("Leave blank to use the server default workspace.")
                }

                if let profile = store.availableCliProfiles.first(where: { $0.id == store.settings?.defaultCliProfileId }) {
                    Section("Default Profile") {
                        Label(profile.name, systemImage: "person.text.rectangle")
                    }
                }
            }
            .navigationTitle("New Conversation")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        Task {
                            await store.createConversation(title: title, workingDirectory: workingDirectory)
                            if store.errorMessage == nil {
                                dismiss()
                            }
                        }
                    }
                    .disabled(store.isLoading)
                }
            }
        }
    }
}

private struct CurrentUserFooter: View {
    var user: CurrentUser?

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "person.crop.circle")
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(user?.displayName ?? "Local session")
                    .font(.caption)
                    .lineLimit(1)
                Text(user?.email ?? "localhost bypass")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
        }
        .padding(10)
        .background(.bar)
    }
}

@MainActor
private final class AgentCockpitSettingsStore: ObservableObject {
    private static let serverURLKey = "agentCockpit.serverURL"

    @Published var serverURLString: String
    @Published private(set) var hasSavedServerURL: Bool

    var serverURL: URL {
        (try? AgentCockpitConfiguration.parseServerURL(serverURLString)) ?? AgentCockpitConfiguration.defaultServerURL
    }

    init(initialServerURL: URL) {
        let saved = UserDefaults.standard.string(forKey: Self.serverURLKey)
        serverURLString = saved ?? initialServerURL.absoluteString
        hasSavedServerURL = saved != nil
    }

    func save() throws -> URL {
        let url = try AgentCockpitConfiguration.parseServerURL(serverURLString)
        serverURLString = url.absoluteString
        UserDefaults.standard.set(url.absoluteString, forKey: Self.serverURLKey)
        hasSavedServerURL = true
        return url
    }
}

private struct ServerSettingsView: View {
    var title: String
    var showsCancelButton: Bool
    @ObservedObject var settings: AgentCockpitSettingsStore
    var onSave: (URL) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var authContextProvider = MobileAuthPresentationContextProvider()
    @State private var authSession: ASWebAuthenticationSession?
    @State private var authInProgress = false
    @State private var authStatusMessage: String?
    @State private var pairingChallengeId = ""
    @State private var pairingCode = ""
    @State private var pairingInProgress = false
    @State private var qrScannerPresented = false
    @State private var validationError: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    #if os(iOS)
                    TextField("Server URL", text: $settings.serverURLString)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    #else
                    TextField("Server URL", text: $settings.serverURLString)
                        .textFieldStyle(.roundedBorder)
                    #endif
                } footer: {
                    Text("Use http://localhost:3334 in the simulator. On a physical iPhone, use the Cloudflare tunnel domain or the Mac's LAN address.")
                }

                Section {
                    Button {
                        startWebSignIn()
                    } label: {
                        Label(authInProgress ? "Signing in..." : "Sign in with Passkey or Password", systemImage: "person.badge.key")
                    }
                    .disabled(authInProgress)

                    if let authStatusMessage {
                        Text(authStatusMessage)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                } header: {
                    Text("Authentication")
                } footer: {
                    Text("Remote iPhone testing uses the same first-party login and session policy as the selected backend.")
                }

                Section {
                    #if os(iOS)
                    Button {
                        qrScannerPresented = true
                    } label: {
                        Label("Scan QR Code", systemImage: "qrcode.viewfinder")
                    }
                    .disabled(pairingInProgress)
                    #endif
                    #if os(iOS)
                    TextField("Challenge ID", text: $pairingChallengeId)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("Pairing code", text: $pairingCode)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                    #else
                    TextField("Challenge ID", text: $pairingChallengeId)
                        .textFieldStyle(.roundedBorder)
                    TextField("Pairing code", text: $pairingCode)
                        .textFieldStyle(.roundedBorder)
                    #endif
                    Button {
                        pairWithCode()
                    } label: {
                        Label(pairingInProgress ? "Pairing..." : "Pair Device", systemImage: "link.badge.plus")
                    }
                    .disabled(pairingInProgress || pairingChallengeId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || pairingCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                } header: {
                    Text("Mobile Pairing")
                }

                if let validationError {
                    Section {
                        Text(validationError)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle(title)
            .toolbar {
                if showsCancelButton {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") {
                            dismiss()
                        }
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        do {
                            let url = try settings.save()
                            validationError = nil
                            onSave(url)
                            dismiss()
                        } catch {
                            validationError = error.localizedDescription
                        }
                    }
                }
            }
        }
        #if os(iOS)
        .sheet(isPresented: $qrScannerPresented) {
            NavigationStack {
                PairingQRCodeScannerView { result in
                    handleScannedPairingResult(result)
                }
                .ignoresSafeArea()
                .navigationTitle("Scan Pairing Code")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") {
                            qrScannerPresented = false
                        }
                    }
                }
            }
        }
        #endif
    }

    private func startWebSignIn() {
        do {
            let serverURL = try settings.save()
            let api = AgentCockpitAPI(configuration: AgentCockpitConfiguration(serverURL: serverURL))
            let loginURL = try api.mobileWebLoginURL()
            validationError = nil
            authStatusMessage = nil
            authInProgress = true

            let session = ASWebAuthenticationSession(
                url: loginURL,
                callbackURLScheme: AgentCockpitConfiguration.mobileAuthCallbackScheme
            ) { callbackURL, error in
                if let error {
                    Task { @MainActor in
                        authInProgress = false
                        authSession = nil
                        authStatusMessage = nil
                        validationError = error.localizedDescription
                    }
                    return
                }

                guard let code = callbackCode(from: callbackURL) else {
                    Task { @MainActor in
                        authInProgress = false
                        authSession = nil
                        validationError = "Sign-in did not return a mobile auth code."
                    }
                    return
                }

                Task {
                    do {
                        let response = try await api.exchangeMobileAuthCode(code)
                        await MainActor.run {
                            authInProgress = false
                            authSession = nil
                            authStatusMessage = "Signed in as \(response.user.displayName ?? response.user.email ?? "Agent Cockpit user")."
                            validationError = nil
                            onSave(serverURL)
                            dismiss()
                        }
                    } catch {
                        await MainActor.run {
                            authInProgress = false
                            authSession = nil
                            authStatusMessage = nil
                            validationError = error.localizedDescription
                        }
                    }
                }
            }
            session.presentationContextProvider = authContextProvider
            session.prefersEphemeralWebBrowserSession = false
            authSession = session
            if !session.start() {
                authInProgress = false
                authSession = nil
                validationError = "Sign-in could not be started."
            }
        } catch {
            authInProgress = false
            authSession = nil
            validationError = error.localizedDescription
        }
    }

    private func pairWithCode(challengeId scannedChallengeId: String? = nil, code scannedCode: String? = nil) {
        let challengeId = (scannedChallengeId ?? pairingChallengeId).trimmingCharacters(in: .whitespacesAndNewlines)
        let code = (scannedCode ?? pairingCode).trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let serverURL = try settings.save()
            let api = AgentCockpitAPI(configuration: AgentCockpitConfiguration(serverURL: serverURL))
            validationError = nil
            authStatusMessage = nil
            pairingInProgress = true

            Task {
                do {
                    let response = try await api.exchangeMobilePairingCode(challengeId: challengeId, code: code)
                    await MainActor.run {
                        pairingInProgress = false
                        pairingChallengeId = ""
                        pairingCode = ""
                        authStatusMessage = "Paired as \(response.user.displayName ?? response.user.email ?? "Agent Cockpit user")."
                        validationError = nil
                        onSave(serverURL)
                        dismiss()
                    }
                } catch {
                    await MainActor.run {
                        pairingInProgress = false
                        authStatusMessage = nil
                        validationError = error.localizedDescription
                    }
                }
            }
        } catch {
            pairingInProgress = false
            validationError = error.localizedDescription
        }
    }

    #if os(iOS)
    private func handleScannedPairingResult(_ result: Result<String, Error>) {
        qrScannerPresented = false
        switch result {
        case .success(let rawValue):
            do {
                let link = try MobilePairingDeepLink(rawValue: rawValue)
                settings.serverURLString = link.serverURL.absoluteString
                pairingChallengeId = link.challengeId
                pairingCode = link.code
                validationError = nil
                authStatusMessage = "Pairing code scanned."
                pairWithCode(challengeId: link.challengeId, code: link.code)
            } catch {
                authStatusMessage = nil
                validationError = error.localizedDescription
            }
        case .failure(let error):
            authStatusMessage = nil
            validationError = error.localizedDescription
        }
    }
    #endif

    private func callbackCode(from callbackURL: URL?) -> String? {
        guard
            let callbackURL,
            let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)
        else {
            return nil
        }
        return components.queryItems?.first { $0.name == "code" }?.value
    }
}

#if os(iOS)
private enum PairingQRCodeScannerError: Error, LocalizedError {
    case cameraUnavailable
    case cameraAccessDenied
    case scannerUnavailable

    var errorDescription: String? {
        switch self {
        case .cameraUnavailable:
            return "This device does not have an available camera."
        case .cameraAccessDenied:
            return "Camera access is required to scan pairing QR codes."
        case .scannerUnavailable:
            return "The camera could not start QR code scanning."
        }
    }
}

private struct PairingQRCodeScannerView: UIViewControllerRepresentable {
    var onResult: (Result<String, Error>) -> Void

    func makeUIViewController(context: Context) -> PairingQRCodeScannerViewController {
        PairingQRCodeScannerViewController(onResult: onResult)
    }

    func updateUIViewController(_ uiViewController: PairingQRCodeScannerViewController, context: Context) {}
}

private final class PairingQRCodeScannerViewController: UIViewController, @preconcurrency AVCaptureMetadataOutputObjectsDelegate {
    private let session = AVCaptureSession()
    private let captureQueue = DispatchQueue(label: "com.agentcockpit.mobilePairingScanner")
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var didReturnResult = false
    private let onResult: (Result<String, Error>) -> Void

    init(onResult: @escaping (Result<String, Error>) -> Void) {
        self.onResult = onResult
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        prepareCamera()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        setSessionRunning(false)
    }

    private func prepareCamera() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            configureSession()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    if granted {
                        self?.configureSession()
                    } else {
                        self?.finish(.failure(PairingQRCodeScannerError.cameraAccessDenied))
                    }
                }
            }
        default:
            finish(.failure(PairingQRCodeScannerError.cameraAccessDenied))
        }
    }

    private func configureSession() {
        guard let device = AVCaptureDevice.default(for: .video) else {
            finish(.failure(PairingQRCodeScannerError.cameraUnavailable))
            return
        }

        do {
            let input = try AVCaptureDeviceInput(device: device)
            guard session.canAddInput(input) else {
                finish(.failure(PairingQRCodeScannerError.scannerUnavailable))
                return
            }
            session.addInput(input)

            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else {
                finish(.failure(PairingQRCodeScannerError.scannerUnavailable))
                return
            }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]

            let layer = AVCaptureVideoPreviewLayer(session: session)
            layer.videoGravity = .resizeAspectFill
            layer.frame = view.bounds
            view.layer.addSublayer(layer)
            previewLayer = layer
            setSessionRunning(true)
        } catch {
            finish(.failure(error))
        }
    }

    private func setSessionRunning(_ running: Bool) {
        let captureSession = session
        captureQueue.async {
            if running, !captureSession.isRunning {
                captureSession.startRunning()
            } else if !running, captureSession.isRunning {
                captureSession.stopRunning()
            }
        }
    }

    private func finish(_ result: Result<String, Error>) {
        guard !didReturnResult else {
            return
        }
        didReturnResult = true
        setSessionRunning(false)
        onResult(result)
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard
            let object = metadataObjects.compactMap({ $0 as? AVMetadataMachineReadableCodeObject }).first,
            object.type == .qr,
            let value = object.stringValue
        else {
            return
        }
        finish(.success(value))
    }
}
#endif

private final class MobileAuthPresentationContextProvider: NSObject, ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        #if canImport(UIKit)
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.flatMap(\.windows).first { $0.isKeyWindow } ?? ASPresentationAnchor()
        #elseif canImport(AppKit)
        return NSApplication.shared.windows.first ?? ASPresentationAnchor()
        #else
        return ASPresentationAnchor()
        #endif
    }
}

private struct ConversationRow: View {
    var conversation: ConversationListItem
    var isStreaming: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(conversation.title)
                    .font(.headline)
                    .lineLimit(1)
                if isStreaming {
                    ProgressView()
                        .controlSize(.mini)
                }
                if conversation.unread == true {
                    Circle()
                        .fill(Color.accentColor)
                        .frame(width: 7, height: 7)
                }
            }
            Text(WorkspacePathFormatter.lastTwoComponents(conversation.workingDir))
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            if let lastMessage = conversation.lastMessage, !lastMessage.isEmpty {
                Text(lastMessage)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 4)
    }
}

private struct ChatDetailView: View {
    @ObservedObject var store: ConversationStore
    @State private var sessionsPresented = false
    @State private var filesPresented = false
    @State private var resetConfirmationPresented = false
    @State private var renamePresented = false
    @State private var deleteConfirmationPresented = false

    var body: some View {
        VStack(spacing: 0) {
            if let conversation = store.activeConversation {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 12) {
                            ForEach(conversation.messages) { message in
                                MessageBubble(message: message)
                                    .id(message.id)
                            }
                            if !store.streamText.isEmpty {
                                MessageBubble(
                                    message: Message(
                                        id: "streaming",
                                        role: .assistant,
                                        content: store.streamText,
                                        backend: conversation.backend,
                                        timestamp: ""
                                    )
                                )
                                .id("streaming")
                            }
                        }
                        .padding()
                    }
                    .onChange(of: conversation.messages.count) {
                        scrollToEnd(proxy)
                    }
                    .onChange(of: store.streamText) {
                        scrollToEnd(proxy)
                    }
                }
                if let usage = store.activeUsage {
                    UsageSummaryBar(usage: usage, planModeActive: store.planModeActive)
                } else if store.planModeActive {
                    UsageSummaryBar(usage: nil, planModeActive: true)
                }
                InteractionCard(store: store)
                ComposerSelectionBar(store: store)
                AttachmentTray(store: store)
                QueueStack(store: store, queue: conversation.messageQueue ?? [])
                Composer(store: store)
            } else {
                ContentUnavailableView("Select a conversation", systemImage: "message")
            }
        }
        .navigationTitle(store.activeConversation?.title ?? "Chat")
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Menu {
                    Button {
                        renamePresented = true
                    } label: {
                        Label("Rename", systemImage: "pencil")
                    }
                    .disabled(store.activeConversation == nil)

                    if store.activeConversation?.archived == true {
                        Button {
                            Task { await store.restoreActiveConversation() }
                        } label: {
                            Label("Restore", systemImage: "tray.and.arrow.up")
                        }
                        .disabled(store.activeConversation == nil || store.isStreaming)
                    } else {
                        Button {
                            Task { await store.archiveActiveConversation() }
                        } label: {
                            Label("Archive", systemImage: "archivebox")
                        }
                        .disabled(store.activeConversation == nil || store.isStreaming)
                    }

                    Button(role: .destructive) {
                        deleteConfirmationPresented = true
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                    .disabled(store.activeConversation == nil || store.isStreaming)
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("Conversation actions")
                .disabled(store.activeConversation == nil)

                Button {
                    filesPresented = true
                } label: {
                    Image(systemName: "folder")
                }
                .accessibilityLabel("Files")
                .disabled(store.activeConversation == nil)

                Button {
                    sessionsPresented = true
                } label: {
                    Image(systemName: "clock.arrow.circlepath")
                }
                .accessibilityLabel("Sessions")
                .disabled(store.activeConversation == nil)

                Button(role: .destructive) {
                    resetConfirmationPresented = true
                } label: {
                    Image(systemName: "arrow.counterclockwise")
                }
                .accessibilityLabel("Reset session")
                .disabled(store.activeConversation == nil || store.isStreaming)
            }
        }
        .sheet(isPresented: $sessionsPresented) {
            SessionsView(store: store)
        }
        .sheet(isPresented: $filesPresented) {
            FilesView(store: store)
        }
        .sheet(isPresented: $renamePresented) {
            RenameConversationView(store: store)
        }
        .confirmationDialog("Reset this session?", isPresented: $resetConfirmationPresented, titleVisibility: .visible) {
            Button("Reset Session", role: .destructive) {
                Task { await store.resetSession() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The current session will be archived and a new session will start in this conversation.")
        }
        .confirmationDialog("Delete this conversation?", isPresented: $deleteConfirmationPresented, titleVisibility: .visible) {
            Button("Delete Conversation", role: .destructive) {
                Task { await store.deleteActiveConversation() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes the conversation, session files, and uploaded artifacts from the server.")
        }
    }

    private func scrollToEnd(_ proxy: ScrollViewProxy) {
        if !store.streamText.isEmpty {
            proxy.scrollTo("streaming", anchor: .bottom)
        } else if let id = store.activeConversation?.messages.last?.id {
            proxy.scrollTo(id, anchor: .bottom)
        }
    }
}

private struct RenameConversationView: View {
    @ObservedObject var store: ConversationStore
    @Environment(\.dismiss) private var dismiss
    @State private var title: String

    init(store: ConversationStore) {
        self.store = store
        _title = State(initialValue: store.activeConversation?.title ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Title", text: $title)
                }
            }
            .navigationTitle("Rename")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            await store.renameActiveConversation(title: title)
                            if store.errorMessage == nil {
                                dismiss()
                            }
                        }
                    }
                    .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.isLoading)
                }
            }
        }
    }
}

private struct UsageSummaryBar: View {
    var usage: Usage?
    var planModeActive: Bool

    var body: some View {
        HStack(spacing: 10) {
            if planModeActive {
                Label("Planning", systemImage: "list.clipboard")
                    .foregroundStyle(.orange)
            }
            if let usage {
                Label("\(totalTokens(usage)) tokens", systemImage: "chart.bar")
                if usage.costUsd > 0 {
                    Text(usage.costUsd, format: .currency(code: "USD"))
                }
                if let credits = usage.credits {
                    Text("\(credits, specifier: "%.1f") credits")
                }
                if let context = usage.contextUsagePercentage {
                    Text("\(formattedContext(context))% context")
                }
            }
            Spacer()
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal)
        .padding(.vertical, 6)
        .background(.bar)
    }

    private func totalTokens(_ usage: Usage) -> Int {
        usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
    }

    private func formattedContext(_ value: Double) -> String {
        if value < 10 {
            return String(format: "%.1f", value)
        }
        return String(format: "%.0f", value)
    }
}

private struct InteractionCard: View {
    @ObservedObject var store: ConversationStore

    var body: some View {
        if let interaction = store.pendingInteraction {
            VStack(alignment: .leading, spacing: 10) {
                switch interaction {
                case .planApproval(let planContent):
                    Label("Needs approval", systemImage: "checklist")
                        .font(.caption)
                        .foregroundStyle(.orange)
                    Text(planContent.isEmpty ? "No plan content." : planContent)
                        .font(.body)
                        .textSelection(.enabled)
                    HStack {
                        Button(role: .destructive) {
                            Task { await store.respondToPendingInteraction("no") }
                        } label: {
                            Label("Reject", systemImage: "xmark")
                        }
                        Button {
                            Task { await store.respondToPendingInteraction("yes") }
                        } label: {
                            Label("Approve & Run", systemImage: "checkmark")
                        }
                        .buttonStyle(.borderedProminent)
                    }
                    .disabled(store.respondPending)
                case .userQuestion(let question, let options):
                    QuestionInteractionView(
                        store: store,
                        question: question,
                        options: options
                    )
                }
            }
            .padding(12)
            .background(Color.orange.opacity(0.10))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .padding(.horizontal)
            .padding(.vertical, 8)
        }
    }
}

private struct QuestionInteractionView: View {
    @ObservedObject var store: ConversationStore
    var question: String
    var options: [QuestionOption]
    @State private var answer = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Clarifying question", systemImage: "questionmark.circle")
                .font(.caption)
                .foregroundStyle(Color.accentColor)
            Text(question)
                .font(.headline)
                .textSelection(.enabled)
            if !options.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(options) { option in
                            Button(option.label) {
                                answer = option.label
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                }
            }
            HStack {
                TextField("Answer", text: $answer)
                    .textFieldStyle(.roundedBorder)
                Button {
                    Task { await store.respondToPendingInteraction(answer) }
                } label: {
                    Label("Send", systemImage: "paperplane")
                }
                .buttonStyle(.borderedProminent)
                .disabled(answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.respondPending)
            }
        }
    }
}

private struct ComposerSelectionBar: View {
    @ObservedObject var store: ConversationStore

    var body: some View {
        if !store.backends.isEmpty || !store.availableCliProfiles.isEmpty {
            VStack(spacing: 8) {
                HStack(spacing: 10) {
                    if !store.availableCliProfiles.isEmpty {
                        Picker("Profile", selection: profileSelection) {
                            ForEach(store.availableCliProfiles) { profile in
                                Text(profile.name).tag(profile.id as String?)
                            }
                        }
                        .pickerStyle(.menu)
                        .disabled(store.profileSelectionLocked)
                    } else {
                        Picker("Backend", selection: backendSelection) {
                            ForEach(store.backends) { backend in
                                Text(backend.label).tag(backend.id as String?)
                            }
                        }
                        .pickerStyle(.menu)
                        .disabled(store.profileSelectionLocked)
                    }

                    if let models = store.selectedBackendMetadata?.models, !models.isEmpty {
                        Picker("Model", selection: modelSelection) {
                            ForEach(models) { model in
                                Text(model.label).tag(model.id as String?)
                            }
                        }
                        .pickerStyle(.menu)
                    }

                    if !store.supportedEffortsForSelection.isEmpty {
                        Picker("Effort", selection: effortSelection) {
                            ForEach(store.supportedEffortsForSelection, id: \.self) { effort in
                                Text(effort.label).tag(effort as EffortLevel?)
                            }
                        }
                        .pickerStyle(.menu)
                    }
                }
                .font(.caption)
            }
            .padding(.horizontal)
            .padding(.vertical, 8)
            .background(.bar)
        }
    }

    private var profileSelection: Binding<String?> {
        Binding(
            get: { store.selectedCliProfileId },
            set: { profileID in
                guard let profileID else { return }
                Task { await store.setSelectedCliProfile(profileID) }
            }
        )
    }

    private var backendSelection: Binding<String?> {
        Binding(
            get: { store.selectedBackend },
            set: { backendID in
                guard let backendID else { return }
                store.setSelectedBackend(backendID)
            }
        )
    }

    private var modelSelection: Binding<String?> {
        Binding(
            get: { store.selectedModel },
            set: { store.setSelectedModel($0) }
        )
    }

    private var effortSelection: Binding<EffortLevel?> {
        Binding(
            get: { store.selectedEffort },
            set: { store.setSelectedEffort($0) }
        )
    }
}

private extension EffortLevel {
    var label: String {
        switch self {
        case .none:
            return "None"
        case .minimal:
            return "Minimal"
        case .low:
            return "Low"
        case .medium:
            return "Medium"
        case .high:
            return "High"
        case .xhigh:
            return "X High"
        case .max:
            return "Max"
        }
    }
}

private struct FilesView: View {
    @ObservedObject var store: ConversationStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        Image(systemName: "folder")
                            .foregroundStyle(.secondary)
                        Text(store.explorerPath.isEmpty ? "/" : store.explorerPath)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    if store.explorerParent != nil || !store.explorerPath.isEmpty {
                        Button {
                            Task { await store.openExplorerParent() }
                        } label: {
                            Label("Parent", systemImage: "arrow.up")
                        }
                    }
                }

                Section("Files") {
                    ForEach(store.explorerEntries) { entry in
                        Button {
                            Task { await store.openExplorerEntry(entry) }
                        } label: {
                            ExplorerEntryRow(entry: entry)
                        }
                    }
                }

                if let preview = store.explorerPreview {
                    Section(preview.filename) {
                        ScrollView(.horizontal, showsIndicators: true) {
                            Text(preview.content)
                                .font(.system(.caption, design: .monospaced))
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
            }
            .navigationTitle("Files")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") {
                        dismiss()
                    }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        Task { await store.loadExplorer(path: store.explorerPath) }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .accessibilityLabel("Refresh files")
                }
            }
            .task {
                await store.loadExplorer()
            }
        }
    }
}

private struct ExplorerEntryRow: View {
    var entry: ExplorerEntry

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: iconName)
                .foregroundStyle(iconColor)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.name)
                    .lineLimit(1)
                if entry.type == .file, let size = entry.size {
                    Text(byteCount(size))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func byteCount(_ size: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)
    }

    private var iconName: String {
        entry.type == .dir ? "folder" : "doc.text"
    }

    private var iconColor: Color {
        entry.type == .dir ? .accentColor : .secondary
    }
}

private struct SessionsView: View {
    @ObservedObject var store: ConversationStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section("Sessions") {
                    ForEach(store.sessions) { session in
                        Button {
                            Task { await store.previewSession(session) }
                        } label: {
                            SessionRow(session: session)
                        }
                    }
                }

                if !store.sessionPreviewMessages.isEmpty {
                    Section("Preview") {
                        ForEach(store.sessionPreviewMessages) { message in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(message.role.rawValue.capitalized)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Text(message.content)
                                    .font(.body)
                                    .lineLimit(6)
                            }
                            .padding(.vertical, 4)
                        }
                    }
                }
            }
            .navigationTitle("Sessions")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
            .task {
                await store.loadSessions()
            }
        }
    }
}

private struct SessionRow: View {
    var session: SessionHistoryItem

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Session \(session.number)")
                    .font(.headline)
                if session.isCurrent {
                    Text("Current")
                        .font(.caption2)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.accentColor.opacity(0.14))
                        .clipShape(Capsule())
                }
                Spacer()
                Text("\(session.messageCount)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let summary = session.summary, !summary.isEmpty {
                Text(summary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
    }
}

private struct QueueStack: View {
    @ObservedObject var store: ConversationStore
    var queue: [QueuedMessage]

    var body: some View {
        if !queue.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Label("Queued (\(queue.count))", systemImage: "text.line.first.and.arrowtriangle.forward")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("Clear") {
                        Task { await store.clearQueue() }
                    }
                    .font(.caption)
                }

                ForEach(Array(queue.enumerated()), id: \.offset) { index, item in
                    HStack(spacing: 8) {
                        Text("\(index + 1)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .frame(width: 22, height: 22)
                            .background(Color.secondary.opacity(0.12))
                            .clipShape(Circle())
                        Text(item.content)
                            .font(.caption)
                            .lineLimit(2)
                        Spacer()
                        Button {
                            Task { await store.removeQueuedMessage(at: index) }
                        } label: {
                            Image(systemName: "xmark")
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Remove queued message")
                    }
                }
            }
            .padding(10)
            .background(.bar)
        }
    }
}

private struct MessageBubble: View {
    var message: Message

    var body: some View {
        HStack {
            if message.role == .user {
                Spacer(minLength: 40)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(message.role.rawValue.capitalized)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let streamError = message.streamError {
                    Label(streamError.message, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                } else {
                    MessageContent(message: message)
                }
            }
            .padding(12)
            .background(message.role == .user ? Color.accentColor.opacity(0.14) : Color.secondary.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            if message.role != .user {
                Spacer(minLength: 40)
            }
        }
    }
}

private struct MessageContent: View {
    var message: Message

    var body: some View {
        if let contentBlocks = message.contentBlocks, !contentBlocks.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(contentBlocks.enumerated()), id: \.offset) { _, block in
                    switch block {
                    case .text(let content):
                        if !content.isEmpty {
                            AssistantMarkdownText(content: content)
                        }
                    case .thinking(let content):
                        if !content.isEmpty {
                            Label(content, systemImage: "brain.head.profile")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        }
                    case .tool(let activity):
                        ToolActivityRow(activity: activity)
                    }
                }
            }
        } else {
            if message.role == .assistant {
                AssistantMarkdownText(content: message.content)
            } else {
                Text(message.content)
                    .textSelection(.enabled)
            }
        }
    }
}

private struct AssistantMarkdownText: View {
    var content: String

    var body: some View {
        if let attributed = try? AttributedString(
            markdown: hardBreakMarkdown(content),
            options: AttributedString.MarkdownParsingOptions(
                interpretedSyntax: .full,
                failurePolicy: .returnPartiallyParsedIfPossible
            )
        ) {
            Text(attributed)
                .textSelection(.enabled)
        } else {
            Text(content)
                .textSelection(.enabled)
        }
    }

    private func hardBreakMarkdown(_ markdown: String) -> String {
        var inFence = false
        return markdown
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { rawLine in
                let line = String(rawLine)
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                    inFence.toggle()
                    return line
                }
                if inFence || trimmed.isEmpty || line.hasSuffix("  ") {
                    return line
                }
                return line + "  "
            }
            .joined(separator: "\n")
    }
}

private struct ToolActivityRow: View {
    var activity: ToolActivity

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: iconName)
                .foregroundStyle(statusColor)
            VStack(alignment: .leading, spacing: 2) {
                Text(activity.tool)
                    .font(.caption)
                    .fontWeight(.semibold)
                if !activity.description.isEmpty {
                    Text(activity.description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
                if let status = activity.status, !status.isEmpty {
                    Text(status.capitalized)
                        .font(.caption2)
                        .foregroundStyle(statusColor)
                }
            }
        }
        .padding(8)
        .background(Color.secondary.opacity(0.10))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private var iconName: String {
        if activity.isAgent == true {
            return "person.2"
        }
        switch activity.tool.lowercased() {
        case "bash":
            return "terminal"
        case "edit":
            return "square.and.pencil"
        case "read":
            return "doc.text.magnifyingglass"
        default:
            return "wrench.and.screwdriver"
        }
    }

    private var statusColor: Color {
        switch activity.status?.lowercased() {
        case "success", "completed":
            return .green
        case "error", "failed":
            return .red
        case "running":
            return .accentColor
        default:
            return .secondary
        }
    }
}

private struct Composer: View {
    @ObservedObject var store: ConversationStore
    @State private var fileImporterPresented = false

    var body: some View {
        HStack(alignment: .bottom, spacing: 10) {
            Button {
                fileImporterPresented = true
            } label: {
                Image(systemName: "paperclip")
            }
            .buttonStyle(.bordered)
            .accessibilityLabel("Attach files")
            .disabled(store.activeConversation == nil || store.pendingInteraction != nil)

            TextField(store.pendingInteraction == nil ? "Message" : "Answer the prompt above to continue", text: $store.draft, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...6)
                .disabled(store.pendingInteraction != nil)
            if store.isStreaming && store.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Button(role: .destructive) {
                    Task { await store.stopStream() }
                } label: {
                    Image(systemName: "stop.fill")
                }
                .buttonStyle(.borderedProminent)
                .accessibilityLabel("Stop agent")
            } else {
                Button {
                    Task { await store.sendDraft() }
                } label: {
                    Image(systemName: "arrow.up")
                }
                .buttonStyle(.borderedProminent)
                .disabled(!hasContent || store.isLoading || store.hasUploadingAttachments || store.pendingInteraction != nil)
                .accessibilityLabel("Send message")
            }
        }
        .padding()
        .background(.bar)
        .fileImporter(isPresented: $fileImporterPresented, allowedContentTypes: [.data], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls):
                for url in urls {
                    Task { await store.uploadAttachment(fileURL: url) }
                }
            case .failure(let error):
                store.errorMessage = error.localizedDescription
            }
        }
    }

    private var hasContent: Bool {
        !store.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.pendingAttachments.contains { attachment in
            if case .done = attachment.status {
                return true
            }
            return false
        }
    }
}

private struct AttachmentTray: View {
    @ObservedObject var store: ConversationStore

    var body: some View {
        if !store.pendingAttachments.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(store.pendingAttachments) { attachment in
                        AttachmentChip(attachment: attachment) {
                            Task { await store.removePendingAttachment(id: attachment.id) }
                        }
                    }
                }
                .padding(.horizontal)
                .padding(.vertical, 8)
            }
            .background(.bar)
        }
    }
}

private struct AttachmentChip: View {
    var attachment: PendingAttachment
    var onRemove: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: iconName)
                .foregroundStyle(statusColor)
            VStack(alignment: .leading, spacing: 2) {
                Text(attachment.result?.name ?? attachment.fileName)
                    .font(.caption)
                    .lineLimit(1)
                Text(statusText)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Button {
                onRemove()
            } label: {
                Image(systemName: "xmark")
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove attachment")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(Color.secondary.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private var iconName: String {
        switch attachment.result?.kind {
        case .image:
            return "photo"
        case .pdf:
            return "doc.richtext"
        case .text, .md:
            return "doc.text"
        case .code:
            return "chevron.left.forwardslash.chevron.right"
        case .folder:
            return "folder"
        case .file, nil:
            return "paperclip"
        }
    }

    private var statusText: String {
        switch attachment.status {
        case .uploading:
            return "Uploading"
        case .done:
            return attachment.result?.meta ?? attachment.result?.kind.rawValue.uppercased() ?? "Ready"
        case .error(let message):
            return message
        }
    }

    private var statusColor: Color {
        switch attachment.status {
        case .uploading:
            return .secondary
        case .done:
            return .accentColor
        case .error:
            return .red
        }
    }
}
