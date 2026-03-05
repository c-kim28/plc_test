#!/usr/bin/env bash
# 한 번에 실행: 백엔드(6005) + Vite 개발서버(5173) 띄우고 브라우저는 5173으로 오픈
set -e
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BACKEND_DIR="$REPO_ROOT/backend"
FRONTEND_DIR="$REPO_ROOT/frontend"
VENV_DIR="$BACKEND_DIR/venv"
VENV_PYTHON="$VENV_DIR/bin/python"
VITE_PORT="${VITE_PORT:-5173}"

# --- 1) Python/venv 필수 (없으면 안내만) ---
if ! command -v python3 &>/dev/null; then
  echo "오류: python3가 없습니다. Python 3.8+ 를 설치한 뒤 다시 실행하세요."
  exit 1
fi
if ! python3 -c "import venv" 2>/dev/null; then
  echo "오류: python3-venv가 없습니다. 터미널에서 다음을 실행한 뒤 다시 시도하세요:"
  echo "  sudo apt install python3-venv"
  exit 1
fi

# --- 2) 백엔드 venv 없으면 만들고 pip 설치 ---
if [ ! -d "$VENV_DIR" ]; then
  echo "백엔드 환경을 처음 설정합니다 (한 번만)..."
  python3 -m venv "$VENV_DIR"
  "$VENV_DIR/bin/pip" install --quiet --upgrade pip
  "$VENV_DIR/bin/pip" install --quiet -r "$BACKEND_DIR/requirements.txt"
  echo "백엔드 설정 완료."
else
  if [ ! -x "$VENV_PYTHON" ] || ! "$VENV_PYTHON" -c "import sys" 2>/dev/null; then
    echo "백엔드 환경을 다시 설정합니다..."
    rm -rf "$VENV_DIR"
    python3 -m venv "$VENV_DIR"
    "$VENV_DIR/bin/pip" install --quiet --upgrade pip
    "$VENV_DIR/bin/pip" install --quiet -r "$BACKEND_DIR/requirements.txt"
    echo "백엔드 설정 완료."
  elif ! "$VENV_PYTHON" -c "import pymcprotocol" 2>/dev/null; then
    echo "MC 프로토콜용 패키지(pymcprotocol) 설치 중..."
    "$VENV_PYTHON" -m pip install --quiet -r "$BACKEND_DIR/requirements.txt"
    echo "설치 완료."
  fi
fi

# --- 3) Node 있으면 Vite 개발서버 사용 (프론트 npm 설치만) ---
USE_VITE=false
if command -v node &>/dev/null && [ -d "$FRONTEND_DIR" ]; then
  if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
    echo "프론트엔드 의존성 설치 중 (한 번만)..."
    (cd "$FRONTEND_DIR" && npm install --no-audit --no-fund)
  fi
  USE_VITE=true
fi

if [ "$USE_VITE" != "true" ]; then
  echo "오류: Node가 없습니다. Vite로 실행하려면 Node.js를 설치한 뒤 다시 실행하세요."
  exit 1
fi

# --- 4) 백엔드(6005) + Vite(5173) 실행, 브라우저는 5173 열기 ---
echo "PLC 모니터 시작 (백엔드 http://localhost:6005, 프론트 http://localhost:${VITE_PORT})..."
export OPEN_BROWSER_FROM_SHELL=1
"$VENV_PYTHON" "$BACKEND_DIR/launcher.py" &
SERVER_PID=$!
sleep 1.5
(cd "$FRONTEND_DIR" && node node_modules/vite/bin/vite.js --port "$VITE_PORT") &
VITE_PID=$!
sleep 2.5
export DISPLAY="${DISPLAY:-:0}"
echo "브라우저 열기 시도 중..."
if ! xdg-open "http://localhost:${VITE_PORT}" 2>/dev/null; then
  gio open "http://localhost:${VITE_PORT}" 2>/dev/null || true
fi
echo "안 열리면 브라우저에 직접 입력: http://localhost:${VITE_PORT}"
cleanup() { kill $VITE_PID 2>/dev/null; exit 0; }
trap cleanup INT TERM
wait $SERVER_PID
kill $VITE_PID 2>/dev/null || true
