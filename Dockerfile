# Bun-capable ax-task-runner image for remote omp agents.
#
# Pinned by digest to the amd64 runner base built from upstream ax sources
# (python:3.12-slim + ax-task-runner binary + antigravity_bootstrap.py).
# On top: unzip, bun (for omp extension TS code), git/curl stay from base.
#
# amd64 only: the upstream runner binary is published for linux/amd64 and the
# substrate schedules amd64. No QEMU emulation involved.
#
# Image contract (unchanged from base): ENTRYPOINT ax-task-runner, env
# AX_TASK_YAML, wakeup probe http_get /readyz port 80, /workspace volume,
# POSIX /bin/sh for the substrate boot stub (`sh /workspace/omp-entry.sh`).

FROM ghcr.io/yurifrl/ax/ax-task-runner@sha256:dfb764969ee8f9dbdf59f681bf07cba01a14bfd64d9753ad860fc64a336a8ac9

ARG BUN_VERSION=1.4.4

RUN apt-get update \
    && apt-get install -y --no-install-recommends unzip \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" \
        -o /tmp/bun.zip \
    && echo "bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c  /tmp/bun.zip" | sha256sum -c - \
    && unzip -q /tmp/bun.zip -d /tmp/bun-install \
    && mv /tmp/bun-install/bun-linux-x64/bun /usr/local/bin/bun \
    && rm -rf /tmp/bun.zip /tmp/bun-install \
    && bun --version

# Bake the omp agent so remote-omp mode needs no node_modules staging (the
# 300 MB payload staging path dies on this cluster). The two scoped packages
# land in one global node_modules tree, so the pi-natives loader resolves
# pi-natives-linux-x64 as a sibling; the bin is /usr/local/bin/omp.
RUN BUN_INSTALL=/usr/local bun install -g \
        @oh-my-pi/pi-coding-agent@18.12.6 \
        @oh-my-pi/pi-natives-linux-x64@18.12.6 \
    && omp --version \
    && omp --help >/dev/null

ENTRYPOINT ["/usr/local/bin/ax-task-runner"]
