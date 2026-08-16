import React, { useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import AppRoutes from './app/routes'
import './styles/index.css'
import 'leaflet/dist/leaflet.css'
import Navbar from './shared/components/Navbar'
import { useDarkMode } from './shared/hooks/useDarkMode'
import AuraModal from './features/ai-assistant/components/AuraModal'
import { LanguageProvider } from './shared/context/LanguageContext'
import TicketScanPage from './features/boarding-pass/pages/TicketScanPage'
import axios from 'axios';

// Centralize API configuration for production Android/Capacitor packaging
const API_BASE_URL = import.meta.env.VITE_API_URL || '';

// Only apply the full URL in production; keep using the Vite proxy in development
if (import.meta.env.PROD) {
  axios.defaults.baseURL = API_BASE_URL;
  
  const originalFetch = window.fetch;
  window.fetch = async (input, init) => {
    if (typeof input === 'string' && input.startsWith('/api')) {
      input = API_BASE_URL + input;
    }
    return originalFetch(input, init);
  };
}

function AppContent() {
  const [auraOpen, setAuraOpen] = useState(false)
  const [isTicketScanned, setIsTicketScanned] = useState(() => {
    return sessionStorage.getItem('ticketScanned') === 'true'
  })

  useEffect(() => {
    const handleOpen = () => setAuraOpen(true)
    const handleClose = () => setAuraOpen(false)

    const handleTicketScanned = () => {
      setIsTicketScanned(true)
    }

    const handleResetScan = () => {
      sessionStorage.removeItem('ticketScanned')
      setIsTicketScanned(false)
    }

    window.addEventListener('aura-open-event', handleOpen)
    window.addEventListener('aura-close-event', handleClose)
    window.addEventListener('ticket-scanned-event', handleTicketScanned)
    window.addEventListener('ticket-rescan-event', handleResetScan)

    return () => {
      window.removeEventListener('aura-open-event', handleOpen)
      window.removeEventListener('aura-close-event', handleClose)
      window.removeEventListener('ticket-scanned-event', handleTicketScanned)
      window.removeEventListener('ticket-rescan-event', handleResetScan)
    }
  }, [])

  // Step 1: Render Ticket Scanner exclusively first if ticket has not been scanned yet
  if (!isTicketScanned) {
    return (
      <TicketScanPage
        onScanComplete={() => {
          setIsTicketScanned(true)
        }}
      />
    )
  }

  // Step 2: Render full Navbar and App routes after ticket scanning
  return (
    <>
      <Navbar />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 pb-28 lg:pb-12 text-[#F8FAFC]">
        <AppRoutes />
      </div>
      <AuraModal
        open={auraOpen}
        onClose={() => {
          setAuraOpen(false)
          window.dispatchEvent(new Event('aura-close-event'))
        }}
      />
    </>
  )
}

function App() {
  useDarkMode()

  return (
    <LanguageProvider>
      <BrowserRouter>
        <AppContent />
      </BrowserRouter>
    </LanguageProvider>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
