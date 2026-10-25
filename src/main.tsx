import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import PhoneCapturePage from './live/PhoneCapturePage';
import './styles.css';
import './theme.css';

// Phones open /live/<session> from the QR code. That page is separate from the hash-routed app.
const isPhoneCapture = window.location.pathname.startsWith('/live/');

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode>{isPhoneCapture ? <PhoneCapturePage /> : <App />}</React.StrictMode>);
