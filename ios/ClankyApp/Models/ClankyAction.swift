import Foundation
import SwiftUI

// MARK: - Action Domain

enum ActionDomain: String, CaseIterable, Sendable {
    case voice
    case llm
    case tool
    case memory
    case error
    case text
    case media
    case system
    case browser
    case discovery
    case asr
    case tts
    case code
    case automation
    case initiative

    var color: Color {
        switch self {
        case .voice:      Color(hex: 0x475569)
        case .llm:        Color(hex: 0x6D28D9)
        case .tool:       Color(hex: 0x059669)
        case .memory:     Color(hex: 0x78716C)
        case .error:      Color(hex: 0xDC2626)
        case .text:       Color(hex: 0x374151)
        case .media:      Color(hex: 0xBE185D)
        case .system:     Color(hex: 0x9CA3AF)
        case .browser:    Color(hex: 0x4338CA)
        case .discovery:  Color(hex: 0x0D9488)
        case .asr:        Color(hex: 0x475569)
        case .tts:        Color(hex: 0x475569)
        case .code:       Color(hex: 0x4338CA)
        case .automation: Color(hex: 0x0D9488)
        case .initiative: Color(hex: 0x0D9488)
        }
    }

    var label: String {
        rawValue.uppercased()
    }

    static func from(kind: String) -> ActionDomain {
        // Error kinds take priority
        if kind.hasSuffix("_error") { return .error }

        // Map by prefix
        if kind.hasPrefix("voice_") { return .voice }
        if kind.hasPrefix("llm_") { return .llm }
        if kind.hasPrefix("memory_") { return .memory }
        if kind.hasPrefix("browser_") { return .browser }
        if kind.hasPrefix("asr_") { return .asr }
        if kind.hasPrefix("tts_") { return .tts }
        if kind.hasPrefix("image_") || kind.hasPrefix("gif_") || kind.hasPrefix("video_") { return .media }
        if kind.hasPrefix("code_") { return .code }
        if kind.hasPrefix("search_") { return .discovery }
        if kind.hasPrefix("automation_") { return .automation }
        if kind.hasPrefix("initiative_") { return .initiative }
        if kind.hasPrefix("discovery_") { return .discovery }

        // Specific kinds
        switch kind {
        case "sent_reply", "reply_skipped", "text_runtime", "direct":
            return .text
        case "speech":
            return .tts
        case "tiktok", "youtube", "url":
            return .media
        case "bot_error", "bot_warning":
            return .error
        case "stream_discovery":
            return .voice
        default:
            return .system
        }
    }
}

// MARK: - Filter Domain (UI-facing subset)

enum FilterDomain: String, CaseIterable, Identifiable, Sendable {
    case all
    case llm
    case voice
    case tool
    case memory
    case error
    case text
    case media
    case browser

    var id: String { rawValue }

    var label: String {
        rawValue.uppercased()
    }

    func matches(_ domain: ActionDomain) -> Bool {
        switch self {
        case .all: true
        case .llm: domain == .llm
        case .voice: domain == .voice || domain == .asr || domain == .tts
        case .tool: domain == .tool
        case .memory: domain == .memory
        case .error: domain == .error
        case .text: domain == .text
        case .media: domain == .media
        case .browser: domain == .browser
        }
    }
}

// MARK: - Action Model

struct ClankyAction: Codable, Identifiable, Sendable {
    let id: Int
    let createdAt: String?
    let guildId: String?
    let channelId: String?
    let messageId: String?
    let userId: String?
    let kind: String
    let content: String?
    let metadata: [String: JSONValue]?
    let usdCost: Double?

    var domain: ActionDomain {
        ActionDomain.from(kind: kind)
    }

    var date: Date? {
        guard let createdAt else { return nil }
        return ISO8601DateFormatter().date(from: createdAt)
    }

    // MARK: - Metadata accessors

    var model: String? {
        metadata?["model"]?.stringValue
    }

    var provider: String? {
        metadata?["provider"]?.stringValue
    }

    var toolNames: [String]? {
        metadata?["toolNames"]?.arrayValue?.compactMap(\.stringValue)
    }

    var toolCallCount: Int? {
        metadata?["toolCallCount"]?.intValue
    }

    var stopReason: String? {
        metadata?["stopReason"]?.stringValue
    }

    var inputTokens: Int? {
        if let usage = metadata?["usage"] {
            return usage.objectValue?["inputTokens"]?.intValue
                ?? usage.objectValue?["input_tokens"]?.intValue
        }
        return nil
    }

    var outputTokens: Int? {
        if let usage = metadata?["usage"] {
            return usage.objectValue?["outputTokens"]?.intValue
                ?? usage.objectValue?["output_tokens"]?.intValue
        }
        return nil
    }

    var cachedInputTokens: Int? {
        if let usage = metadata?["usage"] {
            return usage.objectValue?["cacheReadInputTokens"]?.intValue
                ?? usage.objectValue?["cache_read_input_tokens"]?.intValue
        }
        return nil
    }

    // CodingKeys to handle both snake_case and camelCase from API
    enum CodingKeys: String, CodingKey {
        case id
        case createdAt = "created_at"
        case guildId = "guild_id"
        case channelId = "channel_id"
        case messageId = "message_id"
        case userId = "user_id"
        case kind
        case content
        case metadata
        case usdCost = "usd_cost"
    }
}

// MARK: - JSON Value (type-erased Codable)

enum JSONValue: Codable, Sendable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    var stringValue: String? {
        if case .string(let v) = self { return v }
        return nil
    }

    var intValue: Int? {
        switch self {
        case .int(let v): return v
        case .double(let v): return Int(v)
        default: return nil
        }
    }

    var doubleValue: Double? {
        switch self {
        case .double(let v): return v
        case .int(let v): return Double(v)
        default: return nil
        }
    }

    var boolValue: Bool? {
        if case .bool(let v) = self { return v }
        return nil
    }

    var objectValue: [String: JSONValue]? {
        if case .object(let v) = self { return v }
        return nil
    }

    var arrayValue: [JSONValue]? {
        if case .array(let v) = self { return v }
        return nil
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let v = try? container.decode(Bool.self) {
            self = .bool(v)
        } else if let v = try? container.decode(Int.self) {
            self = .int(v)
        } else if let v = try? container.decode(Double.self) {
            self = .double(v)
        } else if let v = try? container.decode(String.self) {
            self = .string(v)
        } else if let v = try? container.decode([String: JSONValue].self) {
            self = .object(v)
        } else if let v = try? container.decode([JSONValue].self) {
            self = .array(v)
        } else {
            self = .null
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let v): try container.encode(v)
        case .int(let v): try container.encode(v)
        case .double(let v): try container.encode(v)
        case .bool(let v): try container.encode(v)
        case .object(let v): try container.encode(v)
        case .array(let v): try container.encode(v)
        case .null: try container.encodeNil()
        }
    }
}
