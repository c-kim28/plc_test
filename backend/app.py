import json
import os
import queue
import socket
import subprocess
import sys
import threading
import time
import atexit
from concurrent.futures import ThreadPoolExecutor

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

# MC Protocol (3E)
mc_thread = None
mc_stop_event = None
mc_state = None  # {"host": str, "port": int} when connected (slave 없음)
mc_fake_server_proc = None
# InfluxDB 전용 MC 폴러 (M 1초/값1만, D 50ms·일부 1시간, Y 1초)
mc_influx_stop_event = None
# 폴링 스레드별 수신 데이터를 블로킹 없이 즉시 InfluxDB에 저장하기 위한 전용 스레드 풀
_influx_write_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="influx_write")

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
        for _ in range(15):  # 최대 1.5초 대기
            time.sleep(0.1)
            if _is_tcp_open(host, port):
                break
        if not _is_tcp_open(host, port):
            print("[MC] 가짜 서버(5002) 기동 대기 실패. 수동 실행: python backend/plc_tcp_fake_response.py", flush=True)
    except Exception as e:
        print("[MC] 가짜 서버 기동 예외:", e, flush=True)
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


@app.route("/api/health")
def health():
    return {"status": "ok"}


def _mc_on_parsed(parsed):
    broadcast("mc_data", {"parsed": parsed})
    # 폴링 완료 시점(ms 단위 반영)을 타임스탬프로 넘겨 InfluxDB _time이 폴링 주기대로 저장되도록 함
    ts = time.time()
    def _write():
        try:
            from influxdb_from_mc import write_parsed_to_influx
            write_parsed_to_influx(parsed, timestamp=ts)
        except Exception as e:
            print("[InfluxDB] 기록 오류:", e, flush=True)
    _influx_write_executor.submit(_write)


def _mc_on_error(message):
    broadcast("mc_error", {"message": message})


@app.route("/api/mc/connect", methods=["POST", "OPTIONS"])
def mc_connect():
    if request.method == "OPTIONS":
        return "", 204

    global mc_thread, mc_stop_event, mc_state, mc_influx_stop_event
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
        # InfluxDB는 대시보드 폴러와 동일한 수신 데이터로 기록 (mc_connect 시 별도 폴러 없음)
        mc_influx_stop_event = None
        print("[MC] 연결됨 %s:%s → 폴링 시작 후 수신 데이터가 InfluxDB에 자동 기록됩니다." % (host, port), flush=True)
        broadcast("mc_connected", mc_state)
        return {"ok": True}
    except Exception as e:
        return {"error": str(e)}, 500


@app.route("/api/mc/disconnect", methods=["POST", "OPTIONS"])
def mc_disconnect():
    if request.method == "OPTIONS":
        return "", 204
    global mc_thread, mc_stop_event, mc_state, mc_influx_stop_event
    if mc_stop_event:
        mc_stop_event.set()
    if mc_influx_stop_event:
        mc_influx_stop_event.set()
    mc_thread = None
    mc_stop_event = None
    mc_state = None
    mc_influx_stop_event = None
    broadcast("mc_disconnected", {})
    return {"ok": True}


@app.route("/api/mc/poll-rates", methods=["GET"])
def mc_poll_rates():
    try:
        from mc_poller import get_poll_intervals, get_poll_thread_entries, MIN_INTERVAL_SEC, MAX_INTERVAL_SEC
    except ImportError:
        _backend_dir = os.path.dirname(os.path.abspath(__file__))
        if _backend_dir not in sys.path:
            sys.path.insert(0, _backend_dir)
        from mc_poller import get_poll_intervals, get_poll_thread_entries, MIN_INTERVAL_SEC, MAX_INTERVAL_SEC

    intervals = get_poll_intervals()
    grouped = get_poll_thread_entries()
    threads = []
    for key in ("50ms", "1s", "1min", "1h"):
        entries = grouped.get(key, [])
        threads.append({
            "key": key,
            "interval_ms": int(round(float(intervals.get(key, 0)) * 1000)),
            "entry_count": len(entries),
            "entries": [{"name": e[0], "device": e[1], "address": e[2]} for e in entries],
        })
    return {
        "min_ms": int(MIN_INTERVAL_SEC * 1000),
        "max_ms": int(MAX_INTERVAL_SEC * 1000),
        "threads": threads,
    }


@app.route("/api/mc/poll-rates", methods=["POST", "OPTIONS"])
def mc_poll_rates_update():
    if request.method == "OPTIONS":
        return "", 204
    try:
        data = request.get_json(silent=True) or {}
        intervals_ms = data.get("intervals_ms") or {}
        interval_map_sec = {}
        for key in ("50ms", "1s", "1min", "1h"):
            if key not in intervals_ms:
                continue
            interval_map_sec[key] = float(intervals_ms[key]) / 1000.0
    except (TypeError, ValueError) as e:
        return {"error": f"잘못된 요청: {e}"}, 400

    try:
        from mc_poller import set_poll_intervals
    except ImportError:
        _backend_dir = os.path.dirname(os.path.abspath(__file__))
        if _backend_dir not in sys.path:
            sys.path.insert(0, _backend_dir)
        from mc_poller import set_poll_intervals

    try:
        set_poll_intervals(interval_map_sec)
        return {"ok": True}
    except ValueError as e:
        return {"error": str(e)}, 400
    except Exception as e:
        return {"error": str(e)}, 500


@app.route("/api/influxdb/status", methods=["GET"])
def influxdb_status():
    """InfluxDB 연결 상태 확인 (연결 시도 후 결과 반환)."""
    try:
        from influxdb_writer import check_connection
        from influxdb_config import INFLUX_URL
        ok, msg = check_connection()
        return {"ok": ok, "message": msg, "url": INFLUX_URL}
    except Exception as e:
        return {"ok": False, "message": str(e), "url": ""}


@app.route("/api/influxdb/test-write", methods=["POST", "GET"])
def influxdb_test_write():
    """테스트용 포인트 1건 기록. 대시보드에서 measurement 'plc', tag 확인용."""
    try:
        from influxdb_writer import write_plc_point
        if write_plc_point("_test_ping", 1, "test"):
            return {"ok": True, "message": "테스트 기록 완료. 대시보드에서 Bucket → measurement 'plc' 선택"}
        return {"ok": False, "message": "InfluxDB 연결/기록 실패"}
    except Exception as e:
        return {"ok": False, "message": str(e)}


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
    try:
        from influxdb_writer import check_connection
        from influxdb_config import INFLUX_URL
        print("[InfluxDB] 연결 시도: %s" % INFLUX_URL, flush=True)
        ok, msg = check_connection()
        if ok:
            print("[InfluxDB] 연결됨 → MC 폴링 시 자동 기록됩니다.", flush=True)
        else:
            print("[InfluxDB] 연결 실패 (%s)" % msg, flush=True)
            print("  같은 터미널에서 확인: curl -s -o /dev/null -w '%%{http_code}' %s/health  → 200 나와야 함" % INFLUX_URL.rstrip("/"), flush=True)
            print("  백엔드를 Docker 안에서 실행 중이면: INFLUX_URL=http://host.docker.internal:8086 또는 호스트 IP 사용", flush=True)
    except Exception:
        pass
    app.run(host="0.0.0.0", port=6005, debug=True, use_reloader=False, threaded=True)
