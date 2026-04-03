import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AppRouter } from './app/AppRouter.tsx'
import { isAppHost } from './liffConfig'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isAppHost() ? <AppRouter /> : <App />}
  </StrictMode>,
)
