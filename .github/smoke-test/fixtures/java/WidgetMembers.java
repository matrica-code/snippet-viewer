// Smoke-test fixture for the snippet-extractor (Java).
// Demonstrates FIELD- and METHOD-level markers on ANNOTATED members.
// The enclosing class is intentionally NOT marked, so only the two members
// below are emitted — each keeping its annotation(s) intact.
package com.example.smoke;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.GetMapping;

public class WidgetMembers {

    // extract-code java-property
    @Autowired
    private WidgetRepository repository;

    // extract-code java-method
    @GetMapping("/widget")
    public String describe() {
        return repository.findLabel();
    }
}
