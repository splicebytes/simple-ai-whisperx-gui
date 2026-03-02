# Troubleshooting Guide

This guide covers common issues you may encounter when setting up and running **Simple AI WhisperX GUI**.

---

## Table of Contents

- [WhisperX Not Found](#whisperx-not-found)
- [Python / Conda Issues](#python--conda-issues)
- [CUDA / GPU Issues](#cuda--gpu-issues)
- [FFmpeg Issues](#ffmpeg-issues)
- [HuggingFace / Diarization Issues](#huggingface--diarization-issues)
- [General Tips](#general-tips)

---

## WhisperX Not Found

### Symptom
The app shows an error like `Failed to start WhisperX` or `'whisperx' is not recognized`.

### Cause
Desktop GUI applications don't inherit your terminal's shell configuration (like conda activation hooks or `~/.bashrc`). The app needs to know exactly where WhisperX is installed.

### Solution

**Option 1: Conda Environment (Recommended)**

1. **Set your Conda path in Settings → Python Environment:**
   - Click **🔍 Detect** to auto-detect your conda installation, or
   - Manually enter the path, e.g. `C:\Users\YourName\miniconda3`

2. **Set the correct environment name:**
   - If you installed WhisperX in the `base` environment, leave it as `base`
   - If you created a dedicated environment (e.g. `conda create -n whisperx python=3.11`), enter `whisperx`
   - ⚠️ **Make sure to type the exact name** — `whisperx` is not the same as `whisper`

**Option 2: Global pip install (no conda)**

If you installed WhisperX with `pip install whisperx` directly (no conda), the app will try to auto-detect it in common Python locations. If auto-detection fails:
- Set the full path to `whisperx.exe` in Settings → Paths → WhisperX command
- Example: `C:\Users\YourName\AppData\Local\Programs\Python\Python311\Scripts\whisperx.exe`

**Option 3: Python virtual environment (venv)**

If you use `python -m venv`:
- Set the full path to the `whisperx` executable inside your venv:
  - Windows: `C:\path\to\venv\Scripts\whisperx.exe`
  - macOS/Linux: `/path/to/venv/bin/whisperx`

### Diagnostic Info

The Console panel shows `ℹ Using: <path>` — this tells you exactly which executable the app is trying to run. If this path looks wrong, adjust your settings accordingly.

### Verify Installation
Open a terminal and run:
```bash
# Activate your conda environment
conda activate base  # or your env name

# Verify whisperx is installed
whisperx --help

# Check the full path
where whisperx   # Windows
which whisperx   # macOS/Linux
```

---

## Python / Conda Issues

### Wrong Python Version

**Symptom:** Errors mentioning incompatible Python version or syntax errors.

**Solution:** WhisperX requires **Python 3.10 or 3.11**. Create a dedicated environment:

```bash
conda create -n whisperx python=3.11
conda activate whisperx
pip install whisperx
```

> ⚠️ **Do not use Python 3.12+** — some dependencies (like `ctranslate2`) may not yet support it.

### Conda Not Initialized

**Symptom:** `conda` command not found in regular `cmd.exe`, or the app can't find WhisperX even though it works in PowerShell.

**Cause:** During Miniconda installation, the recommended option is *not* to add conda to PATH. Conda instead uses shell-specific hooks (`conda init powershell`), which only work in terminal sessions, not in GUI apps.

**Solution:** This is exactly what the **Python Environment** section in Settings solves. Set the conda installation path and environment name, and the app will locate WhisperX directly in the conda environment's file system — no shell activation needed.

---

## CUDA / GPU Issues

### PyTorch Installed Without CUDA Support

**Symptom:** Transcription works but is extremely slow, or you see warnings about falling back to CPU.

**Cause:** PyTorch was installed with CPU-only support. This commonly happens with default `pip install torch`.

**Solution:** Install the CUDA-enabled version of PyTorch:

```bash
conda activate whisperx  # or your env name

# Uninstall existing torch
pip uninstall torch torchaudio

# Install with CUDA support (check your CUDA version first with nvidia-smi)
# For CUDA 11.8:
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu118

# For CUDA 12.1:
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121
```

### No NVIDIA GPU Available

**Symptom:** CUDA errors or "CUDA not available".

**Solution:**
- In Settings → Compute, change **Device** to `cpu`
- Change **Compute type** to `float32` (int8 and float16 require GPU)
- Note: CPU transcription is significantly slower but works fine

### CUDA Version Mismatch

**Symptom:** `RuntimeError: CUDA error` or driver version incompatibility.

**Solution:**
1. Check your NVIDIA driver version: `nvidia-smi`
2. Ensure your PyTorch CUDA version matches your driver's supported CUDA toolkit
3. Update NVIDIA drivers from [nvidia.com/drivers](https://www.nvidia.com/drivers/)

---

## FFmpeg Issues

### FFmpeg Not Found

**Symptom:** Errors related to audio file processing or ffmpeg not found.

**Solution:**

1. **Download FFmpeg** from [ffmpeg.org/download.html](https://ffmpeg.org/download.html)
2. **Option A**: Add FFmpeg to your system PATH
3. **Option B**: Set the full path to `ffmpeg.exe` in Settings → Paths → FFmpeg path

### Audio Format Not Supported

**Symptom:** FFmpeg errors when processing certain audio files.

**Solution:** Convert your audio to a supported format first:
```bash
ffmpeg -i input.wma -acodec pcm_s16le output.wav
```

Supported formats: WAV, MP3, FLAC, OGG, M4A, and most common audio formats.

---

## HuggingFace / Diarization Issues

### Diarization Fails

**Symptom:** Error when running transcription with diarization enabled.

**Cause:** Speaker diarization requires a HuggingFace token and model authorization.

**Solution:**
1. Create a token at [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens)
2. Enter the token in Settings → HuggingFace → Access token
3. Accept the terms of use for **both** required models:
   - [pyannote/segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0)
   - [pyannote/speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1)
4. Wait a few minutes after accepting — authorization can take time to propagate

### Token Invalid or Expired

**Symptom:** Authentication errors from HuggingFace.

**Solution:** Generate a new token with `read` permissions and update it in Settings.

---

## General Tips

### Check the Console
The app's **Console** panel shows the full output from WhisperX, including any Python errors or warnings. Always check this first when something goes wrong.

### Recommended Setup (Windows)

For the best experience, we recommend:

```bash
# 1. Install Miniconda
#    Download from: https://docs.conda.io/en/latest/miniconda.html

# 2. Create a dedicated environment
conda create -n whisperx python=3.11

# 3. Activate it
conda activate whisperx

# 4. Install PyTorch with CUDA (check your CUDA version)
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu118

# 5. Install WhisperX
pip install whisperx

# 6. Install FFmpeg (via conda or download manually)
conda install -c conda-forge ffmpeg
```

Then in the app:
- Set conda path to your Miniconda installation folder
- Set conda environment to `whisperx`
- Done! 🎉

### Still Having Issues?

Please [open an issue](https://github.com/splicebytes/simple-ai-whisperx-gui/issues) on GitHub with:
- Your operating system
- Python version (`python --version`)
- WhisperX version (`pip show whisperx`)
- The full console output from the app (make sure to enable **Show warnings** to include full tracebacks)

---

## Noisy Logs / Warnings
By default, the application **hides known warnings and tracebacks** in the console to keep the interface clean. This includes warnings about PyTorch, Lightning checkpoints, or Pyannote audio features (like `torchcodec` or `TF32`).
If you notice that some things fail and you want more information, simply check the **Show warnings** checkbox in the Console panel to see the raw output from WhisperX.

**If you want to permanently fix the Lightning warning:**
Open a terminal, activate your conda environment, and run:
`python -m lightning.pytorch.utilities.upgrade_checkpoint <PATH_TO_YOUR_ENVIRONMENT>\Lib\site-packages\whisperx\assets\pytorch_model.bin`
