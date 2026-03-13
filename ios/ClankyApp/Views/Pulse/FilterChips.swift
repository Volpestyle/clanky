import SwiftUI

/// Horizontally scrolling filter chips for action domains.
struct FilterChips: View {
    @Binding var selected: FilterDomain

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(FilterDomain.allCases) { domain in
                    FilterChip(
                        label: domain.label,
                        isSelected: selected == domain
                    ) {
                        withAnimation(.spring(response: 0.25, dampingFraction: 0.9)) {
                            selected = domain
                        }
                    }
                }
            }
            .padding(.horizontal, 16)
        }
    }
}

private struct FilterChip: View {
    let label: String
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 10, weight: isSelected ? .bold : .medium, design: .monospaced))
                .tracking(0.6)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(isSelected ? Color.primary.opacity(0.1) : .clear)
                .foregroundStyle(isSelected ? .primary : .secondary)
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .strokeBorder(
                            isSelected ? Color.primary.opacity(0.2) : Color.primary.opacity(0.06),
                            lineWidth: 0.5
                        )
                )
        }
        .buttonStyle(.plain)
    }
}
