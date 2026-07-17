#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path


MANUAL_ANNOTATION_SCHEMA = "jgzj_yolo_manual_annotation.v1"
PATROL_DATASET_ID = "patrol:vehicle-self-collected"
EXPECTED_AUDIT_PROMPT_VERSION = "qwen_bbox_audit_prompt_v2_training_all_classes"
DEFAULT_QUALITIES = {"good", "blur"}
TRAINING_SOURCE = "auto_ad_patrol_flow_upload"
MANUAL_REVIEW_RESOLVED = {"pass", "negative"}


def normalize_rel(value) -> str:
    return str(value or "").replace("\\", "/").lstrip("/")


def row_source(row: dict) -> str:
    meta = row.get("meta") if isinstance(row.get("meta"), dict) else {}
    return str(row.get("source") or meta.get("source") or "")


def class_name(label: dict) -> str:
    return str(label.get("class_name") or label.get("class") or label.get("label") or "").strip().lower()


def load_manual_annotations(root: Path, dataset_id: str = PATROL_DATASET_ID) -> dict[str, dict]:
    annotations = {}
    if not root.exists():
        return annotations
    for path in root.glob("*/*.json"):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(payload, dict) or payload.get("schema") != MANUAL_ANNOTATION_SCHEMA:
            continue
        if str(payload.get("dataset_id") or "") != dataset_id:
            continue
        item_key = normalize_rel(payload.get("item_key"))
        if not item_key:
            continue
        payload = dict(payload)
        payload["_annotation_path"] = str(path)
        current = annotations.get(item_key)
        if current is None or str(payload.get("updated_at") or "") >= str(current.get("updated_at") or ""):
            annotations[item_key] = payload
    return annotations


def manual_annotation_for_row(row: dict, annotations: dict[str, dict] | None) -> dict | None:
    if not annotations:
        return None
    return annotations.get(normalize_rel(row.get("image_rel_path")))


def effective_labels(row: dict, manual: dict | None = None) -> list[dict]:
    if manual is not None:
        if manual.get("deleted"):
            return []
        labels = manual.get("labels")
        return labels if isinstance(labels, list) else []
    labels = row.get("auto_labels")
    return labels if isinstance(labels, list) else []


def _audit_snapshot_matches(row: dict) -> bool:
    audit = row.get("qwen_bbox_audit") if isinstance(row.get("qwen_bbox_audit"), dict) else {}
    labels = effective_labels(row)
    try:
        label_count = int(audit.get("label_count"))
    except (TypeError, ValueError):
        return False
    if label_count != len(labels):
        return False
    audited_classes = sorted({str(value or "").strip().lower() for value in audit.get("label_classes") or [] if str(value or "").strip()})
    current_classes = sorted({class_name(label) for label in labels if class_name(label)})
    return audited_classes == current_classes


def training_row_decision(
    row: dict,
    manual_annotations: dict[str, dict] | None = None,
    *,
    source: str = TRAINING_SOURCE,
    qualities: set[str] | None = None,
    allow_qwen_audit_pass: bool = False,
) -> tuple[bool, str, dict | None]:
    if row_source(row) != source:
        return False, "source", None

    manual = manual_annotation_for_row(row, manual_annotations)
    if manual is not None:
        if manual.get("deleted"):
            return False, "manual_deleted", manual
        if str(manual.get("kind") or "detect") != "detect" or not isinstance(manual.get("labels"), list):
            return False, "manual_invalid", manual
        review_verdict = str(manual.get("review_verdict") or "pending").strip().lower()
        if review_verdict not in MANUAL_REVIEW_RESOLVED:
            return False, f"manual_review_{review_verdict or 'pending'}", manual
        return True, "manual", manual

    accepted_qualities = DEFAULT_QUALITIES if qualities is None else qualities
    if row.get("qwen_bbox_status") != "done":
        return False, "bbox_status", None
    if str(row.get("qwen_bbox_quality") or "") not in accepted_qualities:
        return False, "quality", None
    if not row.get("qwen_bbox_rel_path"):
        return False, "missing_qwen_label", None
    if str(row.get("qwen_bbox_audit_status") or "") != "done":
        return False, "audit_not_done", None
    if str(row.get("qwen_bbox_audit_verdict") or "") != "pass":
        return False, "audit_not_pass", None
    audit = row.get("qwen_bbox_audit") if isinstance(row.get("qwen_bbox_audit"), dict) else {}
    if str(audit.get("prompt_version") or "") != EXPECTED_AUDIT_PROMPT_VERSION:
        return False, "audit_policy_version", None
    if not _audit_snapshot_matches(row):
        return False, "audit_snapshot_mismatch", None
    if not allow_qwen_audit_pass:
        return False, "qwen_audit_manual_required", None
    return True, "qwen_audit_pass", None
