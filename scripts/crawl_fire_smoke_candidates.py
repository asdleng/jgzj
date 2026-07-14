#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, Iterator, List, Optional, Tuple
from urllib.parse import urlencode, urlparse, urlsplit

import requests
from PIL import Image, ImageOps, UnidentifiedImageError
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


SCHEMA = "jgzj_fire_smoke_web_candidate.v1"
ALLOWED_LICENSE_RE = re.compile(
    r"^(?:cc0|public domain|pdm|cc by(?:-sa)?(?: |-|$))", re.IGNORECASE
)
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}
HTML_TAG_RE = re.compile(r"<[^>]+>")
LANCZOS = getattr(Image, "Resampling", Image).LANCZOS


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def write_json_atomic(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(tmp_name, path)
    finally:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass


def append_jsonl(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")


def iter_jsonl(path: Path) -> Iterator[dict]:
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            row = json.loads(line)
        except (TypeError, ValueError):
            continue
        if isinstance(row, dict):
            yield row


def clean_text(value: object, max_len: int = 500) -> str:
    text = HTML_TAG_RE.sub(" ", html.unescape(str(value or "")))
    return re.sub(r"\s+", " ", text).strip()[:max_len]


def license_allowed(value: object) -> bool:
    return bool(ALLOWED_LICENSE_RE.search(clean_text(value, 120)))


def retry_session(user_agent: str) -> requests.Session:
    retry = Retry(
        total=4,
        connect=3,
        read=3,
        backoff_factor=0.8,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset({"GET"}),
        respect_retry_after_header=True,
    )
    session = requests.Session()
    session.headers.update({"User-Agent": user_agent, "Accept": "application/json,image/*;q=0.9,*/*;q=0.1"})
    session.mount("http://", HTTPAdapter(max_retries=retry))
    session.mount("https://", HTTPAdapter(max_retries=retry))
    return session


def load_seed_file(path: Path) -> List[dict]:
    text = path.read_text(encoding="utf-8")
    try:
        parsed = json.loads(text)
    except ValueError:
        parsed = None
    if isinstance(parsed, dict):
        parsed = parsed.get("items") or []
    if isinstance(parsed, list):
        rows = parsed
    else:
        rows = list(iter_jsonl(path))
    out = []
    for row in rows:
        if not isinstance(row, dict) or not str(row.get("url") or "").startswith(("http://", "https://")):
            continue
        out.append({
            "provider": str(row.get("provider") or "seed_url"),
            "url": str(row["url"]),
            "source_page_url": str(row.get("source_page_url") or row["url"]),
            "title": clean_text(row.get("title") or Path(str(row["url"])).name),
            "query": clean_text(row.get("query") or "seed_url", 160),
            "bucket": clean_text(row.get("bucket") or "unclassified", 80),
            "license": clean_text(row.get("license"), 120),
            "license_url": str(row.get("license_url") or ""),
            "author": clean_text(row.get("author"), 300),
            "credit": clean_text(row.get("credit"), 500),
        })
    return out


def ext_value(metadata: dict, key: str) -> str:
    value = metadata.get(key) if isinstance(metadata, dict) else None
    if isinstance(value, dict):
        value = value.get("value")
    return clean_text(value)


def commons_thumb_url(api_url: str, title: str, width: int) -> str:
    parts = urlsplit(api_url)
    file_name = str(title or "").split(":", 1)[-1]
    query = urlencode({"f": file_name, "w": max(1, int(width))})
    return f"{parts.scheme}://{parts.netloc}/w/thumb.php?{query}"


def commons_candidates(session: requests.Session, config_path: Path, timeout: Tuple[float, float]) -> Iterator[dict]:
    config = json.loads(config_path.read_text(encoding="utf-8"))
    api_url = str(config.get("api_url") or "https://commons.wikimedia.org/w/api.php")
    for item in config.get("queries") or []:
        query = clean_text(item.get("query"), 160)
        bucket = clean_text(item.get("bucket") or "unclassified", 80)
        remaining = max(0, int(item.get("limit") or 0))
        if not query or remaining <= 0:
            continue
        continuation: Dict[str, object] = {}
        while remaining > 0:
            batch = min(50, remaining)
            params: Dict[str, object] = {
                "action": "query",
                "generator": "search",
                "gsrsearch": f"{query} filetype:bitmap",
                "gsrnamespace": 6,
                "gsrlimit": batch,
                "prop": "imageinfo",
                "iiprop": "url|size|mime|extmetadata",
                "iiurlwidth": int(config.get("download_width") or 1920),
                "format": "json",
                "formatversion": 2,
            }
            params.update(continuation)
            response = session.get(api_url, params=params, timeout=timeout)
            response.raise_for_status()
            payload = response.json()
            pages = ((payload.get("query") or {}).get("pages") or []) if isinstance(payload, dict) else []
            if not pages:
                break
            for page in pages:
                infos = page.get("imageinfo") or []
                if not infos:
                    continue
                info = infos[0]
                meta = info.get("extmetadata") or {}
                download_width = int(config.get("download_width") or 1920)
                yield {
                    "provider": "wikimedia_commons",
                    "url": commons_thumb_url(api_url, page.get("title"), download_width),
                    "canonical_file_url": str(info.get("url") or ""),
                    "source_page_url": str(info.get("descriptionurl") or ""),
                    "title": clean_text(page.get("title")),
                    "query": query,
                    "bucket": bucket,
                    "license": ext_value(meta, "LicenseShortName") or ext_value(meta, "UsageTerms"),
                    "license_url": ext_value(meta, "LicenseUrl"),
                    "author": ext_value(meta, "Artist"),
                    "credit": ext_value(meta, "Credit"),
                    "page_id": page.get("pageid"),
                    "original_width": info.get("width"),
                    "original_height": info.get("height"),
                    "mime": info.get("mime"),
                }
                remaining -= 1
                if remaining <= 0:
                    break
            continuation = payload.get("continue") or {}
            if not continuation:
                break


def dhash64(image: Image.Image) -> int:
    sample = image.convert("L").resize((9, 8), LANCZOS)
    pixels = list(sample.getdata())
    value = 0
    for y in range(8):
        for x in range(8):
            value = (value << 1) | int(pixels[y * 9 + x] > pixels[y * 9 + x + 1])
    return value


class BKTree:
    def __init__(self) -> None:
        self.root: Optional[Tuple[int, Dict[int, object]]] = None

    @staticmethod
    def distance(left: int, right: int) -> int:
        return (left ^ right).bit_count() if hasattr(int, "bit_count") else bin(left ^ right).count("1")

    def add(self, value: int) -> None:
        if self.root is None:
            self.root = (value, {})
            return
        node = self.root
        while True:
            current, children = node
            distance = self.distance(value, current)
            child = children.get(distance)
            if child is None:
                children[distance] = (value, {})
                return
            node = child  # type: ignore[assignment]

    def has_within(self, value: int, radius: int) -> bool:
        if self.root is None:
            return False
        stack = [self.root]
        while stack:
            current, children = stack.pop()
            distance = self.distance(value, current)
            if distance <= radius:
                return True
            low, high = distance - radius, distance + radius
            stack.extend(child for edge, child in children.items() if low <= edge <= high)  # type: ignore[arg-type]
        return False


def validate_and_normalize(
    raw_path: Path,
    normalized_path: Path,
    min_side: int,
    max_side: int,
    jpeg_quality: int,
) -> dict:
    try:
        with Image.open(raw_path) as opened:
            image = ImageOps.exif_transpose(opened).convert("RGB")
            width, height = image.size
            if min(width, height) < min_side:
                raise ValueError(f"image_too_small:{width}x{height}")
            if max(width, height) > max_side:
                scale = max_side / float(max(width, height))
                image = image.resize((max(1, round(width * scale)), max(1, round(height * scale))), LANCZOS)
            normalized_width, normalized_height = image.size
            perceptual_hash = dhash64(image)
            image.save(normalized_path, format="JPEG", quality=jpeg_quality, optimize=True)
    except (Image.DecompressionBombError, UnidentifiedImageError, OSError) as exc:
        raise ValueError(f"invalid_image:{type(exc).__name__}") from exc
    return {
        "source_width": width,
        "source_height": height,
        "width": normalized_width,
        "height": normalized_height,
        "dhash64": f"{perceptual_hash:016x}",
    }


def crawl(args: argparse.Namespace) -> dict:
    output = args.output.resolve()
    image_root = output / "images" / "review"
    manifest_path = output / "manifest_selected_images.jsonl"
    log_path = output / "crawl_log.jsonl"
    image_root.mkdir(parents=True, exist_ok=True)

    seen_sha = set()
    seen_url = set()
    hash_tree = BKTree()
    for row in iter_jsonl(manifest_path):
        sha = str(row.get("sha256") or "")
        url = str(row.get("source_file_url") or "")
        dhash = str(row.get("dhash64") or "")
        if sha:
            seen_sha.add(sha)
        if url:
            seen_url.add(url)
        if re.fullmatch(r"[0-9a-fA-F]{16}", dhash):
            hash_tree.add(int(dhash, 16))

    session = retry_session(args.user_agent)
    candidates: List[dict] = []
    for seed_file in args.seed_file:
        candidates.extend(load_seed_file(seed_file))
    if args.commons_config:
        candidates.extend(commons_candidates(session, args.commons_config, (args.connect_timeout, args.read_timeout)))

    accepted = 0
    counts: Dict[str, int] = {}
    for candidate in candidates:
        if accepted >= args.max_images:
            break
        url = str(candidate.get("url") or "")
        base_log = {
            "schema": SCHEMA,
            "processed_at": now_iso(),
            "provider": candidate.get("provider"),
            "url": url,
            "query": candidate.get("query"),
            "bucket": candidate.get("bucket"),
        }
        if url in seen_url:
            counts["already_seen_url"] = counts.get("already_seen_url", 0) + 1
            continue
        if not license_allowed(candidate.get("license")) and not args.allow_unknown_license:
            counts["license_rejected"] = counts.get("license_rejected", 0) + 1
            append_jsonl(log_path, {**base_log, "status": "rejected", "reason": "license_not_allowed", "license": candidate.get("license")})
            seen_url.add(url)
            continue

        fd, raw_name = tempfile.mkstemp(prefix="fire-smoke-web-", suffix=".download", dir=str(output))
        os.close(fd)
        raw_path = Path(raw_name)
        normalized_tmp = raw_path.with_suffix(".jpg")
        try:
            with session.get(url, stream=True, timeout=(args.connect_timeout, args.read_timeout)) as response:
                response.raise_for_status()
                content_type = str(response.headers.get("content-type") or "").lower()
                url_suffix = Path(urlparse(str(response.url)).path).suffix.lower()
                generic_binary = content_type.startswith("application/octet-stream") and url_suffix in IMAGE_SUFFIXES
                if content_type and not content_type.startswith("image/") and not generic_binary:
                    raise ValueError(f"not_image_content_type:{content_type[:80]}")
                size = 0
                with raw_path.open("wb") as handle:
                    for chunk in response.iter_content(1024 * 256):
                        if not chunk:
                            continue
                        size += len(chunk)
                        if size > args.max_bytes:
                            raise ValueError(f"image_too_large:{size}")
                        handle.write(chunk)
            image_meta = validate_and_normalize(raw_path, normalized_tmp, args.min_side, args.max_side, args.jpeg_quality)
            final_sha = hashlib.sha256(normalized_tmp.read_bytes()).hexdigest()
            dhash_value = int(image_meta["dhash64"], 16)
            if final_sha in seen_sha:
                raise ValueError("duplicate_sha256")
            if hash_tree.has_within(dhash_value, args.dhash_radius):
                raise ValueError("near_duplicate_dhash")
            destination = image_root / f"{final_sha[:24]}.jpg"
            os.replace(str(normalized_tmp), str(destination))
            row = {
                "schema": SCHEMA,
                "image": destination.relative_to(output).as_posix(),
                "source_provider": candidate.get("provider"),
                "source_file_url": url,
                "canonical_file_url": candidate.get("canonical_file_url") or url,
                "source_page_url": candidate.get("source_page_url"),
                "title": candidate.get("title"),
                "query": candidate.get("query"),
                "collection_bucket": candidate.get("bucket"),
                "search_hint_is_ground_truth": False,
                "license": candidate.get("license"),
                "license_url": candidate.get("license_url"),
                "author": candidate.get("author"),
                "credit": candidate.get("credit"),
                "page_id": candidate.get("page_id"),
                "sha256": final_sha,
                **image_meta,
                "downloaded_at": now_iso(),
                "review_status": "unlabeled",
                "training_eligible": False,
            }
            append_jsonl(manifest_path, row)
            append_jsonl(log_path, {**base_log, "status": "accepted", "sha256": final_sha, "image": row["image"]})
            seen_sha.add(final_sha)
            seen_url.add(url)
            hash_tree.add(dhash_value)
            accepted += 1
            counts["accepted"] = counts.get("accepted", 0) + 1
        except Exception as exc:
            reason = str(exc)[:240]
            key = reason.split(":", 1)[0] if reason else type(exc).__name__
            counts[key] = counts.get(key, 0) + 1
            append_jsonl(log_path, {**base_log, "status": "rejected", "reason": reason})
            seen_url.add(url)
        finally:
            for path in (raw_path, normalized_tmp):
                try:
                    path.unlink()
                except FileNotFoundError:
                    pass
        if args.delay > 0:
            time.sleep(args.delay)

    total_manifest = sum(1 for _ in iter_jsonl(manifest_path))
    summary = {
        "schema": "jgzj_fire_smoke_web_candidate_summary.v1",
        "profile": "烟雾火焰网络候选集",
        "kind": "detect",
        "updated_at": now_iso(),
        "classes": ["fire", "smoke"],
        "images": {"review": total_manifest},
        "crawl_counts": counts,
        "training_eligible": False,
        "training_policy": "qwen_prelabel_then_human_review",
        "source_policy": "license_metadata_required",
    }
    write_json_atomic(output / "dataset_summary.json", summary)
    write_json_atomic(output / "training_guard.json", {
        "schema": "jgzj_yolo_training_guard.v1",
        "training_eligible": False,
        "reason": "Web search results are candidates only; Qwen labels and human approval are required.",
        "updated_at": now_iso(),
    })
    return summary


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Collect license-traceable fire/smoke web images into a review-only dataset.")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--seed-file", type=Path, action="append", default=[])
    parser.add_argument("--commons-config", type=Path)
    parser.add_argument("--max-images", type=int, default=200)
    parser.add_argument("--min-side", type=int, default=480)
    parser.add_argument("--max-side", type=int, default=2560)
    parser.add_argument("--max-bytes", type=int, default=20 * 1024 * 1024)
    parser.add_argument("--jpeg-quality", type=int, default=92)
    parser.add_argument("--dhash-radius", type=int, default=4)
    parser.add_argument("--delay", type=float, default=0.25)
    parser.add_argument("--connect-timeout", type=float, default=10.0)
    parser.add_argument("--read-timeout", type=float, default=45.0)
    parser.add_argument("--user-agent", default=os.environ.get("JGZJ_CRAWLER_USER_AGENT", "JGZJ-FireSmoke-Collector/1.0 (dataset research)"))
    parser.add_argument("--allow-unknown-license", action="store_true", help="Keep unknown-license images quarantined for evaluation only.")
    args = parser.parse_args()
    if not args.seed_file and not args.commons_config:
        parser.error("at least one --seed-file or --commons-config is required")
    return args


if __name__ == "__main__":
    print(json.dumps(crawl(parse_args()), ensure_ascii=False, indent=2))
