# Образ сервера BrotherHub. Собирается автоматически в GitHub Actions
# (.github/workflows/server-image.yml) и публикуется в
# ghcr.io/ferrumnyak/brotherwatch-server.
#
# Собрать вручную из корня репозитория:
#   docker build -f deploy/Dockerfile -t brotherwatch-server .

FROM rust:1-bookworm AS build
WORKDIR /src
COPY . .
# --locked — ровно те версии библиотек, что в Cargo.lock.
RUN cargo build --release --locked -p brotherwatch-server

FROM debian:bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/Ferrumnyak/Brotherwatch" \
      org.opencontainers.image.description="Сервер BrotherHub: комнаты, чат, синхронизация, пропуска в голос"
COPY --from=build /src/target/release/brotherwatch-server /usr/local/bin/brotherwatch-server
# Не запускать от root.
RUN useradd --system --no-create-home brotherwatch
USER brotherwatch
ENV BROTHERWATCH_ADDR=0.0.0.0:8080 \
    RUST_LOG=info
EXPOSE 8080
CMD ["brotherwatch-server"]
