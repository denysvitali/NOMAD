import React, { useEffect, useState } from 'react'
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuthStore } from './store/authStore'
import { useSettingsStore } from './store/settingsStore'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
import DashboardPage from './pages/DashboardPage'
import TripPlannerPage from './pages/TripPlannerPage'
import CompanionPage from './pages/CompanionPage'
// PhotosPage removed - replaced by Finanzplan
import FilesPage from './pages/FilesPage'
import AdminPage from './pages/AdminPage'
import SettingsPage from './pages/SettingsPage'
import VacayPage from './pages/VacayPage'
import AtlasPage from './pages/AtlasPage'
import { ToastContainer, useToast } from './components/shared/Toast'
import { TranslationProvider, useTranslation } from './i18n'
import DemoBanner from './components/Layout/DemoBanner'
import { authApi } from './api/client'
import { addListener, removeListener } from './api/websocket'
import BriefingsPanel from './components/shared/BriefingsPanel'

function ProtectedRoute({ children, adminRequired = false }) {
  const { isAuthenticated, user, isLoading } = useAuthStore()
  const { t } = useTranslation()

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-4 border-slate-200 border-t-slate-900 rounded-full animate-spin"></div>
          <p className="text-slate-500 text-sm">{t('common.loading')}</p>
        </div>
      </div>
    )
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }

  if (adminRequired && user && user.role !== 'admin') {
    return <Navigate to="/dashboard" replace />
  }

  return children
}

function RootRedirect() {
  const { isAuthenticated, isLoading } = useAuthStore()

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="w-10 h-10 border-4 border-slate-200 border-t-slate-900 rounded-full animate-spin"></div>
      </div>
    )
  }

  return <Navigate to={isAuthenticated ? '/dashboard' : '/login'} replace />
}

export default function App() {
  const { loadUser, token, isAuthenticated, demoMode, setDemoMode, setHasMapsKey } = useAuthStore()
  const { loadSettings } = useSettingsStore()
  const toast = useToast()
  const navigate = useNavigate()
  const [pendingBriefings, setPendingBriefings] = useState([])

  // WebSocket listener for trip briefings
  useEffect(() => {
    function handleMessage(data) {
      if (data.type === 'trip_briefing') {
        const { tripId, briefing } = data
        setPendingBriefings(prev => {
          // Avoid duplicates
          const exists = prev.some(b => b.tripId === tripId)
          if (exists) return prev
          return [...prev, { tripId, briefing, receivedAt: new Date() }]
        })
        // Show toast notification
        const tripTitle = briefing?.trip?.title || 'Your trip'
        toast.info(`Your briefing for "${tripTitle}" is ready!`)
      }
    }
    addListener(handleMessage)
    return () => removeListener(handleMessage)
  }, [])

  // Dismiss a briefing (mark as viewed/removed)
  const handleDismissBriefing = (tripId) => {
    setPendingBriefings(prev => prev.filter(b => b.tripId !== tripId))
  }

  useEffect(() => {
    if (token) {
      loadUser()
    }
    authApi.getAppConfig().then(config => {
      if (config?.demo_mode) setDemoMode(true)
      if (config?.has_maps_key !== undefined) setHasMapsKey(config.has_maps_key)
    }).catch(() => {})
  }, [])

  const { settings } = useSettingsStore()

  useEffect(() => {
    if (isAuthenticated) {
      loadSettings()
    }
  }, [isAuthenticated])

  // Apply dark mode class to <html> + update PWA theme-color
  useEffect(() => {
    const mode = settings.dark_mode
    const applyDark = (isDark) => {
      document.documentElement.classList.toggle('dark', isDark)
      const meta = document.querySelector('meta[name="theme-color"]')
      if (meta) meta.setAttribute('content', isDark ? '#09090b' : '#ffffff')
    }

    if (mode === 'auto') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      applyDark(mq.matches)
      const handler = (e) => applyDark(e.matches)
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    }
    // Support legacy boolean + new string values
    applyDark(mode === true || mode === 'dark')
  }, [settings.dark_mode])

  return (
    <TranslationProvider>
      <ToastContainer />
      <Routes>
        <Route path="/" element={<RootRedirect />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<Navigate to="/login" replace />} />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <DashboardPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/trips/:id"
          element={
            <ProtectedRoute>
              <TripPlannerPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/trip/:id/companion"
          element={
            <ProtectedRoute>
              <CompanionPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/trips/:id/files"
          element={
            <ProtectedRoute>
              <FilesPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin"
          element={
            <ProtectedRoute adminRequired>
              <AdminPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/settings"
          element={
            <ProtectedRoute>
              <SettingsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/vacay"
          element={
            <ProtectedRoute>
              <VacayPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/atlas"
          element={
            <ProtectedRoute>
              <AtlasPage />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <BriefingsPanel pendingBriefings={pendingBriefings} onDismiss={handleDismissBriefing} />
    </TranslationProvider>
  )
}
