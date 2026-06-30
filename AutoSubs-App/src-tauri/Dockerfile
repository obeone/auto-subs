# syntax=docker/dockerfile:1

# =============================================================================
# autosubs-cli - linux/amd64 image with NVIDIA CUDA GPU acceleration
#
# Build context MUST be this directory (the Cargo workspace root):
#   docker buildx build --platform linux/amd64 -f Dockerfile -t autosubs:cuda .
#
# Run (requires nvidia-container-toolkit on the host):
#   docker run --rm --gpus all \
#     -v autosubs-cache:/cache -v "$PWD":/work -w /work \
#     autosubs:cuda input.mp4 -o output.srt
#
# NOTE: the CUDA base images necessarily pin the Ubuntu version in their tag
# (NVIDIA publishes no rolling "latest OS" variant), so the usual "don't pin
# the OS" rule cannot apply here. Bump CUDA_TAG deliberately for security
# updates.
# =============================================================================

ARG CUDA_VERSION=12.4.1
ARG UBUNTU_VERSION=22.04
ARG RUST_VERSION=1.90.0
ARG ONNXRUNTIME_VERSION=1.19.2
# GPU archs compiled into whisper.cpp's CUDA kernels. Trim to your target
# hardware to cut build time (e.g. "89" for Ada / RTX 40xx, "90" for Hopper).
# 75=Turing 80=Ampere(A100) 86=Ampere(RTX30) 89=Ada(RTX40) 90=Hopper(H100)
ARG CUDA_ARCHITECTURES="75;80;86;89;90"

# -----------------------------------------------------------------------------
# Stage 1: builder - full CUDA toolkit (nvcc) to compile whisper.cpp/ggml
# -----------------------------------------------------------------------------
FROM nvidia/cuda:${CUDA_VERSION}-devel-ubuntu${UBUNTU_VERSION} AS builder

ARG RUST_VERSION
ARG ONNXRUNTIME_VERSION
ARG CUDA_ARCHITECTURES

# Keep APT downloads in the BuildKit cache instead of discarding them.
RUN rm -f /etc/apt/apt.conf.d/docker-clean; \
    echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' > /etc/apt/apt.conf.d/keep-cache

# Toolchain + native build deps. clang/libclang for whisper-rs bindgen, cmake
# for ggml, the rest for fetching crates and the onnxruntime tarball.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        cmake \
        clang \
        libclang-dev \
        pkg-config \
        git \
        curl \
        ca-certificates \
        xz-utils

# Rust via rustup, pinned. edition 2024 requires >= 1.85.
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --no-modify-path --profile minimal --default-toolchain "${RUST_VERSION}"

WORKDIR /build

# Whisper.cpp CUDA build knobs (consumed by whisper-rs' cmake invocation).
ENV CUDA_PATH=/usr/local/cuda \
    CMAKE_CUDA_ARCHITECTURES=${CUDA_ARCHITECTURES} \
    CUDAARCHS=${CUDA_ARCHITECTURES}

# Copy the whole workspace (cheap layer; .dockerignore keeps target/ etc. out).
COPY . .

# Build only the CLI crate (and its deps), not the Tauri app. Cargo registry,
# git and target dirs are cache-mounted across builds; the binary is copied out
# of the (non-persisted) target mount within the same RUN.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/build/target \
    cargo build -p autosubs-cli --release --features cuda \
 && cp /build/target/release/autosubs-cli /usr/local/bin/autosubs

# onnxruntime GPU shared library, loaded dynamically by `ort`
# (transcribe-rs / diarize use diarize/load-dynamic). Needed for the
# non-Whisper engines and diarization to use the GPU.
RUN curl --proto '=https' --tlsv1.2 -fsSL \
      "https://github.com/microsoft/onnxruntime/releases/download/v${ONNXRUNTIME_VERSION}/onnxruntime-linux-x64-gpu-${ONNXRUNTIME_VERSION}.tgz" \
      -o /tmp/ort.tgz \
 && mkdir -p /opt/onnxruntime/lib \
 && tar -xzf /tmp/ort.tgz -C /tmp \
 && cp -a /tmp/onnxruntime-linux-x64-gpu-${ONNXRUNTIME_VERSION}/lib/libonnxruntime*.so* /opt/onnxruntime/lib/ \
 && rm -rf /tmp/ort.tgz /tmp/onnxruntime-linux-x64-gpu-${ONNXRUNTIME_VERSION}

# -----------------------------------------------------------------------------
# Stage 2: runtime - CUDA runtime libs only (cuBLAS for whisper, no nvcc)
# -----------------------------------------------------------------------------
FROM nvidia/cuda:${CUDA_VERSION}-runtime-ubuntu${UBUNTU_VERSION} AS runtime

ARG CUDA_VERSION
ARG ONNXRUNTIME_VERSION

LABEL org.opencontainers.image.title="autosubs-cli" \
      org.opencontainers.image.description="AutoSubs standalone CLI (CUDA) - subtitles from video/audio" \
      org.opencontainers.image.source="https://github.com/maxxedev/auto-subs" \
      org.opencontainers.image.licenses="MIT"

RUN rm -f /etc/apt/apt.conf.d/docker-clean; \
    echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' > /etc/apt/apt.conf.d/keep-cache

# ffmpeg: always required (audio normalization).
# mkvtoolnix: provides mkvmerge, only used by --output-type mkv.
# libgomp1: OpenMP runtime used by ggml.
# libcudnn9-cuda-12: required for the onnxruntime CUDA execution provider
#   (ONNX-based models + diarization on GPU). If you only use Whisper you can
#   drop this line; ONNX models then fall back to CPU.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        mkvtoolnix \
        libgomp1 \
        ca-certificates \
        libcudnn9-cuda-12 \
 && rm -rf /var/lib/apt/lists/*

# onnxruntime GPU lib + dynamic-load hint for `ort`.
COPY --from=builder /opt/onnxruntime/lib/ /opt/onnxruntime/lib/
ENV ORT_DYLIB_PATH=/opt/onnxruntime/lib/libonnxruntime.so \
    LD_LIBRARY_PATH=/opt/onnxruntime/lib:${LD_LIBRARY_PATH}

# The CLI binary.
COPY --from=builder /usr/local/bin/autosubs /usr/local/bin/autosubs

# Non-root user (UID/GID > 10000). Models are downloaded at runtime into the
# cache dir, which is overridable via --cache-dir or pointed here by default.
RUN groupadd -r -g 10001 app && useradd -r -u 10001 -g app -m -d /home/app app \
 && mkdir -p /cache \
 && chown -R app:app /cache
USER app

# Persist downloaded models / normalized audio across runs.
ENV XDG_CACHE_HOME=/cache
VOLUME ["/cache"]

# Tame log noise on stdout pipelines by default (overridable with RUST_LOG).
ENV RUST_LOG=info

ENTRYPOINT ["autosubs"]
CMD ["--help"]
