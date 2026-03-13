import SwiftUI

/// First-run configuration: enter tunnel URL and dashboard token.
/// Auto-discovers Clanky on the local network via Bonjour.
struct SetupView: View {
    @Environment(ConnectionStore.self) private var connection
    @State private var tunnelURL = ""
    @State private var token = ""
    @State private var isChecking = false
    @State private var errorMessage: String?
    @State private var bonjour = BonjourBrowser()

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            // Header
            VStack(spacing: 8) {
                Text("CLANKY")
                    .font(.system(size: 28, weight: .bold, design: .monospaced))
                    .tracking(6)

                Text("MISSION CONTROL")
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .tracking(3)
                    .foregroundStyle(.secondary)
            }
            .padding(.bottom, 40)

            // Form
            VStack(spacing: 16) {
                // Auto-discovery banner
                discoveryBanner

                PanelView(label: "CONNECTION") {
                    VStack(alignment: .leading, spacing: 12) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("TUNNEL URL")
                                .font(.system(size: 10, weight: .medium, design: .monospaced))
                                .tracking(0.8)
                                .foregroundStyle(.secondary)

                            TextField("https://abc-xyz.trycloudflare.com", text: $tunnelURL)
                                .font(.system(size: 13, weight: .regular, design: .monospaced))
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .keyboardType(.URL)
                                .textContentType(.URL)
                        }

                        Divider()

                        VStack(alignment: .leading, spacing: 4) {
                            Text("DASHBOARD TOKEN")
                                .font(.system(size: 10, weight: .medium, design: .monospaced))
                                .tracking(0.8)
                                .foregroundStyle(.secondary)

                            SecureField("Token", text: $token)
                                .font(.system(size: 13, weight: .regular, design: .monospaced))
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                        }
                    }
                }

                if let errorMessage {
                    Text(errorMessage)
                        .font(.system(size: 11, weight: .regular, design: .monospaced))
                        .foregroundStyle(Color.negative)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                Button {
                    Task { await connectTapped() }
                } label: {
                    HStack(spacing: 8) {
                        if isChecking {
                            ProgressView()
                                .scaleEffect(0.7)
                        }
                        Text("CONNECT")
                            .font(.system(size: 12, weight: .semibold, design: .monospaced))
                            .tracking(1.5)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(canConnect ? Color.primary : Color.secondary.opacity(0.3))
                    .foregroundStyle(canConnect ? Color(.systemBackground) : .secondary)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay(
                        RoundedRectangle(cornerRadius: 8)
                            .strokeBorder(Color.primary.opacity(0.1), lineWidth: 0.5)
                    )
                }
                .disabled(!canConnect || isChecking)
            }
            .padding(.horizontal, 24)

            Spacer()
            Spacer()
        }
        .task {
            if token.isEmpty {
                token = connection.dashboardToken
            }
            bonjour.startSearching()
        }
        .onDisappear {
            bonjour.stopSearching()
        }
        .onChange(of: bonjour.discovered?.tunnelUrl) { _, newUrl in
            if let newUrl, !newUrl.isEmpty, tunnelURL.isEmpty {
                withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                    tunnelURL = newUrl
                }
            }
        }
    }

    // MARK: - Discovery Banner

    @ViewBuilder
    private var discoveryBanner: some View {
        if bonjour.isSearching, let service = bonjour.discovered {
            VStack(spacing: 4) {
                HStack(spacing: 6) {
                    Circle()
                        .fill(Color.positive)
                        .frame(width: 6, height: 6)

                    Text("FOUND: \(service.name.uppercased())")
                        .font(.system(size: 10, weight: .semibold, design: .monospaced))
                        .tracking(0.8)
                }

                HStack(spacing: 8) {
                    ProgressView()
                        .scaleEffect(0.6)

                    Text("WAITING FOR CLOUDFLARE TUNNEL...")
                        .font(.system(size: 9, weight: .regular, design: .monospaced))
                        .tracking(0.6)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(.ultraThinMaterial)
            .clipShape(RoundedRectangle(cornerRadius: 8))

        } else if bonjour.isSearching {
            VStack(spacing: 4) {
                HStack(spacing: 8) {
                    ProgressView()
                        .scaleEffect(0.6)
                    Text("SEARCHING LOCAL NETWORK...")
                        .font(.system(size: 10, weight: .medium, design: .monospaced))
                        .tracking(0.8)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(.ultraThinMaterial)
            .clipShape(RoundedRectangle(cornerRadius: 8))

        } else if let service = bonjour.discovered {
            VStack(spacing: 4) {
                HStack(spacing: 6) {
                    Circle()
                        .fill(Color.positive)
                        .frame(width: 6, height: 6)

                    Text("FOUND: \(service.name.uppercased())")
                        .font(.system(size: 10, weight: .semibold, design: .monospaced))
                        .tracking(0.8)
                }

                if service.tunnelUrl != nil {
                    Text("TUNNEL URL AUTO-FILLED")
                        .font(.system(size: 9, weight: .regular, design: .monospaced))
                        .tracking(0.6)
                        .foregroundStyle(.secondary)
                } else {
                    Text("NO TUNNEL URL — ENTER MANUALLY")
                        .font(.system(size: 9, weight: .regular, design: .monospaced))
                        .tracking(0.6)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(.ultraThinMaterial)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .transition(.opacity.combined(with: .scale(scale: 0.95)))
        }
    }

    // MARK: - Logic

    private var canConnect: Bool {
        BonjourDiscoveryLogic.normalizedTunnelURL(tunnelURL) != nil
            && !token.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private func connectTapped() async {
        isChecking = true
        errorMessage = nil

        guard let cleanURL = BonjourDiscoveryLogic.normalizedTunnelURL(tunnelURL) else {
            errorMessage = "ENTER A VALID URL"
            isChecking = false
            return
        }

        connection.tunnelURL = cleanURL
        connection.dashboardToken = token.trimmingCharacters(in: .whitespaces)

        await connection.performHealthCheck()

        if !connection.status.isConnected {
            if case .error(let msg) = connection.status {
                errorMessage = msg
            } else {
                errorMessage = "CONNECTION FAILED"
            }
        }

        isChecking = false
        bonjour.stopSearching()
    }
}
