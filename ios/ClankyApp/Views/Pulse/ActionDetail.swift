import SwiftUI

/// Expanded detail sheet for a single action — full metadata inspection.
struct ActionDetail: View {
    let action: ClankyAction
    @Environment(\.dismiss) private var dismiss

    private var domain: ActionDomain { action.domain }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    // Header
                    HStack(alignment: .top) {
                        HStack(spacing: 8) {
                            Rectangle()
                                .fill(domain.color)
                                .frame(width: 3, height: 20)

                            Text(action.kind.uppercased())
                                .font(.system(size: 14, weight: .bold, design: .monospaced))
                                .tracking(0.5)
                        }

                        Spacer()

                        Text("#\(action.id)")
                            .font(.system(size: 11, weight: .regular, design: .monospaced))
                            .foregroundStyle(.tertiary)
                    }

                    Divider()

                    // Key-value pairs
                    detailRows

                    // Content
                    if let content = action.content, !content.isEmpty {
                        Divider()
                        PanelView(label: "CONTENT") {
                            Text(content)
                                .font(.system(size: 12, weight: .regular, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        }
                    }

                    // Raw metadata
                    if let metadata = action.metadata, !metadata.isEmpty {
                        PanelView(label: "METADATA") {
                            VStack(alignment: .leading, spacing: 4) {
                                ForEach(Array(metadata.keys.sorted()), id: \.self) { key in
                                    metadataRow(key: key, value: metadata[key])
                                }
                            }
                        }
                    }
                }
                .padding(16)
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("DONE") { dismiss() }
                        .font(.system(size: 11, weight: .semibold, design: .monospaced))
                        .tracking(0.8)
                }
            }
        }
    }

    // MARK: - Detail Rows

    @ViewBuilder
    private var detailRows: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let provider = action.provider {
                detailRow("PROVIDER", provider)
            }
            if let model = action.model {
                detailRow("MODEL", model)
            }
            if let input = action.inputTokens, let output = action.outputTokens {
                detailRow("TOKENS", "\(input.formatted()) in / \(output.formatted()) out")
            }
            if let cached = action.cachedInputTokens, cached > 0 {
                detailRow("CACHED", "\(cached.formatted()) read")
            }
            if let cost = action.usdCost, cost > 0 {
                detailRow("COST", String(format: "$%.4f", cost))
            }
            if let stop = action.stopReason {
                detailRow("STOP", stop)
            }
            if let tools = action.toolNames, !tools.isEmpty {
                detailRow("TOOLS", tools.joined(separator: ", "))
            }
            if let guildId = action.guildId {
                detailRow("GUILD", guildId)
            }
            if let channelId = action.channelId {
                detailRow("CHANNEL", channelId)
            }
            if let userId = action.userId {
                detailRow("USER", userId)
            }
            if let date = action.createdAt {
                detailRow("TIME", date)
            }
        }
    }

    private func detailRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top) {
            Text(label)
                .font(.system(size: 10, weight: .medium, design: .monospaced))
                .tracking(0.6)
                .foregroundStyle(.tertiary)
                .frame(width: 80, alignment: .leading)

            Text(value)
                .font(.system(size: 12, weight: .regular, design: .monospaced))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
        }
    }

    @ViewBuilder
    private func metadataRow(key: String, value: JSONValue?) -> some View {
        HStack(alignment: .top) {
            Text(key)
                .font(.system(size: 10, weight: .medium, design: .monospaced))
                .foregroundStyle(.tertiary)
                .frame(minWidth: 80, alignment: .leading)

            Text(jsonValueString(value))
                .font(.system(size: 10, weight: .regular, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(3)
                .textSelection(.enabled)
        }
    }

    private func jsonValueString(_ value: JSONValue?) -> String {
        guard let value else { return "null" }
        switch value {
        case .string(let v): return v
        case .int(let v): return "\(v)"
        case .double(let v): return String(format: "%.4f", v)
        case .bool(let v): return v ? "true" : "false"
        case .null: return "null"
        case .object: return "{...}"
        case .array(let arr): return "[\(arr.count) items]"
        }
    }
}
