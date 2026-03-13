import { useState, useEffect, useRef, useMemo } from 'react'
import './App.css'
import PlcDashboard from './components/PlcDashboard'
import SensorTrendCharts from './components/SensorTrendCharts'

// 개발 모드: 접속한 호스트(로컬/원격)의 6005 사용 → SSH로 서버 IP 접속해도 API 연결됨
const API_URL = import.meta.env.DEV ? `http://${window.location.hostname}:6005` : window.location.origin
const SENSOR_TREND_MAX_POINTS = 240

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
    if (typeof raw === 'string') {
      // 문자열이 우연히 16진수 패턴(예: "ABCC")이어도 텍스트로 그대로 표시한다.
      return raw.replace(/\0+$/, '').trim() || '-'
    }
    let hexStr = ''
    if (typeof raw === 'number' && len === 16) {
      hexStr = (raw >>> 0).toString(16).padStart(4, '0')
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

/** 표시용 행의 값. String은 연속 키를 결합하고, Dword는 첫 키 값을 표시한다. */
function getDisplayValue(row, valueMap) {
  if (row.keys.length === 1) return valueMap[row.name]
  const dt = (row.info?.dataType ?? '').toLowerCase()
  // String: 백엔드가 이미 문자열로 디코딩해 보내므로 첫 유효 문자열을 우선 사용한다.
  // (연속 D주소 값을 다시 이어붙이면 겹침 구간이 중복되어 "ABC" -> "ABCC"처럼 보일 수 있음)
  if (dt === 'string') {
    for (const k of row.keys) {
      const v = valueMap[k]
      if (typeof v === 'string' && v.replace(/\0+$/, '').trim()) {
        return v
      }
    }
    // 구형/대체 포맷 대응: 숫자/hex 조각만 오는 경우에만 결합 복원
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
  return valueMap[row.keys[0]]
}

function toFiniteNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function parseVibrationTrendPoint(value) {
  if (!value || typeof value !== 'object') return null
  const point = {
    v_rms: toFiniteNumber(value.v_rms),
    a_peak: toFiniteNumber(value.a_peak),
    a_rms: toFiniteNumber(value.a_rms),
    temperature: toFiniteNumber(value.temperature),
    crest: toFiniteNumber(value.crest),
  }
  const hasAny = Object.values(point).some((v) => v !== null)
  return hasAny ? point : null
}

function parseTemperatureTrendPoint(value) {
  if (value && typeof value === 'object') {
    const inner = value && typeof value.payload === 'object' ? value.payload : value
    const n = toFiniteNumber(inner.data ?? inner.value ?? inner.temperature ?? inner.vibration)
    return n === null ? null : { temperature: n }
  }
  const n = toFiniteNumber(value)
  return n === null ? null : { temperature: n }
}

function App() {
  const [serverConnected, setServerConnected] = useState(false)
  const [activeView, setActiveView] = useState('plc') // 'plc' | 'mc' | 'dashboard'
  const [ioVariableList, setIoVariableList] = useState([]) // [ [name, lengthBit], ... ]
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
  const [sensorTrend, setSensorTrend] = useState({ VVB001: [], TP3237: [] }) // { topic: [{ ts, ...metrics }] }
  const [mqttConnected, setMqttConnected] = useState(false)
  const [mqttError, setMqttError] = useState('')
  const [csvExportOpen, setCsvExportOpen] = useState(false)
  const [csvExportStart, setCsvExportStart] = useState('')
  const [csvExportEnd, setCsvExportEnd] = useState('')
  const [csvExportGroup, setCsvExportGroup] = useState('50ms')
  const [csvExportError, setCsvExportError] = useState('')
  const [csvExportLoading, setCsvExportLoading] = useState(false)
  const eventSourceRef = useRef(null)
  /** 타발수 등: 리셋(음수) 시 처음 보였던 시작값으로 표시 (예: 10000 시작 → 리셋 시 10000) */
  const counterStartRef = useRef({})

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

  /** Dword 쌍 합쳐서 한 행으로 보여줄 목록 (MC 뷰 표시용) */
  const displayVariableList = useMemo(
    () => buildDisplayVariableList(ioVariableList),
    [ioVariableList]
  )

  /** MC 프로토콜 뷰: 원래 전체 목록 표시. MC 폴링되는 4개만 값 있고 나머지는 - (나중에 실데이터 넣을 때 사용) */
  const mcDisplayList = useMemo(() => displayVariableList, [displayVariableList])

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
    }

    es.onerror = () => {
      setServerConnected(false)
      es.close()
    }

    es.addEventListener('mc_data', (e) => {
      const data = JSON.parse(e.data || '{}')
      if (data.parsed && typeof data.parsed === 'object') {
        setMcValues((prev) => {
          const next = { ...prev }
          for (const [key, value] of Object.entries(data.parsed)) {
            // 폴링 순간 오류/타임아웃으로 들어온 '-'는 이전 정상값을 유지해 깜빡임을 줄인다.
            if (value === '-' || value === null || value === undefined) continue
            next[key] = value
          }
          return next
        })
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
        const ts = Number(data.ts) || Date.now() / 1000
        if (topic === 'VVB001') {
          const trendPoint = parseVibrationTrendPoint(data.value)
          if (trendPoint) {
            setSensorTrend((prev) => ({
              ...prev,
              VVB001: [...prev.VVB001, { ts, ...trendPoint }].slice(-SENSOR_TREND_MAX_POINTS),
            }))
          }
        } else if (topic === 'TP3237') {
          const trendPoint = parseTemperatureTrendPoint(data.value)
          if (trendPoint) {
            setSensorTrend((prev) => ({
              ...prev,
              TP3237: [...prev.TP3237, { ts, ...trendPoint }].slice(-SENSOR_TREND_MAX_POINTS),
            }))
          }
        }
        // 센서 데이터가 한 번이라도 들어오면 MQTT 연결된 것으로 간주
        setMqttConnected(true)
      }
    })
    es.addEventListener('sensor_data_snapshot', (e) => {
      const data = JSON.parse(e.data || '{}')
      if (data && typeof data === 'object') {
        setSensorTrend((prev) => {
          const updated = { ...prev }
          for (const [topic, payload] of Object.entries(data)) {
            const ts = Number(payload?.ts) || Date.now() / 1000
            if (topic === 'VVB001') {
              const trendPoint = parseVibrationTrendPoint(payload?.value)
              if (!trendPoint) continue
              updated.VVB001 = [...updated.VVB001, { ts, ...trendPoint }].slice(-SENSOR_TREND_MAX_POINTS)
            } else if (topic === 'TP3237') {
              const trendPoint = parseTemperatureTrendPoint(payload?.value)
              if (!trendPoint) continue
              updated.TP3237 = [...updated.TP3237, { ts, ...trendPoint }].slice(-SENSOR_TREND_MAX_POINTS)
            }
          }
          return updated
        })
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

  /** KST(Asia/Seoul) 기준으로 Date를 datetime-local 값 "YYYY-MM-DDTHH:mm"으로 포맷 */
  const formatKstForInput = (d) => {
    const dateStr = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' })
    const timeStr = d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false })
    return `${dateStr}T${timeStr}`
  }

  /** datetime-local 값 "YYYY-MM-DDTHH:mm"을 KST로 해석해 UTC ISO 문자열 반환 */
  const kstInputToIso = (s) => new Date(s.trim() + ':00+09:00').toISOString()

  const openCsvExportModal = () => {
    const now = new Date()
    const end = new Date(now)
    const start = new Date(now.getTime() - 1 * 60 * 60 * 1000)
    setCsvExportStart(formatKstForInput(start))
    setCsvExportEnd(formatKstForInput(end))
    setCsvExportError('')
    setCsvExportOpen(true)
  }

  /** 빠른 선택: 최근 N분/시간 기준으로 시작·종료 시간 설정 (KST) */
  const setCsvExportQuickRange = (minutes) => {
    const end = new Date()
    const start = new Date(end.getTime() - minutes * 60 * 1000)
    setCsvExportStart(formatKstForInput(start))
    setCsvExportEnd(formatKstForInput(end))
  }

  const handleCsvExportDownload = async () => {
    const start = csvExportStart.trim()
    const end = csvExportEnd.trim()
    const group = csvExportGroup || '50ms'
    if (!start || !end) {
      setCsvExportError('시작 시간과 종료 시간을 입력하세요.')
      return
    }
    const startISO = encodeURIComponent(kstInputToIso(start))
    const endISO = encodeURIComponent(kstInputToIso(end))
    const groupEnc = encodeURIComponent(group)
    setCsvExportError('')
    setCsvExportLoading(true)
    try {
      const res = await fetch(`${API_URL}/api/influxdb/export-csv?start=${startISO}&end=${endISO}&group=${groupEnc}`, {
        method: 'GET',
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setCsvExportError(data.error || `오류 ${res.status}`)
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const safe = (s) => String(s).replace(/:/g, '-')
      const filename = `${safe(start)}_${safe(end)}_${group}.csv`
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
      setCsvExportOpen(false)
    } catch (e) {
      setCsvExportError(e.message || '다운로드 실패')
    } finally {
      setCsvExportLoading(false)
    }
  }

  /** 바이트 하나를 8비트 문자열로 (MSB 먼저) */
  const byteToBits8 = (b) => ((b & 0xff).toString(2)).padStart(8, '0')

  /** 파싱된 값을 리틀/빅엔디안에 맞춘 2진수로 표시. 값 없으면 빈 문자열, 숫자는 부호 없이 스트림 순서대로. 문자열(ASCII)은 바이트별 2진. */
  const formatParsedValueAsBits = (value, lengthBit, dataType, littleEndian) => {
    const len = Number(lengthBit) || 0
    if (value === '-' || value === undefined) return ''
    const le = littleEndian ?? true
    const isStringType = String(dataType || '').toLowerCase() === 'string'
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
    } else if (typeof value === 'string' && !isStringType && /^[0-9a-fA-F]+$/.test(value)) {
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
  const formatParsedValueAsHex = (value, lengthBit, dataType, littleEndian) => {
    const len = Number(lengthBit) || 0
    if (value === '-' || value === undefined) return ''
    const isStringType = String(dataType || '').toLowerCase() === 'string'
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
    if (typeof value === 'string' && !isStringType && /^[0-9a-fA-F]+$/.test(value)) {
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
          <h1>MC Protocol(3E) & MQTT(IOLink)</h1>
        </div>
        <div className="header-actions">
          <button type="button" className="btn csv-export-btn" onClick={openCsvExportModal}>
            Data Export
          </button>
          <div className={`status-badge ${serverConnected ? 'online' : 'offline'}`}>
            {serverConnected ? '서버 연결됨' : '서버 연결 끊김'}
          </div>
        </div>
      </header>

      {csvExportOpen && (
        <div className="modal-overlay csv-export-overlay" onClick={() => setCsvExportOpen(false)} aria-hidden="false">
          <div className="modal csv-export-modal" onClick={(e) => e.stopPropagation()}>
            <div className="csv-modal-header">
              <h3 className="csv-modal-title">CSV 내보내기</h3>
              <p className="csv-modal-subtitle">InfluxDB 저장 데이터를 기간·폴링 그룹별로 다운로드합니다. (KST 기준)</p>
            </div>
            <section className="csv-modal-section">
              <span className="csv-modal-label">폴링 주기 그룹</span>
              <div className="csv-group-options" role="group" aria-label="폴링 주기 선택">
                {['50ms', '1s', '1min', '1h'].map((g) => (
                  <button
                    key={g}
                    type="button"
                    className={`csv-group-option ${csvExportGroup === g ? 'active' : ''}`}
                    onClick={() => setCsvExportGroup(g)}
                  >
                    {g}
                  </button>
                ))}
              </div>
            </section>
            <section className="csv-modal-section csv-section-datetime">
              <span className="csv-modal-label">
                조회 기간
                <em className="csv-label-tz">KST</em>
              </span>
              <div className="csv-datetime-block">
                <div className="csv-datetime-field">
                  <label htmlFor="csv-start">시작 시간</label>
                  <input
                    id="csv-start"
                    type="datetime-local"
                    value={csvExportStart}
                    onChange={(e) => setCsvExportStart(e.target.value)}
                    aria-label="시작 일시 (KST)"
                  />
                </div>
                <span className="csv-datetime-arrow" aria-hidden="true">→</span>
                <div className="csv-datetime-field">
                  <label htmlFor="csv-end">종료 시간</label>
                  <input
                    id="csv-end"
                    type="datetime-local"
                    value={csvExportEnd}
                    onChange={(e) => setCsvExportEnd(e.target.value)}
                    aria-label="종료 일시 (KST)"
                  />
                </div>
              </div>
              <div className="csv-quick-range">
                <span className="csv-quick-label">빠른 선택</span>
                <div className="csv-quick-btns">
                  {[
                    [1, '최근 1분'],
                    [5, '최근 5분'],
                    [30, '최근 30분'],
                    [60, '최근 1시간'],
                    [24 * 60, '최근 24시간'],
                  ].map(([mins, label]) => (
                    <button
                      key={mins}
                      type="button"
                      className="csv-quick-btn"
                      onClick={() => setCsvExportQuickRange(mins)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </section>
            {csvExportError && <p className="csv-modal-error">{csvExportError}</p>}
            <div className="csv-modal-actions">
              <button type="button" className="btn btn-secondary csv-modal-cancel" onClick={() => setCsvExportOpen(false)}>
                취소
              </button>
              <button type="button" className="btn btn-primary csv-modal-download" onClick={handleCsvExportDownload} disabled={csvExportLoading}>
                {csvExportLoading ? '다운로드 중…' : 'CSV 다운로드'}
              </button>
            </div>
          </div>
        </div>
      )}

      <main className="main-wrap">
        <nav className="side-tabs" aria-label="화면 전환">
          <button
            type="button"
            className={`side-tab ${activeView === 'plc' ? 'active' : ''}`}
            onClick={() => setActiveView('plc')}
          >
            <span className="side-tab-label">PLC 대시보드</span>
            <span className="side-tab-desc">고속프레스 메인</span>
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
          {activeView === 'plc' && (
            <PlcDashboard
              mcConnected={mcConnected}
              mcValues={mcValues}
              ioVariableList={ioVariableList}
              apiUrl={API_URL}
            />
          )}

          {activeView === 'mc' && (
            <section className="parsed-view mc-view">
              <div className="parsed-view-header">
                <div className="parsed-view-title-row">
                  <h2>MC Protocol (3E)</h2>
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
                </section>
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
                          showValueCol && 'minmax(220px, 1.3fr)',
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
                      const value = getDisplayValue(row, mcValues)
                      const { name, info } = row
                      const displayValue = decodeForDisplayWithReset(value, info, name)
                      const isStringType = (info?.dataType ?? '').toLowerCase() === 'string'
                      return (
                      <div
                        key={name}
                        className="parsed-var-row"
                        style={{
                          gridTemplateColumns: [
                            'minmax(180px, 1.2fr)',
                            showBitsCol && 'minmax(160px, 2.5fr)',
                            showHexCol && 'minmax(120px, 2fr)',
                            showValueCol && 'minmax(220px, 1.3fr)',
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
                          <span className="parsed-var-hex" title={formatParsedValueAsHex(value, info.length, info.dataType, false)}>
                            {formatParsedValueAsHex(value, info.length, info.dataType, false)}
                          </span>
                        )}
                        {showValueCol && (
                          <span className={`parsed-var-value-wrap ${isStringType ? 'parsed-var-value-wrap--string' : ''}`}>
                            {(info.dataType || '').toLowerCase() === 'boolean' && (
                              <span className={`boolean-dot boolean-dot--${value ? '1' : '0'}`} title={value ? '1' : '0'} aria-hidden />
                            )}
                            <span className={`parsed-var-value ${isStringType ? 'parsed-var-value--string' : ''}`}>
                              {displayValue}
                            </span>
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
              <div className="dashboard-body">
                <SensorTrendCharts
                  vibrationTrend={sensorTrend.VVB001}
                  temperatureTrend={sensorTrend.TP3237}
                />
              </div>
            </section>
          )}

        </div>
      </main>
    </div>
  )
}

export default App
