import SwiftUI

/// Single action row in the live feed — domain-colored left accent, dense monospaced layout.
struct ActionRow: View {
    let action: ClankyAction
    let onTap: () -> Void

    private var domain: ActionDomain { action.domain }

    var body: some View {
        Button(action: onTap) {
            HStack(alignment: .top, spacing: 0) {
                // Left domain accent strip
                Rectangle()
                    .fill(domain.color)
                    .frame(width: 3)

                VStack(alignment: .leading, spacing: 3) {
                    // Top row: kind + timestamp
                    HStack {
                        Text(action.kind.uppercased())
                            .font(.system(size: 11, weight: .semibold, design: .monospaced))
                            .tracking(0.4)
                            .foregroundStyle(.primary)

                        Spacer()

                        RelativeTimestamp(date: action.date)
                    }

                    // Detail line — context-dependent
                    detailLine

                    // Cost line if present
                    if let cost = action.usdCost, cost > 0 {
                        costLine(cost)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
            }
        }
        .buttonStyle(.plain)
    }

    // MARK: - Detail Lines

    @ViewBuilder
    private var detailLine: some View {
        switch action.kind {
        case "llm_call":
            llmCallDetail

        case "llm_tool_call":
            toolCallDetail

        case "voice_turn_in":
            if let content = action.content {
                contentPreview(content, prefix: nil)
            }

        case "voice_turn_out":
            if let content = action.content {
                contentPreview(content, prefix: nil)
            }

        case "sent_reply":
            if let content = action.content {
                contentPreview(content, prefix: nil)
            }

        default:
            if let content = action.content, !content.isEmpty {
                contentPreview(content, prefix: nil)
            }
        }
    }

    private var llmCallDetail: some View {
        HStack(spacing: 0) {
            if let model = action.model {
                Text(model)
                    .font(.system(size: 11, weight: .regular, design: .monospaced))
                    .foregroundStyle(.secondary)
            }

            if let toolCount = action.toolCallCount, toolCount > 0 {
                Text(" · \(toolCount) tool\(toolCount == 1 ? "" : "s")")
                    .font(.system(size: 11, weight: .regular, design: .monospaced))
                    .foregroundStyle(.secondary)
            }

            if let input = action.inputTokens, let output = action.outputTokens {
                Spacer()
                Text("\(formatTokenCount(input)) in / \(formatTokenCount(output)) out")
                    .font(.system(size: 10, weight: .regular, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private var toolCallDetail: some View {
        HStack(spacing: 0) {
            if let tools = action.toolNames, let first = tools.first {
                Text(first)
                    .font(.system(size: 11, weight: .regular, design: .monospaced))
                    .foregroundStyle(.secondary)

                if tools.count > 1 {
                    Text(" +\(tools.count - 1)")
                        .font(.system(size: 10, weight: .regular, design: .monospaced))
                        .foregroundStyle(.tertiary)
                }
            } else if let content = action.content {
                Text(content.prefix(60))
                    .font(.system(size: 11, weight: .regular, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }

    private func contentPreview(_ text: String, prefix: String?) -> some View {
        HStack(spacing: 0) {
            if let prefix {
                Text(prefix)
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
            Text(String(text.prefix(80)))
                .font(.system(size: 11, weight: .regular, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
    }

    private func costLine(_ cost: Double) -> some View {
        HStack {
            Spacer()
            CostText(amount: cost, size: 10)
        }
    }
}
