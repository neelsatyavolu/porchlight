import AuthenticationServices
import PorchKit
import PorchUI
import SwiftUI

/// Sign-in (DESIGN.md §7): the wordmark, Sign in with Apple, and email with a
/// 6-digit code. The emailed link also works on the web; in the app the code
/// is the path, since the link opens in a browser until universal links land.
struct SignInView: View {
    @Environment(ScreenServices.self) private var services
    @Environment(\.colorScheme) private var colorScheme

    private enum Step: Equatable {
        case email
        case code(sentTo: String)
    }

    @State private var step = Step.email
    @State private var email = ""
    @State private var code = ""
    @State private var nonce: AppleNonce?
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PorchSpacing.l) {
                VStack(alignment: .leading, spacing: PorchSpacing.s) {
                    Text("Porchlight")
                        .font(PorchFont.display)
                        .tracking(-0.96)
                        .foregroundStyle(PorchColor.ink)
                        .accessibilityAddTraits(.isHeader)
                    Text("Sign in to see your packages on any device.")
                        .font(PorchFont.body)
                        .foregroundStyle(PorchColor.body)
                }
                switch step {
                case .email: emailStep
                case let .code(sentTo): codeStep(sentTo)
                }
                if let error { ErrorLine(error) }
            }
            .frame(maxWidth: 360, alignment: .leading)
            .padding(.horizontal, PorchSpacing.l)
            .padding(.top, PorchSpacing.page)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(PorchColor.canvas)
        .disabled(busy)
    }

    // MARK: Email

    private var emailStep: some View {
        VStack(alignment: .leading, spacing: PorchSpacing.m) {
            // The Mac app ships with Developer ID, which can't carry the Sign in with Apple
            // entitlement, so Mac users sign in by email only.
            #if os(iOS)
            SignInWithAppleButton(.signIn) { request in
                let fresh = AppleNonce.make()
                nonce = fresh
                request.requestedScopes = [.email]
                request.nonce = fresh.hashed
            } onCompletion: { result in
                Task { await finishApple(result) }
            }
            .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
            .frame(height: 44)

            Text("Or use your email")
                .font(PorchFont.caption)
                .foregroundStyle(PorchColor.mute)
                .padding(.top, PorchSpacing.xs)
            #endif

            TextField("Email", text: $email, prompt: Text("you@example.com"))
                .labelsHidden()
                .accessibilityLabel("Email")
                .textContentType(.emailAddress)
                #if os(iOS)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                #endif
                .autocorrectionDisabled()
                .font(PorchFont.body)
                .textFieldStyle(.roundedBorder)
                .focused($focused)
                .onSubmit { Task { await sendEmail() } }

            Button {
                Task { await sendEmail() }
            } label: {
                Text("Email me a code").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
        }
    }

    // MARK: Code

    private func codeStep(_ sentTo: String) -> some View {
        VStack(alignment: .leading, spacing: PorchSpacing.m) {
            VStack(alignment: .leading, spacing: PorchSpacing.xxs) {
                Text("Check your email")
                    .font(PorchFont.heading)
                    .foregroundStyle(PorchColor.ink)
                Text("We sent a 6-digit code to")
                    .font(PorchFont.body)
                    .foregroundStyle(PorchColor.body)
                Text(sentTo)
                    .font(PorchFont.body)
                    .foregroundStyle(PorchColor.ink)
            }

            TextField("Code", text: $code, prompt: Text("123456"))
                .labelsHidden()
                .accessibilityLabel("Code from the email")
                .textContentType(.oneTimeCode)
                #if os(iOS)
                .keyboardType(.numberPad)
                #endif
                .porchMono(size: 22)
                .textFieldStyle(.roundedBorder)
                .focused($focused)
                .onChange(of: code) { _, new in
                    let clean = SignInText.cleanCode(new)
                    if clean != new { code = clean }
                    if SignInText.isCompleteCode(clean) { Task { await verify(sentTo) } }
                }
                .onAppear { focused = true }

            Button {
                Task { await verify(sentTo) }
            } label: {
                Text("Sign in").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(!SignInText.isCompleteCode(code))

            Button("Use a different email") {
                step = .email
                code = ""
                error = nil
            }
            .buttonStyle(.borderless)
        }
    }

    // MARK: Actions

    private func finishApple(_ result: Result<ASAuthorization, any Error>) async {
        error = nil
        // One nonce per attempt: take it so a second completion can't reuse it.
        let nonce = self.nonce
        self.nonce = nil
        switch result {
        case let .failure(failure):
            // The user closing the Apple sheet is not an error worth a sentence.
            if (failure as? ASAuthorizationError)?.code == .canceled { return }
            error = "Sign in with Apple didn't finish. Try again, or use your email."
        case let .success(authorization):
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential, let nonce else {
                error = "Sign in with Apple didn't finish. Try again, or use your email."
                return
            }
            busy = true
            defer { busy = false }
            do {
                try await services.account.signInWithApple(identityToken: credential.identityToken, nonce: nonce)
            } catch {
                self.error = ErrorText.sentence(error)
            }
        }
    }

    private func sendEmail() async {
        let address = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard SignInText.isPlausibleEmail(address) else {
            error = "Enter your email address, like you@example.com."
            return
        }
        error = nil
        busy = true
        defer { busy = false }
        do {
            try await services.account.startEmail(address)
            code = ""
            step = .code(sentTo: address)
        } catch {
            self.error = ErrorText.sentence(error)
        }
    }

    private func verify(_ address: String) async {
        guard !busy, SignInText.isCompleteCode(code) else { return }
        error = nil
        busy = true
        defer { busy = false }
        do {
            try await services.account.verifyEmail(email: address, code: code)
        } catch {
            if (error as? APIError)?.code == .unauthorized {
                self.error = "That code didn't work. It may have expired. Check the newest email, or send a new one."
            } else {
                self.error = ErrorText.sentence(error)
            }
            code = ""
        }
    }
}

#if DEBUG // ScreenServices.preview() exists only in Debug builds.
#Preview { SignInView().environment(ScreenServices.preview(signedIn: false)) }
#endif
