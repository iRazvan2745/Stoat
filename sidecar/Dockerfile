FROM golang:1.26.1-alpine AS build

WORKDIR /src/stoat/sidecar

COPY --from=uncloud . /src/uncloud
COPY go.mod go.sum ./
RUN go mod download && go mod verify

COPY . .
RUN go test ./...
RUN CGO_ENABLED=0 go build -o /out/sidecar ./cmd/sidecar


FROM alpine:3.23.3

RUN apk --no-cache add ca-certificates

COPY --from=build /out/sidecar /usr/local/bin/sidecar

EXPOSE 8080

# The Uncloud unix socket is expected at /run/uncloud/uncloud.sock.
ENTRYPOINT ["/usr/local/bin/sidecar"]
CMD ["--listen", "0.0.0.0:8080", "--uncloud-config", "/dev/null", "--connect", "unix:///run/uncloud/uncloud.sock"]
