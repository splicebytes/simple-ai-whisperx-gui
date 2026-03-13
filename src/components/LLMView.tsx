import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { save } from '@tauri-apps/plugin-dialog';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import type { TranscriptionResultData } from '../App';
import {
    AppConfig,
    PromptTemplate,
    loadConfig,
    updateStoreConfig,
    loadPrompts,
    savePrompts,
} from '../lib/store';

interface LlmProgress {
    chunk: string | null;
    stats: any | null;
    is_done: boolean;
}

interface LLMViewProps {
    lastResult?: TranscriptionResultData | null;
    refreshKey?: number;
}

const processThinkBlocks = (text: string) => {
    if (!text.includes('<think>')) return text;

    let result = '';
    let isThinking = false;
    
    // Split text by <think> and </think> tags
    const parts = text.split(/(<think>|<\/think>)/);
    
    for (const part of parts) {
        if (part === '<think>') {
            isThinking = true;
            // Use details/summary for collapsible section. Open by default while streaming.
            result += '<details className="think-block" open>\n<summary>💭 Reasoning</summary>\n<div className="think-content">\n\n';
        } else if (part === '</think>') {
            isThinking = false;
            // Close the div and details tags. Then use a hack to close the details tag automatically when finished.
            // A React trick: we can replace the open tag with a closed one by replacing the string later, but for now we close the tags.
            result += '\n</div>\n</details>\n\n';
        } else {
            if (isThinking) {
                // Keep the content as is, CSS will handle the styling inside think-content
                result += part;
            } else {
                result += part;
            }
        }
    }
    
    // If the whole stream finished (we have both tags), collapse it by removing ' open' attribute
    if (text.includes('</think>')) {
        result = result.replace(/<details className="think-block" open>/g, '<details className="think-block">');
    }
    
    return result;
};

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
    const [availableModels, setAvailableModels] = useState<string[]>([]);
    const [isFetchingModels, setIsFetchingModels] = useState(false);
    const [showModelDropdown, setShowModelDropdown] = useState(false);
    const [llmStats, setLlmStats] = useState<any | null>(null);
    const [generationTimeMs, setGenerationTimeMs] = useState<number | null>(null);

    useEffect(() => {
        loadConfig().then(setConfig);
        loadPrompts().then(setPrompts);
    }, []);

    // Clear results when a new transcription starts (lastResult becomes null then changes)
    useEffect(() => {
        setSummaryResult('');
        setTranscriptionText('');
    }, [lastResult]);

    // Fetch available models when endpoint changes
    const fetchModels = useCallback(async () => {
        if (!config?.llmEndpoint || !config.llmEnabled) return;
        setIsFetchingModels(true);
        try {
            const models = await invoke<string[]>('fetch_llm_models', { endpoint: config.llmEndpoint });
            setAvailableModels(models);
        } catch (err) {
            console.warn('Failed to fetch models:', err);
            setAvailableModels([]);
        } finally {
            setIsFetchingModels(false);
        }
    }, [config?.llmEndpoint, config?.llmEnabled]);

    useEffect(() => {
        const timer = setTimeout(fetchModels, 500);
        return () => clearTimeout(timer);
    }, [fetchModels]);

    const updateConfig = useCallback(
        (updates: Partial<AppConfig>) => {
            if (!config) return;
            const updated = { ...config, ...updates };
            setConfig(updated);
            updateStoreConfig(updates);
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
            llmTimeout: config.llmTimeout,
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
                updateConfig({ selectedPromptId: updated[0]?.id || '' });
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
        setLlmStats(null);
        setGenerationTimeMs(null);

        const startTime = Date.now();
        let unlisten: (() => void) | null = null;

        try {
            unlisten = await listen<LlmProgress>('llm-progress', (event) => {
                const { chunk, stats } = event.payload;
                if (chunk) {
                    setSummaryResult((prev) => prev + chunk);
                }
                if (stats) {
                    setLlmStats(stats);
                    setGenerationTimeMs(Date.now() - startTime);
                }
            });

            const result = await invoke<{ summary: string }>('run_llm_summary', {
                request: {
                    endpoint: freshConfig.llmEndpoint,
                    model: freshConfig.llmModel,
                    prompt: selectedPrompt.content,
                    transcription_text: textToUse,
                    timeout: freshConfig.llmTimeout,
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
            if (unlisten) unlisten();
            setIsLoading(false);
            if (!generationTimeMs) {
                setGenerationTimeMs(Date.now() - startTime);
            }
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
                        onClick={() => updateConfig({ llmEnabled: !config.llmEnabled })}
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
                        <div className="card mb-lg" style={{ position: 'relative', zIndex: 10 }}>
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
                                        const newProvider = e.target.value;
                                        if (newProvider === 'ollama') {
                                            updateConfig({ llmProvider: newProvider, llmEndpoint: 'http://localhost:11434' });
                                        } else if (newProvider === 'lmstudio') {
                                            updateConfig({ llmProvider: newProvider, llmEndpoint: 'http://localhost:1234' });
                                        } else {
                                            updateConfig({ llmProvider: newProvider });
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
                                    onChange={(e) => updateConfig({ llmEndpoint: e.target.value })}
                                />
                            </div>

                            <div className="form-group" style={{ position: 'relative', zIndex: 50 }}>
                                <label className="form-label flex items-center justify-between">
                                    <span>Model</span>
                                    <button
                                        className="btn btn-ghost btn-sm"
                                        onClick={fetchModels}
                                        title="Refresh models"
                                        disabled={isFetchingModels}
                                        style={{ padding: '2px 6px', height: 'auto', fontSize: '0.8rem' }}
                                    >
                                        🔄 Refresh
                                    </button>
                                </label>
                                <div className="input-group" style={{ position: 'relative' }}>
                                    <input
                                        className="form-input w-full"
                                        type="text"
                                        placeholder="e.g. llama3, mistral, gemma2..."
                                        value={config.llmModel}
                                        onChange={(e) => updateConfig({ llmModel: e.target.value })}
                                        onFocus={() => setShowModelDropdown(true)}
                                        onBlur={() => setTimeout(() => setShowModelDropdown(false), 200)}
                                    />
                                    {isFetchingModels && (
                                        <div style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)' }}>
                                            <span className="spinner" style={{ width: '16px', height: '16px', borderWidth: '2px' }} />
                                        </div>
                                    )}

                                    {showModelDropdown && (availableModels.length > 0 || isFetchingModels) && (
                                        <div className="dropdown-menu shadow-lg rounded-md"
                                            style={{
                                                position: 'absolute',
                                                top: '100%',
                                                left: 0,
                                                right: 0,
                                                zIndex: 9999,
                                                background: 'var(--bg-secondary)',
                                                border: '1px solid var(--border-color)',
                                                borderRadius: 'var(--radius-md)',
                                                marginTop: '4px',
                                                maxHeight: '200px',
                                                overflowY: 'auto',
                                                boxShadow: '0 10px 25px rgba(0,0,0,0.5)'
                                            }}>
                                            {isFetchingModels && availableModels.length === 0 ? (
                                                <div style={{ padding: '8px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)' }}>
                                                    Loading models...
                                                </div>
                                            ) : (
                                                <>
                                                    {availableModels.map(m => (
                                                        <div
                                                            key={m}
                                                            style={{
                                                                padding: '8px 12px',
                                                                cursor: 'pointer',
                                                                borderBottom: '1px solid var(--border-glass)',
                                                                fontWeight: config.llmModel === m ? 'bold' : 'normal',
                                                                color: config.llmModel === m ? 'var(--accent-primary)' : 'var(--text-primary)'
                                                            }}
                                                            onMouseEnter={(e) => {
                                                                e.currentTarget.style.background = 'var(--bg-card-hover)';
                                                            }}
                                                            onMouseLeave={(e) => {
                                                                e.currentTarget.style.background = 'transparent';
                                                            }}
                                                            onClick={() => {
                                                                updateConfig({ llmModel: m });
                                                                setShowModelDropdown(false);
                                                            }}
                                                        >
                                                            {m}
                                                        </div>
                                                    ))}
                                                </>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>

                            <div className="form-group">
                                <label className="form-label">Timeout (seconds)</label>
                                <input
                                    className="form-input"
                                    type="number"
                                    min="1"
                                    placeholder="3600"
                                    value={config.llmTimeout}
                                    onChange={(e) => updateConfig({ llmTimeout: parseInt(e.target.value, 10) || 3600 })}
                                />
                                <p className="text-secondary" style={{ fontSize: '0.75rem', marginTop: '4px' }}>
                                    Local models can take longer to process. Increase this if you get timeout errors.
                                </p>
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
                                        onClick={() => updateConfig({ selectedPromptId: prompt.id })}
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
                                        <span className="spinner" /> {summaryResult ? 'Generating...' : 'Started...'}
                                    </>
                                ) : (
                                    '🤖 Summarize'
                                )}
                            </button>

                            {llmStats && generationTimeMs && (
                                <div className="mt-md p-sm rounded bg-glass text-xs flex flex-wrap gap-md opacity-80">
                                    {llmStats.completion_tokens && generationTimeMs > 0 && (
                                        <span>
                                            ⚡ {(llmStats.completion_tokens / (generationTimeMs / 1000)).toFixed(1)} tokens/s
                                        </span>
                                    )}
                                    <span>
                                        🕒 {(generationTimeMs / 1000).toFixed(1)}s total
                                    </span>
                                    {llmStats.prompt_tokens && (
                                        <span>
                                            📥 {llmStats.prompt_tokens} prompt tokens
                                        </span>
                                    )}
                                </div>
                            )}
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
                                            <ReactMarkdown rehypePlugins={[rehypeRaw]}>
                                                {processThinkBlocks(summaryResult)}
                                            </ReactMarkdown>
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
