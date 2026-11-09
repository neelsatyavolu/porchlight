import PorchKit
import PorchUI
import SwiftUI

/// Add by paste or scan (DESIGN.md §7 "Add"). One number per line; each shows
/// the carriers the detector finds, and an ambiguous number needs a pick. A
/// title can be given when adding just one.
struct AddPackageView: View {
    /// Called when done: the new package's id when exactly one was added, else nil.
    var onDone: (String?) -> Void

    @Environment(ScreenServices.self) private var services
    /// Absent in previews.
    @Environment(PushController.self) private var push: PushController?
    @State private var text = ""
    @State private var title = ""
    @State private var picks: [String: Carrier] = [:]
    @State private var errors: [String: String] = [:]
    @State private var formError: String?
    @State private var saving = false
    @State private var scanning = false
    /// The text left after a failed submit, so its errors survive the edit that set it.
    @State private var keptText: String?
    @FocusState private var numbersFocused: Bool
    @FocusState private var titleFocused: Bool

    /// `text` prefills the numbers field (snapshots and previews).
    init(text: String = "", onDone: @escaping (String?) -> Void) {
        _text = State(initialValue: text)
        self.onDone = onDone
    }

    private var lines: [ParsedNumber] { NumberInput.parse(text, detector: services.detector) }

    private var canScan: Bool {
        #if os(iOS)
        LabelScanner.isAvailable
        #else
        false
        #endif
    }

    /// The iPhone's navigation bar has room for "Track" or "Track 4" next to
    /// the inline title, not "Track 4 packages".
    private func submitLabel(count: Int) -> String {
        #if os(iOS)
        count > 1 ? "Track \(count)" : "Track"
        #else
        NumberInput.submitLabel(count: count)
        #endif
    }

    var body: some View {
        let lines = lines
        PorchForm {
            Section {
                TextField("Tracking number", text: $text, prompt: Text(verbatim: "1Z999AA10123456784").foregroundStyle(PorchColor.mute), axis: .vertical)
                    .lineLimit(1...8)
                    // The section header names the field; the text starts at the left edge.
                    .labelsHidden()
                    .multilineTextAlignment(.leading)
                    .porchMono()
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.characters)
                    #endif
                    .porchInput(focused: numbersFocused)
                    .focused($numbersFocused)
                    .onChange(of: text) { _, new in
                        formError = nil
                        if new != keptText { errors = [:] }
                    }
            } header: {
                Text(lines.count > 1 ? "Tracking numbers" : "Tracking number")
            } footer: {
                // Once several are in, the list below shows it worked.
                if lines.count <= 1 {
                    Text("Paste one, or several with one per line.")
                }
            }

            // What each number is, right under the field it was typed in.
            if !lines.isEmpty || canScan {
                Section {
                    ForEach(lines) { line in
                        carrierRow(line, several: lines.count > 1)
                    }
                    #if os(iOS)
                    if canScan {
                        Button("Scan a label", systemImage: "barcode.viewfinder") { scanning = true }
                    }
                    #endif
                }
            }

            if let formError {
                Section { ErrorLine(formError) }
            }

            if lines.count <= 1 {
                Section("Name (optional)") {
                    TextField("Name", text: $title, prompt: Text(verbatim: "Headphones").foregroundStyle(PorchColor.mute))
                        .labelsHidden()
                        .multilineTextAlignment(.leading)
                        .font(PorchFont.body)
                        .porchInput(focused: titleFocused)
                        .focused($titleFocused)
                    }
            }
        }
        .porchChrome()
        .navigationTitle("Add a package")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .sheetActions(
            cancel: SheetButton("Cancel") { onDone(nil) },
            primary: SheetButton(submitLabel(count: lines.count), disabled: saving) { Task { await submit(lines) } }
        )
        .disabled(saving)
        .onAppear { numbersFocused = true }
        #if os(iOS)
        .sheet(isPresented: $scanning) {
            LabelScannerSheet { payload in text = NumberInput.appending(payload, to: text) }
        }
        #endif
    }

    /// One detected number: "Carrier" (or the number, when there are several)
    /// on the left, the carrier on the right, and any hint or error under the label.
    private func carrierRow(_ line: ParsedNumber, several: Bool) -> some View {
        LabeledContent {
            carrierValue(line)
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                if several {
                    Text(line.number).porchMono().foregroundStyle(PorchColor.ink).lineLimit(1).truncationMode(.middle)
                } else {
                    Text("Carrier").foregroundStyle(PorchColor.ink)
                }
                if let hint = NumberInput.hint(line) {
                    Text(hint).font(PorchFont.caption).foregroundStyle(PorchColor.mute)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let error = errors[line.number] { ErrorLine(error) }
            }
        }
    }

    /// Every carrier value is a chip, so their right edges line up: the
    /// carrier, "Unknown", or for an ambiguous number a chip that opens a menu.
    @ViewBuilder
    private func carrierValue(_ line: ParsedNumber) -> some View {
        if line.candidates.count > 1 {
            let pick = pickBinding(line)
            Menu {
                Picker("Carrier for \(line.number)", selection: pick) {
                    ForEach(line.candidates, id: \.carrier) { candidate in
                        Text(candidate.carrier.displayName).tag(Carrier?.some(candidate.carrier))
                    }
                }
                .pickerStyle(.inline)
                .labelsHidden()
            } label: {
                HStack(spacing: PorchSpacing.xxs) {
                    Text(pick.wrappedValue?.displayName ?? "Pick a carrier")
                    Image(systemName: "chevron.up.chevron.down").imageScale(.small)
                }
                .modifier(Chip(color: PorchColor.ink))
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .menuIndicator(.hidden)
            .fixedSize()
            .accessibilityLabel("Carrier for \(line.number)")
        } else if let only = line.candidates.first {
            HStack(spacing: PorchSpacing.xs) {
                if only.confidence != .high {
                    Text("Best guess").font(PorchFont.caption).foregroundStyle(PorchColor.mute)
                }
                CarrierBadge(only.carrier)
            }
        } else {
            Text("Unknown").modifier(Chip(color: PorchColor.mute))
        }
    }

    private func pickBinding(_ line: ParsedNumber) -> Binding<Carrier?> {
        Binding(
            get: { picks[line.number] ?? line.preselected },
            set: { picks[line.number] = $0 }
        )
    }

    private func carrier(for line: ParsedNumber) -> Carrier? {
        picks[line.number] ?? line.preselected ?? (line.candidates.count == 1 ? line.candidates.first?.carrier : nil)
    }

    private func submit(_ lines: [ParsedNumber]) async {
        guard !saving else { return }
        if let message = NumberInput.formError(lines) {
            formError = message
            return
        }
        var invalid: [String: String] = [:]
        for line in lines {
            if let message = NumberInput.lineError(line, carrier: carrier(for: line)) { invalid[line.number] = message }
        }
        errors = invalid
        guard invalid.isEmpty else { return }

        saving = true
        defer { saving = false }
        let single = lines.count == 1
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        var failed: [String: String] = [:]
        var last: AddedPackage?
        for line in lines {
            do {
                last = try await services.sync.addPackage(
                    trackingNumber: line.number,
                    carrier: carrier(for: line),
                    title: single && !trimmedTitle.isEmpty ? trimmedTitle : nil,
                    source: .manual
                )
            } catch {
                failed[line.number] = "Couldn't add this number. \(ErrorText.sentence(error))"
            }
        }
        services.didChange()
        if last != nil { push?.packageAdded() }

        if !failed.isEmpty {
            // Keep only what failed, so trying again doesn't add the rest twice.
            let remaining = lines.filter { failed[$0.number] != nil }.map(\.number).joined(separator: "\n")
            keptText = remaining
            text = remaining
            errors = failed
            return
        }
        // A 409 duplicate goes straight to the existing package (DESIGN.md §7 "Add").
        if single, let last, last.alreadyTracked { services.leaveNote("You're already tracking this.", for: last.id) }
        onDone(single ? last?.id : nil)
    }
}

/// CarrierBadge's chip (12pt text, 20pt tall, Line2 hairline, 6pt radius) for
/// values that aren't a carrier.
private struct Chip: ViewModifier {
    var color: Color

    func body(content: Content) -> some View {
        content
            .font(PorchFont.caption)
            .foregroundStyle(color)
            .lineLimit(1)
            .padding(.horizontal, 6)
            .frame(minHeight: 20)
            .overlay(
                RoundedRectangle(cornerRadius: PorchRadius.badge, style: .continuous)
                    .strokeBorder(PorchColor.line2, lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: PorchRadius.badge, style: .continuous))
    }
}

#if DEBUG // ScreenServices.preview() exists only in Debug builds.
#Preview {
    NavigationStack { AddPackageView { _ in } }.environment(ScreenServices.preview())
}
#endif
