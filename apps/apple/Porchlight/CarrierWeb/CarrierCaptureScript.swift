import Foundation
import PorchKit

/// The script the carrier web view injects at document start in every frame
/// (docs/research/scraping.md). It wraps `fetch` and `XMLHttpRequest` and,
/// for a request whose URL contains a capture pattern (UPS GetStatus, FedEx
/// track/v2/shipments),
/// posts `{url, status, body}` to the `porchlightCapture` handler, checking
/// the final URL again and dropping bodies over CarrierPages.maxCaptureBytes.
/// It reads nothing else (no cookies, no storage) and changes no request.
enum CarrierCaptureScript {
    static let handlerName = "porchlightCapture"

    /// One script for every device carrier: the web view is shared, and the
    /// engine checks each capture against the job's carrier.
    static var source: String {
        let patterns = Carrier.deviceCarriers.sorted { $0.rawValue < $1.rawValue }.flatMap(CarrierPages.captureURLPatterns(for:))
        let list = (try? JSONEncoder().encode(patterns)).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        return template
            .replacingOccurrences(of: "__PATTERNS__", with: list)
            .replacingOccurrences(of: "__HANDLER__", with: handlerName)
            .replacingOccurrences(of: "__MAX_CHARS__", with: String(CarrierPages.maxCaptureBytes))
    }

    private static let template = #"""
    (function () {
      if (window.__porchlightCapture) { return; }
      window.__porchlightCapture = true;
      var patterns = __PATTERNS__;
      function matches(url) {
        var u = String(url || "");
        for (var i = 0; i < patterns.length; i++) { if (u.indexOf(patterns[i]) !== -1) { return true; } }
        return false;
      }
      var maxChars = __MAX_CHARS__;
      function post(url, status, body) {
        if (!matches(url)) { return; }
        var text = String(body || "");
        if (text.length > maxChars) { return; }
        try {
          window.webkit.messageHandlers.__HANDLER__.postMessage({ url: String(url || ""), status: Number(status) || 0, body: text });
        } catch (e) {}
      }
      var originalFetch = window.fetch;
      if (typeof originalFetch === "function") {
        window.fetch = function (input, init) {
          var url = typeof input === "string" ? input : (input && input.url) || "";
          var result = originalFetch.apply(this, arguments);
          if (matches(url)) {
            result.then(function (response) {
              response.clone().text().then(function (text) { post(response.url || url, response.status, text); }, function () {});
            }, function () {});
          }
          return result;
        };
      }
      var open = XMLHttpRequest.prototype.open;
      var send = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, url) {
        this.__porchlightURL = url;
        return open.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function () {
        var xhr = this;
        if (matches(xhr.__porchlightURL)) {
          xhr.addEventListener("loadend", function () {
            var body = "";
            try {
              body = (xhr.responseType === "" || xhr.responseType === "text") ? xhr.responseText : JSON.stringify(xhr.response);
            } catch (e) {}
            post(xhr.responseURL || xhr.__porchlightURL, xhr.status, body);
          });
        }
        return send.apply(this, arguments);
      };
    })();
    """#

    /// True once USPS has rendered its tracking layout.
    static let uspsReady = "document.querySelector('.track-bar-container') !== null"

    /// FedEx: when the page hasn't asked for the shipment by itself, type the
    /// number into its own search field and submit, as a person would.
    static func fedExSubmit(_ number: String) -> String {
        let quoted = (try? String(data: JSONEncoder().encode(number), encoding: .utf8)) ?? "\"\""
        return """
        (function () {
          var input = document.querySelector('input[name=trackingnumber]');
          if (!input) { return false; }
          input.focus();
          input.value = \(quoted);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          var form = input.form;
          if (form && form.requestSubmit) { form.requestSubmit(); } else if (form) { form.submit(); }
          return true;
        })();
        """
    }
}
