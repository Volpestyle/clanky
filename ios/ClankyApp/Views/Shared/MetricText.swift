import SwiftUI

/// Animated metric display with numeric content transition.
struct MetricText: View {
    let value: String
    var size: CGFloat = 24
    var weight: Font.Weight = .bold

    var body: some View {
        Text(value)
            .font(.system(size: size, weight: weight, design: .monospaced))
            .contentTransition(.numericText())
            .animation(.spring(response: 0.3, dampingFraction: 0.8), value: value)
    }
}

/// Displays a cost value with dollar sign and color coding.
struct CostText: View {
    let amount: Double
    var size: CGFloat = 13

    var body: some View {
        Text(formatted)
            .font(.system(size: size, weight: .medium, design: .monospaced))
            .foregroundStyle(amount > 0 ? Color.primary : .secondary)
            .contentTransition(.numericText())
            .animation(.spring(response: 0.3, dampingFraction: 0.8), value: amount)
    }

    private var formatted: String {
        if amount < 0.01 && amount > 0 {
            return String(format: "$%.4f", amount)
        }
        return String(format: "$%.2f", amount)
    }
}

/// Formats a token count compactly (1,247 → "1.2k").
func formatTokenCount(_ count: Int) -> String {
    if count >= 1000 {
        return String(format: "%.1fk", Double(count) / 1000)
    }
    return "\(count)"
}
