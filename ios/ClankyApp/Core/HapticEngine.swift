import UIKit

/// Centralized haptic feedback mapped to Clanky event types.
@MainActor
enum HapticEngine {
    private static let lightImpact = UIImpactFeedbackGenerator(style: .light)
    private static let mediumImpact = UIImpactFeedbackGenerator(style: .medium)
    private static let heavyImpact = UIImpactFeedbackGenerator(style: .heavy)
    private static let notification = UINotificationFeedbackGenerator()

    static func prepare() {
        lightImpact.prepare()
        mediumImpact.prepare()
        notification.prepare()
    }

    static func onAction(_ kind: String) {
        let domain = ActionDomain.from(kind: kind)
        switch domain {
        case .error:
            mediumImpact.impactOccurred()
            notification.notificationOccurred(.warning)
        case .voice where kind == "voice_session_start" || kind == "voice_session_end":
            notification.notificationOccurred(.success)
        case .tool where kind == "llm_tool_call":
            lightImpact.impactOccurred(intensity: 0.6)
        default:
            lightImpact.impactOccurred(intensity: 0.4)
        }
    }

    static func onDirectAddress() {
        heavyImpact.impactOccurred()
    }

    static func onError() {
        notification.notificationOccurred(.error)
    }
}
