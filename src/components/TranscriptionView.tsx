import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import { tempDir, join } from '@tauri-apps/api/path';
import { AppConfig, loadConfig, updateStoreConfig } from '../lib/store';
import type { TranscriptionResultData } from '../App';

interface OutputLine {
    line: string;
    stream: 'stdout' | 'stderr' | 'info' | 'error';
    type?: 'normal' | 'warning' | 'progress' | 'download';
}

interface TranscriptionResult {
    success: boolean;
    output_dir: string;
    error?: string;
    processed_audio_path?: string;
}

type TranscriptionStatus = 'idle' | 'running' | 'completed' | 'error' | 'cancelled';

interface TranscriptionViewProps {
    onTranscriptionComplete?: (data: TranscriptionResultData) => void;
    onTranscriptionStart?: () => void;
    refreshKey?: number;
}

export default function TranscriptionView({ onTranscriptionComplete, onTranscriptionStart, refreshKey }: TranscriptionViewProps) {
    const [config, setConfig] = useState<AppConfig | null>(null);
    const [audioPath, setAudioPath] = useState('');
    const [language, setLanguage] = useState('pl');
    const [model, setModel] = useState('large-v3');
    const [diarize, setDiarize] = useState(true);
    const [normalizeAudio, setNormalizeAudio] = useState(true);
    const [outputDir, setOutputDir] = useState('');
    const [status, setStatus] = useState<TranscriptionStatus>('idle');
    const [outputLines, setOutputLines] = useState<OutputLine[]>([]);
    const [resultFiles, setResultFiles] = useState<string[]>([]);
    const [activeResultTab, setActiveResultTab] = useState('');
    const [resultContent, setResultContent] = useState('');
    const [beepOnComplete, setBeepOnComplete] = useState(true);
    const [showWarnings, setShowWarnings] = useState(false);
    const consoleRef = useRef<HTMLDivElement>(null);

    const languages = [
        { value: 'pl', label: 'Polski' },
        { value: 'en', label: 'English' },
        { value: 'de', label: 'Deutsch' },
        { value: 'fr', label: 'Français' },
        { value: 'es', label: 'Español' },
        { value: 'it', label: 'Italiano' },
        { value: 'pt', label: 'Português' },
        { value: 'nl', label: 'Nederlands' },
        { value: 'uk', label: 'Українська' },
        { value: 'cs', label: 'Čeština' },
        { value: 'ja', label: '日本語' },
        { value: 'zh', label: '中文' },
        { value: 'ko', label: '한국어' },
        { value: 'ru', label: 'Русский' },
    ];

    const models = [
        { value: 'tiny', label: 'tiny (39M)' },
        { value: 'base', label: 'base (74M)' },
        { value: 'small', label: 'small (244M)' },
        { value: 'medium', label: 'medium (769M)' },
        { value: 'large-v2', label: 'large-v2 (1.5G)' },
        { value: 'large-v3', label: 'large-v3 (1.5G)' },
    ];

    useEffect(() => {
        loadConfig().then((cfg) => {
            setConfig(cfg);
            setLanguage(cfg.defaultLanguage);
            setModel(cfg.defaultModel);
            setDiarize(cfg.diarize);
            setNormalizeAudio(cfg.normalizeAudio !== undefined ? cfg.normalizeAudio : true);
        });
    }, []);

    useEffect(() => {
        const promiseOutput = listen<{ line: string; stream: string }>('whisperx-output', (event) => {
            const rawLine = event.payload.line;
            const stream = event.payload.stream as 'stdout' | 'stderr';

            let type: 'normal' | 'warning' | 'progress' | 'download' = 'normal';

            if (stream === 'stderr') {
                // Progress bars (tqdm)
                if (/^\s*\d+%\|.*\|/.test(rawLine)) {
                    type = 'progress';
                }
                // Download start lines
                else if (rawLine.startsWith('Downloading:') || rawLine.startsWith('Downloading ')) {
                    type = 'download';
                }
                // Whitelist: known useful stderr lines from whisperx
                else if (
                    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(rawLine) || // timestamped INFO logs
                    rawLine.startsWith('Transcript:')
                ) {
                    type = 'normal';
                }
                // Everything else from stderr is a warning
                else {
                    type = 'warning';
                }
            } else {
                // stdout: check for progress bars
                if (/^\s*\d+%\|.*\|/.test(rawLine)) {
                    type = 'progress';
                }
            }

            setOutputLines((prev) => {
                if (type === 'progress') {
                    const lastLine = prev[prev.length - 1];
                    if (lastLine && lastLine.type === 'progress') {
                        const newLines = [...prev];
                        newLines[newLines.length - 1] = { line: rawLine, stream, type };
                        return newLines;
                    }
                }
                return [...prev, { line: rawLine, stream, type }];
            });
        });

        const promiseStatus = listen<string>('whisperx-status', (event) => {
            if (event.payload === 'completed') setStatus('completed');
            else if (event.payload === 'error') setStatus('error');
            else if (event.payload === 'cancelled') setStatus('cancelled');
        });

        return () => {
            promiseOutput.then((unlisten) => unlisten());
            promiseStatus.then((unlisten) => unlisten());
        };
    }, []);

    useEffect(() => {
        if (consoleRef.current) {
            consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
        }
    }, [outputLines]);

    const selectAudioFile = useCallback(async () => {
        const file = await open({
            multiple: false,
            filters: [
                {
                    name: 'Audio',
                    extensions: ['wav', 'mp3', 'flac', 'ogg', 'm4a', 'wma', 'aac', 'opus', 'webm', 'mp4'],
                },
            ],
        });
        if (file) {
            setAudioPath(file as string);
            // Suggest output dir as same directory
            const parts = (file as string).replace(/\\/g, '/').split('/');
            parts.pop();
            setOutputDir(parts.join('/'));
        }
    }, []);

    const selectOutputDir = useCallback(async () => {
        const dir = await open({ directory: true });
        if (dir) {
            setOutputDir(dir as string);
        }
    }, []);

    const startTranscription = useCallback(async () => {
        if (!audioPath) return;

        // Always reload config from store — user may have changed settings (e.g. HF token)
        const freshConfig = await loadConfig();
        setConfig(freshConfig);

        if (!freshConfig?.hfToken && diarize) {
            setOutputLines([
                {
                    line: '⚠ HuggingFace token is not set. Go to Settings to configure the token (required for diarization).',
                    stream: 'error',
                },
            ]);
            return;
        }

        // Notify parent to clear old transcription state (speakers, LLM, etc.)
        onTranscriptionStart?.();

        // Clean up temp files from previous transcriptions
        try {
            await invoke('cleanup_whisperx_temp', { excludeDir: null });
        } catch (e) {
            console.error('Failed to cleanup temp files', e);
        }

        setStatus('running');
        setOutputLines([{ line: `▶ Starting transcription: ${audioPath}`, stream: 'info' }]);
        setResultFiles([]);
        setResultContent('');

        try {
            let finalOutputDir = outputDir || null;
            if (!freshConfig?.autoSaveFiles) {
                try {
                    const tDir = await tempDir();
                    finalOutputDir = await join(tDir, `whisperx_${Date.now()}`);
                } catch (e) {
                    console.error("Failed to get temp dir", e);
                }
            }

            const result = await invoke<TranscriptionResult>('run_whisperx', {
                request: {
                    audio_path: audioPath,
                    language,
                    model,
                    diarize,
                    normalize_audio: normalizeAudio,
                    hf_token: freshConfig?.hfToken || '',
                    output_dir: finalOutputDir,
                    device: freshConfig?.device || 'cuda',
                    compute_type: freshConfig?.computeType || 'int8',
                    whisperx_cmd: freshConfig?.whisperxCmd || null,
                    ffmpeg_path: freshConfig?.ffmpegPath || null,
                    conda_path: freshConfig?.condaPath || null,
                    conda_env: freshConfig?.condaEnv || 'base',
                },
            });

            if (result.success) {
                setOutputLines((prev) => [
                    ...prev,
                    { line: `✓ Transcription completed successfully`, stream: 'info' },
                ]);

                // Get output files
                const baseName = audioPath
                    .replace(/\\/g, '/')
                    .split('/')
                    .pop()
                    ?.replace(/\.[^.]+$/, '');
                if (baseName) {
                    const files = await invoke<string[]>('get_output_files', {
                        outputDir: result.output_dir,
                        baseName,
                    });
                    setResultFiles(files);
                    if (files.length > 0) {
                        setActiveResultTab(files[0]);
                        const content = await invoke<string>('read_transcription_file', {
                            filePath: files[0],
                        });
                        setResultContent(content);
                    }

                    // Notify parent about completion (for speaker ID tab).
                    // We MUST pass the original audioPath here, because the normalization 
                    // processed_audio_path is a temp file that was just deleted!
                    onTranscriptionComplete?.({
                        audioPath,
                        outputDir: result.output_dir,
                        baseName,
                        diarize,
                    });

                    // Play a subtle notification sound
                    if (beepOnComplete) {
                        try {
                            // A short generic beep using AudioContext
                            const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
                            const osc = ctx.createOscillator();
                            const gain = ctx.createGain();
                            osc.connect(gain);
                            gain.connect(ctx.destination);
                            osc.type = 'sine';
                            osc.frequency.setValueAtTime(880, ctx.currentTime);
                            gain.gain.setValueAtTime(0.1, ctx.currentTime);
                            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
                            osc.start(ctx.currentTime);
                            osc.stop(ctx.currentTime + 0.5);
                        } catch (e) {
                            console.error('Failed to play notification sound', e);
                        }
                    }
                }
            } else {
                setOutputLines((prev) => [
                    ...prev,
                    { line: `✗ Error: ${result.error || 'Unknown error'}`, stream: 'error' },
                ]);
            }
        } catch (err: unknown) {
            setStatus('error');
            setOutputLines((prev) => [...prev, { line: `✗ ${err}`, stream: 'error' }]);
        }
    }, [audioPath, language, model, diarize, normalizeAudio, outputDir, beepOnComplete, onTranscriptionComplete, onTranscriptionStart]);

    const cancelTranscription = useCallback(async () => {
        try {
            await invoke('cancel_whisperx');
        } catch (err) {
            console.error('Cancel failed:', err);
        }
    }, []);

    const loadResultFile = useCallback(async (filePath: string) => {
        setActiveResultTab(filePath);
        try {
            const content = await invoke<string>('read_transcription_file', { filePath });
            setResultContent(content);
        } catch {
            setResultContent('Failed to load file.');
        }
    }, []);

    // Reload active file when refreshKey changes (e.g., after speaker names are applied)
    useEffect(() => {
        if (activeResultTab) {
            loadResultFile(activeResultTab);
        }
    }, [refreshKey, activeResultTab, loadResultFile]);
    const getFileExtension = (path: string) => {
        return path.split('.').pop()?.toUpperCase() || '';
    };

    const saveManualResult = useCallback(async () => {
        if (!activeResultTab || !resultContent) return;
        try {
            const ext = getFileExtension(activeResultTab).toLowerCase();
            let defaultName = 'transcription';
            const parts = activeResultTab.replace(/\\/g, '/').split('/');
            const filename = parts.pop();
            if (filename) defaultName = filename;

            const savePath = await save({
                defaultPath: defaultName,
                filters: [{ name: 'Result', extensions: [ext] }],
            });

            if (savePath) {
                await invoke('save_text_file', { filePath: savePath, content: resultContent });
            }
        } catch (e) {
            console.error('Failed to save file:', e);
            alert(`Failed to save file: ${e}`);
        }
    }, [activeResultTab, resultContent]);

    return (
        <div className="transcription-layout">
            {/* Left column - Controls */}
            <div>
                <div className="card">
                    <div className="card-header">
                        <h2 className="card-title">
                            <span className="card-title-icon">🎙️</span>
                            Transcription
                        </h2>
                        <span className={`status-badge ${status}`}>
                            {status === 'running' && <span className="spinner" />}
                            {status === 'idle' && 'Ready'}
                            {status === 'running' && 'Processing...'}
                            {status === 'completed' && '✓ Completed'}
                            {status === 'error' && '✗ Error'}
                            {status === 'cancelled' && '⏹ Cancelled'}
                        </span>
                    </div>

                    {/* Audio file selection */}
                    <div className="form-group">
                        <label className="form-label">Audio file</label>
                        <div className="file-input-group">
                            <input
                                className="form-input"
                                type="text"
                                placeholder="Select audio file..."
                                value={audioPath}
                                readOnly
                            />
                            <button className="btn btn-ghost btn-icon" onClick={selectAudioFile} title="Select file">
                                📂
                            </button>
                        </div>
                    </div>

                    {/* Language & Model */}
                    <div className="form-row">
                        <div className="form-group">
                            <label className="form-label">Language</label>
                            <select
                                className="form-select"
                                value={language}
                                onChange={(e) => setLanguage(e.target.value)}
                            >
                                {languages.map((l) => (
                                    <option key={l.value} value={l.value}>
                                        {l.label}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className="form-group">
                            <label className="form-label">Model</label>
                            <select
                                className="form-select"
                                value={model}
                                onChange={(e) => setModel(e.target.value)}
                            >
                                {models.map((m) => (
                                    <option key={m.value} value={m.value}>
                                        {m.label}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>

                    {/* Diarization toggle */}
                    <div className="form-group">
                        <div
                            className="toggle-group"
                            onClick={() => setDiarize(!diarize)}
                        >
                            <div className={`toggle ${diarize ? 'active' : ''}`} />
                            <span className="toggle-label">Diarization (speaker recognition)</span>
                        </div>
                    </div>

                    {/* Normalize audio toggle */}
                    <div className="form-group">
                        <div
                            className="toggle-group"
                            onClick={() => setNormalizeAudio(!normalizeAudio)}
                        >
                            <div className={`toggle ${normalizeAudio ? 'active' : ''}`} />
                            <span className="toggle-label">Optimize audio (16kHz Mono) for Diarization</span>
                        </div>
                    </div>

                    {/* Output directory - hidden if autosave is disabled */}
                    {config?.autoSaveFiles && (
                        <div className="form-group">
                            <label className="form-label">Output directory</label>
                            <div className="file-input-group">
                                <input
                                    className="form-input"
                                    type="text"
                                    placeholder="Default: audio file directory"
                                    value={outputDir}
                                    onChange={(e) => setOutputDir(e.target.value)}
                                />
                                <button className="btn btn-ghost btn-icon" onClick={selectOutputDir} title="Select directory">
                                    📁
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Auto save files toggle */}
                    <div className="form-group">
                        <div
                            className="toggle-group"
                            onClick={() => {
                                if (config) {
                                    const updated = { ...config, autoSaveFiles: !config.autoSaveFiles };
                                    setConfig(updated);
                                    updateStoreConfig({ autoSaveFiles: updated.autoSaveFiles });
                                }
                            }}
                        >
                            <div className={`toggle ${config?.autoSaveFiles ? 'active' : ''}`} />
                            <span className="toggle-label">Auto-save results to disk</span>
                        </div>
                    </div>

                    {/* Beep on complete toggle */}
                    <div className="form-group">
                        <div
                            className="toggle-group"
                            onClick={() => setBeepOnComplete(!beepOnComplete)}
                        >
                            <div className={`toggle ${beepOnComplete ? 'active' : ''}`} />
                            <span className="toggle-label">Sound notification on completion</span>
                        </div>
                    </div>

                    {/* Action buttons */}
                    <div className="flex gap-sm mt-lg">
                        {status === 'running' ? (
                            <button className="btn btn-danger btn-full" onClick={cancelTranscription}>
                                ⏹ Cancel
                            </button>
                        ) : (
                            <button
                                className="btn btn-primary btn-full btn-lg"
                                onClick={startTranscription}
                                disabled={!audioPath}
                            >
                                🚀 Transcribe
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* Right column - Output & Results */}
            <div className="flex flex-col gap-lg">
                {/* Console */}
                <div className="card">
                    <div className="card-header">
                        <h2 className="card-title">
                            <span className="card-title-icon">💻</span>
                            Console
                        </h2>
                        <div className="flex gap-sm items-center">
                            <div
                                className="toggle-group"
                                onClick={() => setShowWarnings(!showWarnings)}
                            >
                                <div className={`toggle ${showWarnings ? 'active' : ''}`} />
                                <span className="toggle-label">Show warnings</span>
                            </div>
                            {outputLines.length > 0 && (
                                <button
                                    className="btn btn-ghost btn-sm"
                                    onClick={() => setOutputLines([])}
                                >
                                    Clear
                                </button>
                            )}
                        </div>
                    </div>
                    <div className="console selectable-text" ref={consoleRef}>
                        {outputLines.length === 0 ? (
                            <div className="text-muted">Select an audio file and click "Transcribe"...</div>
                        ) : (
                            outputLines.map((line, i) => {
                                if (line.type === 'warning' && !showWarnings) return null;

                                if (line.type === 'download') {
                                    // Parse: Downloading: "URL" to PATH
                                    const dlMatch = line.line.match(/Downloading:?\s+"?([^"]+)"?\s+to\s+(.+)/);
                                    const fileName = dlMatch
                                        ? dlMatch[1].split('/').pop() || dlMatch[1]
                                        : line.line;
                                    return (
                                        <div key={i} className="console-line" style={{ color: 'var(--text-accent)', padding: '4px 0' }}>
                                            ⬇ Downloading: <span style={{ color: 'var(--text-primary)' }}>{fileName}</span>
                                        </div>
                                    );
                                }

                                if (line.type === 'progress') {
                                    // Parse tqdm: 45%|████▍ | 162M/360M [00:02<00:02, 78.0MB/s]
                                    const match = line.line.match(/^\s*(\d+)%\|.*\|\s*(.+)$/);
                                    if (match) {
                                        const percent = parseInt(match[1], 10);
                                        const stats = match[2].trim();
                                        return (
                                            <div key={i} className="console-line" style={{ padding: '4px 0' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                                    <span style={{ minWidth: '42px', textAlign: 'right', fontWeight: 600, color: percent >= 100 ? 'var(--success)' : 'var(--accent-primary)' }}>{percent}%</span>
                                                    <div style={{ flex: 1, height: '6px', background: 'var(--bg-input)', borderRadius: '3px', overflow: 'hidden', border: '1px solid var(--border-color)' }}>
                                                        <div style={{
                                                            width: `${percent}%`,
                                                            height: '100%',
                                                            background: percent >= 100 ? 'var(--success)' : 'var(--accent-primary)',
                                                            borderRadius: '3px',
                                                            transition: 'width 0.15s ease-out',
                                                        }} />
                                                    </div>
                                                    <span style={{ fontSize: '0.8em', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{stats}</span>
                                                </div>
                                            </div>
                                        );
                                    }
                                }

                                return (
                                    <div key={i} className={`console-line ${line.stream}`} style={line.type === 'warning' ? { color: 'var(--warning)' } : {}}>
                                        {line.line}
                                    </div>
                                );
                            })
                        )}
                    </div>
                </div>

                {/* Results */}
                {resultFiles.length > 0 && (
                    <div className="card">
                        <div className="card-header">
                            <h2 className="card-title">
                                <span className="card-title-icon">📄</span>
                                Results
                            </h2>
                            {activeResultTab && resultContent && (
                                <button className="btn btn-ghost btn-sm" onClick={saveManualResult}>
                                    📥 Save as...
                                </button>
                            )}
                        </div>
                        <div className="result-tabs">
                            {resultFiles.map((f) => (
                                <button
                                    key={f}
                                    className={`result-tab ${activeResultTab === f ? 'active' : ''}`}
                                    onClick={() => loadResultFile(f)}
                                >
                                    {getFileExtension(f)}
                                </button>
                            ))}
                        </div>
                        <div className="result-content selectable-text">{resultContent}</div>
                    </div>
                )}
            </div>
        </div>
    );
}
