# Makefile for atomic-chat-core: the everyday commands, like the app's Makefile.

.PHONY: all release

# Default target, does nothing
all:
	@echo "Specify a target to run, e.g. make release VERSION=patch"

# Bump, commit, tag and push. The pushed tag runs .github/workflows/release.yml: the CI gates on
# macOS, Linux and Windows, every binary, then the GitHub release the app downloads.
#   make release                 # patch: 0.3.0 -> 0.3.1
#   make release VERSION=minor   # or major, or an explicit X.Y.Z
#   make release VERSION=0.3.0   # the current version: tags HEAD without a bump
VERSION ?= patch
release:
	node scripts/release.mjs $(VERSION) --push
