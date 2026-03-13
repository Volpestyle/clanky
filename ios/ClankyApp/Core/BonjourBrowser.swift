import Foundation
import Network
import Observation
import os

private let log = Logger(subsystem: "com.clanky.app", category: "Bonjour")
private let searchTimeout: Duration = .seconds(30)

/// Discovers the Clanky dashboard on the local network via Bonjour.
/// Reads the TXT record to get the tunnel URL for remote access.
@Observable @MainActor
final class BonjourBrowser {
    private(set) var discovered: BonjourDiscoveredService?
    private(set) var isSearching = false

    private var browser: NWBrowser?
    private var timeoutTask: Task<Void, Never>?

    func startSearching() {
        stopSearching()
        isSearching = true
        discovered = nil

        let params = NWParameters()
        params.includePeerToPeer = true

        let browser = NWBrowser(
            for: .bonjour(type: "_clanky._tcp", domain: nil),
            using: params
        )

        browser.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in
                if case .failed(let error) = state {
                    log.error("Bonjour browse failed: \(String(describing: error), privacy: .public)")
                    self?.timeoutTask?.cancel()
                    self?.isSearching = false
                }
            }
        }

        browser.browseResultsChangedHandler = { [weak self] results, _ in
            Task { @MainActor in
                guard let self else { return }
                self.handleResults(Array(results))
            }
        }

        browser.start(queue: .main)
        self.browser = browser

        timeoutTask = Task { [weak self] in
            try? await Task.sleep(for: searchTimeout)
            guard let self else { return }
            if self.isSearching {
                log.info("Bonjour discovery timed out while waiting for tunnel URL")
                self.stopSearching()
            }
        }
    }

    func stopSearching() {
        timeoutTask?.cancel()
        timeoutTask = nil
        browser?.cancel()
        browser = nil
        isSearching = false
    }

    // MARK: - Handle Results

    private func handleResults(_ results: [NWBrowser.Result]) {
        let services = results.compactMap(parseDiscoveredService)
        guard let decision = BonjourDiscoveryLogic.decision(for: services) else {
            return
        }

        switch decision {
        case .keepSearching(let service):
            discovered = service
            isSearching = true
            log.info("Discovered \(service.name), waiting for tunnel URL")

        case .found(let service):
            discovered = service
            log.info("Discovered \(service.name), tunnel: \(service.tunnelUrl ?? "nil")")
            stopSearching()
        }
    }

    private func parseDiscoveredService(_ result: NWBrowser.Result) -> BonjourDiscoveredService? {
        let name: String
        if case .service(let serviceName, _, _, _) = result.endpoint {
            name = serviceName
        } else {
            name = "Clanky"
        }

        var tunnelUrl: String?
        if case .bonjour(let txtRecord) = result.metadata {
            let dict = txtRecord.dictionary
            if !dict.isEmpty {
                log.info("TXT keys for \(name): \(Array(dict.keys).description)")
            }
            tunnelUrl = BonjourDiscoveryLogic.normalizedTunnelURL(dict["tunnelUrl"])
        }

        return BonjourDiscoveredService(name: name, tunnelUrl: tunnelUrl)
    }
}
