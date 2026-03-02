# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-03-01

### Added
- Audio transcription using WhisperX with support for multiple languages and models (tiny → large-v3).
- Speaker diarization with HuggingFace pyannote integration.
- Speaker identification view with audio playback preview and name assignment.
- LLM summary integration supporting Ollama, LM Studio, and OpenAI-compatible endpoints.
- Customizable prompt templates for LLM summarization (Summary, Action Items, Meeting Minutes).
- Multiple output formats: TXT, SRT, VTT, TSV, JSON.
- Configurable auto-save or manual "Save As…" file saving strategy.
- Sound notification on transcription completion.
- Settings panel for HuggingFace token, FFmpeg/WhisperX paths, compute device, and default preferences.
- Markdown rendering toggle for LLM summary results.
- Cross-platform support via Tauri (Windows, macOS, Linux).
