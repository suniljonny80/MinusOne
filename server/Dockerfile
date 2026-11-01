# MinusOne separation server, for a free Hugging Face Space (Docker SDK, CPU basic).
FROM python:3.11-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Hugging Face Spaces run containers as user 1000
RUN useradd -m -u 1000 user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/home/user/.cache/huggingface \
    TORCH_HOME=/home/user/.cache/torch \
    DATA_DIR=/tmp/minusone

WORKDIR /home/user/app

# CPU-only PyTorch keeps the image small (no CUDA libraries)
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

USER user
# Download the Demucs model at build time so the first song doesn't wait for it
ARG DEMUCS_MODEL=htdemucs_6s
RUN python -c "from demucs.pretrained import get_model; get_model('${DEMUCS_MODEL}')"

COPY --chown=user . .
RUN chmod +x start.sh
EXPOSE 7860
CMD ["./start.sh"]
