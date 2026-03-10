"""
MC 프로토콜(3E) 대시보드용 매핑. mc_fake_values.json에 정의된 항목을 폴링·표시.
JSON에 키(예: M300, D140)를 추가하면 해당 변수가 폴링되고 가짜 응답 서버가 value로 응답.
"""
import json
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
MC_FAKE_VALUES_PATH = SCRIPT_DIR / "mc_fake_values.json"


def _parse_key(key: str) -> tuple[str, int] | None:
    '''키 "M300", "D140", "Y14C" → (device, address).'''
    if not key or key.startswith("_"):
        return None
    device = key[0].upper()
    if device not in ("Y", "M", "D"):
        return None
    addr_text = key[1:].strip().upper()
    if not addr_text:
        return None
    try:
        # Mitsubishi Y 디바이스는 16진 표기 주소를 사용한다. (예: Y107, Y14C)
        if device == "Y":
            address = int(addr_text, 16)
        elif any(ch in "ABCDEF" for ch in addr_text):
            address = int(addr_text, 16)
        else:
            address = int(addr_text, 10)
    except ValueError:
        return None
    return (device, address)


def get_mc_entries():
    """mc_fake_values.json에서 (변수명, device, address, data_type, length) 리스트 반환."""
    if not MC_FAKE_VALUES_PATH.exists():
        return []
    try:
        with open(MC_FAKE_VALUES_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return []
    result = []
    for key, entry in data.items():
        if not isinstance(entry, dict) or key.startswith("_"):
            continue
        parsed = _parse_key(key)
        if not parsed:
            continue
        device, address = parsed
        data_type = (entry.get("dataType") or "word").strip().lower()
        length = int(entry.get("length") or 1)
        name = entry.get("name") or key
        result.append((name, device, address, data_type, length))
    return result


# InfluxDB 1시간 주기 저장 대상 (50ms 폴링은 하되 저장만 1시간마다)
INFLUX_HOURLY_SAVE_NAMES = frozenset({
    "currentDieNumber_D140",
    "currentDieName_D1560", "currentDieName_D1561", "currentDieName_D1562", "currentDieName_D1563",
    "currentDieName_D1564", "currentDieName_D1565", "currentDieName_D1566", "currentDieName_D1567",
    "currentDieHeight_D711",
    "currentBalanceAirPressure_D713",
    "nextDieNumber_D510",
    "nextDieName_D549", "nextDieName_D550", "nextDieName_D551", "nextDieName_D552",
    "nextDieName_D553", "nextDieName_D554", "nextDieName_D555", "nextDieName_D556",
    "nextDieHeight_D511",
    "nextBalanceAirPressure_D513",
    "presetCounter_D1816",
    "presetCounter_D1817",
})

# 폴링 주기별 변수명 (대시보드 MC 폴러용)
# 1초: boolean 전체 + 토탈카운터, 현재생산량, 과부족수량, 카운트수량, 금일가동수량, 금일 가동시간
POLL_1SEC_NAMES = frozenset({
    "totalCounter_D1820", "totalCounter_D1821",
    "currentProduction_D1812", "currentProduction_D1813",
    "defficiencyQuantity_D1814", "defficiencyQuantity_D1815",
    "productionCounter_D1810", "productionCounter_D1811",
    "todayStrokeCount_D1912", "todayStrokeCount_D1913",
    "todayRunningTime_D1914",
})
# 1분: C.P.M, S.P.M
POLL_1MIN_NAMES = frozenset({"cPMCyclePerMinute_D104", "strokePerMinute_D126"})
# 1시간: 현재/다음 금형번호·금형이름·다이하이트·바란스에어압력, 생산계획량(목표 타발수)
POLL_1HOUR_NAMES = INFLUX_HOURLY_SAVE_NAMES


def get_mc_entries_by_poll_interval():
    """
    폴링 주기별로 엔트리 분리 반환.
    반환: (entries_50ms, entries_1s, entries_1min, entries_1h)
    - 1s: Boolean 전체 + POLL_1SEC_NAMES
    - 1min: POLL_1MIN_NAMES (C.P.M, S.P.M)
    - 1h: POLL_1HOUR_NAMES (금형/다이/바란스/생산계획·목표타발)
    - 50ms: 나머지 전부
    """
    entries = get_mc_entries()
    e_1h = []
    e_1min = []
    e_1s = []
    e_50ms = []
    for e in entries:
        name, dev, addr, data_type, length = e
        if name in POLL_1HOUR_NAMES:
            e_1h.append(e)
        elif name in POLL_1MIN_NAMES:
            e_1min.append(e)
        elif (data_type or "").strip().lower() == "boolean" or name in POLL_1SEC_NAMES:
            e_1s.append(e)
        else:
            e_50ms.append(e)
    return (e_50ms, e_1s, e_1min, e_1h)


POLL_INTERVAL_KEYS = ("50ms", "1s", "1min", "1h")


def get_variable_names_by_poll_interval() -> dict[str, list[str]]:
    """
    폴링 주기별 변수명 리스트. CSV export 시 그룹 필터·행 순서용.
    반환: {"50ms": [name, ...], "1s": [...], "1min": [...], "1h": [...]}
    """
    e_50ms, e_1s, e_1min, e_1h = get_mc_entries_by_poll_interval()
    return {
        "50ms": [e[0] for e in e_50ms],
        "1s": [e[0] for e in e_1s],
        "1min": [e[0] for e in e_1min],
        "1h": [e[0] for e in e_1h],
    }


def get_mc_entries_by_device(device: str, exclude_hourly_d: bool = False):
    """
    device: "M" | "D" | "Y"
    exclude_hourly_d: True면 D 중 INFLUX_HOURLY_SAVE_NAMES 제외 (일반 D만)
    """
    entries = get_mc_entries()
    out = []
    for e in entries:
        name, dev, *_ = e
        if dev != device:
            continue
        if device == "D" and exclude_hourly_d and name in INFLUX_HOURLY_SAVE_NAMES:
            continue
        out.append(e)
    return out


def get_mc_entries_hourly_d():
    """D 중 1시간마다 InfluxDB에 저장할 항목만."""
    entries = get_mc_entries()
    return [e for e in entries if e[1] == "D" and e[0] in INFLUX_HOURLY_SAVE_NAMES]


def get_name_to_device() -> dict:
    """변수명 → device ("M"|"D"|"Y") 매핑. InfluxDB 기록 시 구분용."""
    entries = get_mc_entries()
    return {e[0]: e[1] for e in entries}


def num_words_from_type(data_type: str, length: int) -> int:
    t = (data_type or "").strip().lower()
    if t == "boolean":
        return max(1, (length + 15) // 16)
    if t == "word":
        return max(1, length)
    if t == "dword":
        return max(1, length * 2)
    if t == "string":
        return max(1, (length + 1) // 2)
    return max(1, length)
