import Foundation

/// Lightweight Server-Sent Events parser with auto-reconnect.
/// Uses URLSession bytes streaming — no third-party dependencies.
actor SSEClient {
    struct Event {
        let name: String
        let data: String
    }

    private let url: URL
    private let headers: [String: String]
    private let reconnectDelay: TimeInterval
    private let maxReconnectDelay: TimeInterval

    private var task: Task<Void, Never>?
    private var currentAttempt: Int = 0

    init(
        url: URL,
        headers: [String: String] = [:],
        reconnectDelay: TimeInterval = 3,
        maxReconnectDelay: TimeInterval = 30
    ) {
        self.url = url
        self.headers = headers
        self.reconnectDelay = reconnectDelay
        self.maxReconnectDelay = maxReconnectDelay
    }

    /// Yields SSE events as they arrive. Auto-reconnects on failure.
    func events() -> AsyncStream<Event> {
        AsyncStream { continuation in
            let streamTask = Task {
                while !Task.isCancelled {
                    do {
                        try await streamEvents(into: continuation)
                    } catch is CancellationError {
                        break
                    } catch {
                        let delay = min(
                            reconnectDelay * pow(2, Double(currentAttempt)),
                            maxReconnectDelay
                        )
                        currentAttempt += 1
                        try? await Task.sleep(for: .seconds(delay))
                    }
                }
                continuation.finish()
            }

            continuation.onTermination = { _ in
                streamTask.cancel()
            }
        }
    }

    private func streamEvents(into continuation: AsyncStream<Event>.Continuation) async throws {
        var request = URLRequest(url: url)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        for (key, value) in headers {
            request.setValue(value, forHTTPHeaderField: key)
        }
        request.timeoutInterval = 300

        let (bytes, response) = try await URLSession.shared.bytes(for: request)

        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw SSEError.badStatus
        }

        // Reset reconnect backoff on successful connection
        currentAttempt = 0

        var eventName = ""
        var dataBuffer = ""

        for try await line in bytes.lines {
            if Task.isCancelled { break }

            if line.isEmpty {
                // Empty line = event boundary
                if !dataBuffer.isEmpty {
                    let name = eventName.isEmpty ? "message" : eventName
                    let data = dataBuffer.hasSuffix("\n")
                        ? String(dataBuffer.dropLast())
                        : dataBuffer
                    continuation.yield(Event(name: name, data: data))
                }
                eventName = ""
                dataBuffer = ""
                continue
            }

            if line.hasPrefix(":") {
                // Comment line (heartbeat), skip
                continue
            }

            if line.hasPrefix("event:") {
                eventName = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:") {
                let value = String(line.dropFirst(5))
                let trimmed = value.hasPrefix(" ") ? String(value.dropFirst()) : value
                dataBuffer += trimmed + "\n"
            }
        }
    }

    enum SSEError: Error {
        case badStatus
    }
}
