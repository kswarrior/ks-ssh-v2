-include .env
export

PORT ?= 8090
DATA_DIR ?= ./data
SECRET_KEY ?= change_me
GOFLAGS_BUILD := -buildvcs=false

.PHONY: dev build test clean web-install web-build server-run

web-install:
	cd apps/web && npm install

web-build:
	cd apps/web && npm run build

server-run:
	cd apps/server && go run ./cmd/ks-ssh

dev:
	bash scripts/dev.sh

build: web-build
	rm -rf apps/server/internal/web/dist
	cp -r apps/web/dist apps/server/internal/web/dist
	cd apps/server && CGO_ENABLED=0 go build $(GOFLAGS_BUILD) -trimpath -ldflags="-s -w" -o ../../ks-ssh ./cmd/ks-ssh

test:
	cd apps/server && go build $(GOFLAGS_BUILD) ./... && go vet $(GOFLAGS_BUILD) ./... && go test ./...
	cd apps/web && npx tsc --noEmit && npm run build

clean:
	rm -rf apps/web/dist apps/server/internal/web/dist ks-ssh
