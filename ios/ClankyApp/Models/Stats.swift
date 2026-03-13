import Foundation

/// Runtime stats payload from `/api/stats` and `stats_update` SSE events.
/// Uses flexible decoding since the shape has many optional nested fields.
struct StatsPayload: Codable, Sendable {
    let runtime: RuntimeInfo?
    let stats: StatsInfo?

    struct RuntimeInfo: Codable, Sendable {
        let isReady: Bool?
        let publicHttps: PublicHttpsInfo?
        let guildCount: Int?

        struct PublicHttpsInfo: Codable, Sendable {
            let enabled: Bool?
            let publicUrl: String?
            let status: String?
        }
    }

    struct StatsInfo: Codable, Sendable {
        let totalCostUsd: Double?
        let last24h: Last24h?
        let dailyCost: DailyCost?

        struct Last24h: Codable, Sendable {
            let actionCount: Int?
            let voiceSessionCount: Int?
            let llmCallCount: Int?
            let toolCallCount: Int?
            let errorCount: Int?
            let memoryFactCount: Int?
        }

        struct DailyCost: Codable, Sendable {
            let totalUsd: Double?
        }
    }

    // Convenience accessors
    var costToday: Double {
        stats?.dailyCost?.totalUsd ?? stats?.totalCostUsd ?? 0
    }

    var actionCount24h: Int {
        stats?.last24h?.actionCount ?? 0
    }

    var voiceSessionCount24h: Int {
        stats?.last24h?.voiceSessionCount ?? 0
    }

    var llmCallCount24h: Int {
        stats?.last24h?.llmCallCount ?? 0
    }

    var toolCallCount24h: Int {
        stats?.last24h?.toolCallCount ?? 0
    }

    var errorCount24h: Int {
        stats?.last24h?.errorCount ?? 0
    }

    var memoryFactCount24h: Int {
        stats?.last24h?.memoryFactCount ?? 0
    }

    var isReady: Bool {
        runtime?.isReady ?? false
    }

    var guildCount: Int {
        runtime?.guildCount ?? 0
    }

    var tunnelStatus: String? {
        runtime?.publicHttps?.status
    }

    var tunnelUrl: String? {
        runtime?.publicHttps?.publicUrl
    }
}

/// Snapshot payload from the `activity_snapshot` SSE event.
struct ActivitySnapshot: Codable, Sendable {
    let actions: [ClankyAction]?
    let stats: StatsPayload?
}
