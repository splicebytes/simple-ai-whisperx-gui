import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { loadConfig } from '../lib/store';
import type { TranscriptionResultData } from '../App';

interface WhisperXWord {
    word: string;
    start: number;
    end: number;
    score: number;
    speaker?: string;
}

interface WhisperXSegment {
    start: number;
    end: number;
    text: string;
    speaker?: string;
    words?: WhisperXWord[];
}

interface WhisperXJson {
    segments: WhisperXSegment[];
}

interface SpeakerSample {
    text: string;
    start: number;
    end: number;
}

interface SpeakerData {
    label: string;
    samples: SpeakerSample[];
    assignedName: string;
    segmentCount: number;
}

interface SpeakerIdViewProps {
    lastResult: TranscriptionResultData | null;
    onNamesApplied?: () => void;
}

export default function SpeakerIdView({ lastResult, onNamesApplied }: SpeakerIdViewProps) {
    const [speakers, setSpeakers] = useState<SpeakerData[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [playingSegment, setPlayingSegment] = useState<string | null>(null);
    const [loadingSegment, setLoadingSegment] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const playTimerRef = useRef<number | null>(null);

    // Load and parse JSON when lastResult changes
    useEffect(() => {
        if (!lastResult || !lastResult.diarize) {
            setSpeakers([]);
            return;
        }

        const loadDiarization = async () => {
            setLoading(true);
            setError('');
            setSaved(false);
            setSpeakers([]); // Clear old speaker data immediately

            // Stop any ongoing playback
            if (audioRef.current) audioRef.current.pause();
            setPlayingSegment(null);

            try {
                const jsonPath = `${lastResult.outputDir}/${lastResult.baseName}.json`;
                const content = await invoke<string>('read_transcription_file', {
                    filePath: jsonPath,
                });

                const data: WhisperXJson = JSON.parse(content);
                const speakerMap = new Map<string, WhisperXSegment[]>();

                for (const segment of data.segments) {
                    if (segment.speaker) {
                        const existing = speakerMap.get(segment.speaker) || [];
                        existing.push(segment);
                        speakerMap.set(segment.speaker, existing);
                    }
                }

                const speakerList: SpeakerData[] = [];
                for (const [label, segments] of speakerMap) {
                    // Pick 3 representative samples: longest segments from different parts
                    const sorted = [...segments]
                        .filter((s) => s.text.trim().length > 10)
                        .sort((a, b) => (b.end - b.start) - (a.end - a.start));

                    const samples: SpeakerSample[] = [];
                    if (sorted.length <= 3) {
                        samples.push(
                            ...sorted.map((s) => ({
                                text: s.text.trim(),
                                start: s.start,
                                end: s.end,
                            }))
                        );
                    } else {
                        // Pick from thirds for variety
                        const third = Math.floor(sorted.length / 3);
                        const picks = [
                            sorted[0],
                            sorted[Math.min(third, sorted.length - 1)],
                            sorted[Math.min(third * 2, sorted.length - 1)],
                        ];
                        const seen = new Set<number>();
                        for (const p of picks) {
                            if (!seen.has(p.start)) {
                                seen.add(p.start);
                                samples.push({ text: p.text.trim(), start: p.start, end: p.end });
                            }
                        }
                        for (const s of sorted) {
                            if (samples.length >= 3) break;
                            if (!seen.has(s.start)) {
                                seen.add(s.start);
                                samples.push({ text: s.text.trim(), start: s.start, end: s.end });
                            }
                        }
                    }

                    speakerList.push({ label, samples, assignedName: '', segmentCount: segments.length });
                }

                speakerList.sort((a, b) => a.label.localeCompare(b.label));
                setSpeakers(speakerList);
            } catch (err) {
                setError(`Failed to load diarization data: ${err}`);
            } finally {
                setLoading(false);
            }
        };

        loadDiarization();
    }, [lastResult]);

    const formatTime = (seconds: number): string => {
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    };

    const playSegment = useCallback(
        async (speakerLabel: string, sampleIdx: number, start: number, originalEnd: number) => {
            const segId = `${speakerLabel}-${sampleIdx}`;
            const end = Math.min(originalEnd, start + 10); // Limit to 10 seconds maximum

            // Toggle pause if already playing this segment
            if (playingSegment === segId) {
                if (audioRef.current) audioRef.current.pause();
                if (playTimerRef.current) clearTimeout(playTimerRef.current);
                setPlayingSegment(null);
                return;
            }

            // Stop any existing playback
            if (audioRef.current) audioRef.current.pause();
            if (playTimerRef.current) clearTimeout(playTimerRef.current);
            setPlayingSegment(null);

            if (!lastResult?.audioPath) return;

            // Always reload config — user may have changed ffmpeg/conda paths in settings
            const freshConfig = await loadConfig();

            setLoadingSegment(segId);
            setError('');

            try {
                // Use ffmpeg via Rust to extract the segment as base64 MP3
                const dataUri = await invoke<string>('extract_audio_segment', {
                    audioPath: lastResult.audioPath,
                    start,
                    end,
                    ffmpegPath: freshConfig?.ffmpegPath || null,
                    condaPath: freshConfig?.condaPath || null,
                    condaEnv: freshConfig?.condaEnv || null,
                });

                setLoadingSegment(null);

                if (!audioRef.current) {
                    audioRef.current = new Audio();
                }

                const audio = audioRef.current;
                audio.src = dataUri;

                await audio.play();
                setPlayingSegment(segId);

                // Auto-stop when segment ends
                const duration = (end - start) * 1000;
                playTimerRef.current = window.setTimeout(() => {
                    audio.pause();
                    setPlayingSegment(null);
                }, duration);

                audio.onended = () => {
                    setPlayingSegment(null);
                    if (playTimerRef.current) clearTimeout(playTimerRef.current);
                };
            } catch (err) {
                setLoadingSegment(null);
                setError(`Playback error: ${err}`);
            }
        },
        [lastResult, playingSegment]
    );

    const updateSpeakerName = useCallback((label: string, name: string) => {
        setSpeakers((prev) =>
            prev.map((s) => (s.label === label ? { ...s, assignedName: name } : s))
        );
        setSaved(false);
    }, []);

    const applyNames = useCallback(async () => {
        if (!lastResult) return;

        const speakerMap: Record<string, string> = {};
        let hasAnyName = false;
        for (const speaker of speakers) {
            if (speaker.assignedName.trim()) {
                speakerMap[speaker.label] = speaker.assignedName.trim();
                hasAnyName = true;
            }
        }

        if (!hasAnyName) return;

        setSaving(true);
        try {
            await invoke('replace_speaker_names', {
                outputDir: lastResult.outputDir,
                baseName: lastResult.baseName,
                speakerMap,
            });
            setSaved(true);
            if (onNamesApplied) {
                onNamesApplied();
            }
        } catch (err) {
            setError(`Error saving: ${err}`);
        } finally {
            setSaving(false);
        }
    }, [lastResult, speakers]);

    // Cleanup audio on unmount
    useEffect(() => {
        return () => {
            if (audioRef.current) audioRef.current.pause();
            if (playTimerRef.current) clearTimeout(playTimerRef.current);
        };
    }, []);

    const hasNames = speakers.some((s) => s.assignedName.trim());

    if (!lastResult) {
        return (
            <div className="card">
                <div className="empty-state">
                    <div className="empty-state-icon">🎭</div>
                    <div className="empty-state-title">No transcription</div>
                    <div className="empty-state-text">
                        Run a transcription with diarization to identify speakers
                    </div>
                </div>
            </div>
        );
    }

    if (!lastResult.diarize) {
        return (
            <div className="card">
                <div className="empty-state">
                    <div className="empty-state-icon">🎭</div>
                    <div className="empty-state-title">Diarization disabled</div>
                    <div className="empty-state-text">
                        Enable diarization in transcription settings to identify speakers
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div>
            <div className="card mb-lg">
                <div className="card-header">
                    <h2 className="card-title">
                        <span className="card-title-icon">🎭</span>
                        Speaker identification
                    </h2>
                    {speakers.length > 0 && (
                        <span className="text-sm text-secondary">
                            Detected {speakers.length} voice{speakers.length === 1 ? '' : 's'}
                        </span>
                    )}
                </div>
                <p className="text-sm text-secondary mt-sm">
                    Listen to voice samples of each speaker and assign a name. After applying, SPEAKER_XX
                    labels will be replaced with names in all output files.
                </p>
            </div>

            {loading && (
                <div className="card mb-lg">
                    <div className="flex items-center gap-md">
                        <span className="spinner" />
                        <span>Loading diarization data...</span>
                    </div>
                </div>
            )}

            {error && (
                <div className="card mb-lg" style={{ borderColor: 'var(--color-error)' }}>
                    <div className="text-sm" style={{ color: 'var(--color-error)' }}>
                        ⚠ {error}
                        <button
                            className="btn btn-ghost btn-sm"
                            style={{ marginLeft: '8px' }}
                            onClick={() => setError('')}
                        >×</button>
                    </div>
                </div>
            )}

            {speakers.map((speaker) => (
                <div key={speaker.label} className="card mb-lg speaker-card">
                    <div className="speaker-card-header">
                        <div className="speaker-label">
                            <span className="speaker-badge">{speaker.label}</span>
                            <span className="text-sm text-secondary">
                                {speaker.segmentCount} utterances
                            </span>
                        </div>
                        <div className="speaker-name-input">
                            <input
                                className="form-input"
                                type="text"
                                placeholder="Enter name..."
                                value={speaker.assignedName}
                                onChange={(e) => updateSpeakerName(speaker.label, e.target.value)}
                            />
                        </div>
                    </div>

                    <div className="speaker-samples">
                        {speaker.samples.map((sample, idx) => {
                            const segId = `${speaker.label}-${idx}`;
                            const isPlaying = playingSegment === segId;
                            const isLoading = loadingSegment === segId;

                            return (
                                <div key={idx} className="speaker-sample">
                                    <button
                                        className={`btn btn-ghost btn-sm speaker-play-btn ${isPlaying ? 'playing' : ''}`}
                                        onClick={() => playSegment(speaker.label, idx, sample.start, sample.end)}
                                        disabled={isLoading || (loadingSegment !== null && loadingSegment !== segId)}
                                        title={`${formatTime(sample.start)} — ${formatTime(sample.end)}`}
                                    >
                                        {isLoading ? <span className="spinner" style={{ width: '12px', height: '12px' }} /> : isPlaying ? '⏸' : '▶'}
                                    </button>
                                    <div className="speaker-sample-text selectable-text">
                                        <span className="speaker-sample-time">
                                            {formatTime(sample.start)} — {formatTime(sample.end)}
                                        </span>
                                        <span className="speaker-sample-content">
                                            „{sample.text.length > 120
                                                ? sample.text.slice(0, 120) + '…'
                                                : sample.text}"
                                        </span>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            ))}

            {speakers.length > 0 && (
                <div className="card">
                    <button
                        className="btn btn-primary btn-full"
                        onClick={applyNames}
                        disabled={!hasNames || saving}
                    >
                        {saving ? (
                            <><span className="spinner" /> Saving...</>
                        ) : saved ? (
                            '✓ Saved! Files updated'
                        ) : (
                            '✏️ Apply names to transcription files'
                        )}
                    </button>
                </div>
            )}
        </div>
    );
}
