import Foundation
import Observation
import PorchKit
import UIKit
import UniformTypeIdentifiers

/// State of the share sheet. Extraction, the PUTs and the summary text are in
/// PorchKit (SharedTextExtractor, ShareSubmitter) and tested there.
@Observable
@MainActor
final class ShareModel {
    enum Phase: Equatable {
        case loading
        case signedOut
        case nothingFound
        case choosing
        case sending
        case finished(String)
        /// Some numbers failed; they stay listed for another try.
        case failed(String)
    }

    private(set) var phase: Phase = .loading
    private(set) var numbers: [SharedNumber] = []
    var selected: Set<String> = []

    @ObservationIgnored var onFinish: () -> Void = {}
    @ObservationIgnored private var token: String?
    @ObservationIgnored private let detector: any CarrierDetector = RuleCarrierDetector()

    var canSubmit: Bool {
        (phase == .choosing || isFailed) && !selected.isEmpty
    }

    var isFailed: Bool {
        if case .failed = phase { return true }
        return false
    }

    func load(from items: [NSExtensionItem]) async {
        // The app saves the session in the shared Keychain group; an error reading it counts as signed out.
        token = (try? KeychainSessionStore().load())?.token
        guard token != nil else {
            phase = .signedOut
            return
        }
        let content = await SharedContent.load(from: items)
        numbers = SharedTextExtractor(detector: detector).numbers(inTexts: content.texts, urls: content.urls)
        selected = Set(numbers.map(\.id))
        phase = numbers.isEmpty ? .nothingFound : .choosing
    }

    func toggle(_ number: SharedNumber) {
        if selected.contains(number.id) {
            selected.remove(number.id)
        } else {
            selected.insert(number.id)
        }
    }

    func submit() async {
        guard let token else {
            phase = .signedOut
            return
        }
        let chosen = numbers.filter { selected.contains($0.id) }
        guard !chosen.isEmpty else { return }
        phase = .sending

        let api = HTTPAPIClient(baseURL: PorchConfig.productionBaseURL, token: { token })
        let outcomes = await ShareSubmitter(api: api).submit(chosen)
        let message = ShareOutcome.summary(outcomes)

        if ShareOutcome.allSucceeded(outcomes) {
            phase = .finished(message)
            try? await Task.sleep(for: .seconds(1.2))
            onFinish()
        } else if outcomes.contains(.failed(.signedOut)) {
            phase = .signedOut
        } else {
            let failedIds = Set(zip(chosen, outcomes).filter { $0.1.isFailure }.map { $0.0.id })
            numbers = numbers.filter { failedIds.contains($0.id) }
            selected = failedIds
            phase = .failed(message)
        }
    }
}

/// Reads text and URLs out of the extension's input items.
@MainActor
enum SharedContent {
    /// Keeps at most `SharedTextExtractor.maxInputLength` characters of text in
    /// all, since the extractor reads no more and the extension has little memory.
    static func load(from items: [NSExtensionItem]) async -> (texts: [String], urls: [URL]) {
        let budget = SharedTextExtractor.maxInputLength
        var texts: [String] = []
        var kept = 0
        var urls: [URL] = []
        func keep(_ text: String) {
            guard kept < budget, !text.isEmpty else { return }
            let part = String(text.prefix(budget - kept))
            kept += part.count
            texts.append(part)
        }
        for item in items {
            if let text = item.attributedContentText?.string { keep(text) }
            for provider in item.attachments ?? [] {
                if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                    if let url = await loadURL(provider) { urls.append(url) }
                } else if kept < budget, provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                    if let text = await loadText(provider) { keep(text) }
                }
            }
        }
        return (texts, urls)
    }

    // The completion handlers run on a background queue, so they are marked
    // @Sendable to keep them off the main actor.
    private static func loadURL(_ provider: NSItemProvider) async -> URL? {
        await withCheckedContinuation { (cont: CheckedContinuation<URL?, Never>) in
            _ = provider.loadObject(ofClass: URL.self) { @Sendable url, _ in cont.resume(returning: url) }
        }
    }

    private static func loadText(_ provider: NSItemProvider) async -> String? {
        await withCheckedContinuation { (cont: CheckedContinuation<String?, Never>) in
            _ = provider.loadObject(ofClass: String.self) { @Sendable text, _ in cont.resume(returning: text) }
        }
    }
}
