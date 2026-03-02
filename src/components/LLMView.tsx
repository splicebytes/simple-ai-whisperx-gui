import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import ReactMarkdown from 'react-markdown';
import type { TranscriptionResultData } from '../App';
import {
    AppConfig,
    PromptTemplate,
    loadConfig,
    updateStoreConfig,
    loadPrompts,
    savePrompts,
} from '../lib/store';

interface LLMViewProps {
    lastResult?: TranscriptionResultData | null;
    refreshKey?: number;
}

export default function LLMView({ lastResult }: LLMViewProps) {
    const [config, setConfig] = useState<AppConfig | null>(null);
    const [prompts, setPrompts] = useState<PromptTemplate[]>([]);
    const [showModal, setShowModal] = useState(false);
    const [editingPrompt, setEditingPrompt] = useState<PromptTemplate | null>(null);
    const [newPromptName, setNewPromptName] = useState('');
    const [newPromptContent, setNewPromptContent] = useState('');
    const [transcriptionText, setTranscriptionText] = useState('');
    const [summaryResult, setSummaryResult] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [saved, setSaved] = useState(false);
    const [renderMarkdown, setRenderMarkdown] = useState(true);

    useEffect(() => {
        loadConfig().then(setConfig);
        loadPrompts().then(setPrompts);
    }, []);

    // Clear results when a new transcription starts (lastResult becomes null then changes)
    useEffect(() => {
        setSummaryResult('');
        setTranscriptionText('');
    }, [lastResult]);

    const updateConfig = useCallback(
        (key: keyof AppConfig, value: string | boolean) => {
            if (!config) return;
            const updated = { ...config, [key]: value };
            setConfig(updated);
            updateStoreConfig({ [key]: value });
        },
        [config]
    );

    const handleSaveSettings = useCallback(async () => {
        if (!config) return;
        // Only save LLM-specific fields — never overwrite Settings fields (e.g. hfToken)
        await updateStoreConfig({
            llmEnabled: config.llmEnabled,
            llmProvider: config.llmProvider,
            llmEndpoint: config.llmEndpoint,
            llmModel: config.llmModel,
            selectedPromptId: config.selectedPromptId,
        });
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
    }, [config]);

    const openNewPromptModal = useCallback(() => {
        setEditingPrompt(null);
        setNewPromptName('');
        setNewPromptContent('');
        setShowModal(true);
    }, []);

    const openEditPromptModal = useCallback((prompt: PromptTemplate) => {
        setEditingPrompt(prompt);
        setNewPromptName(prompt.name);
        setNewPromptContent(prompt.content);
        setShowModal(true);
    }, []);

    const handleSavePrompt = useCallback(async () => {
        if (!newPromptName.trim() || !newPromptContent.trim()) return;

        let updated: PromptTemplate[];
        if (editingPrompt) {
            updated = prompts.map((p) =>
                p.id === editingPrompt.id
                    ? { ...p, name: newPromptName, content: newPromptContent }
                    : p
            );
        } else {
            const id = `custom-${Date.now()}`;
            updated = [
                ...prompts,
                { id, name: newPromptName, content: newPromptContent, isDefault: false },
            ];
        }

        setPrompts(updated);
        await savePrompts(updated);
        setShowModal(false);
    }, [editingPrompt, prompts, newPromptName, newPromptContent]);

    const deletePrompt = useCallback(
        async (id: string) => {
            const updated = prompts.filter((p) => p.id !== id);
            setPrompts(updated);
            await savePrompts(updated);
            if (config?.selectedPromptId === id) {
                updateConfig('selectedPromptId', updated[0]?.id || '');
            }
        },
        [prompts, config, updateConfig]
    );

    const runSummary = useCallback(async () => {
        // Always reload config from store — user may have changed LLM settings
        const freshConfig = await loadConfig();
        setConfig(freshConfig);

        if (!freshConfig) return;

        let textToUse = transcriptionText.trim();

        // Use fallback if textarea is empty
        if (!textToUse && lastResult) {
            try {
                const txtPath = `${lastResult.outputDir}/${lastResult.baseName}.txt`;
                textToUse = await invoke<string>('read_transcription_file', {
                    filePath: txtPath,
                });
            } catch (e) {
                console.error('Failed to fetch transcription text for summary', e);
                setSummaryResult(`Error loading transcription: ${e}`);
                return;
            }
        }

        if (!textToUse) return;

        const selectedPrompt =
            prompts.find((p) => p.id === freshConfig.selectedPromptId) || prompts[0];
        if (!selectedPrompt) return;

        setIsLoading(true);
        setSummaryResult('');

        try {
            const result = await invoke<{ summary: string }>('run_llm_summary', {
                request: {
                    endpoint: freshConfig.llmEndpoint,
                    model: freshConfig.llmModel,
                    prompt: selectedPrompt.content,
                    transcription_text: textToUse,
                },
            });
            setSummaryResult(result.summary);

            // Auto save summary if enabled
            if (freshConfig.autoSaveFiles && lastResult?.outputDir && lastResult?.baseName) {
                try {
                    const savePath = `${lastResult.outputDir}/${lastResult.baseName}_summary.md`;
                    await invoke('save_text_file', { filePath: savePath, content: result.summary });
                } catch (e) {
                    console.error('Failed to auto-save summary', e);
                }
            }

            // Play a subtle notification sound
            try {
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
        } catch (err) {
            setSummaryResult(`Error: ${err}`);
        } finally {
            setIsLoading(false);
        }
    }, [prompts, transcriptionText, lastResult]);

    const exportToFile = useCallback(async () => {
        if (!summaryResult) return;

        try {
            let defaultName = 'summary.md';
            if (lastResult?.baseName) {
                defaultName = `${lastResult.baseName}_summary.md`;
            }

            const savePath = await save({
                defaultPath: defaultName,
                filters: [{ name: 'Markdown', extensions: ['md', 'txt'] }]
            });

            if (savePath) {
                await invoke('save_text_file', { filePath: savePath, content: summaryResult });
            }
        } catch (e) {
            console.error('Failed to save file:', e);
            alert(`Failed to save: ${e}`);
        }
    }, [summaryResult, lastResult]);

    if (!config) return null;

    return (
        <div>
            {/* Enable/Disable Toggle */}
            <div className="card mb-lg">
                <div className="flex items-center justify-between">
                    <div>
                        <h2 className="card-title">
                            <span className="card-title-icon">🤖</span>
                            LLM Summary
                        </h2>
                        <p className="text-sm text-secondary mt-sm">
                            Automatic transcription summary using a local LLM
                        </p>
                    </div>
                    <div
                        className="toggle-group"
                        onClick={() => updateConfig('llmEnabled', !config.llmEnabled)}
                    >
                        <div className={`toggle ${config.llmEnabled ? 'active' : ''}`} />
                    </div>
                </div>
            </div>

            {config.llmEnabled && (
                <div className="llm-layout">
                    {/* Left - Config & Prompts */}
                    <div>
                        {/* LLM Configuration */}
                        <div className="card mb-lg">
                            <div className="card-header">
                                <h2 className="card-title">
                                    <span className="card-title-icon">🔗</span>
                                    Endpoint configuration
                                </h2>
                            </div>

                            <div className="form-group">
                                <label className="form-label">Provider</label>
                                <select
                                    className="form-select"
                                    value={config.llmProvider}
                                    onChange={(e) => {
                                        updateConfig('llmProvider', e.target.value);
                                        if (e.target.value === 'ollama') {
                                            updateConfig('llmEndpoint', 'http://localhost:11434');
                                        } else if (e.target.value === 'lmstudio') {
                                            updateConfig('llmEndpoint', 'http://localhost:1234');
                                        }
                                    }}
                                >
                                    <option value="ollama">Ollama</option>
                                    <option value="lmstudio">LM Studio</option>
                                    <option value="custom">Custom (OpenAI-compatible)</option>
                                </select>
                            </div>

                            <div className="form-group">
                                <label className="form-label">Endpoint URL</label>
                                <input
                                    className="form-input"
                                    type="text"
                                    placeholder="http://localhost:11434"
                                    value={config.llmEndpoint}
                                    onChange={(e) => updateConfig('llmEndpoint', e.target.value)}
                                />
                            </div>

                            <div className="form-group">
                                <label className="form-label">Model</label>
                                <input
                                    className="form-input"
                                    type="text"
                                    placeholder="e.g. llama3, mistral, gemma2..."
                                    value={config.llmModel}
                                    onChange={(e) => updateConfig('llmModel', e.target.value)}
                                />
                            </div>

                            <button className="btn btn-secondary btn-full" onClick={handleSaveSettings}>
                                {saved ? '✓ Saved!' : '💾 Save LLM configuration'}
                            </button>
                        </div>

                        {/* Prompt Templates */}
                        <div className="card">
                            <div className="card-header">
                                <h2 className="card-title">
                                    <span className="card-title-icon">📝</span>
                                    Prompt templates
                                </h2>
                                <button className="btn btn-ghost btn-sm" onClick={openNewPromptModal}>
                                    + New
                                </button>
                            </div>

                            <div className="prompt-list">
                                {prompts.map((prompt) => (
                                    <div
                                        key={prompt.id}
                                        className={`prompt-card ${config.selectedPromptId === prompt.id ? 'selected' : ''}`}
                                        onClick={() => updateConfig('selectedPromptId', prompt.id)}
                                    >
                                        <div>
                                            <div className="prompt-card-name">{prompt.name}</div>
                                            <div className="prompt-card-preview">{prompt.content}</div>
                                        </div>
                                        <div className="prompt-card-actions">
                                            <button
                                                className="btn btn-ghost btn-sm"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    openEditPromptModal(prompt);
                                                }}
                                            >
                                                ✏️
                                            </button>
                                            {!prompt.isDefault && (
                                                <button
                                                    className="btn btn-ghost btn-sm"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        deletePrompt(prompt.id);
                                                    }}
                                                >
                                                    🗑️
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>

                    {/* Right - Test / Results */}
                    <div>
                        <div className="card mb-lg">
                            <div className="card-header">
                                <h2 className="card-title">
                                    <span className="card-title-icon">🧪</span>
                                    Test summary
                                </h2>
                            </div>

                            <div className="form-group">
                                <label className="form-label">
                                    Transcription text
                                </label>
                                <textarea
                                    className="form-textarea"
                                    rows={8}
                                    placeholder="Leave empty to use the current transcription automatically, or paste custom text here..."
                                    value={transcriptionText}
                                    onChange={(e) => setTranscriptionText(e.target.value)}
                                />
                            </div>

                            <button
                                className="btn btn-primary btn-full"
                                onClick={runSummary}
                                disabled={isLoading || (!transcriptionText.trim() && !lastResult) || !config.llmModel}
                            >
                                {isLoading ? (
                                    <>
                                        <span className="spinner" /> Generating summary...
                                    </>
                                ) : (
                                    '🤖 Summarize'
                                )}
                            </button>
                        </div>


                        {/* Result */}
                        <div className="card">
                            <div className="card-header">
                                <h2 className="card-title">
                                    <span className="card-title-icon">📋</span>
                                    Result
                                </h2>
                                {summaryResult && (
                                    <div className="flex items-center gap-sm">
                                        <div className="view-toggle">
                                            <button
                                                className={`view-toggle-btn ${!renderMarkdown ? 'active' : ''}`}
                                                onClick={() => setRenderMarkdown(false)}
                                                title="Raw text"
                                            >
                                                TXT
                                            </button>
                                            <button
                                                className={`view-toggle-btn ${renderMarkdown ? 'active' : ''}`}
                                                onClick={() => setRenderMarkdown(true)}
                                                title="Rendered Markdown"
                                            >
                                                MD
                                            </button>
                                        </div>
                                        <button
                                            className="btn btn-ghost btn-sm"
                                            onClick={exportToFile}
                                            title="Save as Markdown/TXT"
                                        >
                                            📥 Save
                                        </button>
                                    </div>
                                )}
                            </div>
                            {summaryResult ? (
                                <div>
                                    {renderMarkdown ? (
                                        <div className="llm-result markdown-body">
                                            <ReactMarkdown>{summaryResult}</ReactMarkdown>
                                        </div>
                                    ) : (
                                        <div className="llm-result selectable-text">{summaryResult}</div>
                                    )}
                                </div>
                            ) : (
                                <div className="empty-state">
                                    <div className="empty-state-icon">📄</div>
                                    <div className="empty-state-title">No results</div>
                                    <div className="empty-state-text">
                                        Paste a transcription and click "Summarize"
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Modal */}
            {showModal && (
                <div className="modal-overlay" onClick={() => setShowModal(false)}>
                    <div className="modal" onClick={(e) => e.stopPropagation()}>
                        <h3 className="modal-title">
                            {editingPrompt ? 'Edit prompt' : 'New prompt'}
                        </h3>
                        <div className="form-group">
                            <label className="form-label">Name</label>
                            <input
                                className="form-input"
                                type="text"
                                placeholder="Template name..."
                                value={newPromptName}
                                onChange={(e) => setNewPromptName(e.target.value)}
                            />
                        </div>
                        <div className="form-group">
                            <label className="form-label">Prompt content</label>
                            <textarea
                                className="form-textarea"
                                rows={6}
                                placeholder="Instructions for LLM..."
                                value={newPromptContent}
                                onChange={(e) => setNewPromptContent(e.target.value)}
                            />
                        </div>
                        <div className="modal-actions">
                            <button className="btn btn-ghost" onClick={() => setShowModal(false)}>
                                Cancel
                            </button>
                            <button
                                className="btn btn-primary"
                                onClick={handleSavePrompt}
                                disabled={!newPromptName.trim() || !newPromptContent.trim()}
                            >
                                Save
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
