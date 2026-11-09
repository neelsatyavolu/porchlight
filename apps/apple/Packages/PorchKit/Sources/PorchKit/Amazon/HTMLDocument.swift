import Foundation

/// A small, forgiving HTML reader for the Amazon pages (SPEC §6).
///
/// The app's web view hands over `document.documentElement.outerHTML` and all
/// parsing happens here, so `swift test` covers it against saved pages. It
/// builds a plain element tree: no CSS, no scripts, no spec-exact error
/// recovery. Script and style bodies are skipped, void elements never take
/// children, and a stray end tag closes back to its nearest open match or is
/// ignored.
public final class HTMLNode {
    /// Lowercased tag name; "" for a text node and "#document" for the root.
    public let tag: String
    public let attributes: [String: String]
    /// Decoded text, for text nodes only.
    public let text: String?
    public private(set) var children: [HTMLNode] = []

    init(tag: String, attributes: [String: String] = [:], text: String? = nil) {
        self.tag = tag
        self.attributes = attributes
        self.text = text
    }

    func append(_ child: HTMLNode) { children.append(child) }

    public var isText: Bool { text != nil }

    public subscript(attribute name: String) -> String? { attributes[name] }

    public var classes: [Substring] { (attributes["class"] ?? "").split(whereSeparator: \.isWhitespace) }

    public func hasClass(_ name: String) -> Bool { classes.contains { $0 == name } }

    /// Every element below this one, in document order.
    public func elements(where predicate: (HTMLNode) -> Bool) -> [HTMLNode] {
        var out: [HTMLNode] = []
        var stack: [HTMLNode] = children.reversed()
        while let node = stack.popLast() {
            if !node.isText, predicate(node) { out.append(node) }
            stack.append(contentsOf: node.children.reversed())
        }
        return out
    }

    public func first(where predicate: (HTMLNode) -> Bool) -> HTMLNode? {
        var stack: [HTMLNode] = children.reversed()
        while let node = stack.popLast() {
            if !node.isText, predicate(node) { return node }
            stack.append(contentsOf: node.children.reversed())
        }
        return nil
    }

    public func all(class name: String) -> [HTMLNode] { elements { $0.hasClass(name) } }
    public func first(class name: String) -> HTMLNode? { first { $0.hasClass(name) } }
    public func first(id: String) -> HTMLNode? { first { $0.attributes["id"] == id } }
    public func all(tag name: String) -> [HTMLNode] { elements { $0.tag == name } }

    /// All text below this node, whitespace collapsed to single spaces.
    public var textContent: String {
        var parts: [String] = []
        var stack: [HTMLNode] = [self]
        while let node = stack.popLast() {
            if let t = node.text { parts.append(t) } else { stack.append(contentsOf: node.children.reversed()) }
        }
        return HTMLText.collapse(parts.joined(separator: " "))
    }
}

public enum HTMLDocument {
    static let voidTags: Set<String> = [
        "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
    ]
    static let rawTextTags: Set<String> = ["script", "style", "textarea", "noscript"]

    /// Parses `html` into a tree rooted at a "#document" node. Never fails.
    public static func parse(_ html: String) -> HTMLNode {
        var parser = Parser(bytes: Array(html.utf8))
        return parser.run()
    }

    private struct Parser {
        let bytes: [UInt8]
        var i = 0
        let root = HTMLNode(tag: "#document")
        var stack: [HTMLNode] = []

        init(bytes: [UInt8]) {
            self.bytes = bytes
            stack = [root]
        }

        mutating func run() -> HTMLNode {
            while i < bytes.count {
                if bytes[i] == UInt8(ascii: "<") {
                    tag()
                } else {
                    text()
                }
            }
            return root
        }

        // MARK: Tokens

        private mutating func text() {
            let start = i
            while i < bytes.count, bytes[i] != UInt8(ascii: "<") { i += 1 }
            appendText(start, i)
        }

        private mutating func appendText(_ start: Int, _ end: Int) {
            guard end > start else { return }
            let raw = String(decoding: bytes[start..<end], as: UTF8.self)
            guard raw.contains(where: { !$0.isWhitespace }) else { return }
            stack[stack.count - 1].append(HTMLNode(tag: "", text: HTMLText.decodeEntities(raw)))
        }

        private mutating func tag() {
            let next = i + 1 < bytes.count ? bytes[i + 1] : 0
            if next == UInt8(ascii: "!") {
                if starts(with: "<!--", at: i) {
                    i = find("-->", from: i + 4).map { $0 + 3 } ?? bytes.count
                } else {
                    i = find(">", from: i).map { $0 + 1 } ?? bytes.count
                }
            } else if next == UInt8(ascii: "?") {
                i = find(">", from: i).map { $0 + 1 } ?? bytes.count
            } else if next == UInt8(ascii: "/") {
                endTag()
            } else if isLetter(next) {
                startTag()
            } else {
                // A lone "<" in text.
                let start = i
                i += 1
                while i < bytes.count, bytes[i] != UInt8(ascii: "<") { i += 1 }
                appendText(start, i)
            }
        }

        private mutating func endTag() {
            i += 2
            let name = readName()
            i = find(">", from: i).map { $0 + 1 } ?? bytes.count
            guard !name.isEmpty, let index = stack.lastIndex(where: { $0.tag == name }), index > 0 else { return }
            stack.removeSubrange(index...)
        }

        private mutating func startTag() {
            i += 1
            let name = readName()
            var attributes: [String: String] = [:]
            var selfClosing = false
            while i < bytes.count {
                skipSpace()
                guard i < bytes.count else { break }
                let b = bytes[i]
                if b == UInt8(ascii: ">") { i += 1; break }
                if b == UInt8(ascii: "/") { selfClosing = true; i += 1; continue }
                let key = readAttributeName()
                if key.isEmpty { i += 1; continue }
                skipSpace()
                var value = ""
                if i < bytes.count, bytes[i] == UInt8(ascii: "=") {
                    i += 1
                    skipSpace()
                    value = HTMLText.decodeEntities(readAttributeValue())
                }
                if attributes[key] == nil { attributes[key] = value }
            }
            let node = HTMLNode(tag: name, attributes: attributes)
            closeImplied(by: name)
            stack[stack.count - 1].append(node)
            if HTMLDocument.rawTextTags.contains(name) {
                // Skip the body; the reader has no use for script or style text.
                let close = Array("</\(name)".utf8)
                i = findBytes(close, from: i, caseInsensitive: true).map { j in find(">", from: j).map { $0 + 1 } ?? bytes.count } ?? bytes.count
                return
            }
            if !selfClosing, !HTMLDocument.voidTags.contains(name) { stack.append(node) }
        }

        /// The few implied end tags Amazon's markup leans on: a new <li>, <p>
        /// or <option> closes an open one of the same kind.
        private mutating func closeImplied(by name: String) {
            guard ["li", "p", "option", "tr", "td"].contains(name), let top = stack.last, top.tag == name, stack.count > 1 else { return }
            stack.removeLast()
        }

        // MARK: Scanning

        private func isLetter(_ b: UInt8) -> Bool {
            (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A)
        }

        private mutating func skipSpace() {
            while i < bytes.count, bytes[i] == 0x20 || bytes[i] == 0x0A || bytes[i] == 0x09 || bytes[i] == 0x0D || bytes[i] == 0x0C { i += 1 }
        }

        private mutating func readName() -> String {
            let start = i
            while i < bytes.count {
                let b = bytes[i]
                if b == 0x20 || b == 0x0A || b == 0x09 || b == 0x0D || b == UInt8(ascii: ">") || b == UInt8(ascii: "/") { break }
                i += 1
            }
            return String(decoding: bytes[start..<i], as: UTF8.self).lowercased()
        }

        private mutating func readAttributeName() -> String {
            let start = i
            while i < bytes.count {
                let b = bytes[i]
                if b == 0x20 || b == 0x0A || b == 0x09 || b == 0x0D || b == UInt8(ascii: ">") || b == UInt8(ascii: "/") || b == UInt8(ascii: "=") { break }
                i += 1
            }
            return String(decoding: bytes[start..<i], as: UTF8.self).lowercased()
        }

        private mutating func readAttributeValue() -> String {
            guard i < bytes.count else { return "" }
            let quote = bytes[i]
            if quote == UInt8(ascii: "\"") || quote == UInt8(ascii: "'") {
                let start = i + 1
                var j = start
                while j < bytes.count, bytes[j] != quote { j += 1 }
                i = min(j + 1, bytes.count)
                return String(decoding: bytes[start..<min(j, bytes.count)], as: UTF8.self)
            }
            let start = i
            while i < bytes.count {
                let b = bytes[i]
                if b == 0x20 || b == 0x0A || b == 0x09 || b == 0x0D || b == UInt8(ascii: ">") { break }
                i += 1
            }
            return String(decoding: bytes[start..<i], as: UTF8.self)
        }

        private func starts(with literal: String, at index: Int) -> Bool {
            let lit = Array(literal.utf8)
            guard index + lit.count <= bytes.count else { return false }
            return bytes[index..<index + lit.count].elementsEqual(lit)
        }

        private func find(_ literal: String, from index: Int) -> Int? {
            findBytes(Array(literal.utf8), from: index, caseInsensitive: false)
        }

        private func findBytes(_ needle: [UInt8], from index: Int, caseInsensitive: Bool) -> Int? {
            guard !needle.isEmpty, needle.count <= bytes.count else { return nil }
            var j = index
            let last = bytes.count - needle.count
            while j <= last {
                var k = 0
                while k < needle.count {
                    var a = bytes[j + k], b = needle[k]
                    if caseInsensitive {
                        if a >= 0x41, a <= 0x5A { a += 0x20 }
                        if b >= 0x41, b <= 0x5A { b += 0x20 }
                    }
                    if a != b { break }
                    k += 1
                }
                if k == needle.count { return j }
                j += 1
            }
            return nil
        }
    }
}

enum HTMLText {
    /// Collapses runs of whitespace (including no-break spaces) to one space and trims.
    static func collapse(_ s: String) -> String {
        s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    private static let named: [String: String] = [
        "amp": "&", "lt": "<", "gt": ">", "quot": "\"", "apos": "'", "nbsp": "\u{00A0}",
        "rsquo": "\u{2019}", "lsquo": "\u{2018}", "rdquo": "\u{201D}", "ldquo": "\u{201C}",
        "ndash": "\u{2013}", "mdash": "\u{2014}", "hellip": "\u{2026}", "trade": "\u{2122}",
        "reg": "\u{00AE}", "copy": "\u{00A9}", "middot": "\u{00B7}", "bull": "\u{2022}", "times": "\u{00D7}",
    ]

    /// Decodes named, decimal and hex character references. Unknown ones stay as written.
    static func decodeEntities(_ s: String) -> String {
        guard s.contains("&") else { return s }
        var out = ""
        out.reserveCapacity(s.count)
        var rest = s[...]
        while let amp = rest.firstIndex(of: "&") {
            out += rest[..<amp]
            let after = rest[rest.index(after: amp)...]
            if let semi = after.prefix(12).firstIndex(of: ";") {
                let name = after[..<semi]
                if let value = decode(name) {
                    out += value
                    rest = after[after.index(after: semi)...]
                    continue
                }
            }
            out += "&"
            rest = after
        }
        out += rest
        return out
    }

    private static func decode(_ name: Substring) -> String? {
        if name.hasPrefix("#x") || name.hasPrefix("#X") {
            return UInt32(name.dropFirst(2), radix: 16).flatMap(Unicode.Scalar.init).map { String(Character($0)) }
        }
        if name.hasPrefix("#") {
            return UInt32(name.dropFirst()).flatMap(Unicode.Scalar.init).map { String(Character($0)) }
        }
        return named[String(name)]
    }
}
