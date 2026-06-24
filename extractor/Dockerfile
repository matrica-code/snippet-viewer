# snippet-extractor — multi-language extract-code snippet harvester.
#
# Produces the snippets.json that the snippet-viewer web component renders.
# OCI-standard: builds and runs identically under Docker or Podman.
#
# Build context is this directory (extractor/):
#   podman build -t snippet-extractor extractor      # or: docker build ...
#
# Run against a local checkout mounted at /work (paths are /work-relative):
#   podman run --rm -v "$PWD":/work snippet-extractor \
#     --reset --snippetFile=/work/snippets.json /work/src
#
# Tree-sitter grammars are native addons, so we compile them in a full builder
# image (gcc/make/python3) and copy the prebuilt node_modules into a slim runtime.

# ---- builder: compile the native tree-sitter grammars ----------------------
FROM node:20-bookworm AS builder

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/snippet-extractor

# Manifest first so the (slow) native build layer caches across script edits.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund --legacy-peer-deps

COPY extractSnippets.mjs ./

# ---- runtime: slim image with just node + the prebuilt addons --------------
FROM node:20-bookworm-slim

WORKDIR /opt/snippet-extractor
COPY --from=builder /opt/snippet-extractor/node_modules ./node_modules
COPY --from=builder /opt/snippet-extractor/extractSnippets.mjs ./extractSnippets.mjs

# Mount the target repo here.
WORKDIR /work
ENTRYPOINT ["node", "/opt/snippet-extractor/extractSnippets.mjs"]
