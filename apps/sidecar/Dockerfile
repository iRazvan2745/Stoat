FROM golang:1.26.1-alpine AS build

WORKDIR /src/stoat/sidecar

COPY go.mod go.sum ./
RUN go mod download && go mod verify

COPY . .
RUN go test ./...
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-w -s" -o /out/sidecar ./cmd/sidecar


FROM alpine:3.23.3

RUN apk --no-cache add ca-certificates util-linux \
    && addgroup -S sidecar \
    && adduser -S -G sidecar sidecar

COPY --from=build --chown=sidecar:sidecar /out/sidecar /usr/local/bin/sidecar

EXPOSE 80

USER sidecar

# Auto-detect /run/uncloud/api/uncloud.sock (current) or /run/uncloud/uncloud.sock (legacy).
ENTRYPOINT ["/usr/local/bin/sidecar"]
CMD ["--listen", "0.0.0.0:80"]
