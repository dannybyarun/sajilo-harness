# Makefile - the Linux shortcuts for the Sajilo harness.
#
#   make install     install the instance (no arguments, no sudo)
#   make check       syntax-check the shell launchers (what CI runs)
#   make status      report what is installed
#   make uninstall   remove the instance and the launcher from PATH
#   make test        the unit tests (needs bun)
#
# "make install" is install.sh with the repo's own files - the installer
# detects the clone next to it, so the harness spec comes from here and not
# from the network.

SHELL := /bin/bash

.PHONY: install check status uninstall test

install:
	@bash install.sh

check:
	@bash -n sajilo
	@bash -n install.sh
	@bash -n bin/sajilo-rebrand.sh
	@bash -n bin/warp-rotate.sh
	@bash -n bin/tunnel-watchdog.sh
	@echo "check: every shell launcher parses"

status:
	@bash install.sh --status

uninstall:
	@bash install.sh --uninstall

test:
	@bun test
