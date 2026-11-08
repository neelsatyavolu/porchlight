import Foundation
import Synchronization

/// What a background sync found, mapped by the app to
/// `UIBackgroundFetchResult` for silent pushes.
public enum BackgroundSyncResult: Hashable, Sendable {
    case newData
    case noData
    case failed
    /// No session: nothing to sync.
    case signedOut
}

/// One sync run for a silent push, `BGAppRefreshTask` on iOS, or the 15-minute
/// timer on macOS. It goes through the app's one `SyncEngine`, so runs that
/// overlap with a foreground sync join it.
public struct BackgroundSync: Sendable {
    /// macOS: how often the app syncs while it runs.
    public static let macInterval: Duration = .seconds(15 * 60)
    /// iOS: `earliestBeginDate` offset for the next `BGAppRefreshTaskRequest`.
    public static let iOSEarliestBegin: TimeInterval = 15 * 60

    private let sessionStore: any SessionStore
    private let engine: @Sendable () async -> (any SyncEngine)?

    /// `engine` is read on each run; nil skips the run.
    public init(sessionStore: any SessionStore, engine: @escaping @Sendable () async -> (any SyncEngine)?) {
        self.sessionStore = sessionStore
        self.engine = engine
    }

    /// Returns `.failed` as soon as the calling task is cancelled (iOS cancels
    /// a `.backgroundTask` when its time runs out) without waiting for the
    /// shared sync, which carries on for any foreground caller.
    public func run() async -> BackgroundSyncResult {
        guard (try? sessionStore.load()) != nil else { return .signedOut }
        guard let engine = await engine() else { return .noData }
        do {
            let outcome = try await Self.untilCancelled { try await engine.sync() }
            return outcome.changed > 0 || outcome.deleted > 0 || outcome.didFullSync ? .newData : .noData
        } catch {
            return .failed
        }
    }

    /// Runs `operation` in its own task and returns its result, or throws
    /// `CancellationError` once the caller is cancelled, whichever comes first.
    /// The operation itself is left to finish.
    static func untilCancelled<T: Sendable>(_ operation: @escaping @Sendable () async throws -> T) async throws -> T {
        let pending = ContinuationSlot<T>()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<T, any Error>) in
                pending.put(cont)
                if Task.isCancelled {
                    pending.take()?.resume(throwing: CancellationError())
                    return
                }
                Task {
                    let result: Result<T, any Error>
                    do { result = .success(try await operation()) } catch { result = .failure(error) }
                    pending.take()?.resume(with: result)
                }
            }
        } onCancel: {
            pending.take()?.resume(throwing: CancellationError())
        }
    }
}

/// Holds a continuation until whichever side resumes it first takes it.
private final class ContinuationSlot<T: Sendable>: Sendable {
    private let slot = Mutex<CheckedContinuation<T, any Error>?>(nil)
    func put(_ cont: CheckedContinuation<T, any Error>) { slot.withLock { $0 = cont } }
    func take() -> CheckedContinuation<T, any Error>? { slot.withLock { $0.take() } }
}
