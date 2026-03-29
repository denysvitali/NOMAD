import React, { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { companionApi } from '../api/client'
import { weatherApi } from '../api/client'
import {
  MapPin, Clock, Plane, Hotel, Sun, Cloud, CloudRain, CloudSnow,
  CloudLightning, CloudFog, ChevronRight, Navigation, WifiOff,
  ArrowLeft, ChevronDown
} from 'lucide-react'

const WEATHER_ICONS = {
  Clear: Sun,
  Clouds: Cloud,
  Rain: CloudRain,
  Drizzle: CloudRain,
  Snow: CloudSnow,
  Thunderstorm: CloudLightning,
  Fog: CloudFog,
}

function getWeatherIcon(main) {
  const Icon = WEATHER_ICONS[main] || Cloud
  return <Icon size={20} />
}

function formatDate(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

function formatTime(timeStr) {
  if (!timeStr) return ''
  return timeStr.slice(0, 5)
}

function getTodayStr() {
  return new Date().toISOString().slice(0, 10)
}

function getDateRange(startDate, endDate) {
  if (!startDate) return ''
  const start = new Date(startDate)
  const end = endDate ? new Date(endDate) : null
  const opts = { month: 'short', day: 'numeric' }
  if (!end || start.getTime() === end.getTime()) {
    return start.toLocaleDateString(undefined, opts)
  }
  return `${start.toLocaleDateString(undefined, opts)} — ${end.toLocaleDateString(undefined, opts)}`
}

function getCurrentDayInfo(days) {
  const today = getTodayStr()
  const todayIndex = days.findIndex(d => d.date === today)
  if (todayIndex !== -1) {
    return { currentDay: todayIndex + 1, totalDays: days.length, todayAssignments: days[todayIndex].assignments, todayIndex }
  }
  // No match — find the closest day (first day after today, or last day before)
  const future = days.find(d => d.date > today)
  if (future) {
    const idx = days.indexOf(future)
    return { currentDay: idx + 1, totalDays: days.length, todayAssignments: future.assignments, todayIndex: idx }
  }
  // All days are in the past — show last day
  return { currentDay: days.length, totalDays: days.length, todayAssignments: days[days.length - 1].assignments, todayIndex: days.length - 1 }
}

function getCurrentOrNextPlace(assignments) {
  if (!assignments || assignments.length === 0) return null
  const now = new Date()
  const today = getTodayStr()
  const currentTimeStr = now.toTimeString().slice(0, 8)

  for (const a of assignments) {
    const startTime = a.place.place_time
    const endTime = a.place.end_time
    if (!startTime) continue
    if (startTime <= currentTimeStr && endTime && endTime >= currentTimeStr) {
      return { place: a.place, status: 'current' }
    }
    if (startTime > currentTimeStr) {
      return { place: a.place, status: 'next' }
    }
  }
  // All past — return last
  return { place: assignments[assignments.length - 1].place, status: 'past' }
}

function getTomorrowAssignments(days, todayIndex) {
  if (todayIndex < days.length - 1) {
    return days[todayIndex + 1].assignments
  }
  return []
}

export default function CompanionPage() {
  const { id: tripId } = useParams()
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [online, setOnline] = useState(navigator.onLine)
  const [weather, setWeather] = useState({})
  const [weatherLoading, setWeatherLoading] = useState(false)

  useEffect(() => {
    const handleOnline = () => setOnline(true)
    const handleOffline = () => setOnline(false)
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  useEffect(() => {
    if (!tripId) return
    setLoading(true)
    companionApi.getData(tripId)
      .then(setData)
      .catch(err => setError(err.message || 'Failed to load trip data'))
      .finally(() => setLoading(false))
  }, [tripId])

  // Fetch weather for each day that has coordinates
  useEffect(() => {
    if (!data || !data.weather) return
    const dates = Object.keys(data.weather)
    if (dates.length === 0) return
    setWeatherLoading(true)
    const promises = dates.map(async (date) => {
      try {
        const { lat, lng } = data.weather[date]
        const w = await weatherApi.get(lat, lng, date)
        return { date, weather: w }
      } catch {
        return { date, weather: null }
      }
    })
    Promise.all(promises).then(results => {
      const map = {}
      results.forEach(({ date, weather: w }) => { map[date] = w })
      setWeather(map)
    }).finally(() => setWeatherLoading(false))
  }, [data])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-primary)' }}>
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-4 rounded-full animate-spin" style={{ borderColor: 'var(--border-primary)', borderTopColor: 'var(--accent)' }} />
          <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>Loading trip...</p>
        </div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-6" style={{ background: 'var(--bg-primary)' }}>
        <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>{error || 'Trip not found'}</p>
        <button
          onClick={() => navigate(-1)}
          className="px-4 py-2 rounded-lg text-sm font-medium"
          style={{ background: 'var(--accent)', color: 'var(--accent-text)' }}
        >
          Go Back
        </button>
      </div>
    )
  }

  const { trip, days, reservations, accommodations } = data
  const { currentDay, totalDays, todayAssignments, todayIndex } = getCurrentDayInfo(days)
  const currentPlaceInfo = getCurrentOrNextPlace(todayAssignments)
  const tomorrowAssignments = getTomorrowAssignments(days, todayIndex)
  const todayDate = days[todayIndex]?.date
  const todayWeather = todayDate ? weather[todayDate] : null
  const dateRange = getDateRange(trip.start_date, trip.end_date)

  const flights = reservations.filter(r => r.type === 'flight')

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-primary)' }}>
      {/* Offline banner */}
      {!online && (
        <div className="flex items-center gap-2 px-4 py-2 text-xs font-medium" style={{ background: '#92400e', color: '#fef3c7' }}>
          <WifiOff size={14} />
          Offline — showing cached data
        </div>
      )}

      {/* Header */}
      <div style={{ padding: '16px', background: 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)' }}>
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-1 mb-3 text-xs"
          style={{ color: 'rgba(255,255,255,0.6)' }}
        >
          <ArrowLeft size={14} />
          Back
        </button>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          DAY {currentDay} OF {totalDays}
        </div>
        <h1 style={{ margin: '4px 0 0', fontSize: 22, fontWeight: 700, color: 'white' }}>{trip.title}</h1>
        {dateRange && (
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', marginTop: 4 }}>{dateRange}</div>
        )}
      </div>

      {/* Weather bar */}
      <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, background: 'var(--accent)' }}>
        {todayWeather ? (
          <>
            {getWeatherIcon(todayWeather.main)}
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--accent-text)' }}>
                {todayWeather.temp}°C · {todayWeather.main}
              </div>
              <div style={{ fontSize: 11, opacity: 0.7, color: 'var(--accent-text)' }}>
                {days[todayIndex]?.title || `Day ${currentDay}`}
              </div>
            </div>
          </>
        ) : weatherLoading ? (
          <div style={{ fontSize: 12, color: 'var(--accent-text)', opacity: 0.7 }}>Loading weather...</div>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--accent-text)', opacity: 0.7 }}>
            <Clock size={12} style={{ display: 'inline', marginRight: 4 }} />
            {days[todayIndex]?.title || `Day ${currentDay}`}
          </div>
        )}
      </div>

      {/* Current/Next place */}
      {currentPlaceInfo && (
        <div style={{ padding: '16px' }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-faint)', marginBottom: 8 }}>
            {currentPlaceInfo.status === 'current' ? 'NOW' : currentPlaceInfo.status === 'next' ? 'UP NEXT' : 'LAST'}
          </div>
          <div style={{ borderRadius: 12, padding: 16, background: 'var(--bg-card)', border: '1px solid var(--border-primary)', boxShadow: 'var(--shadow-card)' }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>{currentPlaceInfo.place.name}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
              {currentPlaceInfo.place.place_time && (
                <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                  <Clock size={12} />
                  {formatTime(currentPlaceInfo.place.place_time)}
                  {currentPlaceInfo.place.end_time && ` — ${formatTime(currentPlaceInfo.place.end_time)}`}
                </span>
              )}
              {currentPlaceInfo.place.category && (
                <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                  <MapPin size={12} />
                  {currentPlaceInfo.place.category.name}
                </span>
              )}
            </div>
            {currentPlaceInfo.place.lat && currentPlaceInfo.place.lng && (
              <a
                href={`https://www.google.com/maps/dir/?api=1&destination=${currentPlaceInfo.place.lat},${currentPlaceInfo.place.lng}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ marginTop: 12, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 8, background: '#0f172a', color: 'white', fontSize: 13, fontWeight: 600, textDecoration: 'none' }}
              >
                <Navigation size={14} />
                Navigate
                <ChevronRight size={14} />
              </a>
            )}
          </div>
        </div>
      )}

      {/* Today's timeline */}
      <div style={{ padding: '0 16px' }}>
        <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-faint)', marginBottom: 8, paddingTop: 8 }}>
          TODAY'S PLAN
        </div>
        {todayAssignments.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--text-muted)', padding: '12px 0' }}>No places planned for today.</p>
        ) : (
          todayAssignments.map(a => (
            <div
              key={a.id}
              style={{ display: 'flex', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--border-faint)' }}
            >
              <div style={{ fontSize: 11, color: 'var(--text-faint)', minWidth: 44, paddingTop: 2 }}>
                {a.place.place_time ? formatTime(a.place.place_time) : '--:--'}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{a.place.name}</div>
                {a.place.category && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{a.place.category.name}</div>
                )}
              </div>
              {a.place.lat && a.place.lng && (
                <a
                  href={`https://www.google.com/maps/dir/?api=1&destination=${a.place.lat},${a.place.lng}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--text-faint)', display: 'flex', alignItems: 'center' }}
                >
                  <ChevronRight size={16} />
                </a>
              )}
            </div>
          ))
        )}
      </div>

      {/* Flights */}
      {flights.length > 0 && (
        <div style={{ padding: '16px' }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-faint)', marginBottom: 12, paddingTop: 8 }}>
            FLIGHTS
          </div>
          {flights.map(f => {
            const depTime = f.reservation_time ? formatTime(f.reservation_time) : null
            return (
              <div key={f.id} style={{ marginBottom: 12, borderRadius: 12, padding: 16, background: '#1a3a5c', color: 'white' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontSize: 11, opacity: 0.7 }}>{f.airline || 'Airline'} · {f.flight_number}</div>
                    <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4 }}>
                      {f.departure_airport || '---'} → {f.arrival_airport || '---'}
                    </div>
                  </div>
                  {depTime && (
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 11, opacity: 0.7 }}>{depTime}</div>
                    </div>
                  )}
                </div>
                {f.confirmation_number && (
                  <div style={{ fontSize: 11, opacity: 0.7, marginTop: 8 }}>
                    Confirmation: {f.confirmation_number}
                  </div>
                )}
                {f.location && (
                  <div style={{ fontSize: 11, opacity: 0.7, marginTop: 4 }}>
                    <MapPin size={10} style={{ display: 'inline', marginRight: 3 }} />
                    {f.location}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Accommodations */}
      {accommodations.length > 0 && (
        <div style={{ padding: '16px' }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-faint)', marginBottom: 12, paddingTop: 8 }}>
            ACCOMMODATION
          </div>
          {accommodations.map(a => (
            <div key={a.id} style={{ marginBottom: 12, borderRadius: 12, padding: 16, background: 'var(--bg-card)', border: '1px solid var(--border-primary)', boxShadow: 'var(--shadow-card)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Hotel size={16} style={{ color: 'var(--text-muted)' }} />
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{a.place.name}</div>
              </div>
              {a.place.address && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, marginLeft: 24 }}>{a.place.address}</div>
              )}
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6, marginLeft: 24, display: 'flex', gap: 8 }}>
                {a.check_in && <span>Check-in: {formatDate(a.check_in)}</span>}
                {a.check_out && <span>Check-out: {formatDate(a.check_out)}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Tomorrow */}
      {tomorrowAssignments.length > 0 && (
        <details style={{ margin: '0 16px 16px' }}>
          <summary
            style={{ padding: '12px 0', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', listStyle: 'none', display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <ChevronRight size={14} className="chevron" style={{ transition: 'transform 0.2s' }} />
            TOMORROW — {days[todayIndex + 1]?.title || `Day ${currentDay + 1}`}
          </summary>
          <div style={{ paddingTop: 8 }}>
            {tomorrowAssignments.map(a => (
              <div
                key={a.id}
                style={{ display: 'flex', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border-faint)' }}
              >
                <div style={{ fontSize: 11, color: 'var(--text-faint)', minWidth: 44, paddingTop: 2 }}>
                  {a.place.place_time ? formatTime(a.place.place_time) : '--:--'}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{a.place.name}</div>
                  {a.place.category && (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{a.place.category.name}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </details>
      )}

      {/* Bottom padding */}
      <div style={{ height: 32 }} />

      <style>{`
        details[open] .chevron { transform: rotate(90deg); }
        details > summary::-webkit-details-marker { display: none; }
      `}</style>
    </div>
  )
}
