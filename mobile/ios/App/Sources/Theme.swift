import SwiftUI

/// Colors from the Clocked web dashboard (worker/src/dashboard.ts).
enum Palette {
    static let background = Color(hex: 0x0A0B10)
    static let panel = Color(hex: 0x151823)
    static let panelInset = Color(hex: 0x10121A)
    static let border = Color(hex: 0x242938)
    static let text = Color(hex: 0xE9EAF0)
    static let muted = Color(hex: 0x8B91A0)
    static let amber = Color(hex: 0xF2A950)
    static let amberDeep = Color(hex: 0xFF8A3D)
    static let ok = Color(hex: 0x5BD6A2)
    static let error = Color(hex: 0xFF7070)
}

extension Color {
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}

struct Panel<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title.uppercased())
                .font(.caption.weight(.semibold))
                .tracking(0.8)
                .foregroundStyle(Palette.muted)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Palette.panel, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Palette.border, lineWidth: 1))
    }
}

struct AmberButtonStyle: ButtonStyle {
    var prominent = true

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .padding(.vertical, 10)
            .padding(.horizontal, 14)
            .frame(maxWidth: .infinity)
            .foregroundStyle(prominent ? Palette.background : Palette.text)
            .background(
                prominent
                    ? AnyShapeStyle(LinearGradient(colors: [Palette.amber, Palette.amberDeep], startPoint: .leading, endPoint: .trailing))
                    : AnyShapeStyle(Palette.panelInset),
                in: RoundedRectangle(cornerRadius: 10)
            )
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(prominent ? Color.clear : Palette.border, lineWidth: 1))
            .opacity(configuration.isPressed ? 0.8 : 1)
    }
}

enum Format {
    static func duration(_ seconds: Int) -> String {
        let minutes = seconds / 60
        return String(format: "%d:%02d", minutes / 60, minutes % 60)
    }
}
