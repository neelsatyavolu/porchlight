import Foundation
import Testing
@testable import PorchKit

@Suite struct HTMLDocumentTests {
    @Test func buildsATreeWithClassesAndText() {
        let doc = HTMLDocument.parse(#"<div class="a  b"><span id=x>Hi &amp; bye</span><img src='https://x/y.jpg'><p>one<p>two</div>"#)
        let div = doc.first(class: "b")
        #expect(div?.tag == "div")
        #expect(div?.hasClass("a") == true)
        #expect(doc.first(id: "x")?.textContent == "Hi & bye")
        #expect(doc.all(tag: "img").first?[attribute: "src"] == "https://x/y.jpg")
        // A new <p> closes the open one.
        #expect(doc.all(tag: "p").map(\.textContent) == ["one", "two"])
        #expect(div?.textContent == "Hi & bye one two")
    }

    @Test func skipsScriptsCommentsAndStrayEndTags() {
        let doc = HTMLDocument.parse("""
        <!doctype html><html><head><script>if (a < b) { document.write("<div class='no'>") }</script>
        <style>.x{}</style></head><body><!-- <div class="no"> --></span><div class="yes">ok</div></body></html>
        """)
        #expect(doc.all(class: "no").isEmpty)
        #expect(doc.first(class: "yes")?.textContent == "ok")
    }

    @Test func decodesCharacterReferences() {
        let doc = HTMLDocument.parse("<b>it&rsquo;s &#36;5 &#x2014; &nbsp;fine &unknown; &amp</b>")
        #expect(doc.first { $0.tag == "b" }?.textContent == "it\u{2019}s $5 \u{2014} fine &unknown; &amp")
    }

    @Test func readsTheRealPagesQuickly() {
        let clock = ContinuousClock()
        let elapsed = clock.measure {
            for _ in 0..<5 { _ = AmazonFixture.document("order-history") }
        }
        #expect(elapsed < .seconds(5))
        #expect(AmazonFixture.document("order-history").all(class: "order-card").count == 10)
    }
}
