import SwiftUI

@main
struct ClankyApp: App {
    @State private var connectionStore = ConnectionStore()
    @State private var activityStore = ActivityStore()

    var body: some Scene {
        WindowGroup {
            if connectionStore.isConfigured && !connectionStore.requiresSetup {
                ContentView()
                    .environment(connectionStore)
                    .environment(activityStore)
                    .task {
                        await activityStore.connect(using: connectionStore)
                    }
            } else {
                SetupView()
                    .environment(connectionStore)
            }
        }
    }
}

struct ContentView: View {
    @Environment(ConnectionStore.self) private var connection
    @Environment(ActivityStore.self) private var activity

    var body: some View {
        TabView {
            Tab("PULSE", systemImage: "bolt.fill") {
                PulseTab()
            }

            Tab("VOICE", systemImage: "waveform") {
                PlaceholderTab(title: "VOICE", subtitle: "Phase 2")
            }

            Tab("BRAIN", systemImage: "brain") {
                PlaceholderTab(title: "BRAIN", subtitle: "Phase 3")
            }

            Tab("MEMORY", systemImage: "memorychip") {
                PlaceholderTab(title: "MEMORY", subtitle: "Phase 3")
            }

            Tab("CMD", systemImage: "terminal") {
                PlaceholderTab(title: "COMMAND", subtitle: "Phase 4")
            }
        }
        .tabViewStyle(.tabBarOnly)
    }
}

struct PlaceholderTab: View {
    let title: String
    let subtitle: String

    var body: some View {
        VStack(spacing: 8) {
            Text(title)
                .font(.system(.title2, design: .monospaced, weight: .bold))
                .tracking(2)
            Text(subtitle)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
