#!/bin/bash

# ─────────────────────────────────────────────────
#  ConnectWithAllCode — Local Start Script
#  Starts both the gateway and connector locally.
# ─────────────────────────────────────────────────

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "  ╔══════════════════════════════════════════╗"
echo "  ║      ConnectWithAllCode — Local Mode     ║"
echo "  ╚══════════════════════════════════════════╝"
echo ""

# Check dependencies
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
    echo "📦 Installing dependencies..."
    cd "$SCRIPT_DIR" && npm install
    echo ""
fi

# Build shared types
echo "🔨 Building shared types..."
cd "$SCRIPT_DIR" && npm run build -w shared
echo ""

# Start gateway
echo "🚀 Starting gateway server..."
echo ""
echo "─────────────────────────────────────────────"
echo ""
echo "📱 On first run, a QR code will appear below."
echo "   Scan it with WhatsApp:"
echo "     → Settings → Linked Devices → Link a Device"
echo ""
echo "   After scanning once, the session is saved"
echo "   and you won't need to scan again."
echo ""
echo "─────────────────────────────────────────────"
echo ""

cd "$SCRIPT_DIR" && npm run dev:gateway &
GATEWAY_PID=$!

# Wait for gateway to be ready
echo "⏳ Waiting for gateway to start..."
for i in {1..10}; do
    if curl -s http://localhost:3000/health > /dev/null 2>&1; then
        echo "✅ Gateway is running on port 3000"
        break
    fi
    sleep 1
done

echo ""
echo "─────────────────────────────────────────────"
echo ""
echo "📱 Next steps:"
echo ""
echo "  1. Scan the QR code above with WhatsApp"
echo ""
echo "  2. In another terminal, pair your device:"
echo "     Send /pair on WhatsApp"
echo "     Then run:"
echo "     npm run dev:connector -- --pair <CODE>"
echo ""
echo "─────────────────────────────────────────────"
echo ""

# Keep running and handle shutdown
trap "echo ''; echo '🛑 Shutting down...'; kill $GATEWAY_PID 2>/dev/null; exit 0" SIGINT SIGTERM
wait $GATEWAY_PID
