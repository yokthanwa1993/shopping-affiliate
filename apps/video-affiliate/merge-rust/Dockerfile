# Stage 1: Rust (build for the active target platform)
FROM rust:1.85-bookworm AS rust-builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /usr/src/app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release

# Stage 2: Runtime Image
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg ca-certificates wget libssl3 fontconfig fonts-noto-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy rust binary
COPY --from=rust-builder /usr/src/app/target/release/merge-rust /app/merge-rust

# Copy font — register with fontconfig so libass can find it by family name
RUN mkdir -p /usr/local/share/fonts
COPY font.ttf /usr/local/share/fonts/FC-Iconic-Bold.ttf
RUN fc-cache -fv

EXPOSE 8080

CMD ["/app/merge-rust"]
