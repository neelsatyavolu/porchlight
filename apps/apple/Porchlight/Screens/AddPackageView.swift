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

    private var lines: [ParsedNumber] { NumberInput.parse(text, detector: services.detector) }

    var body: some View {
        let lines = lines
        Form {
            Section {
                TextField("Tracking number", text: $text, prompt: Text("1Z999AA10123456784"), axis: .vertical)
                    .lineLimit(1...8)
                    .porchMono()
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.characters)
                    #endif
                    .focused($numbersFocused)
                    .onChange(of: text) { _, new in
                        formError = nil
                        if new != keptText { errors = [:] }
                    }
                #if os(iOS)
                if LabelScanner.isAvailable {
                    Button("Scan a label", systemImage: "barcode.viewfinder") { scanning = true }
                }
                #endif
            } header: {
                Text("Tracking number")
            } footer: {
                Text("Paste one, or several with one per line.")
            }

            if let formError {
                Section { ErrorLine(formError) }
            }

            ForEach(lines) { line in
                Section {
                    lineView(line)
                }
            }

            if lines.count <= 1 {
                Section("Title") {
                    TextField("Title", text: $title, prompt: Text("Optional, like Headphones"))
                        .font(PorchFont.body)
                }
            }
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
        .background(PorchColor.canvas)
        .porchChrome()
        .navigationTitle("Add a package")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { onDone(nil) }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button(NumberInput.submitLabel(count: lines.count)) { Task { await submit(lines) } }
                    .buttonStyle(.borderedProminent)
                    .disabled(saving)
            }
        }
        .disabled(saving)
        .onAppear { numbersFocused = true }
        #if os(iOS)
        .sheet(isPresented: $scanning) {
            LabelScannerSheet { payload in text = NumberInput.appending(payload, to: text) }
        }
        #endif
    }

    @ViewBuilder
    private func lineView(_ line: ParsedNumber) -> some View {
        VStack(alignment: .leading, spacing: PorchSpacing.xs) {
            if lines.count > 1 {
                Text(line.number).porchMono().foregroundStyle(PorchColor.ink).lineLimit(1)
            }
            if line.candidates.count > 1 {
                Picker("Carrier", selection: pickBinding(line)) {
                    Text("Pick a carrier").tag(Carrier?.none)
                    ForEach(line.candidates, id: \.carrier) { candidate in
                        Text(candidate.carrier.displayName).tag(Carrier?.some(candidate.carrier))
                    }
                }
                .pickerStyle(.inline)
                .labelsHidden()
            } else if let only = line.candidates.first {
                HStack(spacing: PorchSpacing.xs) {
                    CarrierBadge(only.carrier)
                    if only.confidence != .high {
                        Text("Best guess").font(PorchFont.caption).foregroundStyle(PorchColor.mute)
                    }
                }
            }
            if let hint = NumberInput.hint(line) {
                Text(hint).font(PorchFont.caption).foregroundStyle(PorchColor.mute)
            }
            if let error = errors[line.number] { ErrorLine(error) }
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

#if DEBUG // ScreenServices.preview() exists only in Debug builds.
#Preview {
    NavigationStack { AddPackageView { _ in } }.environment(ScreenServices.preview())
}
#endif
