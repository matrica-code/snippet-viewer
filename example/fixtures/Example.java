package com.example.demo;

import java.util.Map;

// One source class backs two snippets. `ignore overview` hides advanced()
// from the `overview` snippet, but keeps it in `detail` — no need to
// duplicate the class.
// extract-code overview
// extract-code detail
public class ExampleClass {

    public void basic(Map<String, String> store) {
        store.put("greeting", "hello");
    }

    // extract-code ignore overview
    public void advanced(Map<String, Integer> store) {
        store.merge("visits", 1, Integer::sum);
    }
}

class Demo {
    void run(KeyValService service) {
        // A terminator groups a run of loose statements the AST wouldn't
        // bundle on its own — everything up to `extract-code end`.
        // extract-code data-storage
        service.set("org.group", "key", "value");
        String val = service.get("org.group", "key");
        // extract-code end data-storage

        service.flush();
    }
}
