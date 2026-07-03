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
 * Usage (with provider - recommended for multiple snippets from one source):
 *   <snippet-provider snippet-host="https://example.com/snippets">
 *     <snippet-viewer snippet="counter-model@counter-model.ts"></snippet-viewer>
 *     <snippet-viewer snippet="future-model@futures-model.ts"></snippet-viewer>
 *   </snippet-provider>
 *
 * Usage (named sources - for MULTIPLE snippet files):
 *   Register names -> URLs once (see WordPress Option 3 below), then reference a
 *   `source` per viewer or per provider. A viewer's own source/host wins over a
 *   provider's, so a subtree can default to one file and opt a viewer into another:
 *
 *   <snippet-viewer source="java" snippet="java-class@WidgetService.java"></snippet-viewer>
 *   <snippet-provider source="react">
 *     <snippet-viewer snippet="react-component@Counter.tsx"></snippet-viewer>
 *     <snippet-viewer source="java" snippet="java-method@WidgetMembers.java"></snippet-viewer>
 *   </snippet-provider>
 *
 * WordPress usage (Option 1 - meta tag, add to theme header):
 *   <meta name="snippet-host" content="https://your-site.netlify.app">
 *   <meta name="snippet-theme" content="okaidia">
 *   <script src="https://your-cdn.com/snippet-viewer.js"></script>
 *
 * WordPress usage (Option 2 - JavaScript, add to theme header):
 *   <script src="https://your-cdn.com/snippet-viewer.js"></script>
 *   <script>
 *     SnippetViewer.setDefaultHost('https://your-site.netlify.app');
 *     SnippetViewer.setTheme('okaidia');
 *   </script>
 *
 * Available themes: 'tomorrow' (default), 'okaidia', 'twilight', 'coy', 'solarizedlight', 'dark'
 *
 * WordPress usage (Option 3 - named sources for MULTIPLE files):
 *   A. Manifest (recommended - update one JSON, every post follows):
 *      <meta name="snippet-sources" content="https://your-cdn.com/sources.json">
 *      where sources.json is:
 *        { "java": "https://.../java.json", "react": "https://.../react.json" }
 *   B. Or register in JS (theme header):
 *      <script>
 *        SnippetViewer.setSources({
 *          java: 'https://your-cdn.com/java.json',
 *          react: 'https://your-cdn.com/react.json',
 *        });
 *      </script>
 *   Then in posts: <snippet-viewer source="java" snippet="java-class@WidgetService.java">
 *
 * Then in any post/page, just use:
 *   <snippet-viewer snippet="my-code@example.ts"></snippet-viewer>
 *
 * Resolution: a `source` name maps to a full snippets.json URL via the registry;
 * otherwise the component fetches {snippetHost}/snippets.json (legacy default).
 * The JSON is cached per-URL, so a provider (or repeated viewers) fetch each
 * source only once.
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
    theme: null,
  };

  // Default theme if none configured
  const DEFAULT_THEME = "tomorrow"; // Options: 'tomorrow', 'okaidia', 'twilight', 'coy', 'solarizedlight', 'dark'

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

  /**
   * Set the global Prism.js theme for syntax highlighting. The value is either a
   * built-in Prism theme name (resolved against the CDN) or a full stylesheet
   * URL for a custom theme. Mirrors setDefaultHost: set it once in your header,
   * or via <meta name="snippet-theme">. An individual <snippet-viewer theme="...">
   * attribute overrides it.
   *
   * Usage:
   *   SnippetViewer.setTheme('okaidia');                          // built-in name
   *   SnippetViewer.setTheme('https://cdn.example.com/my.css');   // custom URL
   *
   * Or via meta tag (parsed automatically):
   *   <meta name="snippet-theme" content="okaidia">
   *
   * Built-in names: 'tomorrow', 'okaidia', 'twilight', 'coy', 'solarizedlight', 'dark'
   */
  function setTheme(theme) {
    config.theme = theme;
  }

  function getTheme() {
    // Check for meta tag if no theme configured
    if (!config.theme) {
      const meta = document.querySelector('meta[name="snippet-theme"]');
      if (meta) {
        config.theme = meta.getAttribute("content");
      }
    }
    return config.theme || DEFAULT_THEME;
  }

  // ---------------------------------------------------------------------------
  // Named snippet sources
  //
  // A viewer/provider can name a `source` instead of a `snippet-host`. Names map
  // to full snippets.json URLs via this registry, populated either:
  //   * programmatically — SnippetViewer.setSource('java', 'https://.../java.json')
  //                        SnippetViewer.setSources({ java: '...', react: '...' })
  //   * via a manifest    — <meta name="snippet-sources" content="https://.../sources.json">
  //                        where sources.json is { "java": "...", "react": "..." }
  //
  // The legacy `snippet-host` path (-> `{host}/snippets.json`) is unchanged and
  // used whenever no `source` is given, so existing pages keep working.
  // ---------------------------------------------------------------------------
  const sources = new Map(); // name -> snippets.json URL
  let sourcesManifestPromise = null;

  /**
   * Register a single named source. Wins over anything in the manifest with the
   * same name (programmatic config is treated as authoritative).
   */
  function setSource(name, url) {
    sources.set(name, url);
  }

  /** Register several named sources at once: setSources({ java: '...', react: '...' }). */
  function setSources(map) {
    Object.entries(map || {}).forEach(([name, url]) => sources.set(name, url));
  }

  /**
   * Lazily fetch the `<meta name="snippet-sources">` manifest (once) and merge
   * it into the registry. Programmatically-set names are never clobbered.
   * Always resolves (a failed manifest is logged, not thrown) so a bad manifest
   * doesn't wedge every viewer.
   */
  function ensureSourcesLoaded() {
    if (sourcesManifestPromise) return sourcesManifestPromise;

    const meta = document.querySelector('meta[name="snippet-sources"]');
    const manifestUrl = meta && meta.getAttribute("content");
    if (!manifestUrl) {
      sourcesManifestPromise = Promise.resolve();
      return sourcesManifestPromise;
    }

    sourcesManifestPromise = (async () => {
      try {
        const response = await fetch(manifestUrl);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        const map = await response.json();
        Object.entries(map).forEach(([name, url]) => {
          if (!sources.has(name)) sources.set(name, url);
        });
      } catch (err) {
        console.error(`snippet-viewer: failed to load sources manifest: ${err.message}`);
      }
    })();
    return sourcesManifestPromise;
  }

  /**
   * Resolve the snippets.json URL for a viewer/provider. A `source` name takes
   * precedence; otherwise fall back to the legacy `{host}/snippets.json`.
   * Returns null when nothing is configured (caller renders an error).
   */
  async function resolveSnippetUrl({ source, host }) {
    if (source) {
      await ensureSourcesLoaded();
      const url = sources.get(source);
      if (!url) {
        throw new Error(`Unknown snippet source "${source}"`);
      }
      return url;
    }
    const resolvedHost = host || getDefaultHost();
    if (!resolvedHost) return null;
    return `${resolvedHost.replace(/\/$/, "")}/snippets.json`;
  }

  /**
   * Fetch (and cache) a snippets.json by its fully-resolved URL. Shared by the
   * viewer and the provider; the cache and in-flight dedup are keyed by URL, so
   * different sources coexist and the same source is only fetched once.
   */
  function fetchSnippetsByUrl(url) {
    if (snippetCache.has(url)) return Promise.resolve(snippetCache.get(url));
    if (pendingRequests.has(url)) return pendingRequests.get(url);

    const fetchPromise = (async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        const data = await response.json();
        snippetCache.set(url, data);
        return data;
      } finally {
        // Clear the in-flight marker on success *and* failure, so a transient
        // error doesn't leave a permanently-rejected promise cached for retries.
        pendingRequests.delete(url);
      }
    })();

    pendingRequests.set(url, fetchPromise);
    return fetchPromise;
  }

  // Prism.js CDN URLs
  const PRISM_CDN = "https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0";

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
      // Load core Prism (CSS theme is loaded in each shadow DOM)
      const script = document.createElement("script");
      script.src = `${PRISM_CDN}/prism.min.js`;
      script.onload = () => {
        // Load line numbers plugin
        const lineNumbersPlugin = document.createElement("script");
        lineNumbersPlugin.src = `${PRISM_CDN}/plugins/line-numbers/prism-line-numbers.min.js`;
        lineNumbersPlugin.onload = () => {
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
        lineNumbersPlugin.onerror = reject;
        document.head.appendChild(lineNumbersPlugin);
      };
      script.onerror = reject;
      document.head.appendChild(script);
    });

    return prismLoading;
  }

  class SnippetViewer extends HTMLElement {
    static get observedAttributes() {
      return ["snippet", "snippet-host", "source", "theme"];
    }

    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this._rendered = false;
      this._currentCode = "";
    }

    connectedCallback() {
      this.render();
      this._rendered = true;
      this.loadSnippet();
    }

    attributeChangedCallback(name, oldValue, newValue) {
      // Only react to changes after initial render
      if (!this._rendered || oldValue === newValue) return;

      if (name === "theme") {
        // A theme change only swaps the stylesheet link — re-render the shadow
        // DOM and re-highlight the current code, no re-fetch needed.
        this.render();
        if (this._currentCode) {
          this.renderCode(this._currentCode);
        } else {
          this.loadSnippet();
        }
      } else {
        this.loadSnippet();
      }
    }

    get snippet() {
      return this.getAttribute("snippet") || "";
    }

    get snippetHost() {
      return this.getAttribute("snippet-host") || getDefaultHost() || "";
    }

    get source() {
      return this.getAttribute("source") || "";
    }

    // Per-element theme wins; falls back to the global/meta-tag theme.
    get theme() {
      return this.getAttribute("theme") || getTheme();
    }

    async loadSnippet() {
      // Ensure shadow DOM is ready
      if (!this._rendered) {
        return;
      }

      const { snippet, source, snippetHost } = this;

      // A viewer is configured if it has a snippet and either a named source or
      // a host (its own, a provider-supplied one, or the global default).
      if (!snippet || (!source && !snippetHost)) {
        this.renderError("Missing snippet, plus a source or snippet-host");
        return;
      }

      try {
        this.renderLoading();

        const url = await resolveSnippetUrl({ source, host: snippetHost });
        if (!url) {
          this.renderError("Could not resolve a snippets URL");
          return;
        }

        const snippetData = await fetchSnippetsByUrl(url);
        const code = snippetData[snippet];

        if (code === undefined) {
          this.renderError(`Snippet "${snippet}" not found`);
          return;
        }

        this._currentCode = code;
        this.renderCode(code);
      } catch (error) {
        this.renderError(`Failed to load snippet: ${error.message}`);
      }
    }

    async copyToClipboard() {
      try {
        await navigator.clipboard.writeText(this._currentCode);
        
        // Show feedback
        if (this._els?.copyButton) {
          const button = this._els.copyButton;
          const originalText = button.innerHTML;
          button.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M13.5 4L6 11.5L2.5 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          `;
          button.classList.add("copied");
          
          setTimeout(() => {
            button.innerHTML = originalText;
            button.classList.remove("copied");
          }, 2000);
        }
      } catch (err) {
        console.error("Failed to copy code:", err);
      }
    }

    render() {
      const theme = this.theme;

      // A theme value is either a bare Prism theme name (resolved against the
      // CDN) or a full/root-relative stylesheet URL for a custom theme. One
      // field, like snippet-host — no separate registry or theme-url attribute.
      const themeUrl =
        /^(https?:)?\/\//.test(theme) || theme.startsWith("/")
          ? theme
          : `${PRISM_CDN}/themes/prism-${theme}.min.css`;

      this.shadowRoot.innerHTML = `
        <link rel="stylesheet" href="${themeUrl}">
        <link rel="stylesheet" href="${PRISM_CDN}/plugins/line-numbers/prism-line-numbers.min.css">
        <style>
          :host {
            display: block;
            font-family: monospace;
          }

          .container {
            border: 1px solid #e1e4e8;
            border-radius: 6px;
            overflow: hidden;
            position: relative;
          }

          .header {
            background: #f6f8fa;
            padding: 8px 12px;
            border-bottom: 1px solid #e1e4e8;
            font-size: 12px;
            color: #586069;
            display: flex;
            justify-content: space-between;
            align-items: center;
          }

          .copy-button {
            background: transparent;
            border: 1px solid #d1d5db;
            border-radius: 4px;
            padding: 4px;
            cursor: pointer;
            color: #586069;
            font-size: 12px;
            display: flex;
            align-items: center;
            gap: 4px;
            transition: all 0.2s ease;
          }

          .copy-button:hover {
            background: #ffffff;
            border-color: #9ca3af;
            color: #24292e;
          }

          .copy-button:active {
            background: #f3f4f6;
          }

          .copy-button.copied {
            color: #22863a;
            border-color: #22863a;
          }

          .code-wrapper {
            overflow-x: auto;
          }

          pre {
            margin: 0 !important;
            overflow-x: auto;
          }

          code {
            font-family: 'Fira Code', 'Consolas', 'Monaco', monospace;
            font-size: 14px;
            white-space: pre;
          }

          .error {
            color: #cb2431;
            background: #ffeef0;
            padding: 16px;
          }

          .loading {
            color: #586069;
            padding: 16px;
          }
        </style>
        <div class="container">
          <div class="header">
            <span class="filename"></span>
            <button class="copy-button" title="Copy code">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M10.5 3.5H12.5C13.0523 3.5 13.5 3.94772 13.5 4.5V13.5C13.5 14.0523 13.0523 14.5 12.5 14.5H5.5C4.94772 14.5 4.5 14.0523 4.5 13.5V12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                <rect x="2.5" y="1.5" width="8" height="10" rx="1" stroke="currentColor" stroke-width="1.5"/>
              </svg>
            </button>
          </div>
          <div class="code-wrapper">
            <pre class="line-numbers"><code></code></pre>
          </div>
        </div>
      `;

      // Cache all element references once
      this._els = {
        header: this.shadowRoot.querySelector(".header"),
        filename: this.shadowRoot.querySelector(".filename"),
        code: this.shadowRoot.querySelector("code"),
        pre: this.shadowRoot.querySelector("pre"),
        codeWrapper: this.shadowRoot.querySelector(".code-wrapper"),
        copyButton: this.shadowRoot.querySelector(".copy-button"),
      };

      // Add click handler to copy button
      this._els.copyButton?.addEventListener("click", () => this.copyToClipboard());
    }

    async renderCode(code) {
      if (!this._els) this.render();
      const { filename, code: codeElement, pre, copyButton } = this._els;

      // Extract filename from snippet key (e.g., "counter-model@counter-model.ts" -> "counter-model.ts")
      const filenameText = this.snippet.includes("@")
        ? this.snippet.split("@")[1]
        : this.snippet;

      // Detect language from file extension
      const ext = filenameText.split(".").pop()?.toLowerCase() || "";
      const language = languageMap[ext] || "javascript";

      filename.textContent = filenameText;

      // Set the code content and classes first (fallback to plain text)
      codeElement.textContent = code;
      pre.className = `line-numbers language-${language}`;
      codeElement.className = `language-${language}`;
      
      // Show copy button
      if (copyButton) {
        copyButton.style.display = "flex";
      }

      // Try to use Prism for syntax highlighting
      try {
        const Prism = await loadPrism();
        if (Prism && Prism.languages[language]) {
          // Use highlightElement instead of highlight to trigger plugins
          Prism.highlightElement(codeElement);
        }
      } catch {
        // Fallback to plain text if Prism fails (already set above)
      }
    }

    renderError(message) {
      if (!this._els) this.render();
      const { filename, code: codeElement, pre, copyButton } = this._els;

      filename.textContent = "Error";
      // Update code element without destroying the structure
      codeElement.textContent = message;
      codeElement.className = "";
      pre.className = "error";
      
      // Hide copy button on error
      if (copyButton) {
        copyButton.style.display = "none";
      }
    }

    renderLoading() {
      if (!this._els) this.render();
      const { filename, code: codeElement, pre, copyButton } = this._els;

      filename.textContent = "Loading...";
      
      // Update code element without destroying the structure
      codeElement.textContent = "Loading snippet...";
      codeElement.className = "";
      pre.className = "loading";
      
      // Hide copy button while loading
      if (copyButton) {
        copyButton.style.display = "none";
      }
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
      return ["snippet-host", "source"];
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

    get source() {
      return this.getAttribute("source") || "";
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
      if (oldValue !== newValue && (name === "snippet-host" || name === "source")) {
        this.prefetch();
      }
    }

    async prefetch() {
      const { source, snippetHost: host } = this;

      if (!source && !host) {
        this._error = "Missing source or snippet-host attribute on provider";
        this._loading = false;
        return;
      }

      try {
        this._loading = true;
        this._error = null;

        const url = await resolveSnippetUrl({ source, host });
        if (!url) {
          throw new Error("Could not resolve a snippets URL");
        }

        // Shared, URL-keyed cache + in-flight dedup (same as the viewer).
        this._snippets = await fetchSnippetsByUrl(url);

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

      // Push this provider's source/host down to child viewers that don't carry
      // their own. A viewer with an explicit source or snippet-host is left
      // alone, so a single viewer can opt into a different source mid-subtree.
      const viewers = this.querySelectorAll("snippet-viewer");
      viewers.forEach((viewer) => {
        if (viewer.hasAttribute("source") || viewer.hasAttribute("snippet-host")) {
          return;
        }
        if (this.source) {
          viewer.setAttribute("source", this.source);
        } else {
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
  global.SnippetViewer.setTheme = setTheme;
  global.SnippetViewer.setSource = setSource;
  global.SnippetViewer.setSources = setSources;
  global.SnippetProvider = SnippetProvider;
  global.snippetCache = snippetCache;
})(typeof window !== "undefined" ? window : this);