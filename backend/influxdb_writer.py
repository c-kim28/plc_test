"""
PLC 수집 데이터를 InfluxDB 2.x에 기록.
measurement: plc, tag: variable=이름, field: value (숫자/문자)
"""
from datetime import datetime, timezone

from influxdb_config import INFLUX_URL, INFLUX_TOKEN, INFLUX_ORG, INFLUX_BUCKET, is_configured

_client = None
_write_api = None


def _get_client():
    global _client, _write_api
    if _client is not None:
        return _write_api
    if not is_configured():
        print("[InfluxDB] 설정 없음 (INFLUX_URL 등)", flush=True)
        return None
    try:
        from influxdb_client import InfluxDBClient
        from influxdb_client.client.write_api import SYNCHRONOUS
        _client = InfluxDBClient(url=INFLUX_URL, token=INFLUX_TOKEN, org=INFLUX_ORG)
        # 배치 모드는 버퍼가 쌓여서 즉시 안 갈 수 있음 → 동기 쓰기로 매번 즉시 전송
        _write_api = _client.write_api(write_options=SYNCHRONOUS)
        print("[InfluxDB] 연결됨 %s (동기 쓰기)" % INFLUX_URL, flush=True)
        return _write_api
    except Exception as e:
        print("[InfluxDB] 연결 실패:", e, flush=True)
        return None


def _get_client_obj():
    """쓰기용이 아닌 query_api 등에 쓸 InfluxDBClient 인스턴스 반환."""
    _get_client()
    return _client


def write_plc_point(variable: str, value, device_type: str = ""):
    """
    단일 변수 한 점 기록.
    value: int, float, str (문자열은 field "value_str" 사용)
    """
    api = _get_client()
    if api is None:
        return False
    try:
        from influxdb_client import Point
        p = Point("plc").tag("variable", variable)
        if device_type:
            p = p.tag("device", device_type)
        if isinstance(value, (int, float)):
            p = p.field("value", value)
        else:
            p = p.field("value_str", str(value))
        api.write(bucket=INFLUX_BUCKET, org=INFLUX_ORG, record=p)
        return True
    except Exception:
        return False


def write_plc_batch(records: list, timestamp: float | None = None):
    """
    records: [(variable, value, device_type?), ...]
    device_type 생략 시 "" 사용.
    timestamp: 폴링 완료 시점(초 단위 float, time.time()). None이면 기록 시점 사용.
               설정 시 UTC datetime으로 변환해 각 Point의 _time에 ms 단위까지 저장.
    """
    api = _get_client()
    if api is None:
        return False
    if not records:
        return False
    try:
        from influxdb_client import Point
        # datetime(UTC)으로 넘겨야 클라이언트가 _time을 초 단위로 잘리지 않고 ms까지 저장함
        dt = datetime.fromtimestamp(timestamp, tz=timezone.utc) if timestamp is not None else None
        points = []
        for r in records:
            variable = r[0]
            value = r[1]
            device_type = r[2] if len(r) > 2 else ""
            p = Point("plc").tag("variable", variable)
            if device_type:
                p = p.tag("device", device_type)
            if isinstance(value, (int, float)):
                p = p.field("value", value)
            else:
                p = p.field("value_str", str(value))
            if dt is not None:
                p = p.time(dt)
            points.append(p)
        api.write(bucket=INFLUX_BUCKET, org=INFLUX_ORG, record=points)
        return True
    except Exception as e:
        err_parts = [str(e)]
        cause = e
        while getattr(cause, "__cause__", None):
            cause = cause.__cause__
            err_parts.append(str(cause))
        err = " ".join(err_parts).lower()
        if "connection refused" in err or "errno 111" in err or "failed to establish" in err:
            print("\n[InfluxDB] 8086 연결 안됨 → InfluxDB가 꺼져 있습니다. 먼저 실행하세요:\n  cd ~/plc/plc_test && sudo docker-compose -f docker-compose.influxdb.yml up -d\n", flush=True)
        else:
            print("[InfluxDB] write 실패:", e, flush=True)
        return False


def is_connected() -> bool:
    """이미 연결된 클라이언트가 있는지 여부."""
    return _client is not None


def check_connection() -> tuple[bool, str]:
    """
    InfluxDB 연결 가능 여부. (연결 시도함)
    반환: (성공 여부, 메시지)
    """
    api = _get_client()
    if api is not None:
        return True, "연결됨"
    if not is_configured():
        return False, "설정 없음 (INFLUX_URL 등)"
    return False, "연결 실패 (URL/토큰/네트워크 확인)"


def close():
    global _client, _write_api
    if _client:
        try:
            _client.close()
        except Exception:
            pass
        _client = None
        _write_api = None


def export_plc_csv(start_iso: str, end_iso: str) -> tuple[str | None, str | None]:
    """
    지정 구간(시작/종료 ISO8601)의 plc measurement 데이터를 Flux로 조회해 CSV 문자열 반환.
    반환: (csv_string, None) 성공 시, (None, error_message) 실패 시.
    """
    import csv
    import io
    client = _get_client_obj()
    if client is None or not is_configured():
        return None, "InfluxDB 연결이 없습니다."
    start_ = start_iso.strip().replace(" ", "T", 1)
    end_ = end_iso.strip().replace(" ", "T", 1)
    if not start_ or not end_:
        return None, "시작/종료 시간을 입력하세요."
    if not start_.endswith("Z") and "+" not in start_:
        start_ = start_ + "Z"
    if not end_.endswith("Z") and "+" not in end_:
        end_ = end_ + "Z"
    query = (
        f'from(bucket: "{INFLUX_BUCKET}") '
        f'|> range(start: time(v: "{start_}"), stop: time(v: "{end_}")) '
        '|> filter(fn: (r) => r._measurement == "plc") '
        '|> sort(columns: ["_time", "variable"])'
    )
    try:
        query_api = client.query_api()
        tables = query_api.query(query, org=INFLUX_ORG)
    except Exception as e:
        return None, str(e)
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(["time", "variable", "field", "value"])
    row_count = 0
    for table in tables or []:
        for record in getattr(table, "records", []) or []:
            vals = getattr(record, "values", {}) or {}
            t = vals.get("_time", "")
            var = vals.get("variable", "")
            field = vals.get("_field", "")
            val = vals.get("_value", "")
            if isinstance(val, (int, float)):
                val = str(val)
            writer.writerow([t, var, field, val])
            row_count += 1
    if row_count == 0:
        writer.writerow([])
        return out.getvalue(), None  # 헤더만 있는 CSV도 반환
    return out.getvalue(), None


def export_plc_csv_pivot(start_iso: str, end_iso: str, group_key: str) -> tuple[str | None, str | None]:
    """
    지정 구간·폴링 그룹(50ms|1s|1min|1h)의 plc 데이터를 조회해
    행=변수명, 열=타임스탬프, 셀=value 인 CSV 반환.
    반환: (csv_string, None) 성공 시, (None, error_message) 실패 시.
    """
    import csv
    import io

    from mc_mapping import POLL_INTERVAL_KEYS, get_variable_names_by_poll_interval

    if group_key not in POLL_INTERVAL_KEYS:
        return None, f"지원하지 않는 그룹입니다. 사용 가능: {', '.join(POLL_INTERVAL_KEYS)}"
    client = _get_client_obj()
    if client is None or not is_configured():
        return None, "InfluxDB 연결이 없습니다."
    start_ = start_iso.strip().replace(" ", "T", 1)
    end_ = end_iso.strip().replace(" ", "T", 1)
    if not start_ or not end_:
        return None, "시작/종료 시간을 입력하세요."
    if not start_.endswith("Z") and "+" not in start_:
        start_ = start_ + "Z"
    if not end_.endswith("Z") and "+" not in end_:
        end_ = end_ + "Z"
    query = (
        f'from(bucket: "{INFLUX_BUCKET}") '
        f'|> range(start: time(v: "{start_}"), stop: time(v: "{end_}")) '
        '|> filter(fn: (r) => r._measurement == "plc") '
        '|> sort(columns: ["_time", "variable"])'
    )
    try:
        query_api = client.query_api()
        tables = query_api.query(query, org=INFLUX_ORG)
    except Exception as e:
        return None, str(e)
    # (variable, time) -> value (마지막 값 사용; 동일 시점 중복 시 덮어씀)
    data: dict[tuple[str, str], str] = {}
    timestamps_set: set[str] = set()
    for table in tables or []:
        for record in getattr(table, "records", []) or []:
            vals = getattr(record, "values", {}) or {}
            t = vals.get("_time", "")
            var = vals.get("variable", "")
            val = vals.get("_value", "")
            if isinstance(val, (int, float)):
                val = str(val)
            else:
                val = str(val) if val is not None else ""
            if var and t:
                data[(var, t)] = val
                timestamps_set.add(t)
    var_names = get_variable_names_by_poll_interval().get(group_key, [])
    if not var_names:
        return None, f"해당 그룹({group_key})에 변수가 없습니다."
    # 그룹 순서대로 행 출력; 데이터에만 있는 변수는 그룹 목록 뒤에 추가
    ordered_vars = list(var_names)
    for (v, _) in data:
        if v not in ordered_vars:
            ordered_vars.append(v)
    timestamps = sorted(timestamps_set)
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(["variable"] + timestamps)
    for var in ordered_vars:
        row = [var] + [data.get((var, t), "") for t in timestamps]
        writer.writerow(row)
    return out.getvalue(), None
