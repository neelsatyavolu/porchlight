import Foundation
import Testing
@testable import PorchKit

@Suite struct BackgroundSyncTests {
    private func run(_ engine: (any SyncEngine)?, store: any SessionStore = InMemorySessionStore(SAMPLE_SESSION)) async -> BackgroundSyncResult {
        await BackgroundSync(sessionStore: store, engine: { engine }).run()
    }

    @Test func reportsNewDataWhenSomethingChanged() async {
        #expect(await run(BGFakeSyncEngine(.success(outcome(changed: 2)))) == .newData)
        #expect(await run(BGFakeSyncEngine(.success(outcome(deleted: 1)))) == .newData)
        #expect(await run(BGFakeSyncEngine(.success(outcome(full: true)))) == .newData)
    }

    @Test func reportsNoDataForAnEmptyPage() async {
        #expect(await run(BGFakeSyncEngine(.success(outcome()))) == .noData)
    }

    @Test func reportsFailure() async {
        #expect(await run(BGFakeSyncEngine(.failure(APIError.network("offline")))) == .failed)
    }

    @Test func skipsWhenSignedOut() async {
        let engine = BGFakeSyncEngine(.success(outcome(changed: 1)))
        #expect(await run(engine, store: InMemorySessionStore()) == .signedOut)
        #expect(await run(engine, store: BGThrowingSessionStore()) == .signedOut)
        #expect(engine.calls.withLock { $0 } == 0)
    }

    @Test func skipsWhenNoEngineIsWiredYet() async {
        #expect(await run(nil) == .noData)
    }

    @Test func stopsWaitingWhenTheBackgroundTaskExpires() async {
        let engine = BGHangingSyncEngine()
        let running = Task { await run(engine) }
        await engine.entered()
        running.cancel()
        #expect(await running.value == .failed)
        engine.release()
    }

    @Test func intervalsAreFifteenMinutes() {
        #expect(BackgroundSync.macInterval == .seconds(15 * 60))
        #expect(BackgroundSync.iOSEarliestBegin == 15 * 60)
    }
}
