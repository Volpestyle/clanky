import SwiftUI

/// Animated status indicator dot — pulses when connected.
struct StatusDot: View {
    let status: ConnectionStatus
    @State private var isPulsing = false

    var color: Color {
        switch status {
        case .connected: .positive
        case .connecting: .orange
        case .disconnected: .secondary
        case .error: .negative
        }
    }

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 6, height: 6)
            .opacity(isPulsing && status.isConnected ? 0.6 : 1.0)
            .animation(
                status.isConnected
                    ? .easeInOut(duration: 2).repeatForever(autoreverses: true)
                    : .default,
                value: isPulsing
            )
            .onAppear { isPulsing = true }
    }
}
