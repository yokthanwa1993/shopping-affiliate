import { useState, useRef, useEffect } from 'react'

interface Profile {
  id: string
  name: string
  proxy: string
  homepage?: string
  notes?: string
  tags?: string[]
  avatar_url?: string
  totp_secret?: string
  uid?: string
  username?: string
  password?: string
  datr?: string
}

interface CreateProfileModalProps {
  profile?: Profile
  onClose: () => void
  onSave: (data: Partial<Profile>, avatarFile?: File) => void | Promise<void>
  existingProfiles?: Array<{ id: string; name: string }>
}

const API_SERVER = import.meta.env.VITE_API_SERVER || 'https://browsersaving-worker.yokthanwa1993-bc9.workers.dev/api'
const API_BASE = API_SERVER.replace(/\/api$/, '') // Remove trailing /api only
const PRESET_TAG_OPTIONS = ['post', 'comment', 'mobile']

const normalizeTag = (value: string) => value.trim().toLowerCase()

// Helper to get full avatar URL
const getAvatarUrl = (avatarUrl?: string) => {
  if (!avatarUrl) return null
  if (avatarUrl.startsWith('http')) return avatarUrl
  return `${API_BASE}${avatarUrl}`
}

export function CreateProfileModal({ profile, onClose, onSave, existingProfiles = [] }: CreateProfileModalProps) {
  const [name, setName] = useState(profile?.name || '')
  const [proxy, setProxy] = useState(profile?.proxy || '')
  const [homepage, setHomepage] = useState(profile?.homepage || '')
  const [notes, setNotes] = useState(profile?.notes || '')
  const [selectedTag, setSelectedTag] = useState(() => {
    const normalizedTags = (profile?.tags || []).map(normalizeTag)
    return PRESET_TAG_OPTIONS.find((option) => normalizedTags.includes(option)) || ''
  })
  const [avatarUrl, setAvatarUrl] = useState(profile?.avatar_url || '')
  const [totpSecret, setTotpSecret] = useState(profile?.totp_secret || '')
  const [uid, setUid] = useState(profile?.uid || '')
  const [username, setUsername] = useState(profile?.username || '')
  const [password, setPassword] = useState(profile?.password || '')
  const [datr, setDatr] = useState(profile?.datr || '')
  const [uploading, setUploading] = useState(false)
  const [pendingAvatarFile, setPendingAvatarFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const totpInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const handleAvatarClick = () => {
    fileInputRef.current?.click()
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    // If editing existing profile, upload immediately
    if (profile?.id) {
      setUploading(true)
      try {
        const formData = new FormData()
        formData.append('avatar', file)

        const res = await fetch(`${API_SERVER}/avatar/${profile.id}`, {
          method: 'POST',
          body: formData
        })
        const data = await res.json()
        if (data.avatar) {
          setAvatarUrl(data.avatar)
        }
      } catch (err) {
        console.error('Upload failed:', err)
      } finally {
        setUploading(false)
      }
    } else {
      // For new profile, save file and show preview
      setPendingAvatarFile(file)
      const reader = new FileReader()
      reader.onload = (e) => {
        setPreviewUrl(e.target?.result as string)
      }
      reader.readAsDataURL(file)
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName || isDuplicateName) return

    const tags = selectedTag ? [selectedTag] : []

    // Get TOTP value from ref
    const totpValue = totpInputRef.current?.value?.trim() || ''

    console.log('📝 handleSubmit - totpInputRef.current:', totpInputRef.current)
    console.log('📝 handleSubmit - totpInputRef.current?.value:', totpInputRef.current?.value)
    console.log('📝 handleSubmit - totpValue:', totpValue)

    const data = {
      name: trimmedName,
      proxy,
      homepage: homepage || undefined,
      notes,
      tags: tags.length > 0 ? tags : [],
      avatar_url: avatarUrl || undefined,
      totp_secret: totpValue || undefined,
      uid: uid || null,
      username: username || undefined,
      password: password || undefined,
      datr: datr || undefined,
    }
    console.log('📝 handleSubmit - uid state:', uid)
    console.log('📝 handleSubmit - data:', JSON.stringify(data, null, 2))
    onSave(data, pendingAvatarFile || undefined)
  }

  const normalizedName = name.trim().toLowerCase()
  const isDuplicateName = normalizedName.length > 0 && existingProfiles.some((existingProfile) => {
    if (profile?.id && existingProfile.id === profile.id) {
      return false
    }
    return existingProfile.name.trim().toLowerCase() === normalizedName
  })
  const isSubmitDisabled = name.trim().length === 0 || isDuplicateName

  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{profile ? 'Edit Profile' : 'New Profile'}</h2>
        <form onSubmit={handleSubmit}>
          {/* Avatar Section */}
          <div className="form-group avatar-section">
            <label>Avatar</label>
            <div className="avatar-upload" onClick={handleAvatarClick}>
              {previewUrl ? (
                <img src={previewUrl} alt="Avatar" className="avatar-preview" />
              ) : avatarUrl ? (
                <img src={getAvatarUrl(avatarUrl)!} alt="Avatar" className="avatar-preview" />
              ) : (
                <div className="avatar-placeholder">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 8v8m-4-4h8" />
                  </svg>
                </div>
              )}
              {uploading && <div className="avatar-loading">Uploading...</div>}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              style={{ display: 'none' }}
            />
            <span className="avatar-hint">Click to upload</span>
          </div>

          <div className="form-group">
            <label>Profile Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Profile"
              className={isDuplicateName ? 'input-error' : ''}
            />
            {isDuplicateName && <span className="form-error">โปรไฟล์ซ้ำในระบบ</span>}
          </div>

          <div className="form-group">
            <label>Tag</label>
            <select
              className="tag-select"
              value={selectedTag}
              onChange={(e) => setSelectedTag(e.target.value)}
            >
              <option value="">Select tag...</option>
              {PRESET_TAG_OPTIONS.map((tag) => (
                <option key={tag} value={tag}>{tag}</option>
              ))}
            </select>
              <span className="form-hint">Allowed values: post, comment, mobile</span>
          </div>

          <div className="form-group">
            <label>Proxy</label>
            <input
              type="text"
              value={proxy}
              onChange={(e) => setProxy(e.target.value)}
              placeholder="host:port or socks5://user:pass@host:port"
            />
            <span className="form-hint">รองรับ `socks5://user:pass@host:port` สำหรับ SOCKS5 ที่มี auth</span>
          </div>

          <div className="form-group">
            <label>Homepage</label>
            <input
              type="text"
              value={homepage}
              onChange={(e) => setHomepage(e.target.value)}
              placeholder="https://facebook.com"
            />
          </div>

          <div className="form-group">
            <label>UID (Facebook User ID)</label>
            <input
              type="text"
              value={uid}
              onChange={(e) => setUid(e.target.value)}
              placeholder="100078045158984"
            />
            <span className="form-hint">Facebook numeric User ID</span>
          </div>

          <div className="form-group">
            <label>Email</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="user@example.com"
            />
          </div>

          <div className="form-group">
            <label>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>

          <div className="form-group">
            <label>DATR Cookie</label>
            <input
              type="text"
              value={datr}
              onChange={(e) => setDatr(e.target.value)}
              placeholder="datr value"
            />
            <span className="form-hint">Optional but recommended for stable Facebook login</span>
          </div>

          <div className="form-group">
            <label>Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Any notes about this profile..."
            />
          </div>

          <div className="form-group">
            <label>2FA Secret (TOTP)</label>
            <input
              ref={totpInputRef}
              type="text"
              defaultValue={profile?.totp_secret || ''}
              placeholder="XXXX XXXX XXXX XXXX (Base32)"
            />
            <span className="form-hint">Enter your 2FA secret key to generate 6-digit codes</span>
          </div>

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={isSubmitDisabled}>
              {profile ? 'Save Changes' : 'Create Profile'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
