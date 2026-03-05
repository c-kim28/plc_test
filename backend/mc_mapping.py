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
