import gc
import json
import os
import sys
import traceback
import wave

import numpy as np


def _register_cuda_dlls():
    """Make the pip-installed CUDA runtime (cuBLAS/cuDNN) visible to ctranslate2 on Windows."""
    if sys.platform != 'win32':
        return
    for base in sys.path:
        nvidia_dir = os.path.join(base, 'nvidia')
        if not os.path.isdir(nvidia_dir):
            continue
        for name in os.listdir(nvidia_dir):
            bin_dir = os.path.join(nvidia_dir, name, 'bin')
            if os.path.isdir(bin_dir):
                try:
                    os.add_dll_directory(bin_dir)
                except OSError:
                    pass
                os.environ['PATH'] = bin_dir + os.pathsep + os.environ.get('PATH', '')


_register_cuda_dlls()

# Preferred engine: faster-whisper (CTranslate2). It is several times faster than
# openai-whisper and does not need PyTorch. openai-whisper stays as a fallback so
# an environment without faster-whisper keeps working exactly as before.
try:
    from faster_whisper import WhisperModel
    import ctranslate2
    ENGINE = 'faster-whisper'
except Exception:
    WhisperModel = None
    ctranslate2 = None
    ENGINE = 'openai-whisper'

torch = None
whisper = None
if ENGINE == 'openai-whisper':
    import torch
    import whisper

TARGET_SAMPLE_RATE = 16000

model = None
model_name = None
model_dir = None
model_device = None


def send(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def cuda_available():
    if ENGINE == 'faster-whisper':
        try:
            return ctranslate2.get_cuda_device_count() > 0
        except Exception:
            return False
    return torch.cuda.is_available()


def gpu_name():
    if not cuda_available():
        return None
    if ENGINE == 'openai-whisper':
        return torch.cuda.get_device_name(0)
    try:
        import subprocess
        out = subprocess.run(
            ['nvidia-smi', '--query-gpu=name', '--format=csv,noheader'],
            capture_output=True, text=True, timeout=5,
        ).stdout.strip().splitlines()
        return out[0] if out else 'CUDA GPU'
    except Exception:
        return 'CUDA GPU'


def unload_model():
    global model, model_name, model_dir, model_device
    model = None
    model_name = None
    model_dir = None
    model_device = None
    gc.collect()
    if ENGINE == 'openai-whisper' and torch.cuda.is_available():
        torch.cuda.empty_cache()


def load_faster_whisper(name, device, download_root):
    # float16 on the GPU, int8 on the CPU: both keep accuracy while being much faster.
    compute_type = 'float16' if device == 'cuda' else 'int8'
    cpu_threads = max(1, (os.cpu_count() or 4) // 2)
    try:
        return WhisperModel(
            name,
            device=device,
            compute_type=compute_type,
            download_root=download_root,
            cpu_threads=cpu_threads,
        )
    except Exception:
        if device != 'cuda':
            raise
        # Not enough VRAM for float16: int8_float16 needs less memory.
        return WhisperModel(
            name,
            device=device,
            compute_type='int8_float16',
            download_root=download_root,
        )


def ensure_model(request):
    global model, model_name, model_dir, model_device
    requested_name = request.get('model') or 'small'
    requested_dir = request.get('model_dir') or None
    requested_device = request.get('device') or 'auto'
    if requested_device == 'auto':
        requested_device = 'cuda' if cuda_available() else 'cpu'

    if requested_device == 'cuda' and not cuda_available():
        raise RuntimeError(
            'CUDA was requested but this Python environment has no usable CUDA runtime'
        )

    if (
        model is None
        or model_name != requested_name
        or model_dir != requested_dir
        or model_device != requested_device
    ):
        unload_model()
        if ENGINE == 'faster-whisper':
            model = load_faster_whisper(requested_name, requested_device, requested_dir)
        else:
            model = whisper.load_model(
                requested_name,
                device=requested_device,
                download_root=requested_dir,
            )
        model_name = requested_name
        model_dir = requested_dir
        model_device = requested_device

    return model, requested_device


def load_audio_input(audio_path):
    """Read the app's PCM WAV directly so ffmpeg is not required for recording."""
    if not str(audio_path).lower().endswith('.wav'):
        return audio_path

    try:
        with wave.open(audio_path, 'rb') as wav_file:
            channels = wav_file.getnchannels()
            sample_width = wav_file.getsampwidth()
            sample_rate = wav_file.getframerate()
            frames = wav_file.readframes(wav_file.getnframes())

        if sample_width != 2:
            return audio_path

        samples = np.frombuffer(frames, dtype='<i2').astype(np.float32)
        if channels > 1:
            samples = samples.reshape(-1, channels).mean(axis=1)
        samples /= 32768.0

        if sample_rate != TARGET_SAMPLE_RATE and samples.size:
            output_size = max(1, round(samples.size * TARGET_SAMPLE_RATE / sample_rate))
            source_positions = np.arange(samples.size, dtype=np.float64)
            target_positions = np.linspace(0, samples.size - 1, output_size)
            samples = np.interp(target_positions, source_positions, samples).astype(np.float32)

        return samples
    except (OSError, EOFError, wave.Error, ValueError):
        # Non-PCM or malformed WAV files can still use the normal filename
        # loader when ffmpeg is available on the host.
        return audio_path


def transcribe(request):
    loaded_model, device = ensure_model(request)
    language = request.get('language') or None
    if language in ('auto', 'detect'):
        language = None

    audio = load_audio_input(request['audio_path'])

    if ENGINE == 'faster-whisper':
        # English-only models (*.en) only accept "en".
        if model_name and model_name.endswith('.en'):
            language = 'en'
        segments, info = loaded_model.transcribe(
            audio,
            language=language,
            task='transcribe',
            beam_size=1,  # greedy decoding: fastest, negligible quality loss for live use
            temperature=0,
            condition_on_previous_text=False,
            vad_filter=True,  # built-in silence filter also cuts phantom phrases
            vad_parameters={'min_silence_duration_ms': 300},
        )
        text = ' '.join(segment.text.strip() for segment in segments).strip()
        detected = info.language
    else:
        result = loaded_model.transcribe(
            audio,
            language=language,
            task='transcribe',
            fp16=device == 'cuda',
            verbose=None,
            temperature=0,
            condition_on_previous_text=False,
        )
        text = (result.get('text') or '').strip()
        detected = result.get('language')

    return {
        'text': text,
        'language': detected,
        'device': device,
        'model': model_name,
        'engine': ENGINE,
        'cuda_available': cuda_available(),
        'gpu': gpu_name(),
    }


send({
    'event': 'ready',
    'pid': os.getpid(),
    'engine': ENGINE,
    'torch': torch.__version__ if torch else None,
    'cuda_available': cuda_available(),
    'torch_cuda': torch.version.cuda if torch else None,
    'gpu': gpu_name(),
})

for raw_line in sys.stdin:
    raw_line = raw_line.strip()
    if not raw_line:
        continue

    request_id = None
    try:
        request = json.loads(raw_line)
        request_id = request.get('id')
        action = request.get('action')

        if action == 'transcribe':
            send({'id': request_id, 'ok': True, **transcribe(request)})
        elif action == 'warmup':
            _, device = ensure_model(request)
            send({
                'id': request_id,
                'ok': True,
                'warmed': True,
                'device': device,
                'model': model_name,
                'engine': ENGINE,
                'cuda_available': cuda_available(),
                'gpu': gpu_name(),
            })
        elif action == 'unload':
            unload_model()
            send({'id': request_id, 'ok': True, 'unloaded': True})
        elif action == 'shutdown':
            unload_model()
            send({'id': request_id, 'ok': True, 'shutdown': True})
            break
        else:
            raise ValueError(f'Unsupported worker action: {action}')
    except Exception as error:
        send({
            'id': request_id,
            'ok': False,
            'error': str(error),
            'traceback': traceback.format_exc(),
        })
