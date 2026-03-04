import { useState, useEffect, useCallback } from 'react'

interface LogViewerProps {
  profileId: string
  onClose: () => void
}

// Check if running in Electron
const isElectron = typeof window !== 'undefined' && (window as any).electronAPI !== undefined

async function getLogs(profileId: string): Promise<string> {
  if (isElectron) {
    return (window as any).electronAPI.getLogs(profileId)
  }
  // Browser mode - use API
  try {
    const res = await fetch(`/api/profiles/${profileId}/logs`)
    const data = await res.json()
    return data.logs || ''
  } catch (error) {
    console.error('Failed to fetch logs:', error)
    return ''
  }
}

async function clearLogs(profileId: string): Promise<boolean> {
  if (isElectron) {
    return (window as any).electronAPI.clearLogs(profileId)
  }
  // Browser mode - use API
  try {
    await fetch(`/api/profiles/${profileId}/logs`, { method: 'DELETE' })
    return true
  } catch (error) {
    console.error('Failed to clear logs:', error)
    return false
  }
}

export function LogViewer({ profileId, onClose }: LogViewerProps) {
  const [logs, setLogs] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(true)

  const loadLogs = useCallback(async () => {
    try {
      const data = await getLogs(profileId)
      setLogs(data)
    } catch (error) {
      console.error('Failed to load logs:', error)
    }
  }, [profileId])

  const handleClearLogs = async () => {
    try {
      await clearLogs(profileId)
      setLogs('')
    } catch (error) {
      console.error('Failed to clear logs:', error)
    }
  }

  useEffect(() => {
    loadLogs()

    if (autoRefresh) {
      const interval = setInterval(loadLogs, 2000)
      return () => clearInterval(interval)
    }
  }, [loadLogs, autoRefresh])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '700px' }}>
        <div className="log-header">
          <h2>Console Logs</h2>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <label style={{ fontSize: '14px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
              />
              Auto-refresh
            </label>
            <button className="btn btn-ghost btn-sm" onClick={loadLogs}>
              Refresh
            </button>
            <button className="btn btn-danger btn-sm" onClick={handleClearLogs}>
              Clear
            </button>
          </div>
        </div>

        <div className="log-viewer">
          {logs || 'No logs yet. Launch the browser and interact with pages to see console output.'}
        </div>

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
