"""
MC 프로토콜(3E) 대시보드용 매핑. plc_mcprotocol.py와 동일한 4개 변수만 사용.
- D140 word 1개, Y107 boolean 1비트, D1810 dword 1개, D1560 string 16바이트
"""
# (변수명, device, address, data_type, length)
# data_type: boolean | word | dword | string. length: boolean=비트수, word=워드수, dword=개수, string=바이트수
MC_ENTRIES = [
    ("warningLightRedCircleType_Y107", "Y", 107, "boolean", 1),
    ("currentDieNumber_D140", "D", 140, "word", 1),
    ("productionCounter_D1810", "D", 1810, "dword", 1),
    ("currentDieName_D1560", "D", 1560, "string", 16),
]


def get_mc_entries():
    return list(MC_ENTRIES)


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
