import { useState, useEffect, useRef } from 'react'
import './App.css'

const API_URL = import.meta.env.DEV ? 'http://localhost:6005' : window.location.origin

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

  const bytes = hexToBytes(rawHex)
  const totalBits = bytes.length * 8
  const totalVarBits = listToUse.reduce((s, [, L]) => s + (Number(L) || 0), 0)
  // 패딩 시: 정순(앞→뒤)이면 끝에 맞춤(맨 뒤 변수 = 스트림 맨 뒤), 역순(뒤→앞)이면 0부터(맨 앞 변수 = 스트림 맨 앞)
  let offset =
    totalBits > totalVarBits && !orderReversed
      ? totalBits - totalVarBits
      : 0

  const getBit = (i) => (bytes[i >> 3] >> (7 - (i % 8))) & 1
  const result = {}

  for (const [name, lengthBit] of listToUse) {
    const len = Number(lengthBit) || 0
    if (len <= 0 || offset + len > totalBits) {
      result[name] = '-'
      if (len > 0) offset += len
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
          if (littleEndian) val = ((bytes[start] ?? 0) | ((bytes[start + 1] ?? 0) << 8)) >>> 0
          else val = (((bytes[start] ?? 0) << 8) | (bytes[start + 1] ?? 0)) >>> 0
        } else if (len === 32 && start + 3 < bytes.length) {
          if (littleEndian) {
            val = (
              (bytes[start] ?? 0) +
              ((bytes[start + 1] ?? 0) << 8) +
              ((bytes[start + 2] ?? 0) << 16) +
              ((bytes[start + 3] ?? 0) * 0x1000000)
            ) >>> 0
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
      // 문자열:
      // - big-endian: 수신 순서 그대로 유지
      // - little-endian: 16비트 워드 내 바이트 스왑(PLC 문자열 워드 해석)
      const byteCount = Math.ceil(len / 8)
      const rawBytes = []
      for (let b = 0; b < byteCount; b++) {
        const bitStart = offset + b * 8
        if (bitStart + 8 > totalBits) break
        let byteVal = 0
        for (let i = 0; i < 8; i++) byteVal = (byteVal << 1) | getBit(bitStart + i)
        rawBytes.push(byteVal)
      }
      let ordered = rawBytes
      if (littleEndian && rawBytes.length >= 2) {
        ordered = []
        for (let i = 0; i < rawBytes.length; i += 2) {
          if (i + 1 < rawBytes.length) ordered.push(rawBytes[i + 1], rawBytes[i])
          else ordered.push(rawBytes[i])
        }
      }
      result[name] = ordered.map((v) => v.toString(16).padStart(2, '0')).join('') || '-'
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
    // unsigned로 표시하되, signed로 음수면 절댓값으로 보여줌 (예: 4294965796 → 1500)
    let display = u
    if (len === 16) {
      const s = (u & 0xFFFF) << 16 >> 16
      if (s < 0) display = -s
    } else if (len === 32) {
      const s = (u >>> 0) | 0
      if (s < 0) display = -s
    }
    if (scaleNum === 0.1) return (display * 0.1).toFixed(1)
    return display
  }

  if (dt === 'string') {
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
  const [modbusValues, setModbusValues] = useState({})
  const [modbusConnected, setModbusConnected] = useState(false)
  const [modbusError, setModbusError] = useState('')
  const [modbusHost, setModbusHost] = useState('127.0.0.1')
  const [modbusPort, setModbusPort] = useState('5051')
  const [modbusSlaveId, setModbusSlaveId] = useState('0')
  const [sensorData, setSensorData] = useState({}) // { VVB001: { value, ts }, TP3237: { value, ts } }
  const [mqttConnected, setMqttConnected] = useState(false)
  const [mqttError, setMqttError] = useState('')
  const messagesEndRef = useRef(null)
  const eventSourceRef = useRef(null)
  const ioVariableListRef = useRef([])
  const parsedEndianModeRef = useRef('1')
  ioVariableListRef.current = ioVariableList
  parsedEndianModeRef.current = parsedEndianMode

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
        const listForParse = ioVariableListRef.current.map(([name, info]) => [name, info.length])
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

    es.addEventListener('modbus_data', (e) => {
      const data = JSON.parse(e.data || '{}')
      if (data.parsed && typeof data.parsed === 'object') {
        setModbusValues((prev) => ({ ...prev, ...data.parsed }))
      }
    })

    es.addEventListener('modbus_connected', () => {
      setModbusConnected(true)
      setModbusError('')
    })

    es.addEventListener('modbus_disconnected', () => {
      setModbusConnected(false)
    })

    es.addEventListener('modbus_error', (e) => {
      const data = JSON.parse(e.data || '{}')
      setModbusError(data.message || 'Modbus 오류')
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

  const handleModbusConnect = async () => {
    setModbusError('')
    try {
      const res = await fetch(`${API_URL}/api/modbus/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: modbusHost.trim(),
          port: parseInt(modbusPort, 10) || 5051,
          slave_id: (() => { const n = parseInt(modbusSlaveId, 10); return Number.isNaN(n) ? 0 : n; })(),
        }),
      })
      const data = await res.json()
      if (!res.ok) setModbusError(data.error || '연결 실패')
    } catch (err) {
      setModbusError('서버에 연결할 수 없습니다.')
    }
  }

  const handleModbusDisconnect = async () => {
    try {
      await fetch(`${API_URL}/api/modbus/disconnect`, { method: 'POST' })
    } catch {
      // ignore
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

  /** 파싱된 값을 리틀/빅엔디안에 맞춘 2진수로 표시. 값 없으면 빈 문자열, 숫자는 부호 없이 스트림 순서대로. */
  const formatParsedValueAsBits = (value, lengthBit, dataType, littleEndian) => {
    const len = Number(lengthBit) || 0
    if (len <= 0 || value === '-' || value === undefined) return ''
    const le = littleEndian ?? true
    let bits
    if (typeof value === 'number') {
      if (len > 32) return ''
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
      const byteCount = Math.ceil(len / 8)
      let ordered = bytes.slice(0, byteCount)
      if (le && byteCount >= 2) {
        ordered = []
        for (let i = 0; i < byteCount; i += 2) {
          if (i + 1 < byteCount) ordered.push(bytes[i + 1], bytes[i])
          else ordered.push(bytes[i])
        }
      }
      bits = ordered.map((b) => byteToBits8(b)).join('').slice(0, len).padStart(len, '0')
    } else {
      return ''
    }
    return bits.replace(/(.{8})/g, '$1 ').trim()
  }

  /** 파싱된 값을 16진수 문자열로 표시 (해석된 값 기준 MSB→LSB) */
  const formatParsedValueAsHex = (value, lengthBit, littleEndian) => {
    const len = Number(lengthBit) || 0
    if (len <= 0 || value === '-' || value === undefined) return ''
    if (typeof value === 'number') {
      const u = toUnsigned(value, len)
      const byteCount = Math.ceil(len / 8)
      if (byteCount <= 0) return ''
      const bytes = []
      for (let i = 0; i < byteCount; i++) {
        // 숫자 u에서 LSB부터 추출
        bytes.push((u >> (8 * i)) & 0xff)
      }
      const ordered = [...bytes].reverse()
      return ordered.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')
    }
    if (typeof value === 'string' && /^[0-9a-fA-F]+$/.test(value)) {
      const pairs = value.match(/.{1,2}/g) || []
      return pairs.join(' ').toUpperCase()
    }
    return ''
  }

  return (
    <div className="app">
      <header className="header">
        <div className="logo">
          <span className="logo-icon">◉</span>
          <h1>PLC(UDP), Modbus/TCP, MQTT(IOLink)</h1>
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
            className={`side-tab ${activeView === 'modbus' ? 'active' : ''}`}
            onClick={() => setActiveView('modbus')}
          >
            <span className="side-tab-label">Modbus</span>
            <span className="side-tab-desc">Modbus TCP 폴링</span>
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

          {activeView === 'modbus' && (
            <section className="parsed-view modbus-view">
              <div className="parsed-view-header">
                <div className="parsed-view-title-row">
                  <h2>Modbus TCP</h2>
                </div>
                <section className="control-panel modbus-control">
                  <div className="control-row">
                    <div className="field-group">
                      <label htmlFor="modbus-host">IP</label>
                      <input
                        id="modbus-host"
                        type="text"
                        value={modbusHost}
                        onChange={(e) => setModbusHost(e.target.value)}
                        placeholder="127.0.0.1"
                        disabled={modbusConnected}
                      />
                    </div>
                    <div className="field-group">
                      <label htmlFor="modbus-port">포트</label>
                      <input
                        id="modbus-port"
                        type="number"
                        value={modbusPort}
                        onChange={(e) => setModbusPort(e.target.value)}
                        placeholder="502"
                        min="1"
                        max="65535"
                        disabled={modbusConnected}
                      />
                    </div>
                    <div className="field-group">
                      <label htmlFor="modbus-slave">Slave ID</label>
                      <input
                        id="modbus-slave"
                        type="number"
                        value={modbusSlaveId}
                        onChange={(e) => setModbusSlaveId(e.target.value)}
                        placeholder="1"
                        min="0"
                        max="255"
                        disabled={modbusConnected}
                      />
                    </div>
                  </div>
                  <div className="button-row">
                    <button
                      className="btn btn-primary"
                      onClick={handleModbusConnect}
                      disabled={modbusConnected}
                    >
                      Modbus TCP 연결
                    </button>
                    <button
                      className="btn btn-danger"
                      onClick={handleModbusDisconnect}
                      disabled={!modbusConnected}
                    >
                      연결 중지
                    </button>
                  </div>
                  {modbusError && <p className="error-message">{modbusError}</p>}
                  {modbusConnected && <p className="modbus-status">경고등/알람(Boolean) 3초 간격, 데이터 1초 간격 폴링 중</p>}
                </section>
                <p className="parsed-view-hint">io_variables.json과 동일한 목록. Coil 0~106(Boolean) 3초 간격, Holding Registers 1초 간격.</p>
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
                {ioVariableList.length === 0 ? (
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
                    {ioVariableList.map(([name, info]) => (
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
                          <span className="parsed-var-bits" title={formatParsedValueAsBits(modbusValues[name], info.length, info.dataType, false)}>
                            {formatParsedValueAsBits(modbusValues[name], info.length, info.dataType, false)}
                          </span>
                        )}
                        {showHexCol && (
                          <span className="parsed-var-hex" title={formatParsedValueAsHex(modbusValues[name], info.length, false)}>
                            {formatParsedValueAsHex(modbusValues[name], info.length, false)}
                          </span>
                        )}
                        {showValueCol && (
                          <span className="parsed-var-value-wrap">
                            {(info.dataType || '').toLowerCase() === 'boolean' && (
                              <span className={`boolean-dot boolean-dot--${modbusValues[name] ? '1' : '0'}`} title={modbusValues[name] ? '1' : '0'} aria-hidden />
                            )}
                            <span className="parsed-var-value">{decodeForDisplay(modbusValues[name], info)}</span>
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
                    ))}
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
                      const num = (x) => (x == null ? '—' : (Number.isFinite(Number(x)) ? Number(x) : String(x)))
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
                        disp = (cand != null && typeof cand !== 'object') ? cand : '—'
                      } else if (Number.isFinite(Number(v))) {
                        disp = Number(v)
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
                {ioVariableList.length === 0 ? (
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
                    {ioVariableList.map(([name, info]) => (
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
                          <span className="parsed-var-bits" title={formatParsedValueAsBits(parsedValues[name], info.length, info.dataType, getParseOptionsFromMode(parsedEndianMode).littleEndian)}>
                            {formatParsedValueAsBits(parsedValues[name], info.length, info.dataType, getParseOptionsFromMode(parsedEndianMode).littleEndian)}
                          </span>
                        )}
                        {showHexCol && (
                          <span className="parsed-var-hex" title={formatParsedValueAsHex(parsedValues[name], info.length, getParseOptionsFromMode(parsedEndianMode).littleEndian)}>
                            {formatParsedValueAsHex(parsedValues[name], info.length, getParseOptionsFromMode(parsedEndianMode).littleEndian)}
                          </span>
                        )}
                        {showValueCol && (
                          <span className="parsed-var-value-wrap">
                            {(info.dataType || '').toLowerCase() === 'boolean' && (
                              <span className={`boolean-dot boolean-dot--${parsedValues[name] ? '1' : '0'}`} title={parsedValues[name] ? '1' : '0'} aria-hidden />
                            )}
                            <span className="parsed-var-value">{decodeForDisplay(parsedValues[name], info)}</span>
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
                    ))}
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
