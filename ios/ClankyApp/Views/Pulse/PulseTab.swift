import SwiftUI

/// PULSE tab — real-time action feed. The heartbeat of the app.
struct PulseTab: View {
    @Environment(ActivityStore.self) private var activity
    @Environment(ConnectionStore.self) private var connection
    @State private var selectedAction: ClankyAction?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Connection header
                connectionHeader
                    .padding(.horizontal, 16)
                    .padding(.top, 8)

                // Stats bar
                StatsBar(stats: activity.stats)
                    .padding(.horizontal, 16)
                    .padding(.top, 10)

                // Filter chips
                FilterChips(selected: Bindable(activity).activeFilter)
                    .padding(.top, 10)

                // Live action feed
                actionFeed
            }
            .background(Color(.systemGroupedBackground))
            .sheet(item: $selectedAction) { action in
                ActionDetail(action: action)
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
            }
        }
    }

    // MARK: - Connection Header

    private var connectionHeader: some View {
        HStack(spacing: 8) {
            StatusDot(status: connection.status)

            Text(connection.status.label)
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .tracking(1)
                .foregroundStyle(connection.status.isConnected ? .primary : .secondary)

            Spacer()

            if let stats = activity.stats {
                CostText(amount: stats.costToday, size: 13)
                Text("TODAY")
                    .font(.system(size: 9, weight: .medium, design: .monospaced))
                    .tracking(0.6)
                    .foregroundStyle(.tertiary)
            }
        }
    }

    // MARK: - Action Feed

    private var actionFeed: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                ForEach(activity.filteredActions) { action in
                    ActionRow(action: action) {
                        selectedAction = action
                    }

                    Divider()
                        .padding(.leading, 3)
                }
            }
            .animation(.spring(response: 0.3, dampingFraction: 0.8), value: activity.filteredActions.map(\.id))
        }
        .scrollIndicators(.hidden)
        .padding(.top, 8)

        // Empty state
        .overlay {
            if activity.filteredActions.isEmpty {
                emptyState
            }
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        if activity.isConnected {
            VStack(spacing: 8) {
                Text("WAITING FOR EVENTS")
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
                    .tracking(1)
                    .foregroundStyle(.secondary)

                Text("Actions will appear here in real-time")
                    .font(.system(size: 11, weight: .regular, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }
        } else {
            VStack(spacing: 8) {
                Text("DISCONNECTED")
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
                    .tracking(1)
                    .foregroundStyle(.secondary)

                ProgressView()
                    .scaleEffect(0.8)
            }
        }
    }
}
