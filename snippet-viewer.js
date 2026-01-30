/**
 * SnippetViewer Web Component
 *
 * Fetches and displays code snippets from a JSON file.
 *
 * Usage (standalone):
 *   <snippet-viewer
 *     snippet="counter-model@counter-model.ts"
 *     snippet-host="https://example.com/snippets">
 *   </snippet-viewer>
 *
 * Usage (with provider - recommended for multiple snippets):
 *   <snippet-provider snippet-host="https://example.com/snippets">
 *     <snippet-viewer snippet="counter-model@counter-model.ts"></snippet-viewer>
 *     <snippet-viewer snippet="future-model@futures-model.ts"></snippet-viewer>
 *   </snippet-provider>
 *
 * WordPress usage (Option 1 - meta tag, add to theme header):
 *   <meta name="snippet-host" content="https://your-site.netlify.app">
 *   <script src="https://your-cdn.com/snippet-viewer.js"></script>
 *
 * WordPress usage (Option 2 - JavaScript, add to theme header):
 *   <script src="https://your-cdn.com/snippet-viewer.js"></script>
 *   <script>SnippetViewer.setDefaultHost('https://your-site.netlify.app');</script>
 *
 * Then in any post/page, just use:
 *   <snippet-viewer snippet="my-code@example.ts"></snippet-viewer>
 *
 * The component will fetch {snippetHost}/snippets.json and look up the snippet by key.
 * When using the provider, the JSON is fetched once and shared across all children.
 */
(function (global) {
  "use strict";

  // Shared cache across all instances (keyed by URL)
  const snippetCache = new Map();
  // Track in-flight requests to prevent duplicate fetches
  const pendingRequests = new Map();

  // Global configuration - can be set before or after script loads
  const config = {
    snippetHost: null,
  };

  /**
   * Set global snippet host for all viewers.
   * Call this once in your site header and all snippet-viewers will use it automatically.
   *
   * Usage:
   *   SnippetViewer.setDefaultHost('https://your-site.netlify.app');
   *
   * Or via meta tag (parsed automatically):
   *   <meta name="snippet-host" content="https://your-site.netlify.app">
   */
  function setDefaultHost(host) {
    config.snippetHost = host;
  }

  function getDefaultHost() {
    // Check for meta tag if no host configured
    if (!config.snippetHost) {
      const meta = document.querySelector('meta[name="snippet-host"]');
      if (meta) {
        config.snippetHost = meta.getAttribute("content");
      }
    }
    return config.snippetHost;
  }

  // Prism.js CDN URLs
  const PRISM_CDN = "https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0";
  const PRISM_THEME = "tomorrow"; // Options: 'tomorrow', 'okaidia', 'twilight', 'coy', 'solarizedlight', 'dark'

  // Map file extensions to Prism language classes
  const languageMap = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    json: "json",
    html: "html",
    css: "css",
    scss: "scss",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    sh: "bash",
    bash: "bash",
    yml: "yaml",
    yaml: "yaml",
    md: "markdown",
    sql: "sql",
    c: "c",
    h: "c",
    cpp: "cpp",
    cc: "cpp",
    cxx: "cpp",
    hpp: "cpp",
    ino: "arduino",
  };

  // Load Prism.js dynamically
  let prismLoading = null;
  let prismReady = false;

  async function loadPrism() {
    // If fully loaded, return immediately
    if (prismReady && global.Prism) return global.Prism;

    // If loading in progress, wait for it
    if (prismLoading) return prismLoading;

    prismLoading = new Promise((resolve, reject) => {
      // Load CSS theme
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = `${PRISM_CDN}/themes/prism-${PRISM_THEME}.min.css`;
      document.head.appendChild(link);

      // Load core Prism
      const script = document.createElement("script");
      script.src = `${PRISM_CDN}/prism.min.js`;
      script.onload = () => {
        // Load additional language components
        const languages = [
          "typescript",
          "jsx",
          "tsx",
          "bash",
          "json",
          "yaml",
          "python",
          "java",
          "c",
          "cpp",
          "arduino",
        ];
        let loadedCount = 0;

        languages.forEach((lang) => {
          const langScript = document.createElement("script");
          langScript.src = `${PRISM_CDN}/components/prism-${lang}.min.js`;
          langScript.onload = langScript.onerror = () => {
            loadedCount++;
            if (loadedCount === languages.length) {
              prismReady = true;
              resolve(global.Prism);
            }
          };
          document.head.appendChild(langScript);
        });
      };
      script.onerror = reject;
      document.head.appendChild(script);
    });

    return prismLoading;
  }

  class SnippetViewer extends HTMLElement {
    static get observedAttributes() {
      return ["snippet", "snippet-host"];
    }

    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this._rendered = false;
    }

    connectedCallback() {
      this.render();
      this._rendered = true;
      this.loadSnippet();
    }

    attributeChangedCallback(_name, oldValue, newValue) {
      // Only react to changes after initial render
      if (this._rendered && oldValue !== newValue) {
        this.loadSnippet();
      }
    }

    get snippet() {
      return this.getAttribute("snippet") || "";
    }

    get snippetHost() {
      return this.getAttribute("snippet-host") || getDefaultHost() || "";
    }

    async loadSnippet() {
      // Ensure shadow DOM is ready
      if (!this._rendered) {
        return;
      }

      const { snippet, snippetHost } = this;

      if (!snippet || !snippetHost) {
        this.renderError("Missing snippet or snippet-host attribute");
        return;
      }

      try {
        this.renderLoading();

        const snippetData = await this.fetchSnippets(snippetHost);
        const code = snippetData[snippet];

        if (code === undefined) {
          this.renderError(`Snippet "${snippet}" not found`);
          return;
        }

        this.renderCode(code);
      } catch (error) {
        this.renderError(`Failed to load snippet: ${error.message}`);
      }
    }

    async fetchSnippets(host) {
      const url = `${host.replace(/\/$/, "")}/snippets.json`;

      // Return from shared cache if available
      if (snippetCache.has(url)) {
        return snippetCache.get(url);
      }

      // If a request is already in-flight, wait for it
      if (pendingRequests.has(url)) {
        return pendingRequests.get(url);
      }

      // Create the fetch promise and track it
      const fetchPromise = (async () => {
        const response = await fetch(url);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        snippetCache.set(url, data);
        pendingRequests.delete(url);
        return data;
      })();

      pendingRequests.set(url, fetchPromise);
      return fetchPromise;
    }

    render() {
      this.shadowRoot.innerHTML = `
        <style>
          :host {
            display: block;
            font-family: monospace;
          }

          .container {
            border: 1px solid #e1e4e8;
            border-radius: 6px;
            overflow: hidden;
          }

          .header {
            background: #f6f8fa;
            padding: 8px 12px;
            border-bottom: 1px solid #e1e4e8;
            font-size: 12px;
            color: #586069;
          }

          pre {
            margin: 0;
            padding: 16px;
            overflow-x: auto;
            background: #1d1f21 !important;
          }

          code {
            font-family: 'Fira Code', 'Consolas', 'Monaco', monospace;
            font-size: 14px;
            line-height: 1.5;
            white-space: pre;
            background: transparent !important;
          }

          .error {
            color: #cb2431;
            background: #ffeef0;
          }

          .loading {
            color: #586069;
          }

          /* Prism Tomorrow theme (embedded for Shadow DOM) */
          code[class*="language-"],
          pre[class*="language-"] {
            color: #c5c8c6;
            text-shadow: 0 1px rgba(0, 0, 0, 0.3);
            direction: ltr;
            text-align: left;
            white-space: pre;
            word-spacing: normal;
            word-break: normal;
            tab-size: 4;
            hyphens: none;
          }

          .token.comment,
          .token.block-comment,
          .token.prolog,
          .token.doctype,
          .token.cdata {
            color: #969896;
          }

          .token.punctuation {
            color: #c5c8c6;
          }

          .token.tag,
          .token.attr-name,
          .token.namespace,
          .token.deleted {
            color: #e2777a;
          }

          .token.function-name {
            color: #6196cc;
          }

          .token.boolean,
          .token.number,
          .token.function {
            color: #de935f;
          }

          .token.property,
          .token.class-name,
          .token.constant,
          .token.symbol {
            color: #f0c674;
          }

          .token.selector,
          .token.important,
          .token.atrule,
          .token.keyword,
          .token.builtin {
            color: #b294bb;
          }

          .token.string,
          .token.char,
          .token.attr-value,
          .token.regex,
          .token.variable {
            color: #b5bd68;
          }

          .token.operator,
          .token.entity,
          .token.url {
            color: #8abeb7;
          }

          .token.important,
          .token.bold {
            font-weight: bold;
          }

          .token.italic {
            font-style: italic;
          }

          .token.entity {
            cursor: help;
          }

          .token.inserted {
            color: #b5bd68;
          }

          /* Decorators/Annotations */
          .token.decorator,
          .token.annotation {
            color: #cc99cd;
          }
        </style>
        <div class="container">
          <div class="header"></div>
          <pre><code></code></pre>
        </div>
      `;
    }

    async renderCode(code) {
      let header = this.shadowRoot?.querySelector(".header");
      let codeElement = this.shadowRoot?.querySelector("code");
      let pre = this.shadowRoot?.querySelector("pre");

      // Re-render if elements are missing
      if (!header || !codeElement || !pre) {
        this.render();
        header = this.shadowRoot.querySelector(".header");
        codeElement = this.shadowRoot.querySelector("code");
        pre = this.shadowRoot.querySelector("pre");
      }

      if (!header || !codeElement || !pre) return;

      // Extract filename from snippet key (e.g., "counter-model@counter-model.ts" -> "counter-model.ts")
      const filename = this.snippet.includes("@")
        ? this.snippet.split("@")[1]
        : this.snippet;

      // Detect language from file extension
      const ext = filename.split(".").pop()?.toLowerCase() || "";
      const language = languageMap[ext] || "javascript";

      header.textContent = filename;

      // Try to use Prism for syntax highlighting
      try {
        const Prism = await loadPrism();
        if (Prism && Prism.languages[language]) {
          codeElement.innerHTML = Prism.highlight(
            code,
            Prism.languages[language],
            language
          );
        } else {
          codeElement.textContent = code;
        }
      } catch {
        // Fallback to plain text if Prism fails
        codeElement.textContent = code;
      }

      pre.className = `language-${language}`;
      codeElement.className = `language-${language}`;
    }

    renderError(message) {
      let header = this.shadowRoot?.querySelector(".header");
      let pre = this.shadowRoot?.querySelector("pre");

      // Re-render if elements are missing
      if (!header || !pre) {
        this.render();
        header = this.shadowRoot.querySelector(".header");
        pre = this.shadowRoot.querySelector("pre");
      }

      if (!header || !pre) return;

      header.textContent = "Error";
      pre.innerHTML = `<span class="error">${this.escapeHtml(message)}</span>`;
    }

    renderLoading() {
      let header = this.shadowRoot?.querySelector(".header");
      let pre = this.shadowRoot?.querySelector("pre");

      // Re-render if elements are missing
      if (!header || !pre) {
        this.render();
        header = this.shadowRoot.querySelector(".header");
        pre = this.shadowRoot.querySelector("pre");
      }

      if (!header || !pre) return;

      header.textContent = "Loading...";
      pre.innerHTML = '<span class="loading">Loading snippet...</span>';
    }

    escapeHtml(text) {
      const div = document.createElement("div");
      div.textContent = text;
      return div.innerHTML;
    }
  }

  /**
   * SnippetProvider Web Component
   *
   * Pre-fetches snippets.json and provides it to all child snippet-viewer elements.
   * This ensures only one fetch regardless of how many snippet-viewers are nested inside.
   */
  class SnippetProvider extends HTMLElement {
    static get observedAttributes() {
      return ["snippet-host"];
    }

    constructor() {
      super();
      this._snippets = null;
      this._error = null;
      this._loading = true;
    }

    get snippetHost() {
      return this.getAttribute("snippet-host") || "";
    }

    get snippets() {
      return this._snippets;
    }

    get loading() {
      return this._loading;
    }

    get error() {
      return this._error;
    }

    async connectedCallback() {
      await this.prefetch();
    }

    attributeChangedCallback(name, oldValue, newValue) {
      if (oldValue !== newValue && name === "snippet-host") {
        this.prefetch();
      }
    }

    async prefetch() {
      const host = this.snippetHost;

      if (!host) {
        this._error = "Missing snippet-host attribute on provider";
        this._loading = false;
        return;
      }

      try {
        this._loading = true;
        this._error = null;

        const url = `${host.replace(/\/$/, "")}/snippets.json`;

        // Use shared cache
        if (snippetCache.has(url)) {
          this._snippets = snippetCache.get(url);
          this._loading = false;
          this.notifyChildren();
          return;
        }

        // Wait for pending request or fetch
        if (pendingRequests.has(url)) {
          this._snippets = await pendingRequests.get(url);
        } else {
          const fetchPromise = (async () => {
            const response = await fetch(url);
            if (!response.ok) {
              throw new Error(
                `HTTP ${response.status}: ${response.statusText}`
              );
            }
            const data = await response.json();
            snippetCache.set(url, data);
            pendingRequests.delete(url);
            return data;
          })();

          pendingRequests.set(url, fetchPromise);
          this._snippets = await fetchPromise;
        }

        this._loading = false;
        this.notifyChildren();
      } catch (err) {
        this._error = err.message;
        this._loading = false;
        this.notifyChildren();
      }
    }

    notifyChildren() {
      // Dispatch event for any snippet-viewers that are listening
      this.dispatchEvent(
        new CustomEvent("snippets-loaded", {
          bubbles: false,
          detail: { snippets: this._snippets, error: this._error },
        })
      );

      // Also trigger re-render on child snippet-viewers
      const viewers = this.querySelectorAll("snippet-viewer");
      viewers.forEach((viewer) => {
        if (!viewer.hasAttribute("snippet-host")) {
          viewer.setAttribute("snippet-host", this.snippetHost);
        }
      });
    }
  }

  // Register custom elements
  customElements.define("snippet-viewer", SnippetViewer);
  customElements.define("snippet-provider", SnippetProvider);

  // Expose to global scope for WordPress and CDN usage
  global.SnippetViewer = SnippetViewer;
  global.SnippetViewer.setDefaultHost = setDefaultHost;
  global.SnippetProvider = SnippetProvider;
  global.snippetCache = snippetCache;
})(typeof window !== "undefined" ? window : this);
