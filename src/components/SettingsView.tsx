import { useState, useEffect, useCallback } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { open as openUrl } from '@tauri-apps/plugin-shell';
import { invoke } from '@tauri-apps/api/core';
import { AppConfig, loadConfig, updateStoreConfig } from '../lib/store';


export default function SettingsView() {
    const [config, setConfig] = useState<AppConfig | null>(null);
    const [showToken, setShowToken] = useState(false);
    const [saved, setSaved] = useState(false);
    const [condaDetecting, setCondaDetecting] = useState(false);
    const [cleanupResult, setCleanupResult] = useState<string | null>(null);
    const [debugPaths, setDebugPaths] = useState<Record<string, string[]> | null>(null);

    useEffect(() => {
        loadConfig().then(setConfig);
    }, []);

    const updateConfig = useCallback(
        (key: keyof AppConfig, value: string | boolean) => {
            if (!config) return;
            setConfig({ ...config, [key]: value });
            setSaved(false);
        },
        [config]
    );

    const handleSave = useCallback(async () => {
        if (!config) return;
        // Only save the fields managed by this view — never overwrite LLM settings
        await updateStoreConfig({
            hfToken: config.hfToken,
            condaPath: config.condaPath,
            condaEnv: config.condaEnv,
            ffmpegPath: config.ffmpegPath,
            whisperxCmd: config.whisperxCmd,
            device: config.device,
            computeType: config.computeType,
            defaultLanguage: config.defaultLanguage,
            defaultModel: config.defaultModel,
            diarize: config.diarize,
            normalizeAudio: config.normalizeAudio,
        });
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
    }, [config]);

    const selectFfmpegPath = useCallback(async () => {
        const file = await open({
            multiple: false,
            filters: [{ name: 'ffmpeg', extensions: ['exe'] }],
        });
        if (file) {
            updateConfig('ffmpegPath', file as string);
        }
    }, [updateConfig]);

    const openLink = useCallback(async (url: string) => {
        try {
            await openUrl(url);
        } catch {
            // fallback
            window.open(url, '_blank');
        }
    }, []);

    const autoDetectConda = useCallback(async () => {
        setCondaDetecting(true);
        try {
            const path = await invoke<string>('detect_conda_path');
            updateConfig('condaPath', path);
        } catch {
            alert('Could not auto-detect conda installation. Please set the path manually.');
        } finally {
            setCondaDetecting(false);
        }
    }, [updateConfig]);

    const cleanupTempFiles = useCallback(async () => {
        try {
            const cleaned = await invoke<string[]>('cleanup_whisperx_temp', { excludeDir: null });
            if (cleaned.length > 0) {
                setCleanupResult(`Cleaned ${cleaned.length} temporary folder${cleaned.length > 1 ? 's' : ''}.`);
            } else {
                setCleanupResult('No temporary files found.');
            }
            setTimeout(() => setCleanupResult(null), 5000);
        } catch (e) {
            setCleanupResult(`Cleanup failed: ${e}`);
            setTimeout(() => setCleanupResult(null), 5000);
        }
    }, []);

    if (!config) return null;

    return (
        <div className="settings-grid">
            {/* Left column */}
            <div>
                {/* HuggingFace section */}
                <div className="card mb-lg">
                    <div className="card-header">
                        <h2 className="card-title">
                            <span className="card-title-icon">🤗</span>
                            HuggingFace
                        </h2>
                    </div>

                    <div className="form-group">
                        <label className="form-label">Access token</label>
                        <div className="password-group">
                            <input
                                className="form-input"
                                type={showToken ? 'text' : 'password'}
                                placeholder="hf_..."
                                value={config.hfToken}
                                onChange={(e) => updateConfig('hfToken', e.target.value)}
                            />
                            <button
                                className="password-toggle"
                                onClick={() => setShowToken(!showToken)}
                                title={showToken ? 'Hide' : 'Show'}
                            >
                                {showToken ? '🙈' : '👁️'}
                            </button>
                        </div>
                    </div>

                    <div className="info-box mb-lg">
                        <span className="info-box-icon">ℹ️</span>
                        <div>
                            HuggingFace token is required for diarization (speaker recognition).
                            Generate a token at{' '}
                            <button
                                className="link-btn"
                                onClick={() => openLink('https://huggingface.co/settings/tokens')}
                            >
                                huggingface.co/settings/tokens ↗
                            </button>
                        </div>
                    </div>

                    <div className="settings-section">
                        <div className="settings-section-title">Required model authorization</div>
                        <p className="text-sm text-secondary mb-lg">
                            Accept the terms of use for the following models to enable diarization:
                        </p>
                        <div className="flex flex-col gap-sm">
                            <button
                                className="link-btn"
                                onClick={() =>
                                    openLink('https://huggingface.co/pyannote/segmentation-3.0')
                                }
                            >
                                📋 pyannote/segmentation-3.0 ↗
                            </button>
                            <button
                                className="link-btn"
                                onClick={() =>
                                    openLink('https://huggingface.co/pyannote/speaker-diarization-3.1')
                                }
                            >
                                📋 pyannote/speaker-diarization-3.1 ↗
                            </button>
                        </div>
                    </div>
                </div>

                {/* Python Environment */}
                <div className="card mb-lg">
                    <div className="card-header">
                        <h2 className="card-title">
                            <span className="card-title-icon">🐍</span>
                            Python Environment
                        </h2>
                    </div>

                    <div className="form-group">
                        <label className="form-label">Conda installation path</label>
                        <div className="file-input-group">
                            <input
                                className="form-input"
                                type="text"
                                placeholder="Auto-detect or set manually"
                                value={config.condaPath}
                                onChange={(e) => updateConfig('condaPath', e.target.value)}
                            />
                            <button
                                className="btn btn-ghost btn-sm"
                                onClick={autoDetectConda}
                                disabled={condaDetecting}
                                title="Auto-detect conda"
                            >
                                {condaDetecting ? <span className="spinner" /> : '🔍 Detect'}
                            </button>
                        </div>
                        <p className="text-xs text-muted mt-sm">
                            Path to Miniconda/Anaconda root folder (e.g. <code>C:\Users\you\miniconda3</code>).
                            The app will activate this environment before running WhisperX.
                        </p>
                    </div>

                    <div className="form-group">
                        <label className="form-label">Conda environment name</label>
                        <input
                            className="form-input"
                            type="text"
                            placeholder="base"
                            value={config.condaEnv}
                            onChange={(e) => updateConfig('condaEnv', e.target.value)}
                        />
                        <p className="text-xs text-muted mt-sm">
                            Name of the conda env where WhisperX is installed (default: <code>base</code>).
                            Use a custom name if you installed WhisperX in an isolated environment.
                        </p>
                    </div>

                    <div className="info-box">
                        <span className="info-box-icon">💡</span>
                        <div>
                            If WhisperX was installed via <strong>pip install whisperx</strong> inside a conda environment,
                            make sure to set the correct conda path and environment name above.
                            See <button className="link-btn" onClick={() => openLink('https://github.com/splicebytes/simple-ai-whisperx-gui/blob/main/TROUBLESHOOTING.md')}>Troubleshooting Guide ↗</button> for help.
                        </div>
                    </div>
                </div>

                {/* FFmpeg / WhisperX paths */}
                <div className="card">
                    <div className="card-header">
                        <h2 className="card-title">
                            <span className="card-title-icon">⚙️</span>
                            Paths
                        </h2>
                    </div>

                    <div className="form-group">
                        <label className="form-label">FFmpeg path</label>
                        <div className="file-input-group">
                            <input
                                className="form-input"
                                type="text"
                                placeholder="System default (from PATH)"
                                value={config.ffmpegPath}
                                onChange={(e) => updateConfig('ffmpegPath', e.target.value)}
                            />
                            <button
                                className="btn btn-ghost btn-icon"
                                onClick={selectFfmpegPath}
                                title="Select file"
                            >
                                📂
                            </button>
                        </div>
                        <p className="text-xs text-muted mt-sm">
                            Leave empty to use the global `ffmpeg` installation from the system.
                        </p>
                    </div>

                    <div className="form-group">
                        <label className="form-label">WhisperX command</label>
                        <input
                            className="form-input"
                            type="text"
                            placeholder="System default (from PATH)"
                            value={config.whisperxCmd}
                            onChange={(e) => updateConfig('whisperxCmd', e.target.value)}
                        />
                        <p className="text-xs text-muted mt-sm">
                            Leave empty to use the global `whisperx` environment from the system. You can provide a full path to the executable.
                        </p>
                    </div>
                </div>
            </div>

            {/* Right column */}
            <div>
                {/* Compute settings */}
                <div className="card mb-lg">
                    <div className="card-header">
                        <h2 className="card-title">
                            <span className="card-title-icon">🖥️</span>
                            Compute
                        </h2>
                    </div>

                    <div className="form-row">
                        <div className="form-group">
                            <label className="form-label">Device</label>
                            <select
                                className="form-select"
                                value={config.device}
                                onChange={(e) => updateConfig('device', e.target.value)}
                            >
                                <option value="cuda">CUDA (GPU)</option>
                                <option value="cpu">CPU</option>
                            </select>
                        </div>
                        <div className="form-group">
                            <label className="form-label">Compute type</label>
                            <select
                                className="form-select"
                                value={config.computeType}
                                onChange={(e) => updateConfig('computeType', e.target.value)}
                            >
                                <option value="float16">float16</option>
                                <option value="int8">int8 (recommended)</option>
                                <option value="float32">float32</option>
                            </select>
                        </div>
                    </div>

                    <div className="info-box">
                        <span className="info-box-icon">💡</span>
                        <div>
                            <strong>int8</strong> provides a good balance of quality and speed on NVIDIA GPUs.
                            <strong> float16</strong> requires more VRAM but is faster.
                            <strong> float32</strong> is for CPU.
                        </div>
                    </div>
                </div>

                {/* Defaults */}
                <div className="card mb-lg">
                    <div className="card-header">
                        <h2 className="card-title">
                            <span className="card-title-icon">📌</span>
                            Default settings
                        </h2>
                    </div>

                    <div className="form-row">
                        <div className="form-group">
                            <label className="form-label">Default language</label>
                            <select
                                className="form-select"
                                value={config.defaultLanguage}
                                onChange={(e) => updateConfig('defaultLanguage', e.target.value)}
                            >
                                <option value="pl">Polski</option>
                                <option value="en">English</option>
                                <option value="de">Deutsch</option>
                                <option value="fr">Français</option>
                                <option value="es">Español</option>
                                <option value="it">Italiano</option>
                                <option value="uk">Українська</option>
                                <option value="cs">Čeština</option>
                            </select>
                        </div>
                        <div className="form-group">
                            <label className="form-label">Default model</label>
                            <select
                                className="form-select"
                                value={config.defaultModel}
                                onChange={(e) => updateConfig('defaultModel', e.target.value)}
                            >
                                <option value="tiny">tiny</option>
                                <option value="base">base</option>
                                <option value="small">small</option>
                                <option value="medium">medium</option>
                                <option value="large-v2">large-v2</option>
                                <option value="large-v3">large-v3</option>
                            </select>
                        </div>
                    </div>

                    <div className="form-group">
                        <div
                            className="toggle-group"
                            onClick={() => updateConfig('diarize', !config.diarize)}
                        >
                            <div className={`toggle ${config.diarize ? 'active' : ''}`} />
                            <span className="toggle-label">Enable diarization by default</span>
                        </div>
                    </div>

                    <div className="form-group">
                        <div
                            className="toggle-group"
                            onClick={() => updateConfig('normalizeAudio', !config.normalizeAudio)}
                        >
                            <div className={`toggle ${config.normalizeAudio ? 'active' : ''}`} />
                            <span className="toggle-label">Optimize audio format for Diarization (16kHz Mono)</span>
                        </div>
                    </div>
                </div>

                {/* About / Attribution */}
                <div className="card mb-lg">
                    <div className="card-header">
                        <h2 className="card-title">
                            <span className="card-title-icon">🧹</span>
                            Maintenance
                        </h2>
                    </div>
                    <p className="text-sm text-secondary mb-lg">
                        Remove temporary audio and transcription files created during processing.
                        These files are stored in the system temp folder and can accumulate over time.
                    </p>
                    <div className="flex gap-sm mb-lg">
                        <button className="btn btn-secondary" style={{ flex: 1 }} onClick={cleanupTempFiles}>
                            🗑️ Clean up temp files
                        </button>
                        <button
                            className="btn btn-ghost"
                            style={{ flex: 1 }}
                            onClick={async () => {
                                try {
                                    const paths = await invoke<Record<string, string[]>>('get_debug_temp_paths');
                                    setDebugPaths(paths);
                                } catch (e) {
                                    setDebugPaths({ error: [`${e}`] });
                                }
                            }}
                        >
                            🔍 Show temp paths
                        </button>
                    </div>
                    {cleanupResult && (
                        <p className="text-sm text-secondary mt-sm" style={{ textAlign: 'center' }}>
                            {cleanupResult}
                        </p>
                    )}
                    {debugPaths && (
                        <div className="mt-sm" style={{ fontSize: '0.75rem', lineHeight: '1.5', fontFamily: 'monospace', background: 'var(--bg-input)', padding: '10px', borderRadius: '6px', maxHeight: '300px', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all', userSelect: 'text', cursor: 'text' }}>
                            {Object.entries(debugPaths).map(([key, values]) => (
                                <div key={key} className="mb-sm">
                                    <strong style={{ color: 'var(--accent-primary)' }}>{key}:</strong>
                                    {values.length === 0 ? (
                                        <span style={{ color: 'var(--text-muted)' }}> (empty)</span>
                                    ) : (
                                        values.map((v, i) => (
                                            <div key={i} style={{ paddingLeft: '8px', color: 'var(--text-secondary)', userSelect: 'text', cursor: 'text' }}>{v}</div>
                                        ))
                                    )}
                                </div>
                            ))}
                            <button
                                className="btn btn-ghost btn-sm mt-sm"
                                onClick={() => setDebugPaths(null)}
                            >
                                Close
                            </button>
                        </div>
                    )}
                </div>

                {/* About / Attribution */}
                <div className="card mb-lg">
                    <div className="card-header">
                        <h2 className="card-title">
                            <span className="card-title-icon">❤️</span>
                            About
                        </h2>
                    </div>
                    <div className="text-secondary text-sm">
                        <p className="mb-sm">
                            Created with passion by <strong>Michał Skalczyński</strong> (aka <em>skalunek</em>) for <strong>SpliceBytes</strong>.
                        </p>
                        <p className="mb-sm">
                            We are proud to support and contribute to the open-source community.
                        </p>
                        <p>
                            This project is licensed under the MIT License.
                            <br />
                            <a
                                href="#"
                                className="link-btn mt-sm"
                                onClick={(e) => {
                                    e.preventDefault();
                                    openLink('https://github.com/splicebytes/simple-ai-whisperx-gui');
                                }}
                            >
                                View source code on GitHub ↗
                            </a>
                        </p>
                    </div>
                </div>

                {/* Save */}
                <button className="btn btn-primary btn-full btn-lg" onClick={handleSave}>
                    {saved ? '✓ Saved!' : '💾 Save settings'}
                </button>
            </div>
        </div>
    );
}
