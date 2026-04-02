import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react'

export function useViewerHistory(expanded: boolean, setExpanded: Dispatch<SetStateAction<boolean>>) {
  const pushedViewerHistoryRef = useRef(false)
  const closingFromPopStateRef = useRef(false)

  useEffect(() => {
    if (!expanded) return

    const currentState = window.history.state
    const nextState = currentState && typeof currentState === 'object'
      ? { ...currentState, __viewer_overlay: true }
      : { __viewer_overlay: true }

    closingFromPopStateRef.current = false
    window.history.pushState(nextState, '', window.location.href)
    pushedViewerHistoryRef.current = true

    const handlePopState = () => {
      if (!pushedViewerHistoryRef.current) return
      closingFromPopStateRef.current = true
      pushedViewerHistoryRef.current = false
      setExpanded(false)
    }

    window.addEventListener('popstate', handlePopState)
    return () => {
      window.removeEventListener('popstate', handlePopState)
      if (pushedViewerHistoryRef.current && !closingFromPopStateRef.current) {
        pushedViewerHistoryRef.current = false
        window.history.back()
      }
      closingFromPopStateRef.current = false
    }
  }, [expanded, setExpanded])
}
