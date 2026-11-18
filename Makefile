# Mon Français – task runner.
#
# Admin commands run the CLI (cli.js). Where it runs:
#   make users                      -> locally (or inside the container, e.g. Coolify's terminal)
#   make users COMPOSE=1            -> in the running docker compose service
#   make users CONTAINER=<name>     -> in a running container, e.g. on the Coolify host via SSH
#
# Note: user names are passed as NAME=..., not USER=... (USER is your shell's login name).

.DEFAULT_GOAL := help
.PHONY: help run dev build up down logs shell test \
        invite invites revoke-invite users create-user passwd logout delete-user import-legacy

SERVICE ?= app
DAYS    ?= 14

ifdef CONTAINER
  CLI := docker exec -i $(CONTAINER) node cli.js
else ifdef COMPOSE
  CLI := docker compose exec -T $(SERVICE) node cli.js
else
  CLI := node cli.js
endif

help: ## Show this help
	@echo "Usage: make <target> [VAR=value]"
	@echo
	@grep -hE '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-15s %s\n", $$1, $$2}'
	@echo
	@echo "Run admin commands elsewhere with COMPOSE=1 or CONTAINER=<name>."

# ---------- app ----------
run: ## Run the server locally (http://localhost:3000, data in ./data)
	node server.js

dev: ## Run locally and restart on file changes
	node --watch server.js

build: ## Build the Docker image via compose
	docker compose build

up: ## Start with docker compose (detached)
	docker compose up -d --build

down: ## Stop docker compose
	docker compose down

logs: ## Follow docker compose logs
	docker compose logs -f $(SERVICE)

shell: ## Open a shell in the compose container
	docker compose exec $(SERVICE) sh

test: ## Run the smoke test against a throwaway data dir
	sh scripts/smoke-test.sh

# ---------- admin ----------
invite: ## Create an invite  [NOTE="for Anna"] [DAYS=14, 0 = never expires]
	@$(CLI) invite "$(NOTE)" "$(DAYS)"

invites: ## List invites
	@$(CLI) invites

revoke-invite: ## Delete an invite  CODE=...
	@$(CLI) revoke-invite "$(CODE)"

users: ## List users
	@$(CLI) users

create-user: ## Create a user without invite  NAME=... [PASS=...]
	@$(CLI) create-user "$(NAME)" $(if $(PASS),"$(PASS)")

passwd: ## Reset a password (random if no PASS) NAME=... [PASS=...]
	@$(CLI) passwd "$(NAME)" $(if $(PASS),"$(PASS)")

logout: ## Log a user out on all devices  NAME=...
	@$(CLI) logout "$(NAME)"

delete-user: ## Delete a user (keeps data)  NAME=... [PURGE=1 deletes data too]
	@$(CLI) delete-user "$(NAME)" $(if $(PURGE),--purge)

import-legacy: ## Give old single-user data to a user NAME=... [FORCE=1]
	@$(CLI) import-legacy "$(NAME)" $(if $(FORCE),--force)
