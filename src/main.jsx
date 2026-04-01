import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import Companion from './Companion'
import OPD from './OPD'

// Simple path-based routing — no react-router needed
const path = window.location.pathname;
const isCompanion = path.startsWith('/companion');
const isOPD = path.startsWith('/opd');

ReactDOM.createRoot(document.getElementById('root')).render(
  isCompanion ? <Companion /> : isOPD ? <OPD /> : <App />
)
