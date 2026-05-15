#!/data/data/com.termux/files/usr/bin/bash
# ═══════════════════════════════════════════════════════════════════════
# GG-Shot Bot — Termux Setup & Runner Script
# ═══════════════════════════════════════════════════════════════════════
# Jalankan script ini di Termux untuk setup dan menjalankan bot scanner.
#
# Cara pakai:
#   1. chmod +x termux_setup.sh
#   2. ./termux_setup.sh setup     ← install dependencies (sekali aja)
#   3. ./termux_setup.sh run       ← jalankan bot (loop terus)
#   4. ./termux_setup.sh once      ← scan sekali lalu exit
#   5. ./termux_setup.sh bg        ← jalankan di background
#   6. ./termux_setup.sh stop      ← stop bot yang jalan di background
#   7. ./termux_setup.sh status    ← cek apakah bot sedang jalan
#   8. ./termux_setup.sh logs      ← lihat log terbaru
# ═══════════════════════════════════════════════════════════════════════

set -e

# ─── Paths ───
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOT_DIR="$SCRIPT_DIR"
VENV_DIR="$BOT_DIR/venv"
LOG_FILE="$BOT_DIR/bot.log"
PID_FILE="$BOT_DIR/bot.pid"
ENV_FILE="$BOT_DIR/.env"

# ─── Colors ───
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()  { echo -e "${BLUE}[INFO]${NC} $1"; }
ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }

# ═══════════════════════════════════════════════════════════════════════
# SETUP
# ═══════════════════════════════════════════════════════════════════════
do_setup() {
    info "Updating Termux packages..."
    pkg update -y && pkg upgrade -y

    info "Installing Python & dependencies..."
    pkg install -y python git

    info "Creating virtual environment..."
    if [ ! -d "$VENV_DIR" ]; then
        python -m venv "$VENV_DIR"
        ok "Virtual environment created at $VENV_DIR"
    else
        ok "Virtual environment already exists"
    fi

    info "Activating venv & installing pip packages..."
    source "$VENV_DIR/bin/activate"
    pip install --upgrade pip setuptools wheel
    pip install -r "$BOT_DIR/requirements.txt"

    ok "Dependencies installed!"

    # Check .env
    if [ ! -f "$ENV_FILE" ]; then
        warn ".env file not found!"
        info "Creating .env from .env.example..."
        cp "$BOT_DIR/.env.example" "$ENV_FILE"
        echo ""
        warn "PENTING: Edit file .env dan isi TELEGRAM_BOT_TOKEN & TELEGRAM_CHAT_ID"
        echo ""
        echo "  nano $ENV_FILE"
        echo ""
    else
        ok ".env file found"
    fi

    echo ""
    ok "Setup complete! Jalankan: ./termux_setup.sh run"
}

# ═══════════════════════════════════════════════════════════════════════
# RUN (foreground)
# ═══════════════════════════════════════════════════════════════════════
do_run() {
    check_env
    source "$VENV_DIR/bin/activate"
    info "Starting GG-Shot Scanner (foreground, Ctrl+C to stop)..."
    echo ""
    cd "$BOT_DIR"
    python -m bot.scanner
}

# ═══════════════════════════════════════════════════════════════════════
# RUN ONCE
# ═══════════════════════════════════════════════════════════════════════
do_once() {
    check_env
    source "$VENV_DIR/bin/activate"
    info "Running single scan..."
    cd "$BOT_DIR"
    python -m bot.scanner --once
    ok "Scan complete!"
}

# ═══════════════════════════════════════════════════════════════════════
# BACKGROUND
# ═══════════════════════════════════════════════════════════════════════
do_bg() {
    check_env

    if is_running; then
        warn "Bot sudah jalan dengan PID $(cat "$PID_FILE")"
        warn "Stop dulu: ./termux_setup.sh stop"
        return 1
    fi

    source "$VENV_DIR/bin/activate"
    info "Starting GG-Shot Scanner (background)..."
    cd "$BOT_DIR"
    nohup python -m bot.scanner > "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    ok "Bot running in background (PID: $!)"
    info "Lihat log: ./termux_setup.sh logs"
    info "Stop bot: ./termux_setup.sh stop"
}

# ═══════════════════════════════════════════════════════════════════════
# STOP
# ═══════════════════════════════════════════════════════════════════════
do_stop() {
    if [ ! -f "$PID_FILE" ]; then
        warn "PID file tidak ditemukan. Bot mungkin tidak sedang jalan."
        return 0
    fi

    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        kill "$PID"
        rm -f "$PID_FILE"
        ok "Bot stopped (PID: $PID)"
    else
        warn "Process $PID sudah tidak ada"
        rm -f "$PID_FILE"
    fi
}

# ═══════════════════════════════════════════════════════════════════════
# STATUS
# ═══════════════════════════════════════════════════════════════════════
do_status() {
    if is_running; then
        PID=$(cat "$PID_FILE")
        ok "Bot sedang jalan (PID: $PID)"
        info "Uptime:"
        ps -p "$PID" -o etime= 2>/dev/null || true
    else
        warn "Bot tidak sedang jalan"
    fi
}

# ═══════════════════════════════════════════════════════════════════════
# LOGS
# ═══════════════════════════════════════════════════════════════════════
do_logs() {
    if [ ! -f "$LOG_FILE" ]; then
        warn "Log file belum ada. Bot belum pernah jalan di background."
        return 0
    fi
    info "Last 50 lines of bot.log:"
    echo "─────────────────────────────────────────"
    tail -50 "$LOG_FILE"
    echo "─────────────────────────────────────────"
    info "Follow log real-time: tail -f $LOG_FILE"
}

# ═══════════════════════════════════════════════════════════════════════
# HELPERS
# ═══════════════════════════════════════════════════════════════════════
check_env() {
    if [ ! -f "$ENV_FILE" ]; then
        error ".env file not found! Run: ./termux_setup.sh setup"
        exit 1
    fi
    if [ ! -d "$VENV_DIR" ]; then
        error "Virtual environment not found! Run: ./termux_setup.sh setup"
        exit 1
    fi
    # Check required env vars
    source "$ENV_FILE" 2>/dev/null || true
    if [ -z "$TELEGRAM_BOT_TOKEN" ] || [ -z "$TELEGRAM_CHAT_ID" ]; then
        warn "TELEGRAM_BOT_TOKEN atau TELEGRAM_CHAT_ID kosong di .env"
        warn "Bot akan jalan tapi sinyal hanya muncul di log, bukan Telegram"
    fi
}

is_running() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            return 0
        fi
    fi
    return 1
}

# ═══════════════════════════════════════════════════════════════════════
# CRON (auto-scan setiap 15 menit via Termux cron/cronie)
# ═══════════════════════════════════════════════════════════════════════
do_cron() {
    info "Setting up Termux cron job (scan setiap 15 menit)..."

    # Install cronie if not present
    if ! command -v crond &> /dev/null; then
        pkg install -y cronie
    fi

    CRON_CMD="*/15 * * * * cd $BOT_DIR && $VENV_DIR/bin/python -m bot.scanner --once >> $LOG_FILE 2>&1"

    # Add to crontab (avoid duplicates)
    (crontab -l 2>/dev/null | grep -v "bot.scanner" ; echo "$CRON_CMD") | crontab -

    # Start crond
    crond

    ok "Cron job ditambahkan! Bot akan scan setiap 15 menit."
    info "Cek crontab: crontab -l"
    info "Lihat log: tail -f $LOG_FILE"
}

# ═══════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════

case "${1:-help}" in
    setup)  do_setup ;;
    run)    do_run ;;
    once)   do_once ;;
    bg)     do_bg ;;
    stop)   do_stop ;;
    status) do_status ;;
    logs)   do_logs ;;
    cron)   do_cron ;;
    *)
        echo ""
        echo "  GG-Shot Bot — Termux Runner"
        echo "  ═══════════════════════════════"
        echo ""
        echo "  Usage: ./termux_setup.sh <command>"
        echo ""
        echo "  Commands:"
        echo "    setup   — Install semua dependencies (run sekali)"
        echo "    run     — Jalankan bot (foreground, Ctrl+C stop)"
        echo "    once    — Scan sekali lalu exit"
        echo "    bg      — Jalankan bot di background"
        echo "    stop    — Stop bot yang jalan di background"
        echo "    status  — Cek apakah bot sedang jalan"
        echo "    logs    — Lihat log terbaru"
        echo "    cron    — Setup cron job (scan tiap 15 menit)"
        echo ""
        ;;
esac
