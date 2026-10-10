FROM python:3.12-slim
WORKDIR /guard
COPY scripts/trial_guard/__init__.py scripts/trial_guard/__main__.py scripts/trial_guard/adapters.py scripts/trial_guard/lifecycle.py scripts/trial_guard/runner.py /guard/trial_guard/
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER 65532:65532
ENTRYPOINT ["python", "-m", "trial_guard"]
