# Snippet Viewer

A vanilla web component for displaying syntax-highlighted code snippets from a JSON file. Designed for use in WordPress and static sites.

This repo is two halves of one pipeline:

- **Viewer (this component)** — the _consumer_: renders a `snippets.json` keyed `name@filename.ext`.
- **[`extractor/`](extractor/README.md)** — the _producer_: harvests `// extract-code` markers from your source (JS/TS/TSX/Java) into exactly that `snippets.json`. Runs as an npm package (`npx @matrica-code/snippet-extractor`), a GitHub Action, or a container image.

## Features

- Syntax highlighting via Prism.js (loaded automatically from CDN)
- Auto-detects language from file extension
- Shared cache across all instances (single fetch per source)
- Shadow DOM isolation (safe for WordPress, no style conflicts)
- Provider component for sharing config across multiple viewers
- Named sources for pulling from multiple snippet files via one central manifest
- Supports TypeScript, JavaScript, JSX, TSX, Java, Python, Bash, JSON, YAML, and more

## Installation

Include the script in your HTML:

```html
<script src="https://your-site.netlify.app/snippet-viewer.js"></script>
```

## Usage

### 1. Create a snippets.json file

```json
{
  "hello-world@example.ts": "function helloWorld() {\n  console.log('Hello!');\n}",
  "counter@model.ts": "export class Counter {\n  count = 0;\n  increment() { this.count++; }\n}"
}
```

### 2. Use the component

```html
<snippet-viewer
  snippet="hello-world@example.ts"
  snippet-host="https://your-site.com/path/to/snippets"
>
</snippet-viewer>
```

### 3. Multiple snippets with Provider

Use `<snippet-provider>` to avoid repeating the host:

```html
<snippet-provider snippet-host="https://your-site.com/snippets">
  <h2>Getting Started</h2>
  <snippet-viewer snippet="hello-world@example.ts"></snippet-viewer>

  <h2>Advanced Usage</h2>
  <snippet-viewer snippet="counter@model.ts"></snippet-viewer>
</snippet-provider>
```

### 4. Site-wide Default (WordPress)

Set a global default host so you don't need provider or attributes on every viewer.

**Option A: Meta tag (recommended)**

Add to your theme header:

```html
<meta name="snippet-host" content="https://your-site.netlify.app" />
<script src="https://your-site.netlify.app/snippet-viewer.js"></script>
```

**Option B: JavaScript API**

```html
<script src="https://your-site.netlify.app/snippet-viewer.js"></script>
<script>
  SnippetViewer.setDefaultHost("https://your-site.netlify.app");
</script>
```

Then in any post/page, just use:

```html
<snippet-viewer snippet="my-function@example.ts"></snippet-viewer>
```

### 5. Multiple snippet files with Named Sources

When your snippets live in **more than one file** (e.g. one per language, product, or
repo), give each file a name and let viewers reference it with a `source` attribute.
The `snippet-host` path always resolves to a single `snippets.json`; named sources let
one page mix several files and keep the URL mapping in one place.

**Option A: Manifest (recommended)** — register a manifest once in your theme header:

```html
<meta name="snippet-sources" content="https://your-cdn.com/sources.json" />
```

where `sources.json` maps names to full URLs:

```json
{
  "java": "https://your-cdn.com/java-snippets.json",
  "frontend": "https://your-cdn.com/frontend-snippets.json"
}
```

**Option B: JavaScript API** — register names in your theme header:

```html
<script>
  SnippetViewer.setSources({
    java: "https://your-cdn.com/java-snippets.json",
    frontend: "https://your-cdn.com/frontend-snippets.json",
  });
</script>
```

Then reference a `source` per viewer — or set a default on a provider and override it
on individual viewers:

```html
<snippet-viewer source="java" snippet="widget-service@WidgetService.java"></snippet-viewer>

<snippet-provider source="frontend">
  <!-- inherit the provider's "frontend" source -->
  <snippet-viewer snippet="counter@Counter.tsx"></snippet-viewer>
  <!-- a single viewer can opt into a different source -->
  <snippet-viewer source="java" snippet="describe@WidgetMembers.java"></snippet-viewer>
</snippet-provider>
```

Resolution rules:

- A `source` name wins over `snippet-host`; without a `source`, the legacy
  `{snippet-host}/snippets.json` path is used, so existing pages keep working.
- A viewer's own `source` / `snippet-host` wins over a provider's, so a subtree can
  default to one file and opt individual viewers into another.
- The manifest is fetched once and each source is cached by URL, so a given file is
  only downloaded once no matter how many viewers reference it.

A full working example (manifest + two extra source files) lives in
[`example/`](example/index.html).

## Snippet Key Format

Keys follow the pattern: `name@filename.ext`

- **name**: Identifier for the snippet (can be anything)
- **filename.ext**: Displayed in the header; extension determines syntax highlighting

Examples:

- `counter-model@counter.ts` → TypeScript highlighting
- `main-class@App.java` → Java highlighting
- `config@settings.json` → JSON highlighting

## Attributes

### `<snippet-viewer>`

| Attribute      | Description                                                            |
| -------------- | --------------------------------------------------------------------- |
| `snippet`      | Key to look up in the JSON file                                       |
| `snippet-host` | Base URL where `snippets.json` is located                            |
| `source`       | Named source to fetch from (see [Named Sources](#5-multiple-snippet-files-with-named-sources)); takes precedence over `snippet-host` |

### `<snippet-provider>`

| Attribute      | Description                                                               |
| -------------- | ------------------------------------------------------------------------ |
| `snippet-host` | Shared base URL for all child `<snippet-viewer>` elements                |
| `source`       | Shared named source for all child `<snippet-viewer>` elements            |

### JavaScript API

| Method                          | Description                                          |
| ------------------------------- | ---------------------------------------------------- |
| `SnippetViewer.setDefaultHost(url)` | Global default host for viewers without one      |
| `SnippetViewer.setSource(name, url)` | Register a single named source                  |
| `SnippetViewer.setSources(map)` | Register named sources from a `{ name: url }` object |
| `SnippetViewer.setTheme(name)`  | Prism theme (`tomorrow`, `okaidia`, `twilight`, …)   |

## Supported Languages

TypeScript, JavaScript, JSX, TSX, Java, Python, Ruby, Go, Rust, C, C++, Arduino, Bash, JSON, YAML, HTML, CSS, SCSS, SQL, Markdown

## Hosting

The component and snippets can be hosted anywhere that serves static files:

- **Netlify** (recommended)
- **GitHub Pages**
- **Cloudflare Pages**
- **Your WordPress uploads folder**

### CORS

If hosting snippets on a different domain than your site, ensure CORS headers are set:

```
Access-Control-Allow-Origin: *
```

## Development

```bash
# Serve locally
npx serve .

# Open demo
open http://localhost:3000/example/
```

## License

MIT
