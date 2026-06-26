// Smoke-test fixture for the snippet-extractor (Java).
// Demonstrates a CLASS-level marker on an ANNOTATED class, plus `ignore`.
package com.example.smoke;

import org.springframework.stereotype.Service;

// extract-code java-class
@Service
public class WidgetService {

    private String label = "untitled";

    // A secret the rendered docs must never show — proves `ignore` strips it.
    // extract-code ignore
    private final String apiKey = "sk-do-not-leak";

    public String render() {
        return "<div>" + label + "</div>";
    }
}
