BINARY_NAME := emsgkas
ENCRYPTION_BINARY_NAME := kasenc
SRC := ./main.go
BUILD_DIR := dist

VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
COMMIT  := $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
DATE    := $(shell date -u +"%Y-%m-%dT%H:%M:%SZ")

LDFLAGS := -s -w \
  -X main.Version=$(VERSION) \
  -X main.Commit=$(COMMIT) \
  -X main.Date=$(DATE)

PLATFORMS := \
  linux/amd64 \
  linux/arm64 \
  darwin/amd64 \
  darwin/arm64 \
  windows/amd64 \
  windows/arm64

.PHONY: all clean tidy test $(PLATFORMS)

all: $(PLATFORMS)

$(PLATFORMS):
	$(eval OS := $(word 1,$(subst /, ,$@)))
	$(eval ARCH := $(word 2,$(subst /, ,$@)))
	$(eval EXT := $(if $(filter windows,$(OS)),.exe,))
	@echo "Building $(OS)/$(ARCH)..."
	@mkdir -p $(BUILD_DIR)
	GOOS=$(OS) GOARCH=$(ARCH) CGO_ENABLED=0 \
	  go build -ldflags "$(LDFLAGS)" \
	  -o $(BUILD_DIR)/$(BINARY_NAME)-$(OS)-$(ARCH)$(EXT) $(SRC)


encryption-wasm:
	@echo "Building wasm encryption module..."
	@mkdir -p $(BUILD_DIR)
	cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" static/
	GOOS=js GOARCH=wasm go build -o static/$(ENCRYPTION_BINARY_NAME).wasm ./pkg/encryption/main.go

package:
	mkdir -p .staging/static
	cp dist/$(BINARY_NAME)-* .staging/
	cp -r static/* .staging/static/
	cp -r templates/ .staging/
	tar -czf $(BINARY_NAME).tar.gz -C .staging .
	rm -rf staging/

.PHONY: linux darwin windows

linux:   linux/amd64 linux/arm64
darwin:  darwin/amd64 darwin/arm64
windows: windows/amd64 windows/arm64

tidy:
	go mod tidy

test:
	go test -v -race ./...

clean:
	rm -rf $(BUILD_DIR)
	rm static/$(ENCRYPTION_BINARY_NAME).wasm static/wasm_exec.js

