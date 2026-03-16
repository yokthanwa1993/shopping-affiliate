import { useState, useEffect, useRef } from 'react'
import { desktopInvoke, isDesktopApp } from '../desktopBridge'
import './DebugConsole.css'

interface Profile {
  id: string
  name: string
}

interface NetworkLog {
  method: string
  url: string
  status?: number
  timestamp: number
}

interface ConsoleLog {
  level: string
  text: string
  timestamp: number
}

interface CookieInfo {
  name: string
  value: string
  domain: string
}

interface DebugConsoleProps {
  profile: Profile
  onClose: () => void
}

export function DebugConsole({ profile, onClose }: DebugConsoleProps) {
  const [activeTab, setActiveTab] = useState<'network' | 'console' | 'cookies'>('network')
  const [networkLogs, setNetworkLogs] = useState<NetworkLog[]>([])
  const [consoleLogs, setConsoleLogs] = useState<ConsoleLog[]>([])
  const [cookies, setCookies] = useState<CookieInfo[]>([])
  const [autoRefresh, setAutoRefresh] = useState(true)
  const logsEndRef = useRef<HTMLDivElement>(null)

  // Fetch logs
  useEffect(() => {
    if (!autoRefresh || !isDesktopApp()) return

    const fetchLogs = async () => {
      try {
        const data = await desktopInvoke('get_debug_logs', { profileId: profile.id }) as {
          network: NetworkLog[]
          console: ConsoleLog[]
          cookies: CookieInfo[]
        }
        setNetworkLogs(data.network || [])
        setConsoleLogs(data.console || [])
        setCookies(data.cookies || [])
      } catch (err) {
        console.error('Failed to fetch debug logs:', err)
      }
    }

    fetchLogs()
    const interval = setInterval(fetchLogs, 500)
    return () => clearInterval(interval)
  }, [profile.id, autoRefresh])

  // Auto scroll
  useEffect(() => {
    if (autoRefresh && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [networkLogs, consoleLogs, autoRefresh])

  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString('en-US', { 
      hour12: false, 
      hour: '2-digit', 
      minute: '2-digit', 
      second: '2-digit'
    })
  }

  const clearLogs = async () => {
    // Clear local state
    if (activeTab === 'network') setNetworkLogs([])
    else if (activeTab === 'console') setConsoleLogs([])
  }

  const downloadLogs = () => {
    let data: string
    let filename: string
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')
    const safeName = profile.name.replace(/[^a-zA-Z0-9]/g, '_')

    if (activeTab === 'network') {
      if (networkLogs.length === 0) {
        alert('No network logs to download')
        return
      }
      data = JSON.stringify(networkLogs, null, 2)
      filename = `network-${safeName}-${timestamp}.json`
    } else if (activeTab === 'console') {
      if (consoleLogs.length === 0) {
        alert('No console logs to download')
        return
      }
      data = JSON.stringify(consoleLogs, null, 2)
      filename = `console-${safeName}-${timestamp}.json`
    } else {
      if (cookies.length === 0) {
        alert('No cookies to download')
        return
      }
      data = JSON.stringify(cookies, null, 2)
      filename = `cookies-${safeName}-${timestamp}.json`
    }

    const blob = new Blob([data], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  return (
    <div className="debug-console">
      {/* Header */}
      <div className="console-header">
        <div className="console-title">
          <h1>Debug Console</h1>
          <span className="profile-badge">{profile.name}</span>
        </div>
        <div className="header-actions">
          <label className="toggle-label">
            <input 
              type="checkbox" 
              checked={autoRefresh} 
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            <span className="toggle-switch"></span>
            Auto-refresh
          </label>
          <button className="stop-debug-btn" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="2"/>
            </svg>
            Stop Debug
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="console-tabs">
        <button 
          className={`tab-btn ${activeTab === 'network' ? 'active' : ''}`}
          onClick={() => setActiveTab('network')}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
          </svg>
          Network
          <span className="tab-count">{networkLogs.length}</span>
        </button>
        <button 
          className={`tab-btn ${activeTab === 'console' ? 'active' : ''}`}
          onClick={() => setActiveTab('console')}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="4 17 10 11 4 5"/>
            <line x1="12" y1="19" x2="20" y2="19"/>
          </svg>
          Console
          <span className="tab-count">{consoleLogs.length}</span>
        </button>
        <button 
          className={`tab-btn ${activeTab === 'cookies' ? 'active' : ''}`}
          onClick={() => setActiveTab('cookies')}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/>
            <circle cx="8" cy="9" r="1.5" fill="currentColor"/>
            <circle cx="15" cy="8" r="1" fill="currentColor"/>
            <circle cx="10" cy="14" r="1.5" fill="currentColor"/>
            <circle cx="16" cy="13" r="1" fill="currentColor"/>
          </svg>
          Cookies
          <span className="tab-count">{cookies.length}</span>
        </button>
        
        <button className="download-btn" onClick={downloadLogs}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          Download
        </button>
        <button className="clear-btn" onClick={clearLogs}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
          Clear
        </button>
      </div>

      {/* Content */}
      <div className="console-content">
        {activeTab === 'network' && (
          <div className="log-list">
            {networkLogs.length === 0 ? (
              <div className="empty-state">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
                </svg>
                <p>No network requests yet</p>
                <span>Browse in the debug window to see activity</span>
              </div>
            ) : (
              networkLogs.slice().reverse().map((log, i) => (
                <div key={i} className={`log-item network ${log.status && log.status >= 400 ? 'error' : ''}`}>
                  <span className="log-time">{formatTime(log.timestamp)}</span>
                  <span className={`log-method ${log.method}`}>{log.method}</span>
                  <span className={`log-status ${log.status && log.status >= 400 ? 'error' : 'ok'}`}>
                    {log.status || '...'}
                  </span>
                  <span className="log-url" title={log.url}>{log.url}</span>
                </div>
              ))
            )}
            <div ref={logsEndRef} />
          </div>
        )}

        {activeTab === 'console' && (
          <div className="log-list">
            {consoleLogs.length === 0 ? (
              <div className="empty-state">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <polyline points="4 17 10 11 4 5"/>
                  <line x1="12" y1="19" x2="20" y2="19"/>
                </svg>
                <p>No console logs yet</p>
                <span>Console output will appear here</span>
              </div>
            ) : (
              consoleLogs.slice().reverse().map((log, i) => (
                <div key={i} className={`log-item console ${log.level}`}>
                  <span className="log-time">{formatTime(log.timestamp)}</span>
                  <span className={`log-level ${log.level}`}>{log.level.toUpperCase()}</span>
                  <span className="log-text">{log.text}</span>
                </div>
              ))
            )}
            <div ref={logsEndRef} />
          </div>
        )}

        {activeTab === 'cookies' && (
          <div className="log-list cookies-list">
            {cookies.length === 0 ? (
              <div className="empty-state">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="12" cy="12" r="10"/>
                  <circle cx="8" cy="9" r="1.5" fill="currentColor"/>
                  <circle cx="15" cy="8" r="1" fill="currentColor"/>
                  <circle cx="10" cy="14" r="1.5" fill="currentColor"/>
                </svg>
                <p>No cookies found</p>
                <span>Cookies will appear after page loads</span>
              </div>
            ) : (
              cookies.map((cookie, i) => (
                <div key={i} className="log-item cookie">
                  <span className="cookie-name">{cookie.name}</span>
                  <span className="cookie-domain">{cookie.domain}</span>
                  <span className="cookie-value" title={cookie.value}>{cookie.value}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Status Bar */}
      <div className="console-statusbar">
        <span className={autoRefresh ? 'status-live' : ''}>
          {autoRefresh ? '● Live' : '○ Paused'}
        </span>
        <span className="status-separator">|</span>
        <span>
          {activeTab === 'network' && `${networkLogs.length} requests`}
          {activeTab === 'console' && `${consoleLogs.length} logs`}
          {activeTab === 'cookies' && `${cookies.length} cookies`}
        </span>
      </div>
    </div>
  )
}
