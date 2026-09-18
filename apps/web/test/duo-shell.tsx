// Production shell with browser-only native-platform detection. Tests supply
// synthetic API responses; no device bridge or personal server is contacted.
import { Capacitor } from '@capacitor/core';
import { createRoot } from 'react-dom/client';
import App from '../src/App';
import { markNativePlatform } from '../src/native';
import '../src/styles.css';

Capacitor.isNativePlatform = () => true;
Capacitor.getPlatform = () => 'ios';
Capacitor.isPluginAvailable = () => false;
localStorage.setItem('operalibre.serverUrl', location.origin);
localStorage.setItem('operalibre.serverType', 'operalibre');
markNativePlatform();
createRoot(document.getElementById('root')!).render(<App />);
