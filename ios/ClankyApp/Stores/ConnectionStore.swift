import Foundation
import Observation

@Observable @MainActor
final class ConnectionStore {
    private(set) var status: ConnectionStatus = .disconnected
    private(set) var activityStreamStatus: SSEStreamStatus = .disconnected
    private(set) var voiceStreamStatus: SSEStreamStatus = .disconnected
    private(set) var lastHealthCheckAt: Date?
    private(set) var requiresSetup = false

    var tunnelURL: String {
        get { KeychainStore.load(key: "tunnelURL") ?? "" }
        set { KeychainStore.save(key: "tunnelURL", value: newValue) }
    }

    var dashboardToken: String {
        get { KeychainStore.load(key: "dashboardToken") ?? "" }
        set { KeychainStore.save(key: "dashboardToken", value: newValue) }
    }

    var isConfigured: Bool {
        !tunnelURL.isEmpty && !dashboardToken.isEmpty
    }

    var client: ClankyClient? {
        guard
            isConfigured,
            let normalizedTunnelURL = BonjourDiscoveryLogic.normalizedTunnelURL(tunnelURL),
            let url = URL(string: normalizedTunnelURL)
        else {
            return nil
        }
        return ClankyClient(baseURL: url, token: dashboardToken)
    }

    func performHealthCheck() async {
        guard let client else {
            status = .error("Not configured")
            requiresSetup = true
            return
        }

        status = .connecting
        do {
            let ok = try await client.healthCheck()
            if ok {
                status = .connected
                requiresSetup = false
                lastHealthCheckAt = Date()
            } else {
                status = .error("Health check failed")
                requiresSetup = true
            }
        } catch {
            status = .error(error.localizedDescription)
            requiresSetup = true
        }
    }

    func updateActivityStreamStatus(_ newStatus: SSEStreamStatus) {
        activityStreamStatus = newStatus
    }

    func updateVoiceStreamStatus(_ newStatus: SSEStreamStatus) {
        voiceStreamStatus = newStatus
    }

    func disconnect() {
        status = .disconnected
        activityStreamStatus = .disconnected
        voiceStreamStatus = .disconnected
        requiresSetup = false
        KeychainStore.delete(key: "tunnelURL")
        KeychainStore.delete(key: "dashboardToken")
    }
}
