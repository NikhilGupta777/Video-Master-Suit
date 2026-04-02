#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# YTGrabber — AWS EC2 Setup Script
#
# Run this once on a fresh Ubuntu 24.04 EC2 instance to install Docker,
# clone the repo, and start the app via Docker Compose.
#
# Recommended instance type: t3.medium (2 vCPU, 4 GB RAM) or larger.
# Storage: at least 30 GB root volume (for Docker images + temp downloads).
#
# Usage:
#   chmod +x scripts/aws-ec2-setup.sh
#   ./scripts/aws-ec2-setup.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

echo "=== [1/6] Updating system packages ==="
sudo apt-get update -y
sudo apt-get upgrade -y

echo "=== [2/6] Installing Docker ==="
sudo apt-get install -y ca-certificates curl gnupg lsb-release
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update -y
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Allow current user to run Docker without sudo
sudo usermod -aG docker "$USER"
echo "Docker installed. You may need to log out and back in for group changes."

echo "=== [3/6] Installing git ==="
sudo apt-get install -y git

echo "=== [4/6] Cloning repository ==="
# Edit this to your actual repo URL
REPO_URL="${REPO_URL:-https://github.com/YOUR_USERNAME/YOUR_REPO.git}"
APP_DIR="${APP_DIR:-/opt/ytgrabber}"

if [ ! -d "$APP_DIR" ]; then
  sudo git clone "$REPO_URL" "$APP_DIR"
  sudo chown -R "$USER":"$USER" "$APP_DIR"
else
  echo "Directory $APP_DIR already exists, pulling latest..."
  git -C "$APP_DIR" pull
fi

echo "=== [5/6] Configuring environment variables ==="
cd "$APP_DIR"

if [ ! -f ".env" ]; then
  cp .env.example .env
  echo ""
  echo "┌─────────────────────────────────────────────────────────────┐"
  echo "│  IMPORTANT: Edit .env before starting the app!              │"
  echo "│                                                              │"
  echo "│  nano /opt/ytgrabber/.env                                    │"
  echo "│                                                              │"
  echo "│  Required values:                                            │"
  echo "│   DATABASE_URL  — already set for docker-compose postgres    │"
  echo "│   GEMINI_API_KEY — your Google Gemini key                    │"
  echo "│   BHAGWAT_PASSWORD — password for the Bhagwat editor         │"
  echo "└─────────────────────────────────────────────────────────────┘"
  echo ""
  read -r -p "Press ENTER when you have finished editing .env ..."
fi

echo "=== [6/6] Building and starting the app ==="
# Use sudo because the docker group change from step 2 doesn't apply
# to the current shell session without logging out first.
sudo docker compose up -d --build

echo ""
echo "✅ Done! YTGrabber is running."
echo ""
echo "   App URL:  http://$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4):8080"
echo "   Logs:     sudo docker compose logs -f"
echo "   Stop:     sudo docker compose down"
echo "   Restart:  sudo docker compose restart"
echo ""
echo "   To push database schema (first time / after schema changes):"
echo "   sudo docker compose exec app pnpm --filter @workspace/db run push"
echo ""
echo "   Tip: log out and back in so future docker commands work without sudo."
echo ""
