#!/bin/bash

# Setup script to install pre-commit hooks on new devices

set -e

echo "Setting up pre-commit hooks..."
git config core.hooksPath .githooks
chmod +x .githooks/*

echo "✓ Pre-commit hooks installed successfully"
echo "Hooks will run automatically on the next commit"
