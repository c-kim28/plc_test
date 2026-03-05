import json
import os
import queue
import socket
import subprocess
import sys
import threading
import atexit
from flask import Flask, Response, request, send_from_directory

from flask_cors import CORS

# 단일 실행(또는 .exe) 시 프론트 빌드물 서빙 경로 (PyInstaller: _MEIPASS)
_BASE_DIR = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
_FRONTEND_DIST = os.path.join(_BASE_DIR, "frontend_dist")

app = Flask(__name__)
# CORS: preflight(OPTIONS) 통과하도록 명시 (프론트 localhost:6173 → 백엔드 6005)
CORS(
    app,
    resources={r"/api/*": {"origins": "*", "methods": ["GET", "POST", "OPTIONS"], "allow_headers": ["Content-Type", "Authorization"]}},
)

client_queues = []
client_queues_lock = threading.Lock()
udp_thread = None
listening = False
udp_state = None  # {"ip": str, "port": int} when connected

# MC Protocol (3E)
mc_thread = None
mc_stop_event = None
mc_state = None  # {"host": str, "port": int} when connected (slave 없음)
mc_fake_server_proc = None

# MQTT 센서 (VVB001 진동, TP3237 온도) - 마지막 수신값 (새 SSE 클라이언트용)
last_sensor_data = {}  # {"VVB001": {"value": ..., "ts": ...}, "TP3237": {...}}
# MQTT 연결 상태 (에러는 앱 기동 직후 발생 시 SSE 클라이언트 없어서 안 보임 → 스냅샷으로 전달)
mqtt_status = {"connected": False, "error": ""}  # 새로 접속 시 화면에 표시용


def _is_tcp_open(host: str, port: int, timeout_sec: float = 0.4) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout_sec):
            return True
    except OSError:
        return False


def _ensure_local_mc_fake_server(host: str, port: int):
    """127.0.0.1:5002 대상일 때 fake 3E 서버가 없으면 자동 실행."""
    global mc_fake_server_proc
    if host not in ("127.0.0.1", "localhost") or port != 5002:
        return
    if _is_tcp_open(host, port):
        return
    if mc_fake_server_proc and mc_fake_server_proc.poll() is None:
        return
    fake_script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "plc_tcp_fake_response.py")
    try:
        mc_fake_server_proc = subprocess.Popen(
            [sys.executable, fake_script],
            cwd=os.path.dirname(fake_script),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except Exception:
        mc_fake_server_proc = None


@atexit.register
def _cleanup_mc_fake_server():
    global mc_fake_server_proc
    if mc_fake_server_proc and mc_fake_server_proc.poll() is None:
        try:
            mc_fake_server_proc.terminate()
        except Exception:
            pass


def broadcast(event: str, data: dict):
    """모든 연결된 SSE 클라이언트에 이벤트 전달"""
    global last_sensor_data, mqtt_status
    if event == "sensor_data":
        topic = data.get("topic")
        if topic:
            last_sensor_data[topic] = {"value": data.get("value"), "ts": data.get("ts")}
    elif event == "mqtt_connected":
        mqtt_status["connected"] = True
        mqtt_status["error"] = ""
    elif event == "mqtt_disconnected":
        mqtt_status["connected"] = False
    elif event == "mqtt_error":
        mqtt_status["connected"] = False
        mqtt_status["error"] = data.get("message", "MQTT 오류")
    msg = {"event": event, "data": data}
    with client_queues_lock:
        for q in list(client_queues):
            try:
                q.put_nowait(msg)
            except queue.Full:
                pass


def udp_listener(ip: str, port: int):
    """UDP 메시지를 수신하고 모든 SSE 클라이언트에 전달"""
    global listening, udp_state
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((ip, port))
        listening = True
        udp_state = {"ip": ip, "port": port}

        broadcast("udp_connected", {"ip": ip, "port": port})

        while listening:
            try:
                sock.settimeout(1.0)
                data, addr = sock.recvfrom(1024)
                xfmt = "".join(f"x{b:02x}" for b in data)
                try:
                    text = data.decode("utf-8")
                    payload = xfmt if (not text or "\x00" in text or not text.isprintable()) else text
                except UnicodeDecodeError:
                    payload = xfmt
                broadcast("udp_data", {
                    "payload": payload,
                    "raw": data.hex(),
                    "addr": f"{addr[0]}:{addr[1]}",
                })
            except socket.timeout:
                continue
            except OSError:
                break
        sock.close()
    except OSError as e:
        if e.errno == 49:  # EADDRNOTAVAIL
            broadcast("udp_error", {
                "message": "해당 IP를 사용할 수 없습니다. 바인딩 IP는 이 PC의 IP이거나 0.0.0.0(모든 인터페이스)이어야 합니다. PLC IP가 아닙니다."
            })
        else:
            broadcast("udp_error", {"message": str(e)})
    except Exception as e:
        broadcast("udp_error", {"message": str(e)})
    finally:
        listening = False
        udp_state = None
        broadcast("udp_disconnected", {})


def sse_stream(client_queue):
    """SSE 스트림 생성 - 각 클라이언트 전용 큐 사용"""
    try:
        while True:
            try:
                msg = client_queue.get(timeout=30)
                yield f"event: {msg['event']}\ndata: {json.dumps(msg['data'])}\n\n"
            except queue.Empty:
                yield ": heartbeat\n\n"
    finally:
        with client_queues_lock:
            if client_queue in client_queues:
                client_queues.remove(client_queue)


@app.route("/api/events")
def events():
    """SSE 엔드포인트 - 각 연결마다 별도 큐로 브로드캐스트"""
    client_queue = queue.Queue()
    with client_queues_lock:
        client_queues.append(client_queue)
        # 이미 UDP가 실행 중이면 새 클라이언트에 현재 상태 전달
        if udp_state:
            try:
                client_queue.put_nowait({"event": "udp_connected", "data": udp_state})
            except queue.Full:
                pass
        if mc_state:
            try:
                client_queue.put_nowait({"event": "mc_connected", "data": mc_state})
            except queue.Full:
                pass
        if last_sensor_data:
            try:
                client_queue.put_nowait({"event": "sensor_data_snapshot", "data": last_sensor_data})
            except queue.Full:
                pass
        # MQTT 연결 상태/에러도 전달 (앱 기동 직후 실패해도 화면에 메시지 보이도록)
        try:
            client_queue.put_nowait({"event": "mqtt_status_snapshot", "data": mqtt_status})
        except queue.Full:
            pass
    return Response(
        sse_stream(client_queue),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.route("/api/start_udp", methods=["POST"])
def start_udp():
    global udp_thread
    data = request.get_json() or {}
    ip = data.get("ip", "0.0.0.0")
    port = int(data.get("port", 5212))

    if udp_thread and udp_thread.is_alive():
        return {"error": "이미 UDP 리스너가 실행 중입니다."}, 400

    udp_thread = threading.Thread(target=udp_listener, args=(ip, port))
    udp_thread.daemon = True
    udp_thread.start()

    return {"ok": True}


@app.route("/api/stop_udp", methods=["POST"])
def stop_udp():
    global listening
    listening = False
    return {"ok": True}


@app.route("/api/health")
def health():
    return {"status": "ok"}


def _mc_on_parsed(parsed):
    broadcast("mc_data", {"parsed": parsed})


def _mc_on_error(message):
    broadcast("mc_error", {"message": message})


@app.route("/api/mc/connect", methods=["POST", "OPTIONS"])
def mc_connect():
    if request.method == "OPTIONS":
        return "", 204

    global mc_thread, mc_stop_event, mc_state
    try:
        data = request.get_json(silent=True) or {}
        host = (data.get("host") or "127.0.0.1").strip()
        port = int(data.get("port", 5002))
    except (TypeError, ValueError) as e:
        return {"error": f"잘못된 요청: {e}"}, 400

    if mc_thread and mc_thread.is_alive():
        return {"error": "이미 MC 프로토콜 폴링이 실행 중입니다."}, 400

    _ensure_local_mc_fake_server(host, port)

    try:
        from mc_poller import run_poller
    except ImportError:
        _backend_dir = os.path.dirname(os.path.abspath(__file__))
        if _backend_dir not in sys.path:
            sys.path.insert(0, _backend_dir)
        try:
            from mc_poller import run_poller
        except ImportError:
            return {"error": "mc_poller를 불러올 수 없습니다."}, 500

    try:
        mc_stop_event = threading.Event()
        mc_thread = threading.Thread(
            target=run_poller,
            args=(host, port, _mc_on_parsed, _mc_on_error, mc_stop_event),
            daemon=True,
        )
        mc_thread.start()
        mc_state = {"host": host, "port": port}
        broadcast("mc_connected", mc_state)
        return {"ok": True}
    except Exception as e:
        return {"error": str(e)}, 500


@app.route("/api/mc/disconnect", methods=["POST", "OPTIONS"])
def mc_disconnect():
    if request.method == "OPTIONS":
        return "", 204
    global mc_thread, mc_stop_event, mc_state
    if mc_stop_event:
        mc_stop_event.set()
    mc_thread = None
    mc_stop_event = None
    mc_state = None
    broadcast("mc_disconnected", {})
    return {"ok": True}


@app.route("/api/mc/poll-intervals", methods=["GET", "POST", "OPTIONS"])
def mc_poll_intervals():
    if request.method == "OPTIONS":
        return "", 204
    try:
        from mc_poller import get_poll_intervals, set_poll_intervals
    except ImportError:
        _backend_dir = os.path.dirname(os.path.abspath(__file__))
        if _backend_dir not in sys.path:
            sys.path.insert(0, _backend_dir)
        try:
            from mc_poller import get_poll_intervals, set_poll_intervals
        except ImportError:
            return {"error": "mc_poller를 불러올 수 없습니다."}, 500
    if request.method == "GET":
        return get_poll_intervals()
    data = request.get_json(silent=True) or {}
    set_poll_intervals(
        boolean_ms=data.get("boolean_ms"),
        data_ms=data.get("data_ms"),
        string_ms=data.get("string_ms"),
    )
    return get_poll_intervals()


# MQTT 구독 시작 (앱 로드 시 한 번만)
try:
    from mqtt_subscriber import start as mqtt_start
    mqtt_start(broadcast)
except Exception:
    pass


def _serve_frontend(path=""):
    """프론트 빌드물(frontend_dist)이 있으면 정적 파일/SPA 서빙."""
    path = path.strip("/") or "index.html"
    file_path = os.path.join(_FRONTEND_DIST, path)
    if os.path.isfile(file_path):
        return send_from_directory(_FRONTEND_DIST, path)
    if not path.startswith("api/"):
        index_path = os.path.join(_FRONTEND_DIST, "index.html")
        if os.path.isfile(index_path):
            return send_from_directory(_FRONTEND_DIST, "index.html")
    return None


# frontend_dist 있을 때만 루트/SPA 라우트 등록 (단일 실행·exe용)
if os.path.isdir(_FRONTEND_DIST):
    @app.route("/", defaults={"path": ""})
    @app.route("/<path:path>")
    def serve_static_or_spa(path):
        if path.startswith("api/"):
            return {"error": "Not Found"}, 404
        r = _serve_frontend(path)
        if r is not None:
            return r
        return {"error": "Not Found"}, 404


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=6005, debug=True, use_reloader=False, threaded=True)
