# snippet-extractor

The **producer** side of snippet-viewer. It harvests `// extract-code <name>`
markers out of source files into a `snippets.json` keyed `name@filename.ext` —
exactly the format the [`<snippet-viewer>`](../README.md) web component renders.

Parses with [Tree-sitter](https://tree-sitter.github.io/), so it works across
**JS / TS / TSX and Java** (more grammars can be registered — see below).

## Markers

```ts
// extract-code <name>     // export the node that follows, keyed as <name>@<file>
// extract-code ignore     // strip the following node from any snippet it lives in
```

If the marked node is an `import`, the **whole file** is emitted.

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
          # reset: "true"            # start from {} (default); set "false" to merge
          # image-tag: "1.0.0"       # which ghcr.io image tag to run (default: latest)

      # then commit the file, or upload it, or deploy it to your snippet-viewer host
      - uses: actions/upload-artifact@v4
        with:
          name: snippets
          path: snippets.json
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
cd extractor && npm install
node extractSnippets.mjs --reset --snippetFile=../example/snippets.json [<dir|file> ...]
```

`--reset` starts from `{}`; omit it to merge into an existing file.

## Publishing

Both artifacts publish from a single version tag. Bump `version` in
`extractor/package.json`, then:

```bash
git tag extractor-v1.0.0
git push origin extractor-v1.0.0
```

That fires two workflows:

- `.github/workflows/extractor-npm.yml` → publishes `@matrica-code/snippet-extractor`
  to npm (needs an `NPM_TOKEN` repo secret).
- `.github/workflows/extractor-image.yml` → builds the multi-arch image and pushes
  `ghcr.io/matrica-code/snippet-extractor:1.0.0` + `:latest` (uses the built-in
  `GITHUB_TOKEN`).

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
