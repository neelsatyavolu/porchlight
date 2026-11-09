import Foundation
import OSLog
import PorchKit
import Synchronization
#if canImport(FoundationModels)
import FoundationModels
#endif

/// Shortens Amazon listing names for package titles with Apple's on-device
/// model (Apple Intelligence, macOS and iOS 26 or later). Nothing leaves the
/// device. Without the model, or when it fails or answers with something odd,
/// it uses RuleItemNames. Answers are remembered, so each listing is asked once.
actor OnDeviceItemNames: ItemNameShortening {
    private static let cacheKey = "porchlight.itemNames.v1"
    private static let cacheLimit = 300
    private static let maxLength = 48
    /// How long one name may take. A call that never returns once stalled the
    /// whole Amazon import, so the import never waits longer than this.
    private static let timeout: Duration = .seconds(6)

    /// UserDefaults isn't Sendable, so the actor reads the shared instance instead of holding one.
    private var defaults: UserDefaults { .standard }
    private let log = Logger(subsystem: "co.xanom.porchlight", category: "itemNames")
    private var cache: [String: String]
    /// Set when the model doesn't answer in time: until the app restarts, names use the rules.
    private var modelStalled = false

    init() {
        cache = UserDefaults.standard.dictionary(forKey: Self.cacheKey) as? [String: String] ?? [:]
    }

    func shortName(_ name: String) async -> String {
        let fallback = RuleItemNames.short(name)
        // Already short: nothing to ask.
        if fallback == name.trimmingCharacters(in: .whitespacesAndNewlines) { return fallback }
        if let known = cache[name] { return known }
        guard !modelStalled else { return fallback }
        let log = log
        switch await Self.within(Self.timeout, { await Self.askModel(name, log: log) }) {
        case let .answered(answer?):
            remember(name, answer)
            return answer
        case .answered(nil):
            return fallback
        case .timedOut:
            modelStalled = true
            log.error("on-device shortening timed out; using rules until the app restarts")
            return fallback
        }
    }

    private func remember(_ name: String, _ short: String) {
        if cache.count >= Self.cacheLimit { cache.removeAll() }
        cache[name] = short
        defaults.set(cache, forKey: Self.cacheKey)
    }

    private enum Outcome: Sendable {
        case answered(String?)
        case timedOut
    }

    /// Runs `work`, but returns `.timedOut` after `limit` even if it never finishes.
    private static func within(_ limit: Duration, _ work: @escaping @Sendable () async -> String?) async -> Outcome {
        let done = Once()
        return await withCheckedContinuation { (cont: CheckedContinuation<Outcome, Never>) in
            let finish: @Sendable (Outcome) -> Void = { outcome in
                if done.claim() { cont.resume(returning: outcome) }
            }
            Task { finish(.answered(await work())) }
            Task {
                try? await Task.sleep(for: limit)
                finish(.timedOut)
            }
        }
    }

    private static func askModel(_ name: String, log: Logger) async -> String? {
        #if canImport(FoundationModels)
        guard #available(macOS 26, iOS 26, *) else { return nil }
        guard case .available = SystemLanguageModel.default.availability else { return nil }
        let session = LanguageModelSession(instructions: """
            You shorten online store product listings into the short name a person would use for the item, \
            in 2 to 5 words. Keep the brand and the kind of product. Drop sizes, counts, colors, model years, \
            compatibility lists and marketing words. Reply with the name only, with no quotes or punctuation at the end.
            """)
        do {
            let response = try await session.respond(
                to: "Listing: \(name)",
                options: GenerationOptions(temperature: 0, maximumResponseTokens: 24)
            )
            return Self.clean(response.content, original: name)
        } catch {
            log.error("on-device shortening failed: \(String(describing: error), privacy: .public)")
            return nil
        }
        #else
        return nil
        #endif
    }

    /// The model's answer, or nil when it isn't a usable short name.
    static func clean(_ answer: String, original: String) -> String? {
        var s = answer.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        s = s.trimmingCharacters(in: CharacterSet(charactersIn: "\"'“”‘’.").union(.whitespaces))
        guard !s.isEmpty, s.count <= maxLength, s.count < original.count else { return nil }
        return s
    }
}

/// True for the first caller only.
private final class Once: Sendable {
    private let claimed = Mutex(false)

    func claim() -> Bool {
        claimed.withLock { taken in
            defer { taken = true }
            return !taken
        }
    }
}
