package main

// Set at build time by scripts/build-daemon.sh:
//   -ldflags "-X main.version=<package.json version>"
// so `katacomb-vpn-helper --version` reports the package it shipped with.
var version = "dev"
