#!/bin/bash
echo "Setting up dependencies for Puppeteer on Replit..."

# Install chromium and required dependencies using Nix
echo "nix-env -i chromium" > .replit-nix-commands
echo "nix-env -iA nixpkgs.glib" >> .replit-nix-commands
echo "nix-env -iA nixpkgs.xorg.libX11" >> .replit-nix-commands
echo "nix-env -iA nixpkgs.xorg.libXcursor" >> .replit-nix-commands
echo "nix-env -iA nixpkgs.xorg.libXi" >> .replit-nix-commands
echo "nix-env -iA nixpkgs.xorg.libXrandr" >> .replit-nix-commands
echo "nix-env -iA nixpkgs.cups" >> .replit-nix-commands
echo "nix-env -iA nixpkgs.atk" >> .replit-nix-commands
echo "nix-env -iA nixpkgs.gtk3" >> .replit-nix-commands
echo "nix-env -iA nixpkgs.pango" >> .replit-nix-commands
echo "nix-env -iA nixpkgs.cairo" >> .replit-nix-commands
echo "nix-env -iA nixpkgs.gdk-pixbuf" >> .replit-nix-commands

# Create necessary directories
mkdir -p cache price-history uploads user-state

# Make the script executable
chmod +x setup.sh

echo "Setup completed!"