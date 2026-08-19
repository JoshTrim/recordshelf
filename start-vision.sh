#!/bin/sh
set -eu
cd "$(dirname "$0")"
exec .venv-vision/bin/python vision_service.py
