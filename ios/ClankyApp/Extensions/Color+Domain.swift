import SwiftUI

extension Color {
    init(hex: UInt32, opacity: Double = 1.0) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255.0,
            green: Double((hex >> 8) & 0xFF) / 255.0,
            blue: Double(hex & 0xFF) / 255.0,
            opacity: opacity
        )
    }

    // Semantic colors for positive/negative values
    static let positive = Color(hex: 0x16A34A)
    static let negative = Color(hex: 0xDC2626)

    // Domain accent colors
    static let domainVoice = Color(hex: 0x475569)
    static let domainLLM = Color(hex: 0x6D28D9)
    static let domainTool = Color(hex: 0x059669)
    static let domainMemory = Color(hex: 0x78716C)
    static let domainError = Color(hex: 0xDC2626)
    static let domainText = Color(hex: 0x374151)
    static let domainMedia = Color(hex: 0xBE185D)
    static let domainSystem = Color(hex: 0x9CA3AF)
    static let domainBrowser = Color(hex: 0x4338CA)
    static let domainDiscovery = Color(hex: 0x0D9488)
}
