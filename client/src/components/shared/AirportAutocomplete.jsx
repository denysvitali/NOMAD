import React, { useState, useRef, useEffect, useCallback } from 'react'
import ReactDOM from 'react-dom'
import { MapPin, X } from 'lucide-react'
import { mapsApi } from '../../api/client'
import { useTranslation } from '../../i18n'

export default function AirportAutocomplete({ value, onChange, placeholder, style = {} }) {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  const [results, setResults] = useState([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [highlightIdx, setHighlightIdx] = useState(-1)
  const ref = useRef(null)
  const dropRef = useRef(null)
  const inputRef = useRef(null)
  const debounceRef = useRef(null)

  // Parse stored value "IATA - City (Name)" back into display
  const displayValue = value || ''

  useEffect(() => {
    const handleClick = (e) => {
      if (ref.current?.contains(e.target)) return
      if (dropRef.current?.contains(e.target)) return
      setOpen(false)
    }
    if (open) document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  const doSearch = useCallback(async (q) => {
    if (!q || q.length < 2) { setResults([]); return }
    setLoading(true)
    try {
      const data = await mapsApi.searchAirports(q)
      setResults(data.airports || [])
      setHighlightIdx(-1)
    } catch {
      setResults([])
    } finally {
      setLoading(false)
    }
  }, [])

  const handleInput = (e) => {
    const v = e.target.value
    setSearch(v)
    setOpen(true)
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => doSearch(v), 200)
  }

  const handleSelect = (ap) => {
    const label = `${ap.iata} - ${ap.city} (${ap.name})`
    onChange(label)
    setSearch('')
    setOpen(false)
    setResults([])
  }

  const handleClear = (e) => {
    e.stopPropagation()
    onChange('')
    setSearch('')
    setResults([])
  }

  const handleKeyDown = (e) => {
    if (!open || results.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightIdx(i => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightIdx(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && highlightIdx >= 0) {
      e.preventDefault()
      handleSelect(results[highlightIdx])
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  const handleFocus = () => {
    if (search.length >= 2) setOpen(true)
  }

  // Compute dropdown position
  const [dropPos, setDropPos] = useState(null)
  useEffect(() => {
    if (!open || !ref.current) { setDropPos(null); return }
    const rect = ref.current.getBoundingClientRect()
    setDropPos({
      top: rect.bottom + 4,
      left: rect.left,
      width: rect.width,
    })
  }, [open, results])

  const inputStyle = {
    width: '100%', border: '1px solid var(--border-primary)', borderRadius: 10,
    padding: '8px 12px', fontSize: 13, fontFamily: 'inherit',
    outline: 'none', boxSizing: 'border-box', color: 'var(--text-primary)',
    background: 'var(--bg-input)', paddingRight: value ? 32 : 12,
    ...style,
  }

  const dropdown = open && (results.length > 0 || loading) && dropPos ? ReactDOM.createPortal(
    <div
      ref={dropRef}
      style={{
        position: 'fixed', top: dropPos.top, left: dropPos.left, width: dropPos.width,
        maxHeight: 220, overflowY: 'auto', background: 'var(--bg-card)',
        border: '1px solid var(--border-primary)', borderRadius: 10,
        boxShadow: '0 8px 30px rgba(0,0,0,0.15)', zIndex: 99999,
      }}
    >
      {loading && results.length === 0 && (
        <div style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-faint)' }}>...</div>
      )}
      {results.map((ap, i) => (
        <button
          key={ap.iata + i}
          type="button"
          onMouseDown={(e) => { e.preventDefault(); handleSelect(ap) }}
          onMouseEnter={() => setHighlightIdx(i)}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, width: '100%',
            padding: '8px 14px', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
            background: i === highlightIdx ? 'var(--bg-tertiary)' : 'transparent',
            textAlign: 'left',
          }}
        >
          <span style={{
            fontWeight: 700, fontSize: 13, color: 'var(--text-primary)',
            minWidth: 36, flexShrink: 0,
          }}>{ap.iata}</span>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {ap.city}, {ap.country}
          </span>
          <span style={{ fontSize: 10, color: 'var(--text-faint)', flexShrink: 0, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {ap.name}
          </span>
        </button>
      ))}
    </div>,
    document.body
  ) : null

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      {value ? (
        <div
          style={{
            ...inputStyle,
            display: 'flex', alignItems: 'center', gap: 6,
            cursor: 'text', minHeight: 38,
          }}
          onClick={() => { onChange(''); setSearch(''); setTimeout(() => inputRef.current?.focus(), 0) }}
        >
          <MapPin size={12} style={{ color: 'var(--text-faint)', flexShrink: 0 }} />
          <span style={{ fontSize: 13, color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {displayValue}
          </span>
          <button type="button" onClick={handleClear} style={{
            position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
            background: 'none', border: 'none', cursor: 'pointer', padding: 2,
            color: 'var(--text-faint)', display: 'flex',
          }}>
            <X size={12} />
          </button>
        </div>
      ) : (
        <input
          ref={inputRef}
          type="text"
          value={search}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          onFocus={handleFocus}
          placeholder={placeholder || t('reservations.searchAirport')}
          style={inputStyle}
        />
      )}
      {dropdown}
    </div>
  )
}
