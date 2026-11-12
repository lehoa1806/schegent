# Review gap GC-18 (2026-11-12) — the local Linux verification leg's image.
#
# A one-shot verification container, not a service: it runs the steps in `run-steps.sh` against a
# tree piped in on stdin and exits. There is nothing to health-check, so HEALTHCHECK is NONE.
# It is one stage on purpose: nothing is built here to be shipped, so a second stage would copy
# the same toolchain into itself.
#
# The Node version matches `.nvmrc`; `scripts/linux-leg.sh` refuses to build when they differ.
FROM node:24.19.0-bookworm-slim

# git: the host suite drives real repositories (lanes, checkpoints, diff bases).
# procps: `ps` and `pgrep`. The product reads process start times and resource use with `ps`
# (src/services/process-liveness.ts, src/telemetry/platform/platform-ps.ts) and the process-tree
# tests count strays with `pgrep`; the slim image ships neither, which a desktop Linux does.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates procps \
  && rm -rf /var/lib/apt/lists/*

# The image's own non-root user; the suite never needs root.
USER node
WORKDIR /home/node

COPY --chown=node:node run-steps.sh /home/node/run-steps.sh

HEALTHCHECK NONE
ENTRYPOINT ["/bin/sh", "/home/node/run-steps.sh"]
