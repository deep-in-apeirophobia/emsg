FROM golang:1.24-alpine AS builder

WORKDIR /app

RUN apk update && apk add --no-cache git

COPY go.mod go.sum ./

RUN go env -w GOPRIVATE="hg.atrin.dev/*,github.com/hookgrab/*,git.atrin.dev/hookgrab/*"
RUN go mod download

COPY . .

RUN go build -o kaskade

FROM alpine:latest AS runtime

WORKDIR /app

COPY --from=builder /app/kaskade /app/kaskade

EXPOSE 4000

CMD ["/app/kaskade"]
