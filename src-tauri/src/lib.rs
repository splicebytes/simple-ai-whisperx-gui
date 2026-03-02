use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::Mutex;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TranscriptionRequest {
    pub audio_path: String,
    pub language: String,
    pub model: String,
    pub diarize: bool,
    pub normalize_audio: bool,
    pub hf_token: String,
    pub output_dir: Option<String>,
    pub device: String,
    pub compute_type: String,
    pub whisperx_cmd: Option<String>,
    pub ffmpeg_path: Option<String>,
    pub conda_path: Option<String>,
    pub conda_env: Option<String>,
}

/// Auto-detect conda installation path on the system
fn find_conda_path() -> Option<String> {
    // 1. Check CONDA_EXE env var (set when conda is active)
    if let Ok(conda_exe) = std::env::var("CONDA_EXE") {
        let conda_dir = PathBuf::from(&conda_exe)
            .parent()
            .and_then(|p| p.parent())
            .map(|p| p.to_path_buf());
        if let Some(dir) = conda_dir {
            if dir.join("condabin").exists() {
                return Some(dir.to_string_lossy().to_string());
            }
        }
    }

    // 2. Check common installation locations
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();

    let candidates = [
        format!("{}\\miniconda3", home),
        format!("{}\\anaconda3", home),
        format!("{}\\Miniconda3", home),
        format!("{}\\Anaconda3", home),
        format!("{}\\AppData\\Local\\miniconda3", home),
        format!("{}\\AppData\\Local\\anaconda3", home),
        // Unix-like paths
        format!("{}/miniconda3", home),
        format!("{}/anaconda3", home),
        "/opt/conda".to_string(),
        "/opt/miniconda3".to_string(),
    ];

    for candidate in &candidates {
        let path = PathBuf::from(candidate);
        if path.join("condabin").exists() {
            return Some(path.to_string_lossy().to_string());
        }
    }

    None
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LlmRequest {
    pub endpoint: String,
    pub model: String,
    pub prompt: String,
    pub transcription_text: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LlmResponse {
    pub summary: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct ProcessOutput {
    pub line: String,
    pub stream: String, // "stdout" or "stderr"
}

#[derive(Debug, Serialize, Clone)]
pub struct TranscriptionResult {
    pub success: bool,
    pub output_dir: String,
    pub error: Option<String>,
    pub processed_audio_path: Option<String>,
}

// Global process handle for cancellation
struct AppState {
    running_process: Arc<Mutex<Option<u32>>>,
}

#[tauri::command]
async fn run_whisperx(
    app: AppHandle,
    request: TranscriptionRequest,
) -> Result<TranscriptionResult, String> {
    let mut audio_path = PathBuf::from(&request.audio_path);

    if !audio_path.exists() {
        return Err(format!("Audio file not found: {}", request.audio_path));
    }

    let work_dir = audio_path
        .parent()
        .ok_or("Cannot determine parent directory")?
        .to_path_buf();

    let output_dir = request
        .output_dir
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(|| work_dir.clone());

    let whisperx_cmd = request
        .whisperx_cmd
        .clone()
        .unwrap_or_else(|| "whisperx".to_string());

    // Resolve conda path: explicit config > auto-detect > none
    let conda_path = request
        .conda_path
        .as_ref()
        .filter(|s| !s.is_empty())
        .cloned()
        .or_else(find_conda_path);

    let conda_env = request
        .conda_env
        .as_ref()
        .filter(|s| !s.is_empty())
        .cloned()
        .unwrap_or_else(|| "base".to_string());

    // Resolve the full absolute path to the whisperx executable.
    // CRITICAL: Command::new() uses the PARENT process's PATH to find executables,
    // not the child's modified env. So we must resolve the path ourselves before
    // creating the Command, otherwise the OS won't find whisperx in conda's directories.
    let resolved_cmd = if let Some(ref conda_dir) = conda_path {
        let conda_root = PathBuf::from(conda_dir);
        let env_root = if conda_env == "base" {
            conda_root.clone()
        } else {
            conda_root.join("envs").join(&conda_env)
        };

        // Try multiple candidate locations for the whisperx executable
        let candidates: Vec<PathBuf> = if cfg!(target_os = "windows") {
            vec![
                env_root.join("Scripts").join("whisperx.exe"),
                env_root.join("Scripts").join("whisperx.bat"),
                env_root.join("Scripts").join("whisperx"),
            ]
        } else {
            vec![env_root.join("bin").join("whisperx")]
        };

        // Also try the user-specified whisperx_cmd if it looks like a path
        let whisperx_path = PathBuf::from(&whisperx_cmd);
        let found = candidates
            .iter()
            .find(|c| c.exists())
            .map(|c| c.to_string_lossy().to_string())
            .or_else(|| {
                if whisperx_path.is_absolute() && whisperx_path.exists() {
                    Some(whisperx_cmd.clone())
                } else {
                    None
                }
            });

        // Emit candidate search results for troubleshooting
        let _ = app.emit(
            "whisperx-output",
            ProcessOutput {
                line: format!(
                    "ℹ Conda env: {} (exists: {})",
                    env_root.display(),
                    env_root.exists()
                ),
                stream: "stderr".to_string(),
            },
        );

        found.unwrap_or_else(|| whisperx_cmd.clone())
    } else {
        // No conda configured — try to find whisperx in common global pip locations
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_default();

        let global_candidates: Vec<PathBuf> = if cfg!(target_os = "windows") {
            // Common Windows Python install locations
            let mut paths = Vec::new();
            // Check Python 3.10, 3.11, 3.12 in common locations
            for ver in &["311", "310", "312", "313", "39"] {
                paths.push(
                    PathBuf::from(&home)
                        .join("AppData")
                        .join("Local")
                        .join("Programs")
                        .join("Python")
                        .join(format!("Python{}", ver))
                        .join("Scripts")
                        .join("whisperx.exe"),
                );
            }
            paths.push(
                PathBuf::from(&home)
                    .join("AppData")
                    .join("Roaming")
                    .join("Python")
                    .join("Scripts")
                    .join("whisperx.exe"),
            );
            paths
        } else {
            vec![
                PathBuf::from(&home)
                    .join(".local")
                    .join("bin")
                    .join("whisperx"),
                PathBuf::from("/usr/local/bin/whisperx"),
                PathBuf::from("/usr/bin/whisperx"),
            ]
        };

        // Also try user-specified path
        let whisperx_path = PathBuf::from(&whisperx_cmd);
        global_candidates
            .iter()
            .find(|c| c.exists())
            .map(|c| c.to_string_lossy().to_string())
            .or_else(|| {
                if whisperx_path.is_absolute() && whisperx_path.exists() {
                    Some(whisperx_cmd.clone())
                } else {
                    None
                }
            })
            .unwrap_or_else(|| whisperx_cmd.clone())
    };

    // Emit resolved path info for troubleshooting
    let _ = app.emit(
        "whisperx-output",
        ProcessOutput {
            line: format!("ℹ Using: {}", resolved_cmd),
            stream: "stderr".to_string(),
        },
    );

    // Provide an option to normalize audio to 16kHz Mono WAV
    // This is especially beneficial for Pyannote (diarization) accuracy.
    let mut temp_audio_dir: Option<PathBuf> = None;
    if request.diarize && request.normalize_audio {
        let _ = app.emit(
            "whisperx-output",
            ProcessOutput {
                line: "ℹ Normalizing audio to 16kHz Mono WAV for better diarization...".to_string(),
                stream: "info".to_string(),
            },
        );

        // Resolve absolute ffmpeg path, similar to extract_audio_segment
        let ffmpeg_cmd: String = {
            let user_specified = request.ffmpeg_path.as_deref().filter(|p| !p.is_empty());

            if let Some(p) = user_specified {
                let pb = PathBuf::from(p);
                if pb.is_absolute() && pb.exists() {
                    p.to_string()
                } else if let Some(ref conda_dir) = conda_path {
                    let conda_root = PathBuf::from(conda_dir);
                    let env_root = if conda_env == "base" {
                        conda_root.clone()
                    } else {
                        conda_root.join("envs").join(&conda_env)
                    };
                    let candidates: Vec<PathBuf> = if cfg!(target_os = "windows") {
                        vec![
                            env_root.join("Library").join("bin").join("ffmpeg.exe"),
                            env_root.join("Scripts").join("ffmpeg.exe"),
                            env_root
                                .join("Library")
                                .join("mingw-w64")
                                .join("bin")
                                .join("ffmpeg.exe"),
                        ]
                    } else {
                        vec![env_root.join("bin").join("ffmpeg")]
                    };
                    candidates
                        .iter()
                        .find(|c| c.exists())
                        .map(|c| c.to_string_lossy().to_string())
                        .unwrap_or_else(|| p.to_string())
                } else {
                    p.to_string()
                }
            } else if let Some(ref conda_dir) = conda_path {
                let conda_root = PathBuf::from(conda_dir);
                let env_root = if conda_env == "base" {
                    conda_root.clone()
                } else {
                    conda_root.join("envs").join(&conda_env)
                };
                let candidates: Vec<PathBuf> = if cfg!(target_os = "windows") {
                    vec![
                        env_root.join("Library").join("bin").join("ffmpeg.exe"),
                        env_root.join("Scripts").join("ffmpeg.exe"),
                        env_root
                            .join("Library")
                            .join("mingw-w64")
                            .join("bin")
                            .join("ffmpeg.exe"),
                    ]
                } else {
                    vec![env_root.join("bin").join("ffmpeg")]
                };
                candidates
                    .iter()
                    .find(|c| c.exists())
                    .map(|c| c.to_string_lossy().to_string())
                    .unwrap_or_else(|| "ffmpeg".to_string())
            } else {
                "ffmpeg".to_string()
            }
        };

        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let unique_temp_dir = std::env::temp_dir().join(format!("whisperx_norm_{}", timestamp));
        let _ = std::fs::create_dir_all(&unique_temp_dir);
        let original_stem = audio_path.file_stem().unwrap_or_default().to_string_lossy();
        let target_wav = unique_temp_dir.join(format!("{}.wav", original_stem));

        let mut ffmpeg_proc = Command::new(&ffmpeg_cmd);

        let mut path_parts: Vec<String> = Vec::new();
        let ffmpeg_pb = PathBuf::from(&ffmpeg_cmd);
        if ffmpeg_pb.is_absolute() {
            if let Some(parent) = ffmpeg_pb.parent() {
                path_parts.push(parent.to_string_lossy().to_string());
            }
        }

        if let Some(ref conda_dir) = conda_path {
            let conda_root = PathBuf::from(conda_dir);
            let env_root = if conda_env == "base" {
                conda_root.clone()
            } else {
                conda_root.join("envs").join(&conda_env)
            };
            path_parts.push(env_root.to_string_lossy().to_string());
            path_parts.push(env_root.join("Scripts").to_string_lossy().to_string());
            path_parts.push(
                env_root
                    .join("Library")
                    .join("bin")
                    .to_string_lossy()
                    .to_string(),
            );
            path_parts.push(
                env_root
                    .join("Library")
                    .join("mingw-w64")
                    .join("bin")
                    .to_string_lossy()
                    .to_string(),
            );
            path_parts.push(conda_root.join("condabin").to_string_lossy().to_string());
        }

        let current_path = std::env::var("PATH").unwrap_or_default();
        path_parts.push(current_path);
        let separator = if cfg!(target_os = "windows") {
            ";"
        } else {
            ":"
        };
        ffmpeg_proc.env("PATH", path_parts.join(separator));

        #[cfg(target_os = "windows")]
        {
            ffmpeg_proc.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        ffmpeg_proc.args([
            "-nostdin",
            "-y",
            "-i",
            audio_path.to_str().unwrap(),
            "-ar",
            "16000",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            target_wav.to_str().unwrap(),
        ]);

        ffmpeg_proc
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        match ffmpeg_proc.output().await {
            Ok(output) if output.status.success() => {
                audio_path = target_wav.clone();
                temp_audio_dir = Some(unique_temp_dir.clone());
                let _ = app.emit(
                    "whisperx-output",
                    ProcessOutput {
                        line: "ℹ Normalization complete.".to_string(),
                        stream: "info".to_string(),
                    },
                );
            }
            Ok(output) => {
                let err_str = String::from_utf8_lossy(&output.stderr);
                let _ = app.emit(
                    "whisperx-output",
                    ProcessOutput {
                        line: format!("⚠ Normalization failed, proceeding with original audio. FFmpeg error: {}", err_str),
                        stream: "warning".to_string(),
                    },
                );
            }
            Err(err) => {
                let _ = app.emit(
                    "whisperx-output",
                    ProcessOutput {
                        line: format!("⚠ Normalization failed, proceeding with original audio. Could not start FFmpeg: {}", err),
                        stream: "warning".to_string(),
                    },
                );
            }
        }
    }

    // Build whisperx command with the resolved path
    let mut cmd = Command::new(&resolved_cmd);
    cmd.arg(&audio_path)
        .arg("--model")
        .arg(&request.model)
        .arg("--language")
        .arg(&request.language)
        .arg("--device")
        .arg(&request.device)
        .arg("--compute_type")
        .arg(&request.compute_type)
        .arg("--output_dir")
        .arg(output_dir.to_string_lossy().to_string());

    if request.diarize {
        cmd.arg("--diarize")
            .arg("--hf_token")
            .arg(&request.hf_token);
    }

    // Force UTF-8 encoding
    cmd.env("PYTHONIOENCODING", "utf-8");
    cmd.env("PYTHONUTF8", "1");

    // Build PATH with environment directories
    let mut path_parts: Vec<String> = Vec::new();

    // If we resolved an absolute path, add its parent dir and sibling dirs to PATH
    // This helps global pip installs find Python and DLLs
    let resolved_path = PathBuf::from(&resolved_cmd);
    if resolved_path.is_absolute() {
        if let Some(parent) = resolved_path.parent() {
            path_parts.push(parent.to_string_lossy().to_string());
            // Also add the env root (one level up from Scripts/ or bin/)
            if let Some(env_root) = parent.parent() {
                path_parts.push(env_root.to_string_lossy().to_string());
                if cfg!(target_os = "windows") {
                    path_parts.push(
                        env_root
                            .join("Library")
                            .join("bin")
                            .to_string_lossy()
                            .to_string(),
                    );
                }
            }
        }
    }

    if let Some(ref conda_dir) = conda_path {
        let conda_root = PathBuf::from(conda_dir);
        let env_root = if conda_env == "base" {
            conda_root.clone()
        } else {
            conda_root.join("envs").join(&conda_env)
        };

        path_parts.push(env_root.to_string_lossy().to_string());
        path_parts.push(env_root.join("Scripts").to_string_lossy().to_string());
        path_parts.push(
            env_root
                .join("Library")
                .join("bin")
                .to_string_lossy()
                .to_string(),
        );
        path_parts.push(
            env_root
                .join("Library")
                .join("mingw-w64")
                .join("bin")
                .to_string_lossy()
                .to_string(),
        );
        path_parts.push(conda_root.join("condabin").to_string_lossy().to_string());

        cmd.env("CONDA_PREFIX", env_root.to_string_lossy().to_string());
        cmd.env("CONDA_DEFAULT_ENV", &conda_env);
    }

    if let Some(ffmpeg_path) = &request.ffmpeg_path {
        if let Some(ffmpeg_dir) = PathBuf::from(ffmpeg_path).parent() {
            path_parts.push(ffmpeg_dir.to_string_lossy().to_string());
        }
    }

    let current_path = std::env::var("PATH").unwrap_or_default();
    path_parts.push(current_path);
    let separator = if cfg!(target_os = "windows") {
        ";"
    } else {
        ":"
    };
    cmd.env("PATH", path_parts.join(separator));

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }

    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    // Emit start event
    let _ = app.emit("whisperx-status", "starting");

    let mut child = cmd
        .spawn()
        .map_err(|e| {
            format!(
                "Failed to start WhisperX (cmd: '{}', exists: {}): {}. Make sure whisperx is installed and conda path is configured in Settings.",
                resolved_cmd,
                PathBuf::from(&resolved_cmd).exists(),
                e
            )
        })?;

    // Store PID for potential cancellation
    if let Some(pid) = child.id() {
        let state = app.state::<AppState>();
        *state.running_process.lock().await = Some(pid);
    }

    // Stream stdout
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let app_stdout = app.clone();
    let app_stderr = app.clone();

    let stdout_handle = tokio::spawn(async move {
        if let Some(mut stdout) = stdout {
            let mut buf = [0; 1024];
            let mut current_line = String::new();
            while let Ok(n) = stdout.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                let text = String::from_utf8_lossy(&buf[..n]);
                for c in text.chars() {
                    if c == '\n' || c == '\r' {
                        if !current_line.is_empty() {
                            let _ = app_stdout.emit(
                                "whisperx-output",
                                ProcessOutput {
                                    line: current_line.clone(),
                                    stream: "stdout".to_string(),
                                },
                            );
                            current_line.clear();
                        }
                    } else {
                        current_line.push(c);
                    }
                }
            }
            if !current_line.is_empty() {
                let _ = app_stdout.emit(
                    "whisperx-output",
                    ProcessOutput {
                        line: current_line,
                        stream: "stdout".to_string(),
                    },
                );
            }
        }
    });

    let stderr_handle = tokio::spawn(async move {
        if let Some(mut stderr) = stderr {
            let mut buf = [0; 1024];
            let mut current_line = String::new();
            while let Ok(n) = stderr.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                let text = String::from_utf8_lossy(&buf[..n]);
                for c in text.chars() {
                    if c == '\n' || c == '\r' {
                        if !current_line.is_empty() {
                            let _ = app_stderr.emit(
                                "whisperx-output",
                                ProcessOutput {
                                    line: current_line.clone(),
                                    stream: "stderr".to_string(),
                                },
                            );
                            current_line.clear();
                        }
                    } else {
                        current_line.push(c);
                    }
                }
            }
            if !current_line.is_empty() {
                let _ = app_stderr.emit(
                    "whisperx-output",
                    ProcessOutput {
                        line: current_line,
                        stream: "stderr".to_string(),
                    },
                );
            }
        }
    });

    // Wait for process to complete
    let status = child
        .wait()
        .await
        .map_err(|e| format!("Process error: {}", e))?;

    let _ = stdout_handle.await;
    let _ = stderr_handle.await;

    // Clear PID
    let state = app.state::<AppState>();
    *state.running_process.lock().await = None;

    // Cleanup temporary normalized audio file if it exists
    if let Some(tmp_dir) = temp_audio_dir {
        let _ = tokio::fs::remove_dir_all(tmp_dir).await;
    }

    if status.success() {
        let _ = app.emit("whisperx-status", "completed");
        Ok(TranscriptionResult {
            success: true,
            output_dir: output_dir.to_string_lossy().to_string(),
            error: None,
            processed_audio_path: Some(audio_path.to_string_lossy().to_string()),
        })
    } else {
        let error_msg = format!("WhisperX exited with code: {:?}", status.code());
        let _ = app.emit("whisperx-status", "error");
        Ok(TranscriptionResult {
            success: false,
            output_dir: output_dir.to_string_lossy().to_string(),
            error: Some(error_msg),
            processed_audio_path: None,
        })
    }
}

#[tauri::command]
async fn cancel_whisperx(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let pid = state.running_process.lock().await.take();

    if let Some(pid) = pid {
        #[cfg(target_os = "windows")]
        {
            // taskkill on Windows
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .output();
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = std::process::Command::new("kill")
                .args(["-9", &pid.to_string()])
                .output();
        }
        let _ = app.emit("whisperx-status", "cancelled");
        Ok(())
    } else {
        Err("No running process to cancel".to_string())
    }
}

#[tauri::command]
async fn read_transcription_file(file_path: String) -> Result<String, String> {
    tokio::fs::read_to_string(&file_path)
        .await
        .map_err(|e| format!("Failed to read file {}: {}", file_path, e))
}

#[tauri::command]
fn get_output_files(output_dir: String, base_name: String) -> Result<Vec<String>, String> {
    let dir = PathBuf::from(&output_dir);
    if !dir.exists() {
        return Err(format!("Directory not found: {}", output_dir));
    }

    let extensions = ["txt", "srt", "vtt", "tsv", "json"];
    let mut files = Vec::new();

    for ext in &extensions {
        let file_path = dir.join(format!("{}.{}", base_name, ext));
        if file_path.exists() {
            files.push(file_path.to_string_lossy().to_string());
        }
    }

    Ok(files)
}

#[tauri::command]
async fn run_llm_summary(request: LlmRequest) -> Result<LlmResponse, String> {
    let client = reqwest::Client::new();

    // Build the full prompt with transcription
    let full_prompt = format!(
        "{}\n\n---\nTranscription:\n{}",
        request.prompt, request.transcription_text
    );

    // Try Ollama-compatible API format
    let body = serde_json::json!({
        "model": request.model,
        "messages": [
            {
                "role": "user",
                "content": full_prompt
            }
        ],
        "stream": false
    });

    let endpoint = if request.endpoint.ends_with('/') {
        format!("{}v1/chat/completions", request.endpoint)
    } else {
        format!("{}/v1/chat/completions", request.endpoint)
    };

    let response = client
        .post(&endpoint)
        .json(&body)
        .timeout(std::time::Duration::from_secs(300))
        .send()
        .await
        .map_err(|e| format!("LLM request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("LLM API error ({}): {}", status, text));
    }

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse LLM response: {}", e))?;

    let summary = json["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("No response generated")
        .to_string();

    Ok(LlmResponse { summary })
}

#[tauri::command]
async fn replace_speaker_names(
    output_dir: String,
    base_name: String,
    speaker_map: HashMap<String, String>,
) -> Result<(), String> {
    let dir = PathBuf::from(&output_dir);

    // Replace in text-based files (TXT, SRT, VTT, TSV)
    let text_extensions = ["txt", "srt", "vtt", "tsv"];
    for ext in &text_extensions {
        let file_path = dir.join(format!("{}.{}", base_name, ext));
        if file_path.exists() {
            let content = tokio::fs::read_to_string(&file_path)
                .await
                .map_err(|e| format!("Failed to read {}: {}", file_path.display(), e))?;

            let mut updated = content;
            for (speaker_label, name) in &speaker_map {
                updated = updated.replace(speaker_label, name);
            }

            tokio::fs::write(&file_path, updated)
                .await
                .map_err(|e| format!("Failed to write {}: {}", file_path.display(), e))?;
        }
    }

    // Replace in JSON file (both segment-level and word-level speaker fields)
    let json_path = dir.join(format!("{}.json", base_name));
    if json_path.exists() {
        let content = tokio::fs::read_to_string(&json_path)
            .await
            .map_err(|e| format!("Failed to read {}: {}", json_path.display(), e))?;

        let mut json: serde_json::Value =
            serde_json::from_str(&content).map_err(|e| format!("Failed to parse JSON: {}", e))?;

        if let Some(segments) = json.get_mut("segments").and_then(|s| s.as_array_mut()) {
            for segment in segments {
                // Replace segment-level speaker
                if let Some(speaker) = segment.get("speaker").and_then(|s| s.as_str()) {
                    if let Some(name) = speaker_map.get(speaker) {
                        segment["speaker"] = serde_json::Value::String(name.clone());
                    }
                }
                // Replace word-level speakers
                if let Some(words) = segment.get_mut("words").and_then(|w| w.as_array_mut()) {
                    for word in words {
                        if let Some(speaker) = word.get("speaker").and_then(|s| s.as_str()) {
                            if let Some(name) = speaker_map.get(speaker) {
                                word["speaker"] = serde_json::Value::String(name.clone());
                            }
                        }
                    }
                }
            }
        }

        // Also replace in word_segments if present
        if let Some(word_segments) = json.get_mut("word_segments").and_then(|w| w.as_array_mut()) {
            for word in word_segments {
                if let Some(speaker) = word.get("speaker").and_then(|s| s.as_str()) {
                    if let Some(name) = speaker_map.get(speaker) {
                        word["speaker"] = serde_json::Value::String(name.clone());
                    }
                }
            }
        }

        let updated = serde_json::to_string_pretty(&json)
            .map_err(|e| format!("Failed to serialize JSON: {}", e))?;

        tokio::fs::write(&json_path, updated)
            .await
            .map_err(|e| format!("Failed to write {}: {}", json_path.display(), e))?;
    }

    Ok(())
}

#[tauri::command]
async fn extract_audio_segment(
    audio_path: String,
    start: f64,
    end: f64,
    ffmpeg_path: Option<String>,
    conda_path: Option<String>,
    conda_env: Option<String>,
) -> Result<String, String> {
    let duration = end - start;
    if duration <= 0.0 {
        return Err("Invalid segment: end must be after start".to_string());
    }

    // Resolve conda env root (same logic as run_whisperx)
    let effective_conda_path = conda_path
        .as_ref()
        .filter(|s| !s.is_empty())
        .cloned()
        .or_else(find_conda_path);

    let effective_conda_env = conda_env
        .as_ref()
        .filter(|s| !s.is_empty())
        .cloned()
        .unwrap_or_else(|| "base".to_string());

    // Resolve absolute ffmpeg path, searching conda directories if needed
    let ffmpeg_cmd: String = {
        let user_specified = ffmpeg_path.as_deref().filter(|p| !p.is_empty());

        // If user gave a full absolute path, use it directly
        if let Some(p) = user_specified {
            let pb = PathBuf::from(p);
            if pb.is_absolute() && pb.exists() {
                p.to_string()
            } else {
                // Try to find ffmpeg in conda dirs or fall back to what the user gave
                if let Some(ref conda_dir) = effective_conda_path {
                    let conda_root = PathBuf::from(conda_dir);
                    let env_root = if effective_conda_env == "base" {
                        conda_root.clone()
                    } else {
                        conda_root.join("envs").join(&effective_conda_env)
                    };
                    let candidates: Vec<PathBuf> = if cfg!(target_os = "windows") {
                        vec![
                            env_root.join("Library").join("bin").join("ffmpeg.exe"),
                            env_root.join("Scripts").join("ffmpeg.exe"),
                            env_root
                                .join("Library")
                                .join("mingw-w64")
                                .join("bin")
                                .join("ffmpeg.exe"),
                        ]
                    } else {
                        vec![env_root.join("bin").join("ffmpeg")]
                    };
                    candidates
                        .iter()
                        .find(|c| c.exists())
                        .map(|c| c.to_string_lossy().to_string())
                        .unwrap_or_else(|| p.to_string())
                } else {
                    p.to_string()
                }
            }
        } else {
            // No user-specified path — search conda dirs
            if let Some(ref conda_dir) = effective_conda_path {
                let conda_root = PathBuf::from(conda_dir);
                let env_root = if effective_conda_env == "base" {
                    conda_root.clone()
                } else {
                    conda_root.join("envs").join(&effective_conda_env)
                };
                let candidates: Vec<PathBuf> = if cfg!(target_os = "windows") {
                    vec![
                        env_root.join("Library").join("bin").join("ffmpeg.exe"),
                        env_root.join("Scripts").join("ffmpeg.exe"),
                        env_root
                            .join("Library")
                            .join("mingw-w64")
                            .join("bin")
                            .join("ffmpeg.exe"),
                    ]
                } else {
                    vec![env_root.join("bin").join("ffmpeg")]
                };
                candidates
                    .iter()
                    .find(|c| c.exists())
                    .map(|c| c.to_string_lossy().to_string())
                    .unwrap_or_else(|| "ffmpeg".to_string())
            } else {
                "ffmpeg".to_string()
            }
        }
    };

    // Build PATH with conda dirs (same as run_whisperx) so DLLs are found
    let mut cmd = tokio::process::Command::new(&ffmpeg_cmd);

    let mut path_parts: Vec<String> = Vec::new();

    // Add ffmpeg's own directory so sibling DLLs are found
    let ffmpeg_pb = PathBuf::from(&ffmpeg_cmd);
    if ffmpeg_pb.is_absolute() {
        if let Some(parent) = ffmpeg_pb.parent() {
            path_parts.push(parent.to_string_lossy().to_string());
        }
    }

    if let Some(ref conda_dir) = effective_conda_path {
        let conda_root = PathBuf::from(conda_dir);
        let env_root = if effective_conda_env == "base" {
            conda_root.clone()
        } else {
            conda_root.join("envs").join(&effective_conda_env)
        };
        path_parts.push(env_root.to_string_lossy().to_string());
        path_parts.push(env_root.join("Scripts").to_string_lossy().to_string());
        path_parts.push(
            env_root
                .join("Library")
                .join("bin")
                .to_string_lossy()
                .to_string(),
        );
        path_parts.push(
            env_root
                .join("Library")
                .join("mingw-w64")
                .join("bin")
                .to_string_lossy()
                .to_string(),
        );
        path_parts.push(conda_root.join("condabin").to_string_lossy().to_string());
    }

    let current_path = std::env::var("PATH").unwrap_or_default();
    path_parts.push(current_path);
    let separator = if cfg!(target_os = "windows") {
        ";"
    } else {
        ":"
    };
    cmd.env("PATH", path_parts.join(separator));

    // Suppress console window on Windows
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    cmd.args([
        "-nostdin",
        "-y",
        "-ss",
        &format!("{:.3}", start),
        "-i",
        &audio_path,
        "-t",
        &format!("{:.3}", duration),
        "-f",
        "mp3",
        "-acodec",
        "libmp3lame",
        "-ab",
        "64k",
        "-ac",
        "1",
        "pipe:1",
    ])
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::null());

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run ffmpeg: {}", e))?;

    if output.stdout.is_empty() {
        return Err(format!(
            "ffmpeg produced no output (exit code: {}). Check audio path and ffmpeg installation.",
            output.status
        ));
    }

    // Encode as base64 data URI
    let b64 = base64::engine::general_purpose::STANDARD.encode(&output.stdout);
    Ok(format!("data:audio/mpeg;base64,{}", b64))
}

#[tauri::command]
async fn save_text_file(file_path: String, content: String) -> Result<(), String> {
    tokio::fs::write(&file_path, content)
        .await
        .map_err(|e| format!("Failed to save file: {}", e))
}

#[tauri::command]
async fn detect_conda_path() -> Result<String, String> {
    find_conda_path().ok_or_else(|| "No conda installation found in common locations.".to_string())
}

/// Clean up stale whisperx temporary directories from the system temp folder.
/// Optionally exclude a specific directory (e.g., the currently active output dir).
#[tauri::command]
async fn cleanup_whisperx_temp(exclude_dir: Option<String>) -> Result<Vec<String>, String> {
    let temp_dir = std::env::temp_dir();
    let mut cleaned = Vec::new();

    let exclude = exclude_dir.map(PathBuf::from);

    if let Ok(entries) = std::fs::read_dir(&temp_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if (name.starts_with("whisperx_") || name.starts_with("whisperx_norm_"))
                && entry.path().is_dir()
            {
                // Skip the currently active directory if specified
                if let Some(ref excl) = exclude {
                    if entry.path() == *excl {
                        continue;
                    }
                }
                if std::fs::remove_dir_all(entry.path()).is_ok() {
                    cleaned.push(name);
                }
            }
        }
    }

    Ok(cleaned)
}

/// Diagnostic: list all temp directories, app data paths, and any whisperx-related
/// cache locations on the system so the user can inspect what persists across runs.
#[tauri::command]
async fn get_debug_temp_paths(app: AppHandle) -> Result<HashMap<String, Vec<String>>, String> {
    let mut result: HashMap<String, Vec<String>> = HashMap::new();

    // 1. System temp directory — whisperx_* and whisperx_norm_* folders
    let temp_dir = std::env::temp_dir();
    result.insert(
        "temp_dir".to_string(),
        vec![temp_dir.to_string_lossy().to_string()],
    );

    let mut temp_entries = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&temp_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("whisperx")
                || name.starts_with("pyannote")
                || name.starts_with("torch")
            {
                let meta = entry.metadata().ok();
                let size_info = if let Some(m) = &meta {
                    if m.is_dir() {
                        "dir"
                    } else {
                        "file"
                    }
                } else {
                    "?"
                };
                // List files inside the directory
                let mut contents = Vec::new();
                if entry.path().is_dir() {
                    if let Ok(inner) = std::fs::read_dir(entry.path()) {
                        for inner_entry in inner.flatten() {
                            let fname = inner_entry.file_name().to_string_lossy().to_string();
                            let fmeta = inner_entry.metadata().ok();
                            let fsize = fmeta
                                .map(|m| format!("{} bytes", m.len()))
                                .unwrap_or_else(|| "?".to_string());
                            contents.push(format!("  {} ({})", fname, fsize));
                        }
                    }
                }
                let mut line = format!("{} [{}]", name, size_info);
                for c in &contents {
                    line.push_str(&format!("\n{}", c));
                }
                temp_entries.push(line);
            }
        }
    }
    result.insert("temp_whisperx_entries".to_string(), temp_entries);

    // 2. Tauri app data directory (store config, etc.)
    if let Ok(app_data) = app.path().app_data_dir() {
        let mut app_files = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&app_data) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                let size = entry
                    .metadata()
                    .map(|m| format!("{} bytes", m.len()))
                    .unwrap_or_else(|_| "?".to_string());
                app_files.push(format!("{} ({})", name, size));
            }
        }
        result.insert(
            "app_data_dir".to_string(),
            vec![app_data.to_string_lossy().to_string()],
        );
        result.insert("app_data_files".to_string(), app_files);
    }

    // 3. HuggingFace / Torch / Pyannote cache dirs
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    let cache_dirs = vec![
        format!("{}\\.cache\\huggingface", home),
        format!("{}\\.cache\\torch", home),
        format!("{}\\AppData\\Local\\torch", home),
    ];
    let mut cache_info = Vec::new();
    for dir in &cache_dirs {
        let exists = PathBuf::from(dir).exists();
        cache_info.push(format!("{} (exists: {})", dir, exists));
    }
    result.insert("model_cache_dirs".to_string(), cache_info);

    Ok(result)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            running_process: Arc::new(Mutex::new(None)),
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            run_whisperx,
            cancel_whisperx,
            read_transcription_file,
            get_output_files,
            run_llm_summary,
            replace_speaker_names,
            extract_audio_segment,
            save_text_file,
            detect_conda_path,
            cleanup_whisperx_temp,
            get_debug_temp_paths,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
