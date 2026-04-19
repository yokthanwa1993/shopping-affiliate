# Stage 1: Rust (native cross-compile — avoids QEMU emulation flakiness for rust linker)
# $BUILDPLATFORM = the host arch (e.g. arm64 Mac), $TARGETARCH = what we're producing (amd64).
# By forcing Stage 1 to $BUILDPLATFORM we compile rust NATIVELY then cross-link for x86_64.
FROM --platform=$BUILDPLATFORM rust:1.85-bookworm AS rust-builder
ARG TARGETARCH
RUN dpkg --add-architecture amd64 \
    && apt-get update && apt-get install -y --no-install-recommends \
    pkg-config \
    gcc-x86-64-linux-gnu \
    libc6-dev-amd64-cross \
    libssl-dev:amd64 \
    && rm -rf /var/lib/apt/lists/* \
    && rustup target add x86_64-unknown-linux-gnu
ENV CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=x86_64-linux-gnu-gcc \
    CC_x86_64_unknown_linux_gnu=x86_64-linux-gnu-gcc \
    PKG_CONFIG_ALLOW_CROSS=1 \
    PKG_CONFIG_PATH=/usr/lib/x86_64-linux-gnu/pkgconfig \
    OPENSSL_INCLUDE_DIR=/usr/include/x86_64-linux-gnu \
    OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu
WORKDIR /usr/src/app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --target x86_64-unknown-linux-gnu

# Stage 2: Runtime Image (target amd64 — runs under QEMU on arm64 host but only
# does apt-get + file copies, which are far more reliable than rust linking).
FROM --platform=linux/amd64 debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg ca-certificates wget libssl3 fontconfig fonts-noto-core \
    python3 python3-pil \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy rust binary (cross-compiled to x86_64)
COPY --from=rust-builder /usr/src/app/target/x86_64-unknown-linux-gnu/release/merge-rust /app/merge-rust

# Copy Pillow-based overlay generator — called by thumbnail.rs to render the
# title text with full Thai shaping (FreeType via Pillow + optional raqm).
COPY scripts/ /app/scripts/
RUN chmod +x /app/scripts/generate_overlay.py

# Copy font — register with fontconfig so libass can find it by family name
RUN mkdir -p /usr/local/share/fonts
COPY font.ttf /usr/local/share/fonts/FC-Iconic-Bold.ttf
COPY fonts/*.ttf /usr/local/share/fonts/
RUN fc-cache -fv

EXPOSE 8080

CMD ["/app/merge-rust"]
