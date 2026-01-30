# Snippet Viewer

A vanilla web component for displaying syntax-highlighted code snippets from a JSON file. Designed for use in WordPress and static sites.

## Features

- Syntax highlighting via Prism.js (loaded automatically from CDN)
- Auto-detects language from file extension
- Shared cache across all instances (single fetch for multiple snippets)
- Shadow DOM isolation (safe for WordPress, no style conflicts)
- Provider component for sharing config across multiple viewers
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
  snippet-host="https://your-site.com/path/to/snippets">
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
<meta name="snippet-host" content="https://your-site.netlify.app">
<script src="https://your-site.netlify.app/snippet-viewer.js"></script>
```

**Option B: JavaScript API**

```html
<script src="https://your-site.netlify.app/snippet-viewer.js"></script>
<script>SnippetViewer.setDefaultHost('https://your-site.netlify.app');</script>
```

Then in any post/page, just use:

```html
<snippet-viewer snippet="my-function@example.ts"></snippet-viewer>
```

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

| Attribute | Description |
|-----------|-------------|
| `snippet` | Key to look up in the JSON file |
| `snippet-host` | Base URL where `snippets.json` is located |

### `<snippet-provider>`

| Attribute | Description |
|-----------|-------------|
| `snippet-host` | Shared base URL for all child `<snippet-viewer>` elements |

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
