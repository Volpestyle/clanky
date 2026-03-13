import SwiftUI

/// Compact stats summary bar — data-dense, monospaced, terminal aesthetic.
struct StatsBar: View {
    let stats: StatsPayload?

    private var cells: [(String, String)] {
        guard let stats else {
            return [("ACTIONS", "--"), ("VOICE", "--"), ("LLM", "--"),
                    ("ERRORS", "--"), ("TOOLS", "--"), ("MEMORY", "--")]
        }
        return [
            ("ACTIONS", "\(stats.actionCount24h)"),
            ("VOICE", "\(stats.voiceSessionCount24h)"),
            ("LLM", "\(stats.llmCallCount24h)"),
            ("ERRORS", "\(stats.errorCount24h)"),
            ("TOOLS", "\(stats.toolCallCount24h)"),
            ("MEMORY", "\(stats.memoryFactCount24h)")
        ]
    }

    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 1), count: 3), spacing: 1) {
            ForEach(cells, id: \.0) { label, value in
                VStack(spacing: 2) {
                    Text(value)
                        .font(.system(size: 16, weight: .bold, design: .monospaced))
                        .contentTransition(.numericText())
                        .animation(.spring(response: 0.3, dampingFraction: 0.8), value: value)

                    Text(label)
                        .font(.system(size: 9, weight: .medium, design: .monospaced))
                        .tracking(0.8)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
            }
        }
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.5)
        )
    }
}
