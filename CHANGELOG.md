# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-03-13

### Added
- Real-time streaming for LLM summaries (tokens appear as they are generated).
- Parsing of reasoning/thinking blocks (e.g. `<think>` from DeepSeek models) into beautiful collapsible UI widgets.
- LLM generation statistics (tokens per second, total duration) displayed post-generation.

### Fixed
- Fixed markdown wrapping issues for LLM results by removing forced whitespace wrapping.

## [0.1.1] - 2026-03-03

### Fixed
- Improved GitHub Release automation to correctly extract release notes from CHANGELOG.md based on the pushed tag version.
- Fixed automated binary attachment to GitHub Releases for all platforms.

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
