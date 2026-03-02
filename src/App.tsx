import { useState, useCallback, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import TranscriptionView from './components/TranscriptionView';
import SpeakerIdView from './components/SpeakerIdView';
import SettingsView from './components/SettingsView';
import LLMView from './components/LLMView';
import './index.css';

type View = 'transcription' | 'speakers' | 'llm' | 'settings';

export interface TranscriptionResultData {
  audioPath: string; // The original or temporary path actually used by whisperx
  outputDir: string;
  baseName: string;
  diarize: boolean;
}

function App() {
  const [activeView, setActiveView] = useState<View>('transcription');
  const [lastResult, setLastResult] = useState<TranscriptionResultData | null>(null);
  const [transcriptionRefreshKey, setTranscriptionRefreshKey] = useState(0);

  // Clean up stale whisperx temp directories on app startup
  useEffect(() => {
    invoke('cleanup_whisperx_temp', { excludeDir: null }).catch(console.error);
  }, []);

  // Clear old state when a new transcription starts
  const handleTranscriptionStart = useCallback(() => {
    setLastResult(null);
  }, []);

  const handleTranscriptionComplete = useCallback(
    (data: TranscriptionResultData) => {
      setLastResult(data);
      // Auto-navigate to speakers tab if diarization was enabled
      if (data.diarize) {
        setActiveView('speakers');
      }
    },
    []
  );

  const handleNamesApplied = useCallback(() => {
    setTranscriptionRefreshKey((k) => k + 1);
  }, []);

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="app-logo">
          <div className="app-logo-icon" style={{ background: 'transparent' }}>
            <img src="/icon.png" alt="Logo" style={{ width: '100%', height: '100%', objectFit: 'contain', borderRadius: '4px' }} />
          </div>
          <span className="app-logo-text">Simple AI WhisperX GUI</span>
        </div>

        <nav className="nav-tabs">
          <button
            className={`nav-tab ${activeView === 'transcription' ? 'active' : ''}`}
            onClick={() => setActiveView('transcription')}
          >
            <span className="nav-tab-icon">🎙️</span>
            Transcription
          </button>
          <button
            className={`nav-tab ${activeView === 'speakers' ? 'active' : ''}`}
            onClick={() => setActiveView('speakers')}
          >
            <span className="nav-tab-icon">🎭</span>
            Speakers
            {lastResult?.diarize && <span className="nav-tab-dot" />}
          </button>
          <button
            className={`nav-tab ${activeView === 'llm' ? 'active' : ''}`}
            onClick={() => setActiveView('llm')}
          >
            <span className="nav-tab-icon">🤖</span>
            LLM Summary
          </button>
          <button
            className={`nav-tab ${activeView === 'settings' ? 'active' : ''}`}
            onClick={() => setActiveView('settings')}
          >
            <span className="nav-tab-icon">⚙️</span>
            Settings
          </button>
        </nav>
      </header>

      <main className="main-content">
        <div style={{ display: activeView === 'transcription' ? 'block' : 'none' }}>
          <TranscriptionView
            onTranscriptionComplete={handleTranscriptionComplete}
            onTranscriptionStart={handleTranscriptionStart}
            refreshKey={transcriptionRefreshKey}
          />
        </div>
        <div style={{ display: activeView === 'speakers' ? 'block' : 'none' }}>
          <SpeakerIdView
            lastResult={lastResult}
            onNamesApplied={handleNamesApplied}
          />
        </div>
        <div style={{ display: activeView === 'llm' ? 'block' : 'none' }}>
          <LLMView
            lastResult={lastResult}
            refreshKey={transcriptionRefreshKey}
          />
        </div>
        <div style={{ display: activeView === 'settings' ? 'block' : 'none' }}>
          <SettingsView />
        </div>
      </main>
    </div>
  );
}

export default App;
