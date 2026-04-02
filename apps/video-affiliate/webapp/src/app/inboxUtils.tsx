import type { InboxVideo } from './sharedTypes'

export function isInboxVideoOwnedByCurrentNamespace(video: InboxVideo, currentNamespaceId?: string): boolean {
  const videoNamespaceId = String(video.namespace_id || '').trim()
  const namespaceId = String(currentNamespaceId || '').trim()
  return !!videoNamespaceId && !!namespaceId && videoNamespaceId === namespaceId
}

export function compareInboxVideosForSystemView(a: InboxVideo, b: InboxVideo, currentNamespaceId?: string): number {
  void currentNamespaceId
  const aTs = new Date(String(a.createdAt || a.updatedAt || '')).getTime()
  const bTs = new Date(String(b.createdAt || b.updatedAt || '')).getTime()
  return (Number.isFinite(bTs) ? bTs : 0) - (Number.isFinite(aTs) ? aTs : 0)
}

export function parseImportedNamespaceIdFromSourceLabel(sourceLabel?: string): string | undefined {
  const label = String(sourceLabel || '').trim()
  if (!label) return undefined
  const match = label.match(/imported from\s+([A-Za-z0-9_:-]+)/i)
  const importedNamespaceId = String(match?.[1] || '').trim()
  return importedNamespaceId || undefined
}

export function dedupeSystemInboxVideos(videos: InboxVideo[], currentNamespaceId?: string): InboxVideo[] {
  const namespaceId = String(currentNamespaceId || '').trim()
  const groups = new Map<string, InboxVideo[]>()

  for (const video of videos) {
    const videoId = String(video.id || '').trim()
    if (!videoId) continue
    const items = groups.get(videoId) || []
    items.push(video)
    groups.set(videoId, items)
  }

  return Array.from(groups.values())
    .map((items) => {
      const sortedItems = items
        .slice()
        .sort((a, b) => compareInboxVideosForSystemView(a, b, namespaceId))
      const preferredOwnVideo = namespaceId
        ? sortedItems.find((item) => isInboxVideoOwnedByCurrentNamespace(item, namespaceId))
        : undefined
      const selected = preferredOwnVideo || sortedItems[0]
      const namespaceIds = Array.from(new Set(
        sortedItems
          .map((item) => String(item.namespace_id || '').trim())
          .filter(Boolean)
      ))
      const fallbackThumbVideo = sortedItems.find((item) => !!String(item.thumbnailUrl || '').trim())
      const fallbackPlaybackVideo = sortedItems.find((item) => (
        !!String(item.originalUrl || '').trim()
        || !!String(item.previewUrl || '').trim()
        || !!String(item.videoUrl || '').trim()
      ))
      const selectedNamespaceId = String(selected.namespace_id || '').trim()
      const importedFromNamespaceId = String(
        selected.importedFromNamespaceId
        || parseImportedNamespaceIdFromSourceLabel(selected.sourceLabel)
        || namespaceIds.find((id) => id && id !== selectedNamespaceId)
        || ''
      ).trim() || undefined

      return {
        ...selected,
        thumbnailUrl: String(selected.thumbnailUrl || fallbackThumbVideo?.thumbnailUrl || '').trim() || undefined,
        originalUrl: String(selected.originalUrl || fallbackPlaybackVideo?.originalUrl || '').trim() || undefined,
        previewUrl: String(selected.previewUrl || fallbackPlaybackVideo?.previewUrl || '').trim() || undefined,
        videoUrl: String(selected.videoUrl || fallbackPlaybackVideo?.videoUrl || '').trim() || undefined,
        importedFromNamespaceId,
        duplicateNamespaceIds: namespaceIds,
        dedupedFromOtherNamespace: !!(
          importedFromNamespaceId
          && isInboxVideoOwnedByCurrentNamespace(selected, namespaceId)
        ),
      } satisfies InboxVideo
    })
    .sort((a, b) => compareInboxVideosForSystemView(a, b, namespaceId))
}

export function getInboxVideoIdentityKey(id: string, namespaceId?: string): string {
  const normalizedId = String(id || '').trim()
  const normalizedNamespaceId = String(namespaceId || '').trim()
  return normalizedNamespaceId ? `${normalizedNamespaceId}:${normalizedId}` : normalizedId
}

export function InboxOwnershipIcon({
  own,
  className = '',
}: {
  own: boolean
  className?: string
}) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.1"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {own ? (
        <>
          <path d="M3 10.5 12 3l9 7.5" />
          <path d="M5 9.5V20h14V9.5" />
          <path d="M9 20v-5.5h6V20" />
        </>
      ) : (
        <>
          <path d="m12 3-8 4 8 4 8-4-8-4Z" />
          <path d="m4 12 8 4 8-4" />
          <path d="m4 17 8 4 8-4" />
        </>
      )}
    </svg>
  )
}
