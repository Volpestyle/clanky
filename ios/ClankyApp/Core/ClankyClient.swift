import Foundation

/// HTTP + SSE client for the Clanky dashboard API.
/// Connects through a Cloudflare tunnel URL with token auth.
struct ClankyClient: Sendable {
    let baseURL: URL
    let token: String

    private var decoder: JSONDecoder {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }

    // MARK: - REST

    func healthCheck() async throws -> Bool {
        let (_, response) = try await request("GET", path: "/api/health")
        return (response as? HTTPURLResponse)?.statusCode == 200
    }

    func fetchStats(guildId: String? = nil) async throws -> StatsPayload {
        var path = "/api/stats"
        if let guildId { path += "?guildId=\(guildId)" }
        let (data, _) = try await request("GET", path: path)
        return try decoder.decode(StatsPayload.self, from: data)
    }

    func fetchActions(limit: Int = 200, kinds: [String]? = nil, sinceHours: Int? = nil) async throws -> [ClankyAction] {
        var components = URLComponents(string: "\(baseURL.absoluteString)/api/actions")!
        var queryItems = [URLQueryItem(name: "limit", value: "\(limit)")]
        if let kinds, !kinds.isEmpty {
            queryItems.append(URLQueryItem(name: "kinds", value: kinds.joined(separator: ",")))
        }
        if let sinceHours {
            queryItems.append(URLQueryItem(name: "sinceHours", value: "\(sinceHours)"))
        }
        components.queryItems = queryItems

        var req = URLRequest(url: components.url!)
        req.setValue(token, forHTTPHeaderField: "x-dashboard-token")
        let (data, _) = try await URLSession.shared.data(for: req)
        return try decoder.decode([ClankyAction].self, from: data)
    }

    // MARK: - SSE Streams

    func activitySSE() -> SSEClient {
        SSEClient(
            url: baseURL.appendingPathComponent("/api/activity/events"),
            headers: ["x-dashboard-token": token]
        )
    }

    func voiceSSE() -> SSEClient {
        SSEClient(
            url: baseURL.appendingPathComponent("/api/voice/events"),
            headers: ["x-dashboard-token": token]
        )
    }

    // MARK: - Private

    private func request(_ method: String, path: String) async throws -> (Data, URLResponse) {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = method
        req.setValue(token, forHTTPHeaderField: "x-dashboard-token")
        req.timeoutInterval = 15
        return try await URLSession.shared.data(for: req)
    }
}
