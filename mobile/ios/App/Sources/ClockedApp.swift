import SwiftUI

@main
struct ClockedApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(model)
                .preferredColorScheme(.dark)
                .tint(Palette.amber)
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.refresh() } }
        }
        // Background refresh extends monitoring and uploads queued totals. iOS
        // decides when, or whether, it runs; when it expires the task is
        // cancelled, which cancels the upload and keeps the queue.
        .backgroundTask(.appRefresh(AppModel.refreshTaskID)) {
            await model.refresh()
        }
    }
}
