import Foundation

enum SSEStreamStatus: String, Sendable {
    case disconnected
    case connecting
    case connected
    case error
}

enum ConnectionStatus: Sendable {
    case disconnected
    case connecting
    case connected
    case error(String)

    var label: String {
        switch self {
        case .disconnected: "DISCONNECTED"
        case .connecting: "CONNECTING"
        case .connected: "CONNECTED"
        case .error: "ERROR"
        }
    }

    var isConnected: Bool {
        if case .connected = self { return true }
        return false
    }
}
