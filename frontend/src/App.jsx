import { useState, useEffect, useRef, useMemo } from 'react'
import './App.css'

// 개발 모드: 접속한 호스트(로컬/원격)의 6005 사용 → SSH로 서버 IP 접속해도 API 연결됨
const API_URL = import.meta.env.DEV ? `http://${window.location.hostname}:6005` : window.location.origin

function hexToBytes(hex) {
  const s = String(hex).replace(/\s/g, '')
  if (!/^[0-9a-fA-F]*$/.test(s) || s.length % 2 !== 0) return []
  const out = []
  for (let i = 0; i < s.length; i += 2) out.push(parseInt(s.slice(i, i + 2), 16))
  return out
}

/**
 * @param rawHex - hex 문자열
 * @param variableList - [ [name, lengthBit], ... ]
 * @param options - { orderReversed: boolean, littleEndian: boolean }
 *   orderReversed: true면 목록 역순으로 스트림에 매핑
 *   littleEndian: true면 8/16/32비트는 바이트 리틀엔디안(앞 바이트=하위)으로 해석
 */
function parseRawByVariableList(rawHex, variableList, options = {}) {
  if (!variableList?.length || !rawHex) return {}
  const { orderReversed = false, littleEndian = false } = options
  const listToUse = orderReversed ? [...variableList].reverse() : variableList
  // 항목: [name, lengthBit] 또는 [name, lengthBit, dataType]
  const totalVarBits = listToUse.reduce((s, row) => s + (Number(row[1]) || 0), 0)
  const bytes = hexToBytes(rawHex)
  const totalBits = bytes.length * 8
  let offset =
    totalBits > totalVarBits && !orderReversed
      ? totalBits - totalVarBits
      : 0

  const getBit = (i) => (bytes[i >> 3] >> (7 - (i % 8))) & 1
  const result = {}

  for (let i = 0; i < listToUse.length; i++) {
    const row = listToUse[i]
    const name = row[0]
    const lengthBit = row[1]
    const dataType = (row[2] ?? '').toLowerCase()
    const len = Number(lengthBit) || 0
    const nextRow = listToUse[i + 1]
    const nextName = nextRow?.[0]
    const nextLen = Number(nextRow?.[1]) || 0
    const nextDt = (nextRow?.[2] ?? '').toLowerCase()
    const isDwordLow = dataType === 'dword' && len === 16 && nextDt === 'dword' && nextLen === 16
    const m = name.match(/^(.+)_D(\d+)$/)
    const n = nextName && nextName.match(/^(.+)_D(\d+)$/)
    const sameDwordPair = m && n && m[1] === n[1] && parseInt(n[2], 10) === parseInt(m[2], 10) + 1
    const doWordSwap32 = littleEndian && isDwordLow && sameDwordPair && offset % 8 === 0 && offset + 32 <= totalBits

    if (len <= 0 || offset + len > totalBits) {
      result[name] = '-'
      if (len > 0) offset += len
      continue
    }
    if (doWordSwap32) {
      const start = offset >> 3
      const lowWord = (((bytes[start] ?? 0) << 8) | (bytes[start + 1] ?? 0)) >>> 0
      const highWord = (((bytes[start + 2] ?? 0) << 8) | (bytes[start + 3] ?? 0)) >>> 0
      const val = ((highWord << 16) | lowWord) >>> 0
      result[name] = val & 0xFFFF
      result[nextName] = (val >> 16) & 0xFFFF
      offset += 32
      i++
      continue
    }
    if (len <= 32) {
      let val
      const byteAligned = offset % 8 === 0
      if (byteAligned && (len === 8 || len === 16 || len === 32)) {
        const start = offset >> 3
        if (len === 8) {
          val = bytes[start] ?? 0
        } else if (len === 16 && start + 1 < bytes.length) {
          val = (((bytes[start] ?? 0) << 8) | (bytes[start + 1] ?? 0)) >>> 0
        } else if (len === 32 && start + 3 < bytes.length) {
          if (littleEndian) {
            const lowWord = (((bytes[start] ?? 0) << 8) | (bytes[start + 1] ?? 0)) >>> 0
            const highWord = (((bytes[start + 2] ?? 0) << 8) | (bytes[start + 3] ?? 0)) >>> 0
            val = ((highWord << 16) | lowWord) >>> 0
          } else {
            val = (
              ((bytes[start] ?? 0) * 0x1000000) +
              ((bytes[start + 1] ?? 0) << 16) +
              ((bytes[start + 2] ?? 0) << 8) +
              (bytes[start + 3] ?? 0)
            ) >>> 0
          }
        } else {
          val = readBitsAsNumber(offset, len, getBit, littleEndian)
        }
      } else {
        val = readBitsAsNumber(offset, len, getBit, littleEndian)
      }
      result[name] = val
    } else {
      // 문자열: 수신 순서 그대로 (TOLE은 자연 순서로 전송)
      const byteCount = Math.ceil(len / 8)
      const rawBytes = []
      for (let b = 0; b < byteCount; b++) {
        const bitStart = offset + b * 8
        if (bitStart + 8 > totalBits) break
        let byteVal = 0
        for (let i = 0; i < 8; i++) byteVal = (byteVal << 1) | getBit(bitStart + i)
        rawBytes.push(byteVal)
      }
      result[name] = rawBytes.map((v) => v.toString(16).padStart(2, '0')).join('') || '-'
    }
    offset += len
  }
  return result
}

/** 1비트·비정렬 등 비트 단위 읽기로 숫자 생성 (리틀=LSB 먼저) */
function readBitsAsNumber(offset, len, getBit, littleEndian) {
  let val = 0
  if (littleEndian) {
    for (let i = 0; i < len; i++) val = (val | (getBit(offset + i) << i)) >>> 0
  } else {
    for (let i = 0; i < len; i++) val = ((val << 1) | getBit(offset + i)) >>> 0
  }
  if (len < 32) return val & ((1 << len) - 1)
  return val >>> 0
}

/** 드롭다운 값 '1'=빅엔디안, '2'=리틀엔디안 → { orderReversed, littleEndian } */
function getParseOptionsFromMode(mode) {
  switch (mode) {
    case '1': return { orderReversed: false, littleEndian: false } // 빅엔디안
    case '2': return { orderReversed: false, littleEndian: true }    // 리틀엔디안
    default: return { orderReversed: false, littleEndian: false }
  }
}

/**
 * 파싱된 raw 값을 DataType/scale에 따라 표시용으로 디코딩.
 * - Boolean: 그대로 0/1
 * - Word/Dword, scale 1: 정수
 * - Word/Dword, scale 0.1: 실수
 * - String: hex → ASCII 문자열 (끝 null 제거)
 */
function toUnsigned(num, len) {
  const bits = Number(len) || 32
  const u32 = Number(num) >>> 0
  if (bits <= 8) return u32 & 0xff
  if (bits <= 16) return u32 & 0xffff
  return u32
}

function decodeForDisplay(raw, info) {
  if (raw === '-' || raw === undefined || raw === null) return '-'
  const dt = (info?.dataType ?? '').toLowerCase()
  const scaleStr = String(info?.scale ?? '1').trim()
  const scaleNum = parseFloat(scaleStr) || 1
  const len = Number(info?.length) || 32

  if (dt === 'boolean') return String(Number(raw))

  if (dt === 'word' || dt === 'dword') {
    const num = typeof raw === 'number' ? raw : parseInt(raw, 10)
    if (Number.isNaN(num)) return '-'
    const u = toUnsigned(num, len)
    let display = u
    if (len === 16) {
      const s = (u & 0xFFFF) << 16 >> 16
      if (s < 0) display = 0
    } else if (len === 32) {
      const s = (u >>> 0) | 0
      if (s < 0) display = 0
    }
    if (scaleNum === 0.1) return (display * 0.1).toFixed(1)
    return display
  }

  if (dt === 'string') {
    if (typeof raw === 'string' && !/^[0-9a-fA-F]*$/.test(raw)) {
      return raw.replace(/\0+$/, '').trim() || '-'
    }
    let hexStr = ''
    if (typeof raw === 'number' && len === 16) {
      hexStr = (raw >>> 0).toString(16).padStart(4, '0')
    } else if (typeof raw === 'string' && /^[0-9a-fA-F]*$/.test(raw)) {
      hexStr = raw
    } else {
      return '-'
    }
    const bytes = hexToBytes(hexStr)
    if (!bytes.length) return '-'
    const s = String.fromCharCode(...bytes)
    return s.replace(/\0+$/, '').trim() || '-'
  }

  if (typeof raw === 'number') {
    return toUnsigned(raw, len)
  }
  return raw
}

/** 변수명에서 PLC 디바이스 그룹 추출. 예: xxx_Y14C -> 'Y', xxx_M300 -> 'M'. 없으면 null */
function getDeviceGroup(name) {
  if (!name || typeof name !== 'string') return null
  const m = name.match(/_([YMDX])[\dA-Za-z]*$/i)
  return m ? m[1].toUpperCase() : null
}

/** Dword 쌍·String 연속(같은 이름 + 연속 D주소)을 한 행으로 묶은 표시용 리스트. */
function buildDisplayVariableList(ioVariableList) {
  const result = []
  for (let i = 0; i < ioVariableList.length; i++) {
    const [name, info] = ioVariableList[i]
    const dt = (info?.dataType ?? '').toLowerCase()
    const len = Number(info?.length) || 0
    const next = ioVariableList[i + 1]
    const nextName = next?.[0]
    const nextInfo = next?.[1]
    const nextDt = (nextInfo?.dataType ?? '').toLowerCase()
    const nextLen = Number(nextInfo?.length) || 0
    // Dword: 연속 2개(16+16) → 한 행
    if (dt === 'dword' && len === 16 && nextDt === 'dword' && nextLen === 16) {
      const m = name.match(/^(.+)_D(\d+)$/)
      const n = nextName && nextName.match(/^(.+)_D(\d+)$/)
      if (m && n && m[1] === n[1] && parseInt(n[2], 10) === parseInt(m[2], 10) + 1) {
        result.push({
          name,
          keys: [name, nextName],
          info: { ...info, length: 32 }
        })
        i++
        continue
      }
    }
    // String: 같은 접두어 + 연속 D주소 전부 → 한 행 (예: nextDieName_D549~D556)
    if (dt === 'string' && len === 16) {
      const m = name.match(/^(.+)_D(\d+)$/)
      if (m) {
        const prefix = m[1]
        let lastNum = parseInt(m[2], 10)
        const keys = [name]
        let j = i + 1
        while (j < ioVariableList.length) {
          const [nName, nInfo] = ioVariableList[j]
          const nDt = (nInfo?.dataType ?? '').toLowerCase()
          const nLen = Number(nInfo?.length) || 0
          if (nDt !== 'string' || nLen !== 16) break
          const nm = nName.match(/^(.+)_D(\d+)$/)
          if (!nm || nm[1] !== prefix || parseInt(nm[2], 10) !== lastNum + 1) break
          keys.push(nName)
          lastNum = parseInt(nm[2], 10)
          j++
        }
        if (keys.length > 1) {
          result.push({
            name,
            keys,
            info: { ...info, length: 16 * keys.length }
          })
          i = j - 1
          continue
        }
      }
    }
    result.push({ name, keys: [name], info })
  }
  return result
}

/** 표시용 행의 값 (Modbus: 첫 키에 이미 결합값이 있음, UDP: 두 키를 엔디안에 맞춰 결합. String 병합: 여러 키의 hex/문자열 이어붙임)
 *  udpLittleEndian: UDP 파싱 시 리틀엔디안이었으면 true. BE면 와이어 [상위워드][하위워드] → keys[0]=상위, keys[1]=하위. LE면 [하위워드][상위워드] → keys[0]=하위, keys[1]=상위. */
function getDisplayValue(row, valueMap, source = 'modbus', udpLittleEndian = false) {
  if (row.keys.length === 1) return valueMap[row.name]
  const dt = (row.info?.dataType ?? '').toLowerCase()
  // String 병합: 각 키 값(hex 또는 2바이트)을 이어붙여 한 문자열로
  if (dt === 'string') {
    let combined = ''
    for (const k of row.keys) {
      const v = valueMap[k]
      if (v === undefined || v === null || v === '-') continue
      if (typeof v === 'string' && /^[0-9a-fA-F]*$/.test(v)) combined += v.replace(/\s/g, '')
      else if (typeof v === 'string') combined += v
      else if (typeof v === 'number') combined += (v & 0xFFFF).toString(16).padStart(4, '0')
    }
    return combined || undefined
  }
  // Dword
  if (source === 'modbus') return valueMap[row.keys[0]]
  const a = valueMap[row.keys[0]]
  const b = valueMap[row.keys[1]]
  const va = typeof a === 'number' ? a : parseInt(a, 10)
  const vb = typeof b === 'number' ? b : parseInt(b, 10)
  if (Number.isNaN(va) && Number.isNaN(vb)) return undefined
  if (Number.isNaN(vb)) return a
  if (Number.isNaN(va)) return b
  const high = udpLittleEndian ? vb : va
  const low = udpLittleEndian ? va : vb
  return ((high & 0xFFFF) << 16) | (low & 0xFFFF)
}

function App() {
  const [ip, setIp] = useState('0.0.0.0')
  const [port, setPort] = useState('5212')
  const [connected, setConnected] = useState(false)
  const [serverConnected, setServerConnected] = useState(false)
  const [messages, setMessages] = useState([])
  const [error, setError] = useState('')
  const [logDisplayMode, setLogDisplayMode] = useState('hex') // 'hex' | 'binary'
  const [activeView, setActiveView] = useState('raw') // 'raw' | 'parsed'
  const [ioVariableList, setIoVariableList] = useState([]) // [ [name, lengthBit], ... ]
  const [parsedValues, setParsedValues] = useState({}) // { varName: displayValue }
  const [parsedEndianMode, setParsedEndianMode] = useState('1') // '1'=빅엔디안, '2'=리틀엔디안
  const [showBitsCol, setShowBitsCol] = useState(true)
  const [showHexCol, setShowHexCol] = useState(true)
  const [showValueCol, setShowValueCol] = useState(true)
  const [showMetaBit, setShowMetaBit] = useState(true)
  const [showMetaType, setShowMetaType] = useState(true)
  const [showMetaDesc, setShowMetaDesc] = useState(true)
  const [mcValues, setMcValues] = useState({})
  const [mcConnected, setMcConnected] = useState(false)
  const [mcError, setMcError] = useState('')
  const [mcHost, setMcHost] = useState('127.0.0.1')
  const [mcPort, setMcPort] = useState('5002')
  const [mcPollIntervals, setMcPollIntervals] = useState({ boolean_ms: 1000, data_ms: 1000, string_ms: 1000 })
  const [mcPollSettingsOpen, setMcPollSettingsOpen] = useState(false)
  const [mcPollEdit, setMcPollEdit] = useState({ boolean_ms: 1000, data_ms: 1000, string_ms: 1000 })
  const [mcPollDisplay, setMcPollDisplay] = useState({ boolean: '', data: '', string: '' })
  const [mcPollUnits, setMcPollUnits] = useState({ boolean: 'ms', data: 'ms', string: 'ms' })
  const [mcPollError, setMcPollError] = useState('')

  const POLL_MIN_MS = 200
  const POLL_MAX_MS = 1800000 // 30min
  const toDisplay = (ms, unit) => {
    if (unit === 'min') return ms / 60000
    if (unit === 's') return ms / 1000
    return ms
  }
  /** 입력 문자열을 ms로 파싱. 빈 값·잘못된 값이면 null */
  const parseDisplayToMs = (val, unit) => {
    const s = String(val).trim()
    if (s === '') return null
    let n
    if (unit === 'min') n = Math.round(parseFloat(s) * 60000)
    else if (unit === 's') n = Math.round(parseFloat(s) * 1000)
    else n = parseInt(s, 10)
    return Number.isNaN(n) ? null : n
  }
  /** 저장된 ms를 팝업에서 보기 좋게 표시할 단위로 변환 (1000ms→s, 60s→1min) */
  const msToBestUnit = (ms) => {
    if (ms >= 60000 && ms % 60000 === 0) return 'min'
    if (ms >= 1000 && ms % 1000 === 0) return 's'
    return 'ms'
  }
  const [sensorData, setSensorData] = useState({}) // { VVB001: { value, ts }, TP3237: { value, ts } }
  const [mqttConnected, setMqttConnected] = useState(false)
  const [mqttError, setMqttError] = useState('')
  const messagesEndRef = useRef(null)
  const eventSourceRef = useRef(null)
  const ioVariableListRef = useRef([])
  const parsedEndianModeRef = useRef('1')
  /** 타발수 등: 리셋(음수) 시 처음 보였던 시작값으로 표시 (예: 10000 시작 → 리셋 시 10000) */
  const counterStartRef = useRef({})
  ioVariableListRef.current = ioVariableList
  parsedEndianModeRef.current = parsedEndianMode

  /** Word/Dword: 음수(리셋)일 때 처음 본 값을 시작값으로 저장해 두고, 리셋 시 그 시작값으로 표시 */
  const decodeForDisplayWithReset = (raw, info, rowName) => {
    const dt = (info?.dataType ?? '').toLowerCase()
    const len = Number(info?.length) || 32

    // 과부족수량(D1814): 32비트 부호 있는 값 그대로 표시 (예: 0xFFFFFA24 → -1500)
    if (rowName === 'defficiencyQuantity_D1814' && dt === 'dword') {
      if (raw === '-' || raw === undefined || raw === null) return '-'
      const num = typeof raw === 'number' ? raw : parseInt(raw, 10)
      if (Number.isNaN(num)) return '-'
      const u = toUnsigned(num, len)
      const signed = (u >>> 0) | 0
      const scaleStr = String(info?.scale ?? '1').trim()
      const scaleNum = parseFloat(scaleStr) || 1
      if (scaleNum === 0.1) return (signed * 0.1).toFixed(1)
      return signed
    }

    const isCounter = dt === 'word' || dt === 'dword'
    const num = typeof raw === 'number' ? raw : parseInt(raw, 10)
    if (isCounter && typeof raw === 'number' && num >= 0 && counterStartRef.current[rowName] === undefined) {
      counterStartRef.current[rowName] = raw
    }
    if (isCounter && typeof raw === 'number' && num < 0) {
      const startRaw = counterStartRef.current[rowName]
      return startRaw !== undefined ? decodeForDisplay(startRaw, info) : decodeForDisplay(raw, info)
    }
    return decodeForDisplay(raw, info)
  }

  /** Dword 쌍 합쳐서 한 행으로 보여줄 목록 (Modbus/UDP 테이블용) */
  const displayVariableList = useMemo(
    () => buildDisplayVariableList(ioVariableList),
    [ioVariableList]
  )

  /** MC 프로토콜 뷰: 원래 전체 목록 표시. MC 폴링되는 4개만 값 있고 나머지는 - (나중에 실데이터 넣을 때 사용) */
  const mcDisplayList = useMemo(() => displayVariableList, [displayVariableList])

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  // io_variables.json 로드 (변수명·length/dataType/scale/description, 순서 유지)
  useEffect(() => {
    fetch('/io_variables.json')
      .then((res) => res.json())
      .then((obj) => {
        const entries = Object.entries(obj).map(([name, val]) => {
          const info = typeof val === 'object' && val !== null && 'length' in val
            ? { length: val.length, dataType: val.dataType ?? '', scale: val.scale ?? '', description: val.description ?? '' }
            : { length: Number(val), dataType: '', scale: '', description: '' }
          return [name, info]
        })
        setIoVariableList(entries)
      })
      .catch(() => setIoVariableList([]))
  }, [])

  useEffect(() => {
    const es = new EventSource(`${API_URL}/api/events`)

    es.onopen = () => {
      setServerConnected(true)
      setError('')
    }

    es.onerror = () => {
      setServerConnected(false)
      setConnected(false)
      es.close()
    }

    es.addEventListener('udp_connected', (e) => {
      const data = JSON.parse(e.data)
      setConnected(true)
      setError('')
      setMessages((prev) => [
        ...prev,
        {
          type: 'system',
          text: `UDP 리스너 시작됨 (${data.ip}:${data.port})`,
          time: new Date(),
        },
      ])
    })

    es.addEventListener('udp_data', (e) => {
      const data = JSON.parse(e.data || '{}')
      const payload = String(data.payload ?? data.data ?? '')
      const raw = String(data.raw ?? '')
      const displayText = payload || raw || '(빈 데이터)'
      setMessages((prev) => [
        ...prev,
        {
          type: 'data',
          text: displayText,
          addr: data.addr,
          raw: raw,
          time: new Date(),
        },
      ])
      // 파싱 탭용: 서버에서 보낸 decoded parsed 우선 사용, 없으면 클라이언트에서 파싱
      if (data.parsed && typeof data.parsed === 'object') {
        setParsedValues((prev) => ({ ...prev, ...data.parsed }))
      } else {
        const listForParse = ioVariableListRef.current.map(([name, info]) => [name, info.length, info.dataType ?? ''])
        setParsedValues((prev) => ({
          ...prev,
          ...parseRawByVariableList(raw, listForParse, getParseOptionsFromMode(parsedEndianModeRef.current)),
        }))
      }
    })

    es.addEventListener('udp_error', (e) => {
      const data = JSON.parse(e.data)
      setError(data.message)
      setConnected(false)
    })

    es.addEventListener('udp_disconnected', () => {
      setConnected(false)
      setMessages((prev) => [
        ...prev,
        { type: 'system', text: 'UDP 리스너 종료됨', time: new Date() },
      ])
    })

    es.addEventListener('mc_data', (e) => {
      const data = JSON.parse(e.data || '{}')
      if (data.parsed && typeof data.parsed === 'object') {
        setMcValues((prev) => ({ ...prev, ...data.parsed }))
      }
    })

    es.addEventListener('mc_connected', () => {
      setMcConnected(true)
      setMcError('')
    })

    es.addEventListener('mc_disconnected', () => {
      setMcConnected(false)
    })

    es.addEventListener('mc_error', (e) => {
      const data = JSON.parse(e.data || '{}')
      setMcError(data.message || 'MC 프로토콜 오류')
    })

    es.addEventListener('sensor_data', (e) => {
      const data = JSON.parse(e.data || '{}')
      const topic = data.topic
      if (topic) {
        setSensorData((prev) => ({ ...prev, [topic]: { value: data.value, ts: data.ts } }))
        // 센서 데이터가 한 번이라도 들어오면 MQTT 연결된 것으로 간주
        setMqttConnected(true)
      }
    })
    es.addEventListener('sensor_data_snapshot', (e) => {
      const data = JSON.parse(e.data || '{}')
      if (data && typeof data === 'object') {
        setSensorData((prev) => ({ ...prev, ...data }))
        if (Object.keys(data).length > 0) {
          setMqttConnected(true)
        }
      }
    })
    es.addEventListener('mqtt_connected', () => {
      setMqttConnected(true)
      setMqttError('')
    })
    es.addEventListener('mqtt_disconnected', () => setMqttConnected(false))
    es.addEventListener('mqtt_error', (e) => {
      const data = JSON.parse(e.data || '{}')
      setMqttError(data.message || 'MQTT 오류')
      setMqttConnected(false)
    })
    es.addEventListener('mqtt_status_snapshot', (e) => {
      const data = JSON.parse(e.data || '{}')
      setMqttConnected(!!data.connected)
      setMqttError(data.error || '')
    })

    eventSourceRef.current = es
    return () => {
      es.close()
    }
  }, [])

  const handleConnect = async () => {
    setError('')
    setMessages([])
    try {
      const res = await fetch(`${API_URL}/api/start_udp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip, port: parseInt(port, 10) }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || '연결 실패')
      }
    } catch (err) {
      setError('서버에 연결할 수 없습니다.')
    }
  }

  const handleDisconnect = async () => {
    try {
      await fetch(`${API_URL}/api/stop_udp`, { method: 'POST' })
    } catch {
      // ignore
    }
  }

  const handleMcConnect = async () => {
    setMcError('')
    try {
      const payload = {
        host: mcHost.trim(),
        port: parseInt(mcPort, 10) || 5002,
      }
      const res = await fetch(`${API_URL}/api/mc/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) setMcError(data.error || '연결 실패')
    } catch (err) {
      setMcError('서버에 연결할 수 없습니다.')
    }
  }

  const handleMcDisconnect = async () => {
    try {
      await fetch(`${API_URL}/api/mc/disconnect`, { method: 'POST' })
    } catch {
      // ignore
    }
  }

  const fetchMcPollIntervals = async () => {
    try {
      const res = await fetch(`${API_URL}/api/mc/poll-intervals`)
      if (res.ok) {
        const data = await res.json()
        setMcPollIntervals({
          boolean_ms: Number(data.boolean_ms) || 1000,
          data_ms: Number(data.data_ms) || 1000,
          string_ms: Number(data.string_ms) || 1000,
        })
      }
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    if (activeView === 'mc') fetchMcPollIntervals()
  }, [activeView])

  useEffect(() => {
    if (mcPollSettingsOpen) {
      const units = {
        boolean: msToBestUnit(mcPollIntervals.boolean_ms),
        data: msToBestUnit(mcPollIntervals.data_ms),
        string: msToBestUnit(mcPollIntervals.string_ms),
      }
      setMcPollEdit({ ...mcPollIntervals })
      setMcPollUnits(units)
      setMcPollDisplay({
        boolean: String(toDisplay(mcPollIntervals.boolean_ms, units.boolean)),
        data: String(toDisplay(mcPollIntervals.data_ms, units.data)),
        string: String(toDisplay(mcPollIntervals.string_ms, units.string)),
      })
      setMcPollError('')
    }
  }, [mcPollSettingsOpen])

  const handleMcPollIntervalsSave = async () => {
    const boolean_ms = parseDisplayToMs(mcPollDisplay.boolean, mcPollUnits.boolean)
    const data_ms = parseDisplayToMs(mcPollDisplay.data, mcPollUnits.data)
    const string_ms = parseDisplayToMs(mcPollDisplay.string, mcPollUnits.string)

    if (boolean_ms === null || data_ms === null || string_ms === null) {
      setMcPollError('모든 항목에 값을 입력해 주세요.')
      return
    }
    if (boolean_ms < POLL_MIN_MS || data_ms < POLL_MIN_MS || string_ms < POLL_MIN_MS ||
        boolean_ms > POLL_MAX_MS || data_ms > POLL_MAX_MS || string_ms > POLL_MAX_MS) {
      setMcPollError('최소 200ms(0.2s) 이상, 최대 30분 이하로 입력해 주세요. 현재 값이 범위를 벗어나 저장되지 않습니다.')
      return
    }

    const payload = { boolean_ms, data_ms, string_ms }
    try {
      const res = await fetch(`${API_URL}/api/mc/poll-intervals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data && (typeof data.boolean_ms === 'number' || typeof data.boolean_ms === 'string')) {
        setMcPollIntervals({
          boolean_ms: Number(data.boolean_ms) || 1000,
          data_ms: Number(data.data_ms) || 1000,
          string_ms: Number(data.string_ms) || 1000,
        })
        setMcPollSettingsOpen(false)
        setMcPollError('')
      } else {
        setMcPollError(data?.error || '저장 실패. 백엔드를 재시작한 뒤 다시 시도하세요.')
      }
    } catch (err) {
      setMcPollError('서버에 연결할 수 없습니다. 백엔드(6005)가 켜져 있는지 확인하세요.')
    }
  }

  const handleClear = () => {
    setMessages([])
  }

  const formatTime = (date) => {
    const s = date.toLocaleTimeString('ko-KR', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    const ms = String(date.getMilliseconds()).padStart(3, '0')
    return `${s}.${ms}`
  }

  /** raw(hex 문자열)을 16진수 바이트 단위로 포맷 (예: "0a1b2c" → "0a 1b 2c") */
  const formatAsHex = (raw) => {
    if (!raw || typeof raw !== 'string') return ''
    const s = raw.replace(/\s/g, '')
    if (!/^[0-9a-fA-F]*$/.test(s)) return raw
    return s.match(/.{1,2}/g)?.join(' ') ?? s
  }

  /** raw(hex 문자열)을 2진수 바이트 단위로 포맷 (예: "0a" → "00001010") */
  const formatAsBinary = (raw) => {
    if (!raw || typeof raw !== 'string') return ''
    const s = raw.replace(/\s/g, '')
    if (!/^[0-9a-fA-F]*$/.test(s)) return raw
    return s
      .match(/.{1,2}/g)
      ?.map((pair) => parseInt(pair, 16).toString(2).padStart(8, '0'))
      .join(' ') ?? ''
  }

  const getDataDisplayText = (msg) => {
    if (msg.type !== 'data') return msg.text ?? ''
    const raw = msg.raw ?? ''
    if (logDisplayMode === 'binary' && raw) return formatAsBinary(raw)
    if (logDisplayMode === 'hex' && raw) return formatAsHex(raw)
    return msg.text ?? '(빈 데이터)'
  }

  /** 바이트 하나를 8비트 문자열로 (MSB 먼저) */
  const byteToBits8 = (b) => ((b & 0xff).toString(2)).padStart(8, '0')

  /** 파싱된 값을 리틀/빅엔디안에 맞춘 2진수로 표시. 값 없으면 빈 문자열, 숫자는 부호 없이 스트림 순서대로. 문자열(ASCII)은 바이트별 2진. */
  const formatParsedValueAsBits = (value, lengthBit, dataType, littleEndian) => {
    const len = Number(lengthBit) || 0
    if (value === '-' || value === undefined) return ''
    const le = littleEndian ?? true
    let bits
    if (typeof value === 'number') {
      if (len <= 0 || len > 32) return ''
      const u = toUnsigned(value, len)
      if (len === 1) bits = String(u & 1)
      else if (len === 8) bits = byteToBits8(u)
      else if (len === 16) {
        const low = u & 0xff
        const high = (u >> 8) & 0xff
        bits = byteToBits8(high) + byteToBits8(low)
      } else if (len === 32) {
        const b0 = u & 0xff
        const b1 = (u >> 8) & 0xff
        const b2 = (u >> 16) & 0xff
        const b3 = (u >> 24) & 0xff
        bits = byteToBits8(b3) + byteToBits8(b2) + byteToBits8(b1) + byteToBits8(b0)
      } else {
        if (le) {
          bits = ''
          for (let i = 0; i < len; i++) bits += (u >> i) & 1 ? '1' : '0'
        } else {
          bits = ''
          for (let i = len - 1; i >= 0; i--) bits += (u >> i) & 1 ? '1' : '0'
        }
      }
    } else if (typeof value === 'string' && /^[0-9a-fA-F]+$/.test(value)) {
      const bytes = hexToBytes(value)
      if (!bytes.length) return ''
      const byteCount = Math.ceil((len || bytes.length * 8) / 8)
      let ordered = bytes.slice(0, byteCount)
      if (le && byteCount >= 2) {
        ordered = []
        for (let i = 0; i < byteCount; i += 2) {
          if (i + 1 < byteCount) ordered.push(bytes[i + 1], bytes[i])
          else ordered.push(bytes[i])
        }
      }
      bits = ordered.map((b) => byteToBits8(b)).join('').slice(0, len || 999).padStart(len || ordered.length * 8, '0')
    } else if (typeof value === 'string') {
      const bytes = Array.from(value).map((c) => c.charCodeAt(0) & 0xff)
      if (!bytes.length) return ''
      bits = bytes.map((b) => byteToBits8(b)).join(' ')
    } else {
      return ''
    }
    return (typeof bits === 'string' && bits.includes(' ')) ? bits : bits.replace(/(.{8})/g, '$1 ').trim()
  }

  /** 파싱된 값을 16진수 문자열로 표시 (해석된 값 기준 MSB→LSB). 문자열(ASCII)은 바이트별 hex. */
  const formatParsedValueAsHex = (value, lengthBit, littleEndian) => {
    const len = Number(lengthBit) || 0
    if (value === '-' || value === undefined) return ''
    if (typeof value === 'number') {
      if (len <= 0) return ''
      const u = toUnsigned(value, len)
      const byteCount = Math.ceil(len / 8)
      if (byteCount <= 0) return ''
      const bytes = []
      for (let i = 0; i < byteCount; i++) {
        bytes.push((u >> (8 * i)) & 0xff)
      }
      const ordered = [...bytes].reverse()
      return ordered.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')
    }
    if (typeof value === 'string' && /^[0-9a-fA-F]+$/.test(value)) {
      const pairs = value.match(/.{1,2}/g) || []
      return pairs.join(' ').toUpperCase()
    }
    if (typeof value === 'string') {
      const bytes = Array.from(value).map((c) => c.charCodeAt(0) & 0xff)
      return bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')
    }
    return ''
  }

  return (
    <div className="app">
      <header className="header">
        <div className="logo">
          <span className="logo-icon">◉</span>
          <h1>PLC(UDP), MC Protocol(3E), MQTT(IOLink)</h1>
        </div>
        <div className={`status-badge ${serverConnected ? 'online' : 'offline'}`}>
          {serverConnected ? '서버 연결됨' : '서버 연결 끊김'}
        </div>
      </header>

      <main className="main-wrap">
        <nav className="side-tabs" aria-label="화면 전환">
          <button
            type="button"
            className={`side-tab ${activeView === 'raw' ? 'active' : ''}`}
            onClick={() => setActiveView('raw')}
          >
            <span className="side-tab-label">Raw 데이터</span>
            <span className="side-tab-desc">16진수/2진수 로그</span>
          </button>
          <button
            type="button"
            className={`side-tab ${activeView === 'parsed' ? 'active' : ''}`}
            onClick={() => setActiveView('parsed')}
          >
            <span className="side-tab-label">파싱 데이터</span>
            <span className="side-tab-desc">디코딩/파싱 결과</span>
          </button>
          <button
            type="button"
            className={`side-tab ${activeView === 'mc' ? 'active' : ''}`}
            onClick={() => setActiveView('mc')}
          >
            <span className="side-tab-label">MC Protocol</span>
            <span className="side-tab-desc">MC 3E 폴링</span>
          </button>
          <button
            type="button"
            className={`side-tab ${activeView === 'dashboard' ? 'active' : ''}`}
            onClick={() => setActiveView('dashboard')}
          >
            <span className="side-tab-label">센서 대시보드</span>
            <span className="side-tab-desc">MQTT 진동/온도 실시간</span>
          </button>
        </nav>

        <div className="view-content">
          {activeView === 'raw' && (
            <>
        <section className="control-panel">
          <div className="control-row">
            <div className="field-group">
              <label htmlFor="ip">바인딩 IP</label>
              <input
                id="ip"
                type="text"
                value={ip}
                onChange={(e) => setIp(e.target.value)}
                placeholder="0.0.0.0"
                disabled={connected}
              />
              <span className="field-hint">이 PC의 IP 또는 0.0.0.0 (PLC IP 아님)</span>
            </div>
            <div className="field-group">
              <label htmlFor="port">포트</label>
              <input
                id="port"
                type="number"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="5212"
                min="1"
                max="65535"
                disabled={connected}
              />
            </div>
          </div>
          <div className="button-row">
            <button
              className="btn btn-primary"
              onClick={handleConnect}
              disabled={connected}
            >
              UDP 연결
            </button>
            <button
              className="btn btn-danger"
              onClick={handleDisconnect}
              disabled={!connected}
            >
              연결 중지
            </button>
            <button className="btn btn-secondary" onClick={handleClear}>
              로그 지우기
            </button>
          </div>
          {error && <p className="error-message">{error}</p>}
        </section>

        <section className="output-panel">
          <div className="panel-header">
            <h2>수신 데이터</h2>
            <div className="panel-header-right">
              <div className="log-format-toggle" role="group" aria-label="로그 표시 형식">
                <button
                  type="button"
                  className={`btn btn-toggle ${logDisplayMode === 'hex' ? 'active' : ''}`}
                  onClick={() => setLogDisplayMode('hex')}
                >
                  16진수
                </button>
                <button
                  type="button"
                  className={`btn btn-toggle ${logDisplayMode === 'binary' ? 'active' : ''}`}
                  onClick={() => setLogDisplayMode('binary')}
                >
                  2진수
                </button>
              </div>
              <span className="count">{messages.filter((m) => m.type === 'data').length}개 수신</span>
            </div>
          </div>
          <div className="messages-box">
            {messages.length === 0 ? (
              <div className="empty-state">
                <p>UDP 연결 후 수신된 데이터가 여기에 표시됩니다.</p>
                <p className="hint">PLC에서 설정한 IP:Port로 데이터를 전송해보세요.</p>
              </div>
            ) : (
              messages.map((msg, i) => (
                <div key={i} className={`message-item ${msg.type}`}>
                  <span className="msg-time">{formatTime(msg.time)}</span>
                  {msg.type === 'data' && msg.addr && (
                    <span className="msg-addr">[{msg.addr}]</span>
                  )}
                  <span className="msg-text">{getDataDisplayText(msg)}</span>
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>
        </section>
            </>
          )}

          {activeView === 'mc' && (
            <section className="parsed-view mc-view">
              <div className="parsed-view-header">
                <div className="parsed-view-title-row">
                  <h2>MC Protocol (3E)</h2>
                  <div className="parsed-view-title-row-right">
                    <button
                      type="button"
                      className="modbus-poll-settings-btn"
                      onClick={() => setMcPollSettingsOpen(true)}
                      title="폴링 간격 설정"
                      aria-label="폴링 간격 설정"
                    >
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="3" />
                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                      </svg>
                    </button>
                  </div>
                </div>
                <section className="control-panel mc-control">
                  <div className="control-row">
                    <div className="field-group">
                      <label htmlFor="mc-host">IP</label>
                      <input
                        id="mc-host"
                        type="text"
                        value={mcHost}
                        onChange={(e) => setMcHost(e.target.value)}
                        placeholder="127.0.0.1"
                        disabled={mcConnected}
                      />
                    </div>
                    <div className="field-group">
                      <label htmlFor="mc-port">포트</label>
                      <input
                        id="mc-port"
                        type="number"
                        value={mcPort}
                        onChange={(e) => setMcPort(e.target.value)}
                        placeholder="5002"
                        min="1"
                        max="65535"
                        disabled={mcConnected}
                      />
                    </div>
                  </div>
                  <div className="button-row">
                    <button
                      className="btn btn-primary"
                      onClick={handleMcConnect}
                      disabled={mcConnected}
                    >
                      폴링 시작
                    </button>
                    <button
                      className="btn btn-danger"
                      onClick={handleMcDisconnect}
                      disabled={!mcConnected}
                    >
                      연결 중지
                    </button>
                  </div>
                  {mcError && <p className="error-message">{mcError}</p>}
                  {mcConnected && (
                    <p className="modbus-status">
                      Y107, D140, D1810, D1560 하드코딩 폴링 중 (Boolean {mcPollIntervals.boolean_ms}ms / 데이터 {mcPollIntervals.data_ms}ms / String {mcPollIntervals.string_ms}ms)
                    </p>
                  )}
                </section>
                <p className="parsed-view-hint">
                  MC 매핑 4개 변수만 표시. 현재는 하드코딩 응답으로 폴링됩니다.
                </p>
                {mcPollSettingsOpen && (
                  <div className="modbus-poll-modal-overlay" onClick={() => setMcPollSettingsOpen(false)}>
                    <div className="modbus-poll-modal" onClick={(e) => e.stopPropagation()}>
                      <h3>폴링 간격 설정</h3>
                      <p className="modbus-poll-modal-desc">각 구간별 폴링 주기. 최소 200ms, 최대 30분. 단위는 ms/s/min 선택. 1000ms→1s, 60s→1min으로 자동 변환되어 표시됩니다.</p>
                      {mcPollError && <p className="modbus-poll-modal-error">{mcPollError}</p>}
                      <div className="modbus-poll-modal-fields">
                        <div className="field-group">
                          <label>경고등/알람 (Boolean)</label>
                          <span className="modbus-poll-input-wrap">
                            <input
                              type="number"
                              min={mcPollUnits.boolean === 'min' ? 0.01 : mcPollUnits.boolean === 's' ? 0.2 : 200}
                              max={mcPollUnits.boolean === 'min' ? 30 : mcPollUnits.boolean === 's' ? 1800 : 1800000}
                              step={mcPollUnits.boolean === 'min' ? 0.5 : mcPollUnits.boolean === 's' ? 0.1 : 100}
                              placeholder={mcPollUnits.boolean === 'min' ? '0.5' : mcPollUnits.boolean === 's' ? '1' : '500'}
                              value={mcPollDisplay.boolean}
                              onChange={(e) => setMcPollDisplay((p) => ({ ...p, boolean: e.target.value }))}
                            />
                            <select
                              className="modbus-poll-unit-select"
                              value={mcPollUnits.boolean}
                              onChange={(e) => {
                                const newUnit = e.target.value
                                const ms = parseDisplayToMs(mcPollDisplay.boolean, mcPollUnits.boolean) ?? mcPollEdit.boolean_ms
                                setMcPollEdit((p) => ({ ...p, boolean_ms: ms }))
                                setMcPollDisplay((p) => ({ ...p, boolean: String(toDisplay(ms, newUnit)) }))
                                setMcPollUnits((u) => ({ ...u, boolean: newUnit }))
                              }}
                              aria-label="Boolean 단위"
                            >
                              <option value="ms">ms</option>
                              <option value="s">s</option>
                              <option value="min">min</option>
                            </select>
                          </span>
                        </div>
                        <div className="field-group">
                          <label>데이터 (타발수 등)</label>
                          <span className="modbus-poll-input-wrap">
                            <input
                              type="number"
                              min={mcPollUnits.data === 'min' ? 0.01 : mcPollUnits.data === 's' ? 0.2 : 200}
                              max={mcPollUnits.data === 'min' ? 30 : mcPollUnits.data === 's' ? 1800 : 1800000}
                              step={mcPollUnits.data === 'min' ? 0.5 : mcPollUnits.data === 's' ? 0.1 : 100}
                              placeholder={mcPollUnits.data === 'min' ? '0.5' : mcPollUnits.data === 's' ? '1' : '500'}
                              value={mcPollDisplay.data}
                              onChange={(e) => setMcPollDisplay((p) => ({ ...p, data: e.target.value }))}
                            />
                            <select
                              className="modbus-poll-unit-select"
                              value={mcPollUnits.data}
                              onChange={(e) => {
                                const newUnit = e.target.value
                                const ms = parseDisplayToMs(mcPollDisplay.data, mcPollUnits.data) ?? mcPollEdit.data_ms
                                setMcPollEdit((p) => ({ ...p, data_ms: ms }))
                                setMcPollDisplay((p) => ({ ...p, data: String(toDisplay(ms, newUnit)) }))
                                setMcPollUnits((u) => ({ ...u, data: newUnit }))
                              }}
                              aria-label="데이터 단위"
                            >
                              <option value="ms">ms</option>
                              <option value="s">s</option>
                              <option value="min">min</option>
                            </select>
                          </span>
                        </div>
                        <div className="field-group">
                          <label>금형이름 (String)</label>
                          <span className="modbus-poll-input-wrap">
                            <input
                              type="number"
                              min={mcPollUnits.string === 'min' ? 0.01 : mcPollUnits.string === 's' ? 0.2 : 200}
                              max={mcPollUnits.string === 'min' ? 30 : mcPollUnits.string === 's' ? 1800 : 1800000}
                              step={mcPollUnits.string === 'min' ? 0.5 : mcPollUnits.string === 's' ? 0.1 : 100}
                              placeholder={mcPollUnits.string === 'min' ? '0.5' : mcPollUnits.string === 's' ? '5' : '5000'}
                              value={mcPollDisplay.string}
                              onChange={(e) => setMcPollDisplay((p) => ({ ...p, string: e.target.value }))}
                            />
                            <select
                              className="modbus-poll-unit-select"
                              value={mcPollUnits.string}
                              onChange={(e) => {
                                const newUnit = e.target.value
                                const ms = parseDisplayToMs(mcPollDisplay.string, mcPollUnits.string) ?? mcPollEdit.string_ms
                                setMcPollEdit((p) => ({ ...p, string_ms: ms }))
                                setMcPollDisplay((p) => ({ ...p, string: String(toDisplay(ms, newUnit)) }))
                                setMcPollUnits((u) => ({ ...u, string: newUnit }))
                              }}
                              aria-label="금형이름 단위"
                            >
                              <option value="ms">ms</option>
                              <option value="s">s</option>
                              <option value="min">min</option>
                            </select>
                          </span>
                        </div>
                      </div>
                      <div className="modbus-poll-modal-actions">
                        <button type="button" className="btn btn-primary" onClick={handleMcPollIntervalsSave}>
                          적용
                        </button>
                        <button type="button" className="btn" onClick={() => setMcPollSettingsOpen(false)}>
                          취소
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                <div className="parsed-meta-toolbar">
                  <span className="parsed-meta-toolbar-label">표시 열</span>
                  <div className="parsed-meta-toolbar-checks">
                    <label className="parsed-meta-check-wrap"><input type="checkbox" checked={showBitsCol} onChange={(e) => setShowBitsCol(e.target.checked)} /> 2진수</label>
                    <label className="parsed-meta-check-wrap"><input type="checkbox" checked={showHexCol} onChange={(e) => setShowHexCol(e.target.checked)} /> 16진수</label>
                    <label className="parsed-meta-check-wrap"><input type="checkbox" checked={showValueCol} onChange={(e) => setShowValueCol(e.target.checked)} /> 값</label>
                    <label className="parsed-meta-check-wrap"><input type="checkbox" checked={showMetaBit} onChange={(e) => setShowMetaBit(e.target.checked)} /> 비트</label>
                    <label className="parsed-meta-check-wrap"><input type="checkbox" checked={showMetaType} onChange={(e) => setShowMetaType(e.target.checked)} /> 타입</label>
                    <label className="parsed-meta-check-wrap"><input type="checkbox" checked={showMetaDesc} onChange={(e) => setShowMetaDesc(e.target.checked)} /> 설명</label>
                  </div>
                </div>
              </div>
              <div className="parsed-view-body">
                {mcDisplayList.length === 0 ? (
                  <p className="parsed-view-empty">
                    {displayVariableList.length === 0 ? 'io_variables.json을 불러오는 중…' : '해당하는 변수가 없습니다.'}
                  </p>
                ) : (
                  <div className="parsed-vars-grid">
                    <div
                      className="parsed-var-header"
                      style={{
                        gridTemplateColumns: [
                          'minmax(180px, 1.2fr)',
                          showBitsCol && 'minmax(160px, 2.5fr)',
                          showHexCol && 'minmax(120px, 2fr)',
                          showValueCol && '90px',
                          (showMetaBit || showMetaType || showMetaDesc) && 'minmax(340px, 1.5fr)'
                        ].filter(Boolean).join(' ')
                      }}
                    >
                      <span className="parsed-var-name">변수명</span>
                      {showBitsCol && <span className="parsed-var-bits">2진수</span>}
                      {showHexCol && <span className="parsed-var-hex">16진수</span>}
                      {showValueCol && (
                        <span className="parsed-var-value-wrap">
                          <span className="boolean-dot-header-spacer" aria-hidden />
                          <span className="parsed-var-value">값</span>
                        </span>
                      )}
                      {(showMetaBit || showMetaType || showMetaDesc) && (
                        <div
                          className="parsed-var-meta-cols"
                          style={{
                            gridTemplateColumns: [
                              showMetaBit && '56px',
                              showMetaType && '100px',
                              showMetaDesc && '1fr'
                            ].filter(Boolean).join(' ')
                          }}
                        >
                          {showMetaBit && <span className="parsed-meta-bit">비트</span>}
                          {showMetaType && <span className="parsed-meta-type">타입</span>}
                          {showMetaDesc && <span className="parsed-meta-desc">설명</span>}
                        </div>
                      )}
                    </div>
                    {mcDisplayList.map((row) => {
                      const value = getDisplayValue(row, mcValues, 'modbus')
                      const { name, info } = row
                      return (
                      <div
                        key={name}
                        className="parsed-var-row"
                        style={{
                          gridTemplateColumns: [
                            'minmax(180px, 1.2fr)',
                            showBitsCol && 'minmax(160px, 2.5fr)',
                            showHexCol && 'minmax(120px, 2fr)',
                            showValueCol && '90px',
                            (showMetaBit || showMetaType || showMetaDesc) && 'minmax(340px, 1.5fr)'
                          ].filter(Boolean).join(' ')
                        }}
                      >
                        <span className="parsed-var-name" title={name}>{name}</span>
                        {showBitsCol && (
                          <span className="parsed-var-bits" title={formatParsedValueAsBits(value, info.length, info.dataType, false)}>
                            {formatParsedValueAsBits(value, info.length, info.dataType, false)}
                          </span>
                        )}
                        {showHexCol && (
                          <span className="parsed-var-hex" title={formatParsedValueAsHex(value, info.length, false)}>
                            {formatParsedValueAsHex(value, info.length, false)}
                          </span>
                        )}
                        {showValueCol && (
                          <span className="parsed-var-value-wrap">
                            {(info.dataType || '').toLowerCase() === 'boolean' && (
                              <span className={`boolean-dot boolean-dot--${value ? '1' : '0'}`} title={value ? '1' : '0'} aria-hidden />
                            )}
                            <span className="parsed-var-value">{decodeForDisplayWithReset(value, info, name)}</span>
                          </span>
                        )}
                        {(showMetaBit || showMetaType || showMetaDesc) && (
                          <div
                            className="parsed-var-meta-cols"
                            style={{
                              gridTemplateColumns: [
                                showMetaBit && '56px',
                                showMetaType && '100px',
                                showMetaDesc && '1fr'
                              ].filter(Boolean).join(' ')
                            }}
                            title={[info.dataType && `DataType: ${info.dataType}`, info.scale && `scale: ${info.scale}`, info.description].filter(Boolean).join('\n')}
                          >
                            {showMetaBit && <span className="parsed-meta-bit">{info.length}bit</span>}
                            {showMetaType && <span className="parsed-meta-type">{info.dataType}{info.scale ? ` scale ${info.scale}` : ''}</span>}
                            {showMetaDesc && <span className="parsed-meta-desc">{info.description ? (info.description.length > 50 ? info.description.slice(0, 50) + '…' : info.description) : '-'}</span>}
                          </div>
                        )}
                      </div>
                    )})}
                  </div>
                )}
              </div>
            </section>
          )}

          {activeView === 'dashboard' && (
            <section className="parsed-view dashboard-view">
              <div className="dashboard-header">
                <h2>센서 대시보드</h2>
                <span className={`mqtt-status ${mqttConnected ? 'connected' : 'disconnected'}`}>
                  {mqttConnected ? 'MQTT 연결됨' : 'MQTT 미연결'}
                </span>
                {mqttError && <p className="dashboard-error">{mqttError}</p>}
              </div>
              <div className="dashboard-grid">
                <div className="sensor-panel sensor-panel-vibration">
                  <div className="sensor-panel-head">
                    <span className="sensor-panel-label">VVB001</span>
                    <span className="sensor-panel-desc">진동 센서</span>
                  </div>
                  <div className="sensor-panel-body">
                    {(() => {
                      const v = sensorData.VVB001?.value
                      if (!v || typeof v !== 'object') {
                        return <div className="sensor-panel-empty">데이터 대기 중</div>
                      }
                      const num = (x) => {
                        if (x == null) return '—'
                        const n = Number(x)
                        return Number.isFinite(n) ? n.toFixed(2) : String(x)
                      }
                      const rows = [
                        { label: 'v-rms', value: num(v.v_rms), unit: '' },
                        { label: 'a-peak', value: num(v.a_peak), unit: '' },
                        { label: 'a-rms', value: num(v.a_rms), unit: '' },
                        { label: '온도', value: num(v.temperature), unit: '°C' },
                        { label: 'crest', value: num(v.crest), unit: '' },
                      ]
                      return (
                        <dl className="sensor-rows">
                          {rows.map(({ label, value, unit }) => (
                            <div key={label} className="sensor-row">
                              <dt>{label}</dt>
                              <dd><span className="sensor-num">{value}</span>{unit && <span className="sensor-unit">{unit}</span>}</dd>
                            </div>
                          ))}
                        </dl>
                      )
                    })()}
                  </div>
                  {sensorData.VVB001?.ts && (
                    <div className="sensor-panel-footer">
                      {new Date(sensorData.VVB001.ts * 1000).toLocaleTimeString('ko-KR')}
                    </div>
                  )}
                </div>
                <div className="sensor-panel sensor-panel-temperature">
                  <div className="sensor-panel-head">
                    <span className="sensor-panel-label">TP3237</span>
                    <span className="sensor-panel-desc">온도 센서</span>
                  </div>
                  <div className="sensor-panel-body sensor-panel-body-center">
                    {(() => {
                      const v = sensorData.TP3237?.value
                      if (v == null) return <div className="sensor-panel-empty">데이터 대기 중</div>
                      let disp = v
                      if (typeof v === 'object') {
                        const inner = v && typeof v.payload === 'object' ? v.payload : v
                        const cand = inner.data ?? inner.value ?? inner.temperature ?? inner.vibration
                        if (cand != null && typeof cand !== 'object') {
                          const n = Number(cand)
                          disp = Number.isFinite(n) ? n.toFixed(2) : String(cand)
                        } else {
                          disp = '—'
                        }
                      } else if (Number.isFinite(Number(v))) {
                        const n = Number(v)
                        disp = n.toFixed(2)
                      }
                      return (
                        <>
                          <span className="sensor-temp-value">{disp}</span>
                          <span className="sensor-temp-unit">°C</span>
                        </>
                      )
                    })()}
                  </div>
                  {sensorData.TP3237?.ts && (
                    <div className="sensor-panel-footer">
                      {new Date(sensorData.TP3237.ts * 1000).toLocaleTimeString('ko-KR')}
                    </div>
                  )}
                </div>
              </div>
            </section>
          )}

          {activeView === 'parsed' && (
            <section className="parsed-view">
              <div className="parsed-view-header">
                <div className="parsed-view-title-row">
                  <h2>파싱 데이터</h2>
                  <label className="parsed-endian-select-wrap">
                    <span className="parsed-endian-label">파싱 모드</span>
                    <select
                      className="parsed-endian-select"
                      value={parsedEndianMode}
                      onChange={(e) => setParsedEndianMode(e.target.value)}
                      aria-label="순서·엔디안 파싱 모드"
                    >
                      <option value="1">빅엔디안</option>
                      <option value="2">리틀엔디안</option>
                    </select>
                  </label>
                </div>
                <p className="parsed-view-hint">수신 데이터를 io_variables.json 길이(bit) 기준으로 파싱한 값입니다. 값은 최신 수신 시마다 갱신됩니다.</p>
                <div className="parsed-meta-toolbar">
                  <span className="parsed-meta-toolbar-label">표시 열</span>
                  <div className="parsed-meta-toolbar-checks">
                    <label className="parsed-meta-check-wrap"><input type="checkbox" checked={showBitsCol} onChange={(e) => setShowBitsCol(e.target.checked)} /> 2진수</label>
                    <label className="parsed-meta-check-wrap"><input type="checkbox" checked={showHexCol} onChange={(e) => setShowHexCol(e.target.checked)} /> 16진수</label>
                    <label className="parsed-meta-check-wrap"><input type="checkbox" checked={showValueCol} onChange={(e) => setShowValueCol(e.target.checked)} /> 값</label>
                    <label className="parsed-meta-check-wrap"><input type="checkbox" checked={showMetaBit} onChange={(e) => setShowMetaBit(e.target.checked)} /> 비트</label>
                    <label className="parsed-meta-check-wrap"><input type="checkbox" checked={showMetaType} onChange={(e) => setShowMetaType(e.target.checked)} /> 타입</label>
                    <label className="parsed-meta-check-wrap"><input type="checkbox" checked={showMetaDesc} onChange={(e) => setShowMetaDesc(e.target.checked)} /> 설명</label>
                  </div>
                </div>
              </div>
              <div className="parsed-view-body">
                {displayVariableList.length === 0 ? (
                  <p className="parsed-view-empty">io_variables.json을 불러오는 중…</p>
                ) : (
                  <div className="parsed-vars-grid">
                    <div
                      className="parsed-var-header"
                      style={{
                        gridTemplateColumns: [
                          'minmax(180px, 1.2fr)',
                          showBitsCol && 'minmax(160px, 2.5fr)',
                          showHexCol && 'minmax(120px, 2fr)',
                          showValueCol && '90px',
                          (showMetaBit || showMetaType || showMetaDesc) && 'minmax(340px, 1.5fr)'
                        ].filter(Boolean).join(' ')
                      }}
                    >
                      <span className="parsed-var-name">변수명</span>
                      {showBitsCol && <span className="parsed-var-bits">2진수</span>}
                      {showHexCol && <span className="parsed-var-hex">16진수</span>}
                      {showValueCol && (
                        <span className="parsed-var-value-wrap">
                          <span className="boolean-dot-header-spacer" aria-hidden />
                          <span className="parsed-var-value">값</span>
                        </span>
                      )}
                      {(showMetaBit || showMetaType || showMetaDesc) && (
                        <div
                          className="parsed-var-meta-cols"
                          style={{
                            gridTemplateColumns: [
                              showMetaBit && '56px',
                              showMetaType && '100px',
                              showMetaDesc && '1fr'
                            ].filter(Boolean).join(' ')
                          }}
                        >
                          {showMetaBit && <span className="parsed-meta-bit">비트</span>}
                          {showMetaType && <span className="parsed-meta-type">타입</span>}
                          {showMetaDesc && <span className="parsed-meta-desc">설명</span>}
                        </div>
                      )}
                    </div>
                    {displayVariableList.map((row) => {
                      const value = getDisplayValue(row, parsedValues, 'udp', getParseOptionsFromMode(parsedEndianMode).littleEndian)
                      const { name, info } = row
                      return (
                      <div
                        key={name}
                        className="parsed-var-row"
                        style={{
                          gridTemplateColumns: [
                            'minmax(180px, 1.2fr)',
                            showBitsCol && 'minmax(160px, 2.5fr)',
                            showHexCol && 'minmax(120px, 2fr)',
                            showValueCol && '90px',
                            (showMetaBit || showMetaType || showMetaDesc) && 'minmax(340px, 1.5fr)'
                          ].filter(Boolean).join(' ')
                        }}
                      >
                        <span className="parsed-var-name" title={name}>{name}</span>
                        {showBitsCol && (
                          <span className="parsed-var-bits" title={formatParsedValueAsBits(value, info.length, info.dataType, getParseOptionsFromMode(parsedEndianMode).littleEndian)}>
                            {formatParsedValueAsBits(value, info.length, info.dataType, getParseOptionsFromMode(parsedEndianMode).littleEndian)}
                          </span>
                        )}
                        {showHexCol && (
                          <span className="parsed-var-hex" title={formatParsedValueAsHex(value, info.length, getParseOptionsFromMode(parsedEndianMode).littleEndian)}>
                            {formatParsedValueAsHex(value, info.length, getParseOptionsFromMode(parsedEndianMode).littleEndian)}
                          </span>
                        )}
                        {showValueCol && (
                          <span className="parsed-var-value-wrap">
                            {(info.dataType || '').toLowerCase() === 'boolean' && (
                              <span className={`boolean-dot boolean-dot--${value ? '1' : '0'}`} title={value ? '1' : '0'} aria-hidden />
                            )}
                            <span className="parsed-var-value">{decodeForDisplayWithReset(value, info, name)}</span>
                          </span>
                        )}
                        {(showMetaBit || showMetaType || showMetaDesc) && (
                          <div
                            className="parsed-var-meta-cols"
                            style={{
                              gridTemplateColumns: [
                                showMetaBit && '56px',
                                showMetaType && '100px',
                                showMetaDesc && '1fr'
                              ].filter(Boolean).join(' ')
                            }}
                            title={[info.dataType && `DataType: ${info.dataType}`, info.scale && `scale: ${info.scale}`, info.description].filter(Boolean).join('\n')}
                          >
                            {showMetaBit && <span className="parsed-meta-bit">{info.length}bit</span>}
                            {showMetaType && <span className="parsed-meta-type">{info.dataType}{info.scale ? ` scale ${info.scale}` : ''}</span>}
                            {showMetaDesc && <span className="parsed-meta-desc">{info.description ? (info.description.length > 50 ? info.description.slice(0, 50) + '…' : info.description) : '-'}</span>}
                          </div>
                        )}
                      </div>
                    )})}
                  </div>
                )}
              </div>
            </section>
          )}
        </div>
      </main>
    </div>
  )
}

export default App
