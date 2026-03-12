import { useEffect, useMemo, useState } from 'react'
import './PlcDashboard.css'

const DEFAULT_IO_PAGE_SIZE = 10

function extractAddress(name) {
  const m = String(name).match(/_([MXY][0-9A-F]+)$/i)
  return m ? m[1].toUpperCase() : null
}

function parseIoSearch(startVal, endVal) {
  const startRaw = String(startVal || '').trim()
  const endRaw = String(endVal || '').trim()
  if (!startRaw) return null
  let start = startRaw.toUpperCase()
  if (/^\d+$/.test(start)) start = `M${start}`
  if (!endRaw) return { rangeStart: start, limit: DEFAULT_IO_PAGE_SIZE }
  let end = endRaw.toUpperCase()
  if (/^\d+$/.test(end)) end = `M${end}`
  return { rangeStart: start, rangeEnd: end }
}

function addressInSearch(addr, search) {
  if (!addr || !search) return true
  const { rangeStart, rangeEnd } = search
  const dev = rangeStart[0]
  if (addr[0] !== dev) return false
  const base = dev === 'Y' ? 16 : 10
  const aNum = parseInt(addr.slice(1), base)
  const sNum = parseInt(rangeStart.slice(1), base)
  if (Number.isNaN(aNum) || Number.isNaN(sNum)) return false
  if (rangeEnd) {
    const eNum = parseInt(rangeEnd.slice(1), base)
    if (Number.isNaN(eNum)) return false
    const lo = Math.min(sNum, eNum)
    const hi = Math.max(sNum, eNum)
    return aNum >= lo && aNum <= hi
  }
  return aNum >= sNum
}

function filterAndSliceBySearch(rows, search) {
  if (!search) return rows.slice(0, DEFAULT_IO_PAGE_SIZE)
  const { rangeStart, rangeEnd, limit } = search
  const dev = rangeStart[0]
  const base = dev === 'Y' ? 16 : 10
  const filtered = rows
    .filter((r) => addressInSearch(r.address, search))
    .sort((a, b) => {
      const an = parseInt(a.address.slice(1), base)
      const bn = parseInt(b.address.slice(1), base)
      return an - bn
    })
  if (rangeEnd) return filtered
  return filtered.slice(0, limit)
}

function formatDurationMs(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value <= 0) return '-'
  if (value < 1000) return `${Math.round(value)}ms`
  const sec = value / 1000
  if (sec < 60) return `${sec % 1 === 0 ? sec.toFixed(0) : sec.toFixed(2)}초`
  const min = sec / 60
  if (min < 60) return `${min % 1 === 0 ? min.toFixed(0) : min.toFixed(2)}분`
  const hour = min / 60
  return `${hour % 1 === 0 ? hour.toFixed(0) : hour.toFixed(2)}시간`
}

const POLL_RATE_UNITS = [
  { key: 'ms', label: 'ms', factor: 1 },
  { key: 's', label: 's', factor: 1000 },
  { key: 'min', label: 'min', factor: 60000 },
  { key: 'hr', label: 'hr', factor: 3600000 },
]

const POLL_THREAD_TITLES = {
  '50ms': '실시간 공정값',
  '1s': '경고/부저/입출력',
  '1min': 'SPM/CPM 요약',
  '1h': '금형/셋업',
}

const POLL_THREAD_SUBTITLES = {
  '50ms': '각도/온도/생산량 고속 갱신',
  '1s': '알람, 램프, 카운터 주기',
  '1min': '사이클 트렌드 집계',
  '1h': '금형 번호/이름/셋업',
}

function toPollRateDraft(intervalMs) {
  const value = Number(intervalMs)
  if (!Number.isFinite(value) || value <= 0) return { value: '', unit: 'ms' }
  if (value % 3600000 === 0) return { value: '', unit: 'hr', placeholder: String(value / 3600000) }
  if (value % 60000 === 0) return { value: '', unit: 'min', placeholder: String(value / 60000) }
  if (value % 1000 === 0) return { value: '', unit: 's', placeholder: String(value / 1000) }
  return { value: '', unit: 'ms', placeholder: String(value) }
}

function draftToMs(draft) {
  const unit = POLL_RATE_UNITS.find((u) => u.key === draft?.unit) || POLL_RATE_UNITS[0]
  const source = String(draft?.value ?? '').trim() || String(draft?.placeholder ?? '').trim()
  const raw = Number(source)
  if (!Number.isFinite(raw) || raw <= 0) return NaN
  return raw * unit.factor
}

function getDraftPlaceholder(thread, draft) {
  if (draft?.placeholder && String(draft.placeholder).trim()) return String(draft.placeholder)
  const ms = Number(thread?.interval_ms)
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const unit = draft?.unit || 'ms'
  const def = POLL_RATE_UNITS.find((u) => u.key === unit) || POLL_RATE_UNITS[0]
  return String(ms / def.factor)
}

function getDraftPreviewText(thread, draft) {
  const ms = draftToMs(draft)
  if (Number.isFinite(ms) && ms > 0) return formatDurationMs(ms)
  return formatDurationMs(thread?.interval_ms)
}

function PlcDashboard({ mcConnected, mcValues, ioVariableList, apiUrl }) {
  const [plcTrend, setPlcTrend] = useState({ spm: [], balanceAir: [], productionRate: [] })
  const [activeTab, setActiveTab] = useState('main')
  const [moldIndex, setMoldIndex] = useState(0)
  const [showMoldList, setShowMoldList] = useState(false)
  const [ioSearchStart, setIoSearchStart] = useState('')
  const [ioSearchEnd, setIoSearchEnd] = useState('')
  const [pollRateConfig, setPollRateConfig] = useState(null)
  const [pollRateDraft, setPollRateDraft] = useState({})
  const [pollRateLoading, setPollRateLoading] = useState(false)
  const [pollRateSaving, setPollRateSaving] = useState(false)
  const [pollRateError, setPollRateError] = useState('')
  const [pollRateMessage, setPollRateMessage] = useState('')

  const infoByName = useMemo(() => Object.fromEntries(ioVariableList), [ioVariableList])

  const toNumber = (value) => {
    if (value === '-' || value === undefined || value === null) return null
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }

  const formatMetric = (value, digits = 0) => {
    const n = toNumber(value)
    if (n === null) return '-'
    return n.toLocaleString('ko-KR', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })
  }

  const decodeMetricValue = (raw, info) => {
    if (raw === '-' || raw === undefined || raw === null || !info) return null
    const dt = String(info?.dataType || '').toLowerCase()
    const scale = parseFloat(String(info?.scale ?? '1')) || 1
    const num = Number(raw)
    if (!Number.isFinite(num)) return null
    if (dt === 'word') return (num & 0xFFFF) * scale
    if (dt === 'dword') return (num >>> 0) * scale
    if (dt === 'boolean') return Number(Boolean(num))
    return num * scale
  }

  const getTextByCandidates = (names) => {
    for (const name of names) {
      const raw = mcValues[name]
      if (raw === undefined || raw === null || raw === '-') continue
      const text = String(raw).replace(/\0+$/, '').trim()
      if (text) return text
    }
    return '-'
  }

  const getMetricByCandidates = (names) => {
    for (const name of names) {
      const info = infoByName[name]
      if (!info) continue
      const decoded = decodeMetricValue(mcValues[name], info)
      if (decoded !== null) return decoded
    }
    return null
  }

  const plcMetrics = useMemo(() => {
    const dieHeight = getMetricByCandidates(['currentDieHeight_D711', 'nextDieHeight_D511'])
    const currentProduction = getMetricByCandidates(['currentProduction_D1812', 'production_D1818', 'production_D1819'])
    const balanceAir = getMetricByCandidates(['currentBalanceAirPressure_D713', 'nextBalanceAirPressure_D513'])
    const counterQty = getMetricByCandidates(['todayStrokeCount_D1912', 'totalCounter_D1820'])
    const targetProduction = getMetricByCandidates(['productionCounter_D1810', 'presetCounter_D1816'])
    const pressAngle = getMetricByCandidates(['pressAngle_D100'])
    const spm = getMetricByCandidates(['strokePerMinute_D126', 'cPMCyclePerMinute_D104'])
    return {
      dieHeight,
      currentProduction,
      balanceAir,
      counterQty,
      targetProduction,
      pressAngle,
      spm,
    }
  }, [mcValues, infoByName])

  const warningConfig = useMemo(() => ([
    { key: 'emergencyStopRF_M300', label: '비상정지(RF)', level: 'critical' },
    { key: 'emergencyStopLF_M301', label: '비상정지(LF)', level: 'critical' },
    { key: 'emergencyStopRR_M302', label: '비상정지(RR)', level: 'critical' },
    { key: 'emergencyStopLR_M303', label: '비상정지(LR)', level: 'critical' },
    { key: 'cBPumpMotorTrip_M327', label: 'C/B 펌프 모터 트립', level: 'critical' },
    { key: 'cBCoolingMotorTrip_M328', label: 'C/B 오일 냉각 모터 트립', level: 'critical' },
    { key: 'pressOverload_M334', label: '프레스 과부하', level: 'critical' },
    { key: 'overrun_M339', label: '오버런 감지', level: 'critical' },
    { key: 'safetyBlock_M329', label: '안전 블록 해제', level: 'critical' },
    { key: 'balanceAirAlarmLow_M331', label: '바란스 에어압력 저하', level: 'warning' },
    { key: 'clutchValveError_M309', label: '클러치 밸브 이상', level: 'warning' },
    { key: 'brakeValveError_M310', label: '브레이크 밸브 이상', level: 'warning' },
    { key: 'lightCurtainFront_M340', label: '전면 광전관 동작', level: 'info' },
    { key: 'lightCurtainRear_M359', label: '후면 광전관 동작', level: 'info' },
  ]), [])

  const ioItems = useMemo(() => {
    const items = []
    for (const [name, info] of ioVariableList) {
      const addr = extractAddress(name)
      if (!addr) continue
      const dt = String(info?.dataType || '').toLowerCase()
      if (dt !== 'boolean') continue
      const device = addr[0].toUpperCase()
      const dir = device === 'M' ? '입력' : device === 'Y' ? '출력' : null
      if (!dir) continue
      const label = info?.description?.trim() || name.replace(/_[MXY][0-9A-F]+$/i, '') || name
      items.push({ key: name, label, dir, address: addr })
    }
    return items
  }, [ioVariableList])

  const ioRows = useMemo(
    () => ioItems.map((item) => {
      const raw = Number(mcValues[item.key]) === 1
      return {
        ...item,
        on: raw,
        desc: infoByName[item.key]?.description || '',
      }
    }),
    [ioItems, mcValues, infoByName]
  )

  const activeWarnings = useMemo(() => {
    const byKey = Object.fromEntries(warningConfig.map((w) => [w.key, w]))
    const result = []
    for (const [name] of ioVariableList) {
      const addr = extractAddress(name)
      if (!addr || addr[0] !== 'M') continue
      if (Number(mcValues[name]) !== 1) continue
      const preset = byKey[name]
      result.push(
        preset
          ? { key: name, label: preset.label, level: preset.level }
          : {
              key: name,
              label: infoByName[name]?.description?.trim() || name.replace(/_[MXY][0-9A-F]+$/i, '') || name,
              level: 'info',
            }
      )
    }
    return result
  }, [warningConfig, ioVariableList, mcValues, infoByName])

  const warningCounts = useMemo(() => ({
    critical: activeWarnings.filter((w) => w.level === 'critical').length,
    warning: activeWarnings.filter((w) => w.level === 'warning').length,
    info: activeWarnings.filter((w) => w.level === 'info').length,
  }), [activeWarnings])

  const ioSearchParsed = useMemo(() => parseIoSearch(ioSearchStart, ioSearchEnd), [ioSearchStart, ioSearchEnd])
  const pollRateThreads = useMemo(() => pollRateConfig?.threads || [], [pollRateConfig])

  const ioInputsDisplay = useMemo(
    () => filterAndSliceBySearch(ioRows.filter((r) => r.dir === '입력'), ioSearchParsed),
    [ioRows, ioSearchParsed]
  )

  const ioOutputsDisplay = useMemo(
    () => ioRows.filter((r) => r.dir === '출력'),
    [ioRows]
  )

  const ioAddressValueMap = useMemo(() => {
    const out = {}
    for (const [name] of ioVariableList) {
      const m = String(name).match(/_([XYMD][0-9A-F]+)$/i)
      if (!m) continue
      const address = m[1].toUpperCase()
      const raw = mcValues[name]
      if (raw === undefined || raw === null || raw === '-') continue
      out[address] = Number(raw)
    }
    return out
  }, [ioVariableList, mcValues])

  const ioAddressPanels = useMemo(() => ([
    [
      { kind: 'M-INPUT', ranges: [['M300', 'M319'], ['M320', 'M339']] },
      { kind: 'M-INPUT', ranges: [['M340', 'M359'], ['M360', 'M379']] },
      { kind: 'M-INPUT', ranges: [['M380', 'M399']] },
      { kind: 'Y-OUTPUT', ranges: [['Y100', 'Y10F'], ['Y140', 'Y14F']] },
      { kind: 'Y-OUTPUT', ranges: [['Y150', 'Y15F'], ['Y160', 'Y16F']] },
      { kind: 'Y-OUTPUT', ranges: [['Y170', 'Y17F']] },
    ],
  ]), [])

  const parseAddrNum = (addr) => {
    const device = addr[0].toUpperCase()
    const raw = addr.slice(1).toUpperCase()
    const base = device === 'Y' ? 16 : 10
    return { device, num: parseInt(raw, base) }
  }

  const makeAddrKey = (device, num) => {
    if (device === 'Y') return `${device}${num.toString(16).toUpperCase()}`
    return `${device}${num}`
  }

  const getRangeSummary = (startAddr, endAddr) => {
    const { device: startDevice, num: start } = parseAddrNum(startAddr)
    const { device: endDevice, num: end } = parseAddrNum(endAddr)
    if (startDevice !== endDevice || Number.isNaN(start) || Number.isNaN(end)) return { active: 0, available: 0 }
    const device = startDevice
    let active = 0
    let available = 0
    for (let i = start; i <= end; i += 1) {
      const key = makeAddrKey(device, i)
      if (Object.prototype.hasOwnProperty.call(ioAddressValueMap, key)) {
        available += 1
        if (Number(ioAddressValueMap[key]) === 1) active += 1
      }
    }
    return { active, available }
  }

  const ioStats = useMemo(() => ({
    inputOn: ioRows.filter((r) => r.dir === '입력' && r.on).length,
    outputOn: ioRows.filter((r) => r.dir === '출력' && r.on).length,
    totalOn: ioRows.filter((r) => r.on).length,
  }), [ioRows])

  const productionRate = useMemo(() => {
    const current = toNumber(plcMetrics.currentProduction)
    const target = toNumber(plcMetrics.targetProduction)
    if (current === null || target === null || target <= 0) return 0
    return Math.max(0, Math.min(100, (current / target) * 100))
  }, [plcMetrics.currentProduction, plcMetrics.targetProduction])

  const pressTemps = useMemo(() => {
    const tempPointLabels = {
      crankShaftTempRightFront_D340: '크랭크샤프트 우전',
      crankShaftTempLeftFront_D341: '크랭크샤프트 좌전',
      crankShaftTempRightRear_D342: '크랭크샤프트 우후',
      crankShaftTempLeftRear_D343: '크랭크샤프트 좌후',
      conrodTempLeft_D330: '콘로드 좌',
      conrodTempRight_D331: '콘로드 우',
    }
    const tempKeys = [
      'crankShaftTempRightFront_D340',
      'crankShaftTempLeftFront_D341',
      'crankShaftTempRightRear_D342',
      'crankShaftTempLeftRear_D343',
      'conrodTempLeft_D330',
      'conrodTempRight_D331',
    ]
    const rows = tempKeys.map((key) => {
      const value = getMetricByCandidates([key])
      return { key, label: tempPointLabels[key] || key, value }
    }).filter((row) => row.value !== null)
    if (!rows.length) return { avg: null, max: null, level: 'unknown' }
    const sum = rows.reduce((acc, row) => acc + row.value, 0)
    const avg = sum / rows.length
    const hottest = rows.reduce((max, row) => (max && max.value > row.value ? max : row), null)
    const level = avg >= 60 ? 'high' : avg >= 52 ? 'caution' : 'normal'
    return { avg, max: hottest, level }
  }, [mcValues, infoByName])

  const operationScore = useMemo(() => {
    let score = 100
    score -= warningCounts.critical * 28
    score -= warningCounts.warning * 10
    const air = toNumber(plcMetrics.balanceAir)
    if (air !== null && air < 4.5) score -= 10
    if (air !== null && air < 3.8) score -= 8
    if (pressTemps.level === 'caution') score -= 7
    if (pressTemps.level === 'high') score -= 18
    if (warningCounts.critical >= 3) score = Math.min(score, 20)
    else if (warningCounts.critical >= 2) score = Math.min(score, 35)
    else if (warningCounts.critical >= 1) score = Math.min(score, 55)
    return Math.max(0, Math.min(100, score))
  }, [warningCounts, plcMetrics.balanceAir, pressTemps.level])

  const moldData = useMemo(() => ({
    currentNo: getMetricByCandidates(['currentDieNumber_D140']),
    nextNo: getMetricByCandidates(['nextDieNumber_D510']),
    currentName: getTextByCandidates(['currentDieName_D1560']),
    nextName: getTextByCandidates(['nextDieName_D549']),
    currentHeight: getMetricByCandidates(['currentDieHeight_D711']),
    nextHeight: getMetricByCandidates(['nextDieHeight_D511']),
    currentAir: getMetricByCandidates(['currentBalanceAirPressure_D713']),
    nextAir: getMetricByCandidates(['nextBalanceAirPressure_D513']),
  }), [mcValues, infoByName])

  const moldCatalog = useMemo(() => {
    const list = []
    const pushIfValid = (item) => {
      if (!item) return
      const hasNo = item.no !== null && item.no !== undefined
      const hasName = item.name && item.name !== '-'
      if (!hasNo && !hasName) return
      const id = `${hasNo ? item.no : '-'}|${hasName ? item.name : '-'}`
      if (list.some((m) => m.id === id)) return
      list.push({
        id,
        no: hasNo ? item.no : null,
        name: hasName ? item.name : '-',
        dieHeight: item.dieHeight ?? null,
        balanceAir: item.balanceAir ?? null,
      })
    }
    pushIfValid({
      no: moldData.currentNo,
      name: moldData.currentName,
      dieHeight: moldData.currentHeight,
      balanceAir: moldData.currentAir,
    })
    pushIfValid({
      no: moldData.nextNo,
      name: moldData.nextName,
      dieHeight: moldData.nextHeight,
      balanceAir: moldData.nextAir,
    })
    if (list.length === 0) {
      list.push({ id: 'default', no: null, name: '-', dieHeight: null, balanceAir: null })
    }
    return list
  }, [moldData])

  useEffect(() => {
    if (moldIndex >= moldCatalog.length) setMoldIndex(0)
  }, [moldCatalog, moldIndex])

  const selectedMold = moldCatalog[moldIndex] || moldCatalog[0]
  const nextMoldPreview = moldCatalog[(moldIndex + 1) % moldCatalog.length] || selectedMold

  const counterData = useMemo(() => ({
    total: getMetricByCandidates(['totalCounter_D1820']),
    plan: getMetricByCandidates(['productionCounter_D1810']),
    current: getMetricByCandidates(['currentProduction_D1812', 'production_D1818']),
    preset: getMetricByCandidates(['presetCounter_D1816']),
    deficiency: getMetricByCandidates(['defficiencyQuantity_D1814']),
  }), [mcValues, infoByName])

  const moldViewData = useMemo(() => {
    const angle = plcMetrics.pressAngle
    const nextAngle = angle == null ? null : (Number(angle) + 120) % 360
    const altAngle = angle == null ? null : (Number(angle) + 45) % 360
    const spm = plcMetrics.spm
    const ejectSec = spm && Number(spm) > 0 ? (60 / Number(spm)) : null
    return {
      moldNo: selectedMold?.no ?? null,
      moldName: selectedMold?.name ?? '-',
      dieHeight: selectedMold?.dieHeight ?? null,
      balanceAir: selectedMold?.balanceAir ?? null,
      nextMoldNo: nextMoldPreview?.no ?? null,
      nextMoldName: nextMoldPreview?.name ?? '-',
      autoAngle1From: angle,
      autoAngle1To: nextAngle,
      autoAngle2From: altAngle,
      autoAngle2To: nextAngle,
      ejector1From: angle,
      ejector1To: nextAngle,
      ejector1Sec: ejectSec,
      ejector2From: altAngle,
      ejector2To: nextAngle,
      ejector2Sec: ejectSec,
      misfeed1From: angle,
      misfeed1To: nextAngle,
      misfeed2From: altAngle,
      misfeed2To: nextAngle,
    }
  }, [selectedMold, nextMoldPreview, plcMetrics.pressAngle, plcMetrics.spm])

  const formatAnglePair = (from, to) => {
    if (from == null || to == null) return '-'
    return `${formatMetric(from, 0)}° - ${formatMetric(to, 0)}°`
  }

  useEffect(() => {
    const nextSpm = toNumber(plcMetrics.spm)
    const nextAir = toNumber(plcMetrics.balanceAir)
    setPlcTrend((prev) => {
      const push = (arr, value) => {
        if (value === null) return arr
        const next = [...arr, value]
        return next.slice(-24)
      }
      return {
        spm: push(prev.spm, nextSpm),
        balanceAir: push(prev.balanceAir, nextAir),
        productionRate: [...prev.productionRate, productionRate].slice(-24),
      }
    })
  }, [plcMetrics.spm, plcMetrics.balanceAir, productionRate])

  const buildSparklinePoints = (series, width = 180, height = 54) => {
    if (!series || series.length === 0) return ''
    const min = Math.min(...series)
    const max = Math.max(...series)
    const range = max - min || 1
    return series.map((v, i) => {
      const x = (i / Math.max(series.length - 1, 1)) * width
      const y = height - ((v - min) / range) * height
      return `${x.toFixed(2)},${y.toFixed(2)}`
    }).join(' ')
  }

  const loadPollRates = async () => {
    if (!apiUrl) return
    setPollRateLoading(true)
    setPollRateError('')
    try {
      const res = await fetch(`${apiUrl}/api/mc/poll-rates`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '폴링레이트 정보를 가져오지 못했습니다.')
      setPollRateConfig(data)
      const nextDraft = {}
      for (const thread of data.threads || []) {
        nextDraft[thread.key] = toPollRateDraft(thread.interval_ms)
      }
      setPollRateDraft(nextDraft)
    } catch (err) {
      setPollRateError(err.message || '폴링레이트 정보를 가져오지 못했습니다.')
    } finally {
      setPollRateLoading(false)
    }
  }

  useEffect(() => {
    if (activeTab !== 'pollrate') return
    if (!pollRateConfig) loadPollRates()
  }, [activeTab])

  const handleSavePollRates = async () => {
    if (!pollRateConfig || !apiUrl) return
    const minMs = Number(pollRateConfig.min_ms ?? 50)
    const maxMs = Number(pollRateConfig.max_ms ?? 43200000)
    const intervals = {}
    for (const thread of pollRateThreads) {
      const draft = pollRateDraft[thread.key]
      let value = draftToMs(draft)
      if (!Number.isFinite(value) || value <= 0) value = Number(thread.interval_ms)
      if (!Number.isFinite(value) || value < minMs || value > maxMs) {
        setPollRateError(`폴링레이트는 ${formatDurationMs(minMs)} ~ ${formatDurationMs(maxMs)} 범위로 입력해 주세요.`)
        return
      }
      intervals[thread.key] = Math.round(value)
    }
    setPollRateSaving(true)
    setPollRateError('')
    setPollRateMessage('')
    try {
      const res = await fetch(`${apiUrl}/api/mc/poll-rates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intervals_ms: intervals }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '폴링레이트 저장에 실패했습니다.')
      setPollRateMessage('폴링레이트를 저장했습니다.')
      await loadPollRates()
    } catch (err) {
      setPollRateError(err.message || '폴링레이트 저장에 실패했습니다.')
    } finally {
      setPollRateSaving(false)
    }
  }

  return (
    <section className="parsed-view plc-view">
      <div className="plc-hero">
        <div className="plc-title-wrap">
          <h2>PLC 대시보드</h2>
          <p>고속프레스 메인 운전 상태</p>
        </div>
        <div className="plc-badges">
          <span className={`status-badge ${mcConnected ? 'online' : 'offline'}`}>
            {mcConnected ? 'MC 폴링 정상' : 'MC 폴링 미연결'}
          </span>
          <span className={`plc-alarm-pill ${activeWarnings.length ? 'danger' : 'safe'}`}>
            {activeWarnings.length ? `경고 ${activeWarnings.length}건` : '경고 없음'}
          </span>
        </div>
      </div>
      <div className="plc-subtabs" role="tablist" aria-label="PLC 대시보드 탭">
        <button type="button" className={`plc-subtab ${activeTab === 'main' ? 'active' : ''}`} onClick={() => setActiveTab('main')}>메인</button>
        <button type="button" className={`plc-subtab ${activeTab === 'mold' ? 'active' : ''}`} onClick={() => setActiveTab('mold')}>금형데이터</button>
        <button type="button" className={`plc-subtab ${activeTab === 'counter' ? 'active' : ''}`} onClick={() => setActiveTab('counter')}>생산카운터</button>
        <button type="button" className={`plc-subtab ${activeTab === 'io' ? 'active' : ''}`} onClick={() => setActiveTab('io')}>PLC 입출력</button>
        <button type="button" className={`plc-subtab ${activeTab === 'pollrate' ? 'active' : ''}`} onClick={() => setActiveTab('pollrate')}>PLC 폴링레이트</button>
      </div>

      {activeTab === 'main' && <div className="plc-body">
        <div className="plc-gauge-card">
          <div className="plc-gauge-head">
            <span>프레스 각도</span>
            <span className="plc-gauge-sub">실시간 오퍼레이션</span>
          </div>
          <div className="plc-gauge-value">
            {formatMetric(plcMetrics.pressAngle, 0)}
            <small>°</small>
          </div>
          <div className="plc-gauge-progress-wrap">
            <div className="plc-gauge-progress-track">
              <div
                className="plc-gauge-progress-fill"
                style={{ width: `${Math.max(0, Math.min(100, ((plcMetrics.pressAngle ?? 0) / 360) * 100))}%` }}
              />
            </div>
            <div className="plc-gauge-progress-labels">
              <span>0°</span>
              <span>180°</span>
              <span>360°</span>
            </div>
          </div>
          <div className="plc-gauge-meta">
            <span>SPM</span>
            <strong>{formatMetric(plcMetrics.spm, 1)}</strong>
          </div>
          <div className="plc-gauge-extra">
            <span>현재 생산량 {formatMetric(plcMetrics.currentProduction, 0)} ea</span>
            <span>바란스 {formatMetric(plcMetrics.balanceAir, 1)} kg/cm²</span>
          </div>
        </div>

        <div className="plc-score-card">
          <h3>운전 스코어</h3>
          <div className="plc-score-body">
            <div
              className="plc-score-ring"
              style={{
                background: `conic-gradient(var(--accent) 0 ${operationScore}%, rgba(139, 156, 179, 0.2) ${operationScore}% 100%)`,
              }}
            >
              <span>{operationScore}</span>
            </div>
            <div className="plc-score-meta">
              <p>경고/온도/공압을 반영한 실시간 상태 지수</p>
              <div className="plc-score-chips">
                <span className="chip critical">치명 {warningCounts.critical}</span>
                <span className="chip warning">주의 {warningCounts.warning}</span>
                <span className="chip info">안내 {warningCounts.info}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="plc-kpi-grid">
          <article className="plc-kpi-card kpi-dieheight">
            <div className="plc-kpi-head">
              <span className="plc-kpi-label">다이하이트</span>
              <small>D711</small>
            </div>
            <strong className="plc-kpi-value">{formatMetric(plcMetrics.dieHeight, 1)}</strong>
            <span className="plc-kpi-unit">mm</span>
            <div className="plc-kpi-line" aria-hidden />
          </article>
          <article className="plc-kpi-card kpi-production">
            <div className="plc-kpi-head">
              <span className="plc-kpi-label">현재 생산량</span>
              <small>D1812</small>
            </div>
            <strong className="plc-kpi-value">{formatMetric(plcMetrics.currentProduction, 0)}</strong>
            <span className="plc-kpi-unit">ea</span>
            <div className="plc-kpi-line" aria-hidden />
          </article>
          <article className="plc-kpi-card kpi-air">
            <div className="plc-kpi-head">
              <span className="plc-kpi-label">바란스 에어압력</span>
              <small>D713</small>
            </div>
            <strong className="plc-kpi-value">{formatMetric(plcMetrics.balanceAir, 1)}</strong>
            <span className="plc-kpi-unit">kg/cm²</span>
            <div className="plc-kpi-line" aria-hidden />
          </article>
          <article className="plc-kpi-card kpi-counter">
            <div className="plc-kpi-head">
              <span className="plc-kpi-label">카운터 수량</span>
              <small>D1912</small>
            </div>
            <strong className="plc-kpi-value">{formatMetric(plcMetrics.counterQty, 0)}</strong>
            <span className="plc-kpi-unit">count</span>
            <div className="plc-kpi-line" aria-hidden />
          </article>
        </div>

        <div className="plc-production-card">
          <div className="plc-production-head">
            <span>생산 진행률</span>
            <strong>{productionRate.toFixed(1)}%</strong>
          </div>
          <div className="plc-progress-track">
            <div className="plc-progress-fill" style={{ width: `${productionRate}%` }} />
          </div>
          <div className="plc-production-meta">
            <span>현재 {formatMetric(plcMetrics.currentProduction, 0)} ea</span>
            <span>목표 {formatMetric(plcMetrics.targetProduction, 0)} ea</span>
          </div>
        </div>

        <div className="plc-trend-card">
          <div className="plc-trend-head">
            <h3>실시간 트렌드</h3>
            <span>최근 24포인트</span>
          </div>
          <div className="plc-trend-grid">
            <div className="plc-trend-item">
              <strong>SPM</strong>
              <svg viewBox="0 0 180 54" className="plc-spark">
                <polyline points={buildSparklinePoints(plcTrend.spm)} />
              </svg>
              <span>{formatMetric(plcMetrics.spm, 1)}</span>
            </div>
            <div className="plc-trend-item">
              <strong>Balance Air</strong>
              <svg viewBox="0 0 180 54" className="plc-spark">
                <polyline points={buildSparklinePoints(plcTrend.balanceAir)} />
              </svg>
              <span>{formatMetric(plcMetrics.balanceAir, 1)} kg/cm²</span>
            </div>
            <div className="plc-trend-item">
              <strong>진행률</strong>
              <svg viewBox="0 0 180 54" className="plc-spark">
                <polyline points={buildSparklinePoints(plcTrend.productionRate)} />
              </svg>
              <span>{productionRate.toFixed(1)}%</span>
            </div>
          </div>
        </div>

        <div className="plc-insight-card">
          <div className="plc-insight-head">
            <h3>온도 인사이트</h3>
            <span className={`temp-level ${pressTemps.level}`}>
              {pressTemps.level === 'high' ? '고온' : pressTemps.level === 'caution' ? '주의' : pressTemps.level === 'normal' ? '정상' : '대기'}
            </span>
          </div>
          <div className="plc-insight-grid">
            <div>
              <p>평균 구동부 온도</p>
              <strong>{pressTemps.avg === null ? '-' : `${formatMetric(pressTemps.avg, 1)} °C`}</strong>
            </div>
            <div>
              <p>최고 온도 포인트</p>
              <strong>
                {pressTemps.max
                  ? `${pressTemps.max.label} / ${formatMetric(pressTemps.max.value, 1)} °C`
                  : '-'}
              </strong>
            </div>
          </div>
        </div>

        <div className="plc-signal-card">
          <h3>타워램프</h3>
          <div className="plc-signal-lights">
            <span className={`plc-light red ${Number(mcValues.warningLightRed_Y14C) === 1 ? 'on' : ''}`}>적색</span>
            <span className={`plc-light yellow ${Number(mcValues.warningLightYellow_Y14D) === 1 ? 'on' : ''}`}>황색</span>
            <span className={`plc-light green ${Number(mcValues.warningLightGreen_Y14E) === 1 ? 'on' : ''}`}>녹색</span>
          </div>
          <p className="plc-signal-buzzer">
            부저: {Number(mcValues.towerLampBuzzer_Y14F) === 1 ? '동작 중' : '정상'}
          </p>
        </div>

        <div className="plc-alert-card">
          <div className="plc-alert-head">
            <h3>주요 경고등</h3>
            <span className="plc-alert-total">{activeWarnings.length}</span>
          </div>
          <div className="plc-alert-summary">
            <span className="badge critical">치명 {warningCounts.critical}</span>
            <span className="badge warning">주의 {warningCounts.warning}</span>
            <span className="badge info">안내 {warningCounts.info}</span>
          </div>
          {activeWarnings.length === 0 ? (
            <p className="plc-alert-empty">현재 활성화된 주요 경고가 없습니다.</p>
          ) : (
            <ul className="plc-alert-list">
              {activeWarnings.map((alarm) => (
                <li key={alarm.key} className={`plc-alert-item ${alarm.level}`}>
                  <span className="plc-alert-item-main">
                    <i className="plc-alert-dot" aria-hidden />
                    <span className="plc-alert-texts">
                      <strong>{alarm.label}</strong>
                      <small>{alarm.key}</small>
                    </span>
                  </span>
                  <em>{alarm.level === 'critical' ? '치명' : alarm.level === 'warning' ? '주의' : '안내'}</em>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>}

      {activeTab === 'mold' && (
        <section className="plc-subview mold-subview">
          <article className="plc-sub-card mold-board">
            <div className="mold-hero">
              <div className="mold-hero-main">
                <p className="mold-hero-label">현재 선택 금형</p>
                <div className="mold-hero-title">
                  <strong className="mold-no-display">No. {formatMetric(moldViewData.moldNo, 0)}</strong>
                  <span className="mold-page-indicator">
                    {Math.min(moldIndex + 1, moldCatalog.length)} / {moldCatalog.length}
                  </span>
                </div>
                <h3 className="mold-name-display">{moldViewData.moldName || '-'}</h3>
                <p className="mold-next-hint">
                  다음 금형: {formatMetric(moldViewData.nextMoldNo, 0)} / {moldViewData.nextMoldName || '-'}
                </p>
              </div>

              <div className="mold-hero-actions">
                <span className="mold-catalog-count">총 {moldCatalog.length}개</span>
                <div className="mold-switch-controls">
                  <button
                    type="button"
                    className="mold-icon-btn"
                    aria-label="이전 금형"
                    onClick={() => setMoldIndex((prev) => (prev - 1 + moldCatalog.length) % moldCatalog.length)}
                    disabled={moldCatalog.length <= 1}
                  >
                    ◀
                  </button>
                  <button
                    type="button"
                    className="mold-icon-btn"
                    aria-label="다음 금형"
                    onClick={() => setMoldIndex((prev) => (prev + 1) % moldCatalog.length)}
                    disabled={moldCatalog.length <= 1}
                  >
                    ▶
                  </button>
                </div>
                <button
                  type="button"
                  className="mold-list-btn"
                  onClick={() => setShowMoldList(true)}
                >
                  금형 리스트
                </button>
              </div>
            </div>

            <div className="mold-kpi-strip">
              <div className="mold-kpi-card">
                <span>다이 하이트</span>
                <strong>{formatMetric(moldViewData.dieHeight, 1)}</strong>
                <small>mm</small>
              </div>
              <div className="mold-kpi-card">
                <span>바란스 에어압력</span>
                <strong>{formatMetric(moldViewData.balanceAir, 1)}</strong>
                <small>kg/cm²</small>
              </div>
              <div className="mold-kpi-card">
                <span>에젝터 1 동작시간</span>
                <strong>{moldViewData.ejector1Sec == null ? '-' : formatMetric(moldViewData.ejector1Sec, 1)}</strong>
                <small>s</small>
              </div>
              <div className="mold-kpi-card">
                <span>에젝터 2 동작시간</span>
                <strong>{moldViewData.ejector2Sec == null ? '-' : formatMetric(moldViewData.ejector2Sec, 1)}</strong>
                <small>s</small>
              </div>
            </div>

            <div className="mold-detail-grid">
              <div className="mold-detail-item">
                <span>자동화 각도 1</span>
                <strong>{formatAnglePair(moldViewData.autoAngle1From, moldViewData.autoAngle1To)}</strong>
              </div>
              <div className="mold-detail-item">
                <span>미스피드 1</span>
                <strong>{formatAnglePair(moldViewData.misfeed1From, moldViewData.misfeed1To)}</strong>
              </div>
              <div className="mold-detail-item">
                <span>자동화 각도 2</span>
                <strong>{formatAnglePair(moldViewData.autoAngle2From, moldViewData.autoAngle2To)}</strong>
              </div>
              <div className="mold-detail-item">
                <span>미스피드 2</span>
                <strong>{formatAnglePair(moldViewData.misfeed2From, moldViewData.misfeed2To)}</strong>
              </div>
              <div className="mold-detail-item">
                <span>에젝터 1 각도 범위</span>
                <strong>{formatAnglePair(moldViewData.ejector1From, moldViewData.ejector1To)}</strong>
              </div>
              <div className="mold-detail-item">
                <span>에젝터 2 각도 범위</span>
                <strong>{formatAnglePair(moldViewData.ejector2From, moldViewData.ejector2To)}</strong>
              </div>
            </div>
          </article>
        </section>
      )}

      {activeTab === 'counter' && (
        <section className="plc-subview">
          <div className="plc-sub-grid plc-sub-grid-4">
            <article className="plc-sub-card"><h3>총 타발수</h3><p className="plc-sub-emphasis">{formatMetric(counterData.total, 0)}</p></article>
            <article className="plc-sub-card"><h3>계획 생산량</h3><p className="plc-sub-emphasis">{formatMetric(counterData.plan, 0)}</p></article>
            <article className="plc-sub-card"><h3>현재 생산량</h3><p className="plc-sub-emphasis">{formatMetric(counterData.current, 0)}</p></article>
            <article className="plc-sub-card"><h3>일 목표량</h3><p className="plc-sub-emphasis">{formatMetric(counterData.preset, 0)}</p></article>
          </div>
          <article className="plc-sub-card">
            <h3>생산 진척</h3>
            <div className="plc-progress-track">
              <div className="plc-progress-fill" style={{ width: `${productionRate}%` }} />
            </div>
            <div className="plc-sub-meta">
              <span>진행률 {productionRate.toFixed(1)}%</span>
              <span>과부족 {formatMetric(counterData.deficiency, 0)} ea</span>
            </div>
          </article>
        </section>
      )}

      {activeTab === 'io' && (
        <section className="plc-subview">
          <article className="plc-sub-card plc-io-search-card">
            <h3>PLC 입출력 검색</h3>
            <div className="plc-io-search-row">
              <input
                type="text"
                className="plc-io-search-input"
                placeholder="300"
                value={ioSearchStart}
                onChange={(e) => setIoSearchStart(e.target.value)}
              />
              <span className="plc-io-search-sep">~</span>
              <input
                type="text"
                className="plc-io-search-input"
                placeholder="333"
                value={ioSearchEnd}
                onChange={(e) => setIoSearchEnd(e.target.value)}
              />
              <span className="plc-io-search-hint">
                {ioSearchParsed
                  ? `입력 ${ioInputsDisplay.length}건`
                  : `기본 입력 ${DEFAULT_IO_PAGE_SIZE}건`}
                {`, 출력 ${ioOutputsDisplay.length}건`}
              </span>
            </div>
          </article>

          <article className="plc-sub-card plc-address-board">
            <h3>주소 대역 모니터 (X/Y)</h3>
            <div className="plc-address-rows">
              {ioAddressPanels.map((row, rowIdx) => (
                <div key={rowIdx} className="plc-address-row">
                  {row.map((panel, panelIdx) => (
                    <div key={`${rowIdx}-${panelIdx}`} className={`plc-address-panel ${panel.kind === 'Y-OUTPUT' ? 'output' : 'input'}`}>
                      <div className="plc-address-panel-title">{panel.kind}</div>
                      <div className="plc-address-ranges">
                        {panel.ranges.map(([startAddr, endAddr]) => {
                          const summary = getRangeSummary(startAddr, endAddr)
                          return (
                            <div key={`${startAddr}-${endAddr}`} className="plc-address-range">
                              <div className="plc-address-range-main">{startAddr} ~ {endAddr}</div>
                              <div className="plc-address-range-sub">활성 {summary.active} / 수신 {summary.available}</div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </article>

          <div className="plc-io-stats-grid">
            <article className="plc-io-stat-card">
              <span className="plc-io-stat-label">활성 입력</span>
              <strong className="plc-io-stat-value">{ioStats.inputOn}</strong>
            </article>
            <article className="plc-io-stat-card">
              <span className="plc-io-stat-label">활성 출력</span>
              <strong className="plc-io-stat-value">{ioStats.outputOn}</strong>
            </article>
            <article className="plc-io-stat-card">
              <span className="plc-io-stat-label">전체 활성점</span>
              <strong className="plc-io-stat-value">{ioStats.totalOn}</strong>
            </article>
            <article className="plc-io-stat-card plc-io-stat-card-meta">
              <span className="plc-io-stat-label">판독 기준</span>
              <strong className="plc-io-stat-value">ON=동작</strong>
            </article>
          </div>

          <div className="plc-sub-grid plc-sub-grid-2">
            <article className="plc-sub-card">
              <h3>입력 (센서/인터록)</h3>
              <div className="plc-io-grid">
                {ioInputsDisplay.map((row) => (
                  <div key={row.key} className={`plc-io-item ${row.on ? 'on' : 'off'}`}>
                    <div className="plc-io-head">
                      <strong>{row.label}</strong>
                      <span className={`plc-io-state ${row.on ? 'on' : 'off'}`}>{row.on ? 'ON' : 'OFF'}</span>
                    </div>
                    <div className="plc-io-key">{row.key}</div>
                    {row.desc && <p className="plc-io-desc">{row.desc}</p>}
                  </div>
                ))}
              </div>
            </article>
            <article className="plc-sub-card">
              <div className="plc-io-output-header">
                <h3>출력 (램프/부저)</h3>
                <div className="plc-signal-lights">
                  <span className={`plc-light red ${Number(mcValues.warningLightRed_Y14C) === 1 ? 'on' : ''}`}>적색</span>
                  <span className={`plc-light yellow ${Number(mcValues.warningLightYellow_Y14D) === 1 ? 'on' : ''}`}>황색</span>
                  <span className={`plc-light green ${Number(mcValues.warningLightGreen_Y14E) === 1 ? 'on' : ''}`}>녹색</span>
                </div>
              </div>
              <div className="plc-io-grid">
                {ioOutputsDisplay.map((row) => (
                  <div key={row.key} className={`plc-io-item ${row.on ? 'on' : 'off'}`}>
                    <div className="plc-io-head">
                      <strong>{row.label}</strong>
                      <span className={`plc-io-state ${row.on ? 'on' : 'off'}`}>{row.on ? 'ON' : 'OFF'}</span>
                    </div>
                    <div className="plc-io-key">{row.key}</div>
                  </div>
                ))}
              </div>
              <div className="plc-sub-meta">
                <span>MC 연결 {mcConnected ? '정상' : '미연결'}</span>
                <span>경고(치명/주의/안내): {warningCounts.critical}/{warningCounts.warning}/{warningCounts.info}</span>
              </div>
            </article>
          </div>
        </section>
      )}

      {activeTab === 'pollrate' && (
        <section className="plc-subview">
          <article className="plc-sub-card plc-pollrate-card">
            <div className="plc-pollrate-head">
              <h3>스레드별 폴링레이트 설정</h3>
              <button type="button" className="mold-list-btn" onClick={loadPollRates} disabled={pollRateLoading}>
                새로고침
              </button>
            </div>
            <p className="plc-pollrate-range">
              설정 범위: {formatDurationMs(pollRateConfig?.min_ms ?? 50)} ~ {formatDurationMs(pollRateConfig?.max_ms ?? 43200000)}
            </p>
            {pollRateError && <p className="error-message">{pollRateError}</p>}
            {pollRateMessage && <p className="plc-pollrate-ok">{pollRateMessage}</p>}
            {pollRateLoading && !pollRateThreads.length ? (
              <p className="plc-alert-empty">폴링레이트 정보를 불러오는 중...</p>
            ) : (
              <div className="plc-pollrate-grid">
                {pollRateThreads.map((thread) => (
                  <div key={thread.key} className="plc-pollrate-item">
                    <div className="plc-pollrate-item-head">
                      <div className="plc-pollrate-title-wrap">
                        <strong>{POLL_THREAD_TITLES[thread.key] || `${thread.key} 스레드`}</strong>
                        <small>{POLL_THREAD_SUBTITLES[thread.key] || thread.key}</small>
                      </div>
                      <span>{thread.entry_count}개 변수</span>
                    </div>
                    <div className="plc-pollrate-input-row">
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        className="plc-io-search-input"
                        value={pollRateDraft[thread.key]?.value ?? ''}
                        placeholder={getDraftPlaceholder(thread, pollRateDraft[thread.key])}
                        onChange={(e) => setPollRateDraft((prev) => ({
                          ...prev,
                          [thread.key]: {
                            ...(prev[thread.key] || { unit: 'ms', placeholder: '' }),
                            value: e.target.value,
                          },
                        }))}
                      />
                      <select
                        className="plc-pollrate-unit"
                        value={pollRateDraft[thread.key]?.unit ?? 'ms'}
                        onChange={(e) => setPollRateDraft((prev) => ({
                          ...prev,
                          [thread.key]: {
                            ...(prev[thread.key] || { value: '', placeholder: '' }),
                            unit: e.target.value,
                          },
                        }))}
                      >
                        {POLL_RATE_UNITS.map((unit) => (
                          <option key={unit.key} value={unit.key}>{unit.label}</option>
                        ))}
                      </select>
                      <span className="plc-pollrate-human">현재: {getDraftPreviewText(thread, pollRateDraft[thread.key])}</span>
                    </div>
                    <div className="plc-pollrate-list">
                      {(thread.entries || []).map((entry) => {
                        const desc = infoByName[entry.name]?.description?.trim()
                        return (
                          <div key={entry.name} className="plc-pollrate-list-item">
                            <span>{entry.name}</span>
                            <small>{desc || `${entry.device}${entry.address}`}</small>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="plc-pollrate-footer">
              <span className={`plc-pollrate-conn ${mcConnected ? 'online' : 'offline'}`}>
                {mcConnected ? 'MC 연결 중' : 'MC 미연결'}
              </span>
              <span className="plc-pollrate-note">값 또는 단위를 바꾼 항목만 반영되며, 미변경 항목은 현재값이 유지됩니다.</span>
            </div>
            <div className="button-row plc-pollrate-actions">
              <button className="btn btn-primary" type="button" onClick={handleSavePollRates} disabled={pollRateSaving || pollRateLoading || !pollRateThreads.length}>
                {pollRateSaving ? '저장 중...' : '폴링레이트 저장'}
              </button>
            </div>
          </article>
        </section>
      )}

      {showMoldList && (
        <div className="mold-modal-backdrop" onClick={() => setShowMoldList(false)}>
          <div className="mold-modal" onClick={(e) => e.stopPropagation()}>
            <div className="mold-modal-head">
              <h3>금형 리스트</h3>
              <button type="button" className="mold-modal-close" onClick={() => setShowMoldList(false)}>닫기</button>
            </div>
            <ul className="mold-modal-list">
              {moldCatalog.map((mold, idx) => (
                <li key={mold.id}>
                  <button
                    type="button"
                    className={`mold-modal-item ${idx === moldIndex ? 'active' : ''}`}
                    onClick={() => {
                      setMoldIndex(idx)
                      setShowMoldList(false)
                    }}
                  >
                    <span>No. {formatMetric(mold.no, 0)}</span>
                    <strong>{mold.name || '-'}</strong>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  )
}

export default PlcDashboard
