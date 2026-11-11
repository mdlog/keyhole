import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import { DataProvider } from './data/DataContext'
import './styles.css'

// A hash router: GitHub Pages serves one file, so deep links live after the #.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <DataProvider>
        <App />
      </DataProvider>
    </HashRouter>
  </React.StrictMode>,
)
