import SwiftUI

/// Displays a relative timestamp that updates periodically ("3s ago", "2m ago").
struct RelativeTimestamp: View {
    let date: Date?
    @State private var now = Date()

    private let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        Text(relativeText)
            .font(.system(size: 10, weight: .regular, design: .monospaced))
            .foregroundStyle(.tertiary)
            .onReceive(timer) { now = $0 }
    }

    private var relativeText: String {
        guard let date else { return "" }
        let seconds = Int(now.timeIntervalSince(date))

        if seconds < 0 { return "now" }
        if seconds < 60 { return "\(seconds)s ago" }
        if seconds < 3600 { return "\(seconds / 60)m ago" }
        if seconds < 86400 { return "\(seconds / 3600)h ago" }
        return "\(seconds / 86400)d ago"
    }
}
