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
```

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
terminators, decorator/annotation handling) plus regressions for the
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
