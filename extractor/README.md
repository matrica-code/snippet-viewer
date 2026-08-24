# snippet-extractor

The **producer** side of snippet-viewer. It harvests `// extract-code <name>`
markers out of source files into a `snippets.json` keyed `name@filename.ext` —
exactly the format the [`<snippet-viewer>`](../README.md) web component renders.

Parses with [Tree-sitter](https://tree-sitter.github.io/), so it works across
**JS / TS / TSX and Java** (more grammars can be registered — see below).

## Markers

```ts
// extract-code <name>       // export the node that follows, keyed as <name>@<file>
// extract-code end <name>   // (optional) explicitly end snippet <name> here
// extract-code ignore       // strip the following node from every snippet it lives in
// extract-code ignore a, b  // strip it only from snippets a and b
// extract-code ignore start // strip everything up to the matching `ignore end`
// extract-code ignore end   //   ...(both accept the same `a, b` scope list)
```

Reusing one `<name>` on several markers in a file is **additive** — the pieces
concatenate into a single snippet. See [Additive snippets](#additive-snippets).

If the marked node is an `import`, the **whole file** is emitted.

### Extent of a snippet

By default a marker captures the **whole syntax node** that follows it — a
class (with its decorators/annotations), a method, a field, a statement. When
several markers stack on the annotations of one declaration, each captures its
own piece, and a marker on the declaration itself captures the declaration:

```java
// extract-code policy      // -> just this annotation
@ListenerPolicy(Policy.NO_CALLBACK)

// extract-code service      // -> the whole class below
public class AutosaveService { /* ... */ }
```

To group a **run of loose statements** the AST wouldn't bundle on its own, close
it with a terminator. Everything from the marker up to `extract-code end <name>`
is captured; without a terminator the whole-node default applies:

```java
// extract-code data-storage
service.set("org.group", "key", "value");
String val = service.get("org.group", "key");
// extract-code end data-storage
```

### Additive snippets

A `<name>` used on more than one marker in the same file doesn't overwrite —
every marker contributes a **segment**, and they concatenate in source order into
one snippet. This is for the pieces that legitimately live apart: an include, a
macro, and the code that uses them, each in its own region of the file.

```c
// extract-code wifi-connect
#include <WiFi.h>
#include <WiFiClient.h>
// extract-code end wifi-connect
#include <stdio.h>          // not marked -> not in the snippet

// extract-code wifi-connect
#define WIFI_SSID "my-network"
#define WIFI_PASS "hunter2"
// extract-code end wifi-connect

static int retries = 0;     // not marked -> not in the snippet

// extract-code wifi-connect
void connectWifi() {
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}
```

`wifi-connect@Sketch.ino` becomes:

```c
#include <WiFi.h>
#include <WiFiClient.h>

#define WIFI_SSID "my-network"
#define WIFI_PASS "hunter2"

void connectWifi() {
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}
```

No file reorganization and no fake tutorial-only source — the file keeps its real
structure and the snippet reads as one contiguous example.

Details worth knowing:

- Segments join with a **blank line** between them, since they come from
  discontiguous regions.
- Each segment follows the normal extent rules: the whole node by default, or up
  to `extract-code end <name>` to group a run of loose lines. A terminator binds
  to the nearest preceding segment of that name, so each segment can have its
  own — as above, where the two `#include`s and the two `#define`s are grouped.
- Each segment re-indents to column 0 independently, so a segment lifted from
  inside a class or function body isn't left with stray leading whitespace.
- **Whole-file mode is off for additive names.** A single marker on an
  `import`/`#include` still emits the entire file (unchanged); once a name has
  two or more markers, an include segment contributes just the include — the
  hand-composed segments are the point.
- `ignore` (both forms) still applies within each segment.

### Reusing one class across several snippets

`ignore` scoping lets one source class back several snippets that each expose a
different part — no need to duplicate the class:

```java
// extract-code overview
// extract-code detail
public class ExampleClass {
    public void basic() { /* shown in both */ }

    // extract-code ignore overview   // hidden from `overview`, kept in `detail`
    public void advanced() { /* ... */ }
}
```

An `ignore` with no names strips from **every** enclosing snippet (the original
behavior). Marker directives themselves never appear in rendered output.

### Ignoring a run of loose lines

`ignore` on its own removes the **one node** that follows it. When what you want
gone isn't a single node — a preamble of option parsing, some setup boilerplate
in the middle of a function — bracket it with `ignore start` / `ignore end`.
This is the ignore-side counterpart of the `extract-code end <name>` terminator:

```c
// extract-code arduino-s1
int main(int argc, char *argv[]) {
  // extract-code ignore start arduino-s1
  int console = 0;
  signed char c;
  while ((c = getopt(argc, argv, "hc:")) != -1) { /* ... */ }
  srand(time(NULL));
  // extract-code ignore end arduino-s1

  run();
  return 0;
}
```

`arduino-s1` yields just:

```c
int main(int argc, char *argv[]) {
  run();
  return 0;
}
```

Both ends take the same optional scope list as plain `ignore` — omit it to strip
from every enclosing snippet, list names to strip only from those:

```java
// extract-code ignore start lite, mobile
// ...
// extract-code ignore end lite, mobile
```

Details worth knowing:

- Blocks **nest**. An `ignore end` closes the nearest unclosed `ignore start`
  with the same scope list, falling back to the nearest unclosed one — so the
  scope list doubles as a pairing label when blocks overlap.
- An **unterminated** `ignore start` strips to end of file and logs a warning:
  hiding too much is visible to you, whereas leaking what you meant to hide is
  not. An `ignore end` with nothing open is skipped with a warning.
- Because `start` and `end` are the block keywords, a snippet literally named
  `start` or `end` can't be used as a scope name in the one-line
  `extract-code ignore <names>` form.

## Ways to run it

Pick the channel that fits the consumer:

| Consumer                          | Channel             |
| --------------------------------- | ------------------- |
| JS/TS repo (has Node)             | **npm / npx**       |
| Java or any repo (no Node)        | **GitHub Action**   |
| Any CI or local, pinned toolchain | **container image** |

### As a GitHub Action

The repo ships a composite action that runs the published image, so it works in
**any** repo — Node, Java/Gradle, Maven, whatever — with no local toolchain.
Add one step:

```yaml
# .github/workflows/snippets.yml
name: snippets
on:
  push:
    branches: [main]

jobs:
  extract:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Extract snippets
        uses: matrica-code/snippet-viewer/extractor@main # pin to extractor-vX.Y.Z for reproducibility
        with:
          snippet-file: snippets.json # output path, relative to repo root
          paths: src # space-separated dirs/files to scan
          upload-artifact: "true" # also upload the result as a workflow artifact
          # reset: "true"            # start from {} (default); set "false" to merge
          # artifact-name: snippets  # artifact name (default: snippets)
          # image-tag: "1.0.0"       # which ghcr.io image tag to run (default: latest)
```

A **Java repo** is identical — just point `paths` at the sources:

```yaml
- uses: matrica-code/snippet-viewer/extractor@main
  with:
    snippet-file: docs/snippets.json
    paths: src/main/java
```

The action requires a Linux runner with Docker available (GitHub-hosted
`ubuntu-latest` has it). It pulls `ghcr.io/matrica-code/snippet-extractor` and
runs it over your checked-out workspace.

#### Action inputs

| Input                     | Default         | Description                                                    |
| ------------------------- | --------------- | -------------------------------------------------------------- |
| `snippet-file`            | `snippets.json` | Output JSON path, relative to the repo root.                   |
| `paths`                   | `.`             | Space-separated dirs/files to scan, relative to the repo root. |
| `reset`                   | `true`          | Start from `{}`; set `false` to merge into an existing file.   |
| `image-tag`               | `latest`        | Which `ghcr.io/matrica-code/snippet-extractor` tag to run.     |
| `upload-artifact`         | `false`         | Upload the generated file as a workflow artifact.              |
| `artifact-name`           | `snippets`      | Artifact name (when `upload-artifact` is `true`).              |
| `artifact-retention-days` | `90`            | Artifact retention (when `upload-artifact` is `true`).         |

The generated file also stays in the workspace at `$GITHUB_WORKSPACE/<snippet-file>`,
so a later step in the same job can read it directly — commit it, deploy it to your
snippet-viewer host, or push it to a blob store (S3/R2/GCS/Azure). The action exposes
its path as the `snippet-file` output too.

A later step can grab it via the output:

```yaml
- id: snippets
  uses: matrica-code/snippet-viewer/extractor@main
  with:
    paths: src
- run: aws s3 cp "${{ steps.snippets.outputs.snippet-file }}" s3://my-bucket/snippets.json --content-type application/json
```

### Via npm / npx (Node repos)

No install step needed — run the published package directly:

```bash
npx @matrica-code/snippet-extractor --reset --snippetFile=snippets.json src
```

Or add it as a dev dependency and wire a script:

```jsonc
// package.json
{
  "scripts": {
    "snippets": "extract-snippets --reset --snippetFile=public/snippets.json src"
  },
  "devDependencies": {
    "@matrica-code/snippet-extractor": "^1.0.0"
  }
}
```

(The Tree-sitter grammars are native addons; npm fetches prebuilt binaries for
common platforms, falling back to a local compile if none match.)

### With a container (Docker or Podman)

OCI-standard image, so `podman` and `docker` are interchangeable. All paths are
relative to `/work`, the mount point for the repo you're scanning.

```bash
# pull the published image...
podman run --rm -v "$PWD":/work \
  ghcr.io/matrica-code/snippet-extractor:latest \
  --reset --snippetFile=/work/snippets.json /work/src

# ...or build it locally from this directory
podman build -t snippet-extractor extractor        # or: docker build ...
```

On macOS, Podman is daemonless and avoids the Docker Desktop GUI/login gate:

```bash
podman machine init    # one-time, if you have no machine yet
podman machine start
```

If the CLI isn't on `PATH`, the macOS installer puts it at `/opt/podman/bin/podman`.

### Locally from source (Node)

```bash
cd extractor && npm install --legacy-peer-deps   # see the Testing note on this flag
node extractSnippets.mjs --reset --snippetFile=../example/snippets.json [<dir|file> ...]
```

`--reset` starts from `{}`; omit it to merge into an existing file.

## Test harness (live preview)

To see what snippets an annotated file yields *before* wiring it into CI, run
the local harness and paste code into the page:

```bash
cd extractor && npm run harness    # -> http://localhost:8787
```

Left pane: filename (the extension picks the grammar) and your annotated
source, re-extracted as you type. Right pane: every snippet the extractor
produced, rendered through the real `<snippet-viewer>` component — same
highlighting and chrome your docs readers get — with the raw text and the
resulting `snippets.json` one click away. It runs the same `extractFromSource`
as the CLI/action, so the preview is exactly what CI would emit.

## Testing

```bash
cd extractor && npm install --legacy-peer-deps   # once, to pull the Tree-sitter grammars
npm test                                          # runs extractSnippets.test.mjs via `node --test`
```

> The `--legacy-peer-deps` flag is currently required: `tree-sitter-java`
> declares a peer range that predates the pinned `tree-sitter` version, so a
> plain `npm install` fails with `ERESOLVE`. It's a benign resolution mismatch —
> the grammars build and run fine.

`extractSnippets.test.mjs` drives `extractFromSource` directly — each case is a
small source string paired with its expected snippet — and covers every marker
use case across JS/TS/TSX and Java (whole-file mode, `ignore` scoping,
`ignore start`/`ignore end` blocks, additive segments, terminators,
decorator/annotation handling) plus regressions for the
annotation/`modifiers` extraction bug. It also re-extracts the committed
`.github/smoke-test` fixtures so they stay in sync with the extractor. Add a
test alongside any new marker behavior or language grammar.

## Publishing

**The tag is the source of truth for the version** — to release, just push a tag.
Both workflows derive the version from it, so there is no `package.json` bump to
keep in sync.

```bash
git tag extractor-v1.0.3
git push origin extractor-v1.0.3
```

That fires two workflows:

- `.github/workflows/extractor-npm.yml` → sets the package version to the tag's
  version and publishes `@matrica-code/snippet-extractor` to npm (needs an
  `NPM_TOKEN` repo secret).
- `.github/workflows/extractor-image.yml` → builds the multi-arch image and pushes
  `ghcr.io/matrica-code/snippet-extractor:1.0.3` + `:latest` (uses the built-in
  `GITHUB_TOKEN`).

The `version` in `extractor/package.json` is only a default for manual
`workflow_dispatch` runs; tagged releases override it. npm refuses to republish a
version that already exists, so each release tag must use a new version number.

## CLI

```
extractSnippets.mjs --snippetFile=<path> [--reset] <dir-or-file> [<dir-or-file> ...]
```

| Flag                   | Meaning                                                                   |
| ---------------------- | ------------------------------------------------------------------------- |
| `--snippetFile=<path>` | Output JSON file (merged into unless `--reset`). Required.                |
| `--reset`              | Start from `{}` instead of merging.                                       |
| `<dir-or-file> ...`    | Roots to scan recursively (`node_modules`, `dist`, `.git`, etc. skipped). |

## Adding a language

Register an entry in `LANGUAGES` in `extractSnippets.mjs`: the file extension, a
`load()` returning the grammar, the grammar's comment node types, and which node
type triggers whole-file mode. (Prism in the viewer already highlights many
languages; extraction just needs the matching Tree-sitter grammar as a dep.)
