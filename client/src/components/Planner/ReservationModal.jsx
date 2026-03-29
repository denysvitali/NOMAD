import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import Modal from '../shared/Modal'
import CustomSelect from '../shared/CustomSelect'
import AirportAutocomplete from '../shared/AirportAutocomplete'
import { Plane, Hotel, Utensils, Train, Car, Ship, Ticket, FileText, Users, Paperclip, X, ExternalLink, Link2, ArrowRight } from 'lucide-react'
import { useToast } from '../shared/Toast'
import { useTranslation } from '../../i18n'
import { CustomDateTimePicker } from '../shared/CustomDateTimePicker'
import { mapsApi } from '../../api/client'

const TYPE_OPTIONS = [
  { value: 'flight',     labelKey: 'reservations.type.flight',     Icon: Plane },
  { value: 'hotel',      labelKey: 'reservations.type.hotel',      Icon: Hotel },
  { value: 'restaurant', labelKey: 'reservations.type.restaurant', Icon: Utensils },
  { value: 'train',      labelKey: 'reservations.type.train',      Icon: Train },
  { value: 'car',        labelKey: 'reservations.type.car',        Icon: Car },
  { value: 'cruise',     labelKey: 'reservations.type.cruise',     Icon: Ship },
  { value: 'event',      labelKey: 'reservations.type.event',      Icon: Ticket },
  { value: 'tour',       labelKey: 'reservations.type.tour',       Icon: Users },
  { value: 'other',      labelKey: 'reservations.type.other',      Icon: FileText },
]

function buildAssignmentOptions(days, assignments, t, locale) {
  const options = []
  for (const day of (days || [])) {
    const da = (assignments?.[String(day.id)] || []).slice().sort((a, b) => a.order_index - b.order_index)
    if (da.length === 0) continue
    const dayLabel = day.title || t('dayplan.dayN', { n: day.day_number })
    const dateStr = day.date ? ` · ${formatDate(day.date, locale)}` : ''
    // Group header (non-selectable)
    options.push({ value: `_header_${day.id}`, label: `${dayLabel}${dateStr}`, disabled: true, isHeader: true })
    for (let i = 0; i < da.length; i++) {
      const place = da[i].place
      if (!place) continue
      const timeStr = place.place_time ? ` · ${place.place_time}${place.end_time ? ' – ' + place.end_time : ''}` : ''
      options.push({
        value: da[i].id,
        label: `  ${i + 1}. ${place.name}${timeStr}`,
      })
    }
  }
  return options
}

function getIataFromAirport(str) {
  if (!str) return ''
  const m = str.match(/^([A-Z]{3})\s*-/)
  return m ? m[1] : ''
}

function buildFlightTitle(form) {
  const parts = []
  if (form.flight_number) parts.push(form.flight_number)
  const dep = getIataFromAirport(form.departure_airport)
  const arr = getIataFromAirport(form.arrival_airport)
  if (dep && arr) parts.push(`${dep} → ${arr}`)
  else if (dep) parts.push(`from ${dep}`)
  else if (arr) parts.push(`to ${arr}`)
  return parts.join(' · ') || ''
}

export function ReservationModal({ isOpen, onClose, onSave, reservation, days, places, assignments, selectedDayId, files = [], onFileUpload, onFileDelete }) {
  const toast = useToast()
  const { t, locale } = useTranslation()
  const fileInputRef = useRef(null)

  const [form, setForm] = useState({
    title: '', type: 'other', status: 'pending',
    reservation_time: '', location: '', confirmation_number: '',
    notes: '', assignment_id: '',
    flight_number: '', airline: '', departure_airport: '', arrival_airport: '',
  })
  const [isSaving, setIsSaving] = useState(false)
  const [uploadingFile, setUploadingFile] = useState(false)
  const [pendingFiles, setPendingFiles] = useState([])
  const airlineLookupRef = useRef(null)

  const assignmentOptions = useMemo(
    () => buildAssignmentOptions(days, assignments, t, locale),
    [days, assignments, t, locale]
  )

  useEffect(() => {
    if (reservation) {
      setForm({
        title: reservation.title || '',
        type: reservation.type || 'other',
        status: reservation.status || 'pending',
        reservation_time: reservation.reservation_time ? reservation.reservation_time.slice(0, 16) : '',
        location: reservation.location || '',
        confirmation_number: reservation.confirmation_number || '',
        notes: reservation.notes || '',
        assignment_id: reservation.assignment_id || '',
        flight_number: reservation.flight_number || '',
        airline: reservation.airline || '',
        departure_airport: reservation.departure_airport || '',
        arrival_airport: reservation.arrival_airport || '',
      })
    } else {
      setForm({
        title: '', type: 'other', status: 'pending',
        reservation_time: '', location: '', confirmation_number: '',
        notes: '', assignment_id: '',
        flight_number: '', airline: '', departure_airport: '', arrival_airport: '',
      })
      setPendingFiles([])
    }
  }, [reservation, isOpen, selectedDayId])

  const set = (field, value) => setForm(prev => ({ ...prev, [field]: value }))

  // Auto-detect airline from flight number (e.g. "LH123" → "LH" → "Deutsche Lufthansa AG")
  const handleFlightNumberChange = useCallback((val) => {
    const v = val.toUpperCase().replace(/[^A-Z0-9]/g, '')
    setForm(prev => ({ ...prev, flight_number: v }))

    // Extract airline code: 2-letter IATA code at start of flight number
    const match = v.match(/^([A-Z]{2})\d/)
    const code = match ? match[1] : null

    clearTimeout(airlineLookupRef.current)
    if (code) {
      airlineLookupRef.current = setTimeout(async () => {
        try {
          const data = await mapsApi.lookupAirline(code)
          if (data.airline) {
            setForm(prev => {
              const next = { ...prev, airline: data.airline.name }
              // Auto-generate title from flight info
              next.title = buildFlightTitle(next)
              return next
            })
          }
        } catch { /* ignore */ }
      }, 300)
    } else {
      setForm(prev => ({ ...prev, airline: '' }))
    }
  }, [])

  // Auto-update title when airports change
  const handleAirportChange = useCallback((field, value) => {
    setForm(prev => {
      const next = { ...prev, [field]: value }
      next.title = buildFlightTitle(next)
      return next
    })
  }, [])

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!form.title.trim()) return
    setIsSaving(true)
    try {
      const payload = {
        ...form,
        assignment_id: form.assignment_id || null,
      }
      // Only include flight fields when type is flight
      if (form.type !== 'flight') {
        payload.flight_number = null
        payload.airline = null
        payload.departure_airport = null
        payload.arrival_airport = null
      }
      const saved = await onSave(payload)
      if (!reservation?.id && saved?.id && pendingFiles.length > 0) {
        for (const file of pendingFiles) {
          const fd = new FormData()
          fd.append('file', file)
          fd.append('reservation_id', saved.id)
          fd.append('description', form.title)
          await onFileUpload(fd)
        }
      }
    } finally {
      setIsSaving(false)
    }
  }

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (reservation?.id) {
      setUploadingFile(true)
      try {
        const fd = new FormData()
        fd.append('file', file)
        fd.append('reservation_id', reservation.id)
        fd.append('description', reservation.title)
        await onFileUpload(fd)
        toast.success(t('reservations.toast.fileUploaded'))
      } catch {
        toast.error(t('reservations.toast.uploadError'))
      } finally {
        setUploadingFile(false)
        e.target.value = ''
      }
    } else {
      setPendingFiles(prev => [...prev, file])
      e.target.value = ''
    }
  }

  const attachedFiles = reservation?.id ? files.filter(f => f.reservation_id === reservation.id) : []

  const inputStyle = {
    width: '100%', border: '1px solid var(--border-primary)', borderRadius: 10,
    padding: '8px 12px', fontSize: 13, fontFamily: 'inherit',
    outline: 'none', boxSizing: 'border-box', color: 'var(--text-primary)', background: 'var(--bg-input)',
  }
  const labelStyle = { display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-faint)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.03em' }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={reservation ? t('reservations.editTitle') : t('reservations.newTitle')} size="2xl">
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

        {/* Type selector */}
        <div>
          <label style={labelStyle}>{t('reservations.bookingType')}</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {TYPE_OPTIONS.map(({ value, labelKey, Icon }) => (
              <button key={value} type="button" onClick={() => set('type', value)} style={{
                display: 'flex', alignItems: 'center', gap: 4,
                padding: '5px 10px', borderRadius: 99, border: '1px solid',
                fontSize: 11, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.12s',
                background: form.type === value ? 'var(--text-primary)' : 'var(--bg-card)',
                borderColor: form.type === value ? 'var(--text-primary)' : 'var(--border-primary)',
                color: form.type === value ? 'var(--bg-primary)' : 'var(--text-muted)',
              }}>
                <Icon size={11} /> {t(labelKey)}
              </button>
            ))}
          </div>
        </div>

        {/* Flight-specific fields */}
        {form.type === 'flight' && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label style={labelStyle}>{t('reservations.flightNumber')}</label>
                <input type="text" value={form.flight_number} onChange={e => handleFlightNumberChange(e.target.value)}
                  placeholder={t('reservations.flightNumberPlaceholder')} style={inputStyle} maxLength={10} />
              </div>
              <div>
                <label style={labelStyle}>{t('reservations.airline')}</label>
                <input type="text" value={form.airline} readOnly tabIndex={-1}
                  style={{ ...inputStyle, background: 'var(--bg-secondary)', color: form.airline ? 'var(--text-primary)' : 'var(--text-faint)' }}
                  placeholder="—" />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" style={{ alignItems: 'end' }}>
              <div>
                <label style={labelStyle}>{t('reservations.departureAirport')}</label>
                <AirportAutocomplete value={form.departure_airport} onChange={v => handleAirportChange('departure_airport', v)} />
              </div>
              <div>
                <label style={labelStyle}>{t('reservations.arrivalAirport')}</label>
                <AirportAutocomplete value={form.arrival_airport} onChange={v => handleAirportChange('arrival_airport', v)} />
              </div>
            </div>
          </>
        )}

        {/* Title (auto-generated for flights, manual for others) */}
        <div>
          <label style={labelStyle}>{t('reservations.titleLabel')} *</label>
          <input type="text" value={form.title} onChange={e => set('title', e.target.value)} required
            placeholder={form.type === 'flight' ? 'LH123 · FRA → JFK' : t('reservations.titlePlaceholder')} style={inputStyle} />
        </div>

        {/* Assignment Picker */}
        {assignmentOptions.length > 0 && (
          <div>
            <label style={labelStyle}>
              <Link2 size={10} style={{ display: 'inline', verticalAlign: '-1px', marginRight: 3 }} />
              {t('reservations.linkAssignment')}
            </label>
            <CustomSelect
              value={form.assignment_id}
              onChange={value => set('assignment_id', value)}
              placeholder={t('reservations.pickAssignment')}
              options={[
                { value: '', label: t('reservations.noAssignment') },
                ...assignmentOptions,
              ]}
              searchable
              size="sm"
            />
          </div>
        )}

        {/* Date/Time + Status */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label style={labelStyle}>{t('reservations.datetime')}</label>
            <CustomDateTimePicker value={form.reservation_time} onChange={v => set('reservation_time', v)} />
          </div>
          <div>
            <label style={labelStyle}>{t('reservations.status')}</label>
            <CustomSelect
              value={form.status}
              onChange={value => set('status', value)}
              options={[
                { value: 'pending', label: t('reservations.pending') },
                { value: 'confirmed', label: t('reservations.confirmed') },
              ]}
              size="sm"
            />
          </div>
        </div>

        {/* Location + Booking Code */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label style={labelStyle}>{t('reservations.locationAddress')}</label>
            <input type="text" value={form.location} onChange={e => set('location', e.target.value)}
              placeholder={t('reservations.locationPlaceholder')} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>{t('reservations.confirmationCode')}</label>
            <input type="text" value={form.confirmation_number} onChange={e => set('confirmation_number', e.target.value)}
              placeholder={t('reservations.confirmationPlaceholder')} style={inputStyle} />
          </div>
        </div>

        {/* Notes */}
        <div>
          <label style={labelStyle}>{t('reservations.notes')}</label>
          <textarea value={form.notes} onChange={e => set('notes', e.target.value)} rows={2}
            placeholder={t('reservations.notesPlaceholder')}
            style={{ ...inputStyle, resize: 'none', lineHeight: 1.5 }} />
        </div>

        {/* Files */}
        <div>
          <label style={labelStyle}>{t('files.title')}</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {attachedFiles.map(f => (
              <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', background: 'var(--bg-secondary)', borderRadius: 8 }}>
                <FileText size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                <span style={{ flex: 1, fontSize: 12, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.original_name}</span>
                <a href={f.url} target="_blank" rel="noreferrer" style={{ color: 'var(--text-faint)', display: 'flex', flexShrink: 0 }}><ExternalLink size={11} /></a>
                {onFileDelete && (
                  <button type="button" onClick={() => onFileDelete(f.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', display: 'flex', padding: 0, flexShrink: 0 }}>
                    <X size={11} />
                  </button>
                )}
              </div>
            ))}
            {pendingFiles.map((f, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', background: 'var(--bg-secondary)', borderRadius: 8 }}>
                <FileText size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                <span style={{ flex: 1, fontSize: 12, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                <button type="button" onClick={() => setPendingFiles(prev => prev.filter((_, j) => j !== i))}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', display: 'flex', padding: 0, flexShrink: 0 }}>
                  <X size={11} />
                </button>
              </div>
            ))}
            <input ref={fileInputRef} type="file" accept=".pdf,.doc,.docx,.txt,image/*" style={{ display: 'none' }} onChange={handleFileChange} />
            <button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploadingFile} style={{
              display: 'flex', alignItems: 'center', gap: 5, padding: '6px 10px',
              border: '1px dashed var(--border-primary)', borderRadius: 8, background: 'none',
              fontSize: 11, color: 'var(--text-faint)', cursor: uploadingFile ? 'default' : 'pointer', fontFamily: 'inherit',
            }}>
              <Paperclip size={11} />
              {uploadingFile ? t('reservations.uploading') : t('reservations.attachFile')}
            </button>
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 4, borderTop: '1px solid var(--border-secondary)' }}>
          <button type="button" onClick={onClose} style={{ padding: '8px 16px', borderRadius: 10, border: '1px solid var(--border-primary)', background: 'none', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-muted)' }}>
            {t('common.cancel')}
          </button>
          <button type="submit" disabled={isSaving || !form.title.trim()} style={{ padding: '8px 20px', borderRadius: 10, border: 'none', background: 'var(--text-primary)', color: 'var(--bg-primary)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', opacity: isSaving || !form.title.trim() ? 0.5 : 1 }}>
            {isSaving ? t('common.saving') : reservation ? t('common.update') : t('common.add')}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function formatDate(dateStr, locale) {
  if (!dateStr) return ''
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString(locale || 'de-DE', { day: 'numeric', month: 'short' })
}
