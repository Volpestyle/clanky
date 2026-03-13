import Foundation
import Observation

/// Manages the real-time activity stream from the Clanky SSE endpoint.
/// Holds actions, stats, and filter state for the Pulse tab.
@Observable @MainActor
final class ActivityStore {
    private(set) var actions: [ClankyAction] = []
    private(set) var stats: StatsPayload?
    private(set) var isConnected = false

    var activeFilter: FilterDomain = .all

    var filteredActions: [ClankyAction] {
        if activeFilter == .all { return actions }
        return actions.filter { activeFilter.matches($0.domain) }
    }

    private let maxActions = 220
    private var sseTask: Task<Void, Never>?
    nonisolated private var _sseTaskForDeinit: Task<Void, Never>? {
        // Workaround: access via MainActor.assumeIsolated is not allowed in deinit.
        // We rely on disconnect() being called explicitly or the Task being cancelled by ARC.
        nil
    }

    func connect(using connectionStore: ConnectionStore) async {
        sseTask?.cancel()

        guard let client = connectionStore.client else { return }

        // Health check first
        await connectionStore.performHealthCheck()
        guard connectionStore.status.isConnected else { return }

        let sse = client.activitySSE()

        sseTask = Task { [weak self] in
            guard let self else { return }

            connectionStore.updateActivityStreamStatus(.connecting)

            for await event in await sse.events() {
                guard !Task.isCancelled else { break }

                switch event.name {
                case "activity_snapshot":
                    handleSnapshot(event.data)
                    connectionStore.updateActivityStreamStatus(.connected)
                    isConnected = true

                case "action_event":
                    handleActionEvent(event.data)

                case "stats_update":
                    handleStatsUpdate(event.data)

                default:
                    break
                }
            }

            isConnected = false
            connectionStore.updateActivityStreamStatus(.disconnected)
        }
    }

    func disconnect() {
        sseTask?.cancel()
        sseTask = nil
        isConnected = false
    }

    // MARK: - SSE Event Handlers

    private func handleSnapshot(_ data: String) {
        guard let jsonData = data.data(using: .utf8) else { return }
        do {
            let snapshot = try JSONDecoder().decode(ActivitySnapshot.self, from: jsonData)
            if let snapshotActions = snapshot.actions {
                actions = Array(snapshotActions.prefix(maxActions))
            }
            if let snapshotStats = snapshot.stats {
                stats = snapshotStats
            }
        } catch {
            // Snapshot parse failure — non-fatal
        }
    }

    private func handleActionEvent(_ data: String) {
        guard let jsonData = data.data(using: .utf8) else { return }
        do {
            let action = try JSONDecoder().decode(ClankyAction.self, from: jsonData)

            // Deduplicate
            if actions.contains(where: { $0.id == action.id }) { return }

            // Insert at top, trim to max
            actions.insert(action, at: 0)
            if actions.count > maxActions {
                actions = Array(actions.prefix(maxActions))
            }

            // Haptic feedback
            HapticEngine.onAction(action.kind)
        } catch {
            // Single action parse failure — non-fatal
        }
    }

    private func handleStatsUpdate(_ data: String) {
        guard let jsonData = data.data(using: .utf8) else { return }
        do {
            stats = try JSONDecoder().decode(StatsPayload.self, from: jsonData)
        } catch {
            // Stats parse failure — non-fatal
        }
    }
}
