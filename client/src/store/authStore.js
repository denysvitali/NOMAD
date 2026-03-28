import { create } from 'zustand'
import { authApi } from '../api/client'
import { connect, disconnect } from '../api/websocket'

export const useAuthStore = create((set, get) => ({
  user: null,
  token: localStorage.getItem('auth_token') || null,
  isAuthenticated: !!localStorage.getItem('auth_token'),
  isLoading: false,
  error: null,
  demoMode: localStorage.getItem('demo_mode') === 'true',
  hasMapsKey: false,

  login: async (email, password) => {
    set({ isLoading: true, error: null })
    try {
      const data = await authApi.login({ email, password })
      localStorage.setItem('auth_token', data.token)
      set({
        user: data.user,
        token: data.token,
        isAuthenticated: true,
        isLoading: false,
        error: null,
      })
      connect(data.token)
      return data
    } catch (err) {
      const error = err.response?.data?.error || 'Login failed'
      set({ isLoading: false, error })
      throw new Error(error)
    }
  },

  register: async (username, email, password) => {
    set({ isLoading: true, error: null })
    try {
      const data = await authApi.register({ username, email, password })
      localStorage.setItem('auth_token', data.token)
      set({
        user: data.user,
        token: data.token,
        isAuthenticated: true,
        isLoading: false,
        error: null,
      })
      connect(data.token)
      return data
    } catch (err) {
      const error = err.response?.data?.error || 'Registration failed'
      set({ isLoading: false, error })
      throw new Error(error)
    }
  },

  logout: async () => {
    disconnect()
    const token = localStorage.getItem('auth_token')
    if (token) {
      try {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` }
        })
      } catch {}
    }
    localStorage.removeItem('auth_token')
    if ('caches' in window) {
      caches.keys().then(names => {
        names.forEach(name => {
          if (name.startsWith('api-')) caches.delete(name)
        })
      })
    }
    set({
      user: null,
      token: null,
      isAuthenticated: false,
      error: null,
    })
  },

  loadUser: async () => {
    const token = get().token
    if (!token) {
      set({ isLoading: false })
      return
    }
    set({ isLoading: true })
    try {
      const data = await authApi.me()
      set({
        user: data.user,
        isAuthenticated: true,
        isLoading: false,
      })
      connect(token)
    } catch (err) {
      localStorage.removeItem('auth_token')
      set({
        user: null,
        token: null,
        isAuthenticated: false,
        isLoading: false,
      })
    }
  },

  updateMapsKey: async (key) => {
    try {
      await authApi.updateMapsKey(key)
      set(state => ({
        user: { ...state.user, maps_api_key: key || null }
      }))
    } catch (err) {
      throw new Error(err.response?.data?.error || 'Error saving API key')
    }
  },

  updateApiKeys: async (keys) => {
    try {
      const data = await authApi.updateApiKeys(keys)
      set({ user: data.user })
    } catch (err) {
      throw new Error(err.response?.data?.error || 'Error saving API keys')
    }
  },

  updateProfile: async (profileData) => {
    try {
      const data = await authApi.updateSettings(profileData)
      set({ user: data.user })
    } catch (err) {
      throw new Error(err.response?.data?.error || 'Error updating profile')
    }
  },

  uploadAvatar: async (file) => {
    const formData = new FormData()
    formData.append('avatar', file)
    const data = await authApi.uploadAvatar(formData)
    set(state => ({ user: { ...state.user, avatar_url: data.avatar_url } }))
    return data
  },

  deleteAvatar: async () => {
    await authApi.deleteAvatar()
    set(state => ({ user: { ...state.user, avatar_url: null } }))
  },

  setDemoMode: (val) => {
    if (val) localStorage.setItem('demo_mode', 'true')
    else localStorage.removeItem('demo_mode')
    set({ demoMode: val })
  },

  setHasMapsKey: (val) => set({ hasMapsKey: val }),

  demoLogin: async () => {
    set({ isLoading: true, error: null })
    try {
      const data = await authApi.demoLogin()
      localStorage.setItem('auth_token', data.token)
      set({
        user: data.user,
        token: data.token,
        isAuthenticated: true,
        isLoading: false,
        demoMode: true,
        error: null,
      })
      connect(data.token)
      return data
    } catch (err) {
      const error = err.response?.data?.error || 'Demo login failed'
      set({ isLoading: false, error })
      throw new Error(error)
    }
  },
}))
