"""Safe persistence for the four-point master RH profile."""

from __future__ import annotations

from dataclasses import dataclass
import json
import math
import os
from pathlib import Path
import tempfile
from typing import Any

from .models import MasterProfile


PROFILE_SCHEMA_VERSION = 1


@dataclass(frozen=True)
class ProfileLoadResult:
    """A profile plus a user-displayable error when persisted data is invalid."""

    profile: MasterProfile
    error: str | None = None


class MasterProfileStore:
    """Load and atomically save the user master profile.

    ``base_path`` is a test-friendly override for the directory containing
    ``master_profile.json``.  In production the directory is derived from
    ``%APPDATA%\\Lebrew\\AwCalibrator``.
    """

    def __init__(self, base_path: str | Path | None = None) -> None:
        if base_path is None:
            appdata = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
            base_path = appdata / "Lebrew" / "AwCalibrator"
        self.path = Path(base_path) / "master_profile.json"

    def load(self) -> ProfileLoadResult:
        """Load a valid file, retaining a damaged one untouched for recovery."""
        if not self.path.exists():
            return ProfileLoadResult(MasterProfile())
        try:
            parsed = json.loads(self.path.read_text(encoding="utf-8"))
            profile = _profile_from_document(parsed)
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as error:
            return ProfileLoadResult(MasterProfile(), f"无法读取基准配置：{error}")
        return ProfileLoadResult(profile)

    def save(self, profile: MasterProfile) -> None:
        """Atomically replace the profile after writing and syncing a sibling temp file."""
        if not isinstance(profile, MasterProfile):
            raise TypeError("profile must be a MasterProfile")
        document = {
            "schema_version": PROFILE_SCHEMA_VERSION,
            "rh": list(profile.rh),
        }
        encoded = (json.dumps(document, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n").encode("utf-8")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{self.path.name}.", suffix=".tmp", dir=self.path.parent,
        )
        temporary_path = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary_path, self.path)
        finally:
            if temporary_path.exists():
                temporary_path.unlink()


def _profile_from_document(document: Any) -> MasterProfile:
    if not isinstance(document, dict) or set(document) != {"schema_version", "rh"}:
        raise ValueError("配置 schema 无效")
    if type(document["schema_version"]) is not int or document["schema_version"] != PROFILE_SCHEMA_VERSION:
        raise ValueError("配置版本无效")
    values = document["rh"]
    if not isinstance(values, list) or len(values) != 4:
        raise ValueError("基准 RH 必须包含四个值")
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)
           for value in values):
        raise ValueError("基准 RH 必须为有限数值")
    return MasterProfile(tuple(values))
