export interface DashboardAdminStat {
  telegram_id: string
  email: string
  display_name?: string
  picture_url?: string
  line_user_id?: string
  links: number
}

export interface DashboardData {
  date: string
  totals: {
    posts_all: number
    posts_on_date: number
    links_all: number
    links_on_date: number
  }
  admins: DashboardAdminStat[]
}

export interface InboxVideo {
  id: string
  namespace_id?: string
  importedFromNamespaceId?: string
  duplicateNamespaceIds?: string[]
  dedupedFromOtherNamespace?: boolean
  videoUrl?: string
  previewUrl?: string
  originalUrl?: string
  thumbnailUrl?: string
  fallbackThumbnailUrl?: string
  createdAt: string
  processedAt?: string
  updatedAt?: string
  status: string
  sourceType?: string
  sourceLabel?: string
  shopeeLink?: string
  lazadaLink?: string
  hasShopeeLink?: boolean
  hasLazadaLink?: boolean
  readyToProcess?: boolean
  canStartProcessing?: boolean
  canDelete?: boolean
}
