# Сборка сервера BrotherWatch. Запускать из корня репозитория:
#   docker compose -f deploy/docker-compose.yml up -d --build

FROM rust:1-bookworm AS build
WORKDIR /src
COPY . .
RUN cargo build --release -p brotherwatch-server

FROM debian:bookworm-slim
COPY --from=build /src/target/release/brotherwatch-server /usr/local/bin/brotherwatch-server
ENV BROTHERWATCH_ADDR=0.0.0.0:8080 \
    RUST_LOG=info
EXPOSE 8080
CMD ["brotherwatch-server"]
