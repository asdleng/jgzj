#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import concurrent.futures
import json
import math
import os
import time
from pathlib import Path
from typing import Any, Callable

import requests


ROOT = Path("/home/admin1")
VEHICLE_RAG_DIR = ROOT / "CloudVoice/multi_car_asr_demo/vehicle_rag"
CAR_G_PATH = VEHICLE_RAG_DIR / "car-g.txt"
CAR_WEB_PATH = VEHICLE_RAG_DIR / "car-web.txt"

SYSTEM_PROMPT = (
    "你是白泽机器人，由吉光智界开发。默认使用中文，回答准确、简洁、稳健。"
    "不要自称通义千问、Qwen、ChatGPT 或其他模型名。"
)


def read_text(path: Path, fallback: str) -> str:
    env_b64_key = f"QWEN36_BENCH_{path.stem.upper().replace('-', '_')}_TEXT_B64"
    env_b64_value = os.getenv(env_b64_key, "").strip()
    if env_b64_value:
        try:
            return base64.b64decode(env_b64_value).decode("utf-8")
        except Exception:
            pass
    env_key = f"QWEN36_BENCH_{path.stem.upper().replace('-', '_')}_TEXT"
    env_value = os.getenv(env_key, "").strip()
    if env_value:
        return env_value
    try:
        return path.read_text(encoding="utf-8")
    except Exception:
        return fallback


CAR_G_TEXT = read_text(
    CAR_G_PATH,
    "白泽机器人在光明科学公园南翼提供安防巡逻、导览和服务问答。"
    "南翼也叫蝶水翼，有两个主要入口：光耀广场和星辰广场。"
    "星辰广场下方有地下停车场，约955个车位。",
)
CAR_WEB_TEXT = read_text(
    CAR_WEB_PATH,
    "白泽机器人是吉光智界的综合服务机器人，具备安防巡逻、异常识别、智能检测和导览能力。"
    "落水时应先呼叫安保与120，并优先使用救生圈、绳索或长杆施救。",
)


def rag_excerpt(source: str, limit: int = 1600) -> str:
    return source[:limit].strip()


def make_long_context(base: str, repeat: int) -> str:
    blocks = [base.strip()] * max(1, repeat)
    return "\n\n".join(blocks)


def tool_specs() -> dict[str, list[dict[str, Any]]]:
    return {
        "time": [
            {
                "type": "function",
                "function": {
                    "name": "resolve_time_query",
                    "description": "识别时间相关中文问题，只返回分类参数。",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "query_type": {
                                "type": "string",
                                "enum": ["not_time", "current_time", "year_relation"],
                            },
                            "year_relation": {
                                "type": "string",
                                "enum": [
                                    "current_year",
                                    "last_year",
                                    "year_before_last",
                                    "next_year",
                                    "year_after_next",
                                ],
                            },
                        },
                        "required": ["query_type"],
                        "additionalProperties": False,
                    },
                },
            }
        ],
        "weather": [
            {
                "type": "function",
                "function": {
                    "name": "get_shenzhen_weather",
                    "description": "查询深圳天气摘要。",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "city": {"type": "string", "enum": ["深圳"]},
                            "target_date": {
                                "type": "string",
                                "enum": ["today", "tomorrow"],
                            },
                        },
                        "required": ["city", "target_date"],
                        "additionalProperties": False,
                    },
                },
            }
        ],
    }


def build_cases(long_repeat: int, image_path: str | None) -> list[dict[str, Any]]:
    long_ctx = make_long_context(rag_excerpt(CAR_G_TEXT, 2400), repeat=long_repeat)
    cases: list[dict[str, Any]] = [
        {
            "id": "identity_cn",
            "kind": "stream_text",
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": "你是谁？你现在主要负责什么？"},
            ],
            "validator": validate_identity,
        },
        {
            "id": "baize_rag",
            "kind": "stream_text",
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": (
                        "请只根据下面资料回答，不要编造。\n\n"
                        f"{rag_excerpt(CAR_WEB_TEXT)}\n\n"
                        "问题：白泽机器人有哪些主要功能？请用两到三句话回答。"
                    ),
                },
            ],
            "validator": validate_baize_rag,
        },
        {
            "id": "poi_nav",
            "kind": "stream_text",
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": (
                        "请只根据下面资料回答，不要编造路线。\n\n"
                        f"{rag_excerpt(CAR_G_TEXT)}\n\n"
                        "问题：光明科学公园南翼现在有几个主要入口？分别叫什么？"
                    ),
                },
            ],
            "validator": validate_poi_nav,
        },
        {
            "id": "security_event",
            "kind": "stream_text",
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": (
                        "请只根据下面资料回答，不要延伸编造。\n\n"
                        f"{rag_excerpt(CAR_WEB_TEXT, 2600)}\n\n"
                        "问题：有人掉水里了怎么办？请给出简短处置建议。"
                    ),
                },
            ],
            "validator": validate_security_event,
        },
        {
            "id": "multi_turn",
            "kind": "stream_text",
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": (
                        "请只根据下面资料回答，不要编造。\n\n"
                        f"{rag_excerpt(CAR_G_TEXT)}\n\n"
                        "南翼还有什么好听的名字呀？"
                    ),
                },
                {"role": "assistant", "content": "南翼还有一个好听的名字叫蝶水翼。"},
                {"role": "user", "content": "那它以前做过什么特别的事情？"},
            ],
            "validator": validate_multi_turn,
        },
        {
            "id": "long_context_rag",
            "kind": "stream_text",
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": (
                        "请只根据下面长资料回答，不要编造。\n\n"
                        f"{long_ctx}\n\n"
                        "问题：星辰广场下面有什么？请顺带说明车位信息。"
                    ),
                },
            ],
            "validator": validate_long_context,
        },
        {
            "id": "action_json",
            "kind": "json_text",
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "你是园区调度助手。只输出 JSON，不要输出额外文字。"
                        "JSON 必须包含 action, target, priority, safety_notice 四个键。"
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        "事件：巡逻机器人在光明科学公园南翼发现一名儿童在水边奔跑，周围游客较多。"
                        "请输出一条调度 JSON。"
                    ),
                },
            ],
            "validator": validate_action_json,
        },
        {
            "id": "time_tool",
            "kind": "tool_call",
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "你是时间工具调用分类器。你不能直接回答，只能通过工具参数表达判断。"
                        "去年->last_year；前年->year_before_last；今年->current_year；"
                        "明年->next_year；后年->year_after_next；现在几点/现在时间->current_time。"
                    ),
                },
                {"role": "user", "content": "现在几点了？"},
            ],
            "tools": tool_specs()["time"],
            "tool_choice": "required",
            "validator": validate_time_tool,
        },
        {
            "id": "weather_tool",
            "kind": "tool_call",
            "messages": [
                {
                    "role": "system",
                    "content": "你是天气工具调用助手。不要直接回答，必须调用工具。",
                },
                {"role": "user", "content": "深圳今天天气怎么样？"},
            ],
            "tools": tool_specs()["weather"],
            "tool_choice": "required",
            "validator": validate_weather_tool,
        },
    ]
    if image_path:
        cases.append(
            {
                "id": "image_smoke",
                "kind": "mm_text",
                "messages": build_image_messages(image_path),
                "validator": validate_image_smoke,
            }
        )
    return cases


def build_image_messages(image_path: str) -> list[dict[str, Any]]:
    mime = "image/jpeg"
    if image_path.lower().endswith(".png"):
        mime = "image/png"
    data = base64.b64encode(Path(image_path).read_bytes()).decode("ascii")
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{data}"}},
                {"type": "text", "text": "请用中文简要描述这张图片里最主要的场景。"},
            ],
        },
    ]


def default_payload(model: str, messages: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "model": model,
        "messages": messages,
        "temperature": 0.2,
        "top_p": 0.95,
        "max_tokens": 192,
        "chat_template_kwargs": {"enable_thinking": False, "preserve_thinking": False},
    }


def stream_chat(base_url: str, payload: dict[str, Any], timeout: int) -> dict[str, Any]:
    payload = dict(payload)
    payload["stream"] = True
    payload["stream_options"] = {"include_usage": True}
    start = time.time()
    first = None
    content_parts: list[str] = []
    reasoning_parts: list[str] = []
    usage: dict[str, Any] | None = None
    with requests.post(
        f"{base_url}/chat/completions",
        json=payload,
        stream=True,
        timeout=timeout,
    ) as resp:
        resp.raise_for_status()
        for line in resp.iter_lines(decode_unicode=True):
            if not line or not line.startswith("data: "):
                continue
            data = line[6:]
            if data == "[DONE]":
                break
            obj = json.loads(data)
            if obj.get("usage"):
                usage = obj["usage"]
            delta = ((obj.get("choices") or [{}])[0].get("delta") or {})
            piece = delta.get("content") or delta.get("reasoning") or ""
            if piece:
                if first is None:
                    first = time.time()
                if delta.get("content"):
                    content_parts.append(delta["content"])
                elif delta.get("reasoning"):
                    reasoning_parts.append(delta["reasoning"])
    end = time.time()
    return {
        "text": "".join(content_parts),
        "reasoning": "".join(reasoning_parts),
        "ttft_s": None if first is None else first - start,
        "latency_s": end - start,
        "usage": usage or {},
    }


def json_chat(base_url: str, payload: dict[str, Any], timeout: int) -> dict[str, Any]:
    start = time.time()
    resp = requests.post(f"{base_url}/chat/completions", json=payload, timeout=timeout)
    latency = time.time() - start
    resp.raise_for_status()
    data = resp.json()
    return {"data": data, "latency_s": latency}


def run_case(
    base_url: str,
    model: str,
    case: dict[str, Any],
    timeout: int,
) -> dict[str, Any]:
    payload = default_payload(model, case["messages"])
    validator: Callable[[Any], tuple[bool, str]] = case["validator"]
    try:
        result: dict[str, Any]
        if case["kind"] in {"stream_text", "mm_text"}:
            stream = stream_chat(base_url, payload, timeout)
            success, detail = validator(stream["text"] or stream["reasoning"])
            usage = stream["usage"]
            completion_tokens = int(usage.get("completion_tokens") or 0)
            latency_s = stream["latency_s"]
            ttft_s = stream["ttft_s"]
            decode_window = max((latency_s - ttft_s) if ttft_s is not None else 0.0, 1e-6)
            result = {
                "case_id": case["id"],
                "kind": case["kind"],
                "ok": success,
                "detail": detail,
                "ttft_ms": None if ttft_s is None else round(ttft_s * 1000, 1),
                "latency_ms": round(latency_s * 1000, 1),
                "prompt_tokens": int(usage.get("prompt_tokens") or 0),
                "completion_tokens": completion_tokens,
                "decode_tok_s": round(completion_tokens / decode_window, 2),
                "e2e_tok_s": round(completion_tokens / max(latency_s, 1e-6), 2),
                "text_preview": (stream["text"] or stream["reasoning"])[:220],
                "reasoning_chars": len(stream["reasoning"]),
            }
        elif case["kind"] == "json_text":
            payload["response_format"] = {"type": "json_object"}
            data = json_chat(base_url, payload, timeout)
            message = (((data["data"].get("choices") or [{}])[0]).get("message") or {})
            text = str(message.get("content") or "").strip()
            success, detail = validator(text)
            usage = data["data"].get("usage") or {}
            result = {
                "case_id": case["id"],
                "kind": case["kind"],
                "ok": success,
                "detail": detail,
                "ttft_ms": None,
                "latency_ms": round(data["latency_s"] * 1000, 1),
                "prompt_tokens": int(usage.get("prompt_tokens") or 0),
                "completion_tokens": int(usage.get("completion_tokens") or 0),
                "decode_tok_s": None,
                "e2e_tok_s": round(
                    int(usage.get("completion_tokens") or 0) / max(data["latency_s"], 1e-6), 2
                ),
                "text_preview": text[:220],
            }
        elif case["kind"] == "tool_call":
            payload["tools"] = case["tools"]
            payload["tool_choice"] = case.get("tool_choice", "required")
            data = json_chat(base_url, payload, timeout)
            message = (((data["data"].get("choices") or [{}])[0]).get("message") or {})
            success, detail = validator(message)
            usage = data["data"].get("usage") or {}
            result = {
                "case_id": case["id"],
                "kind": case["kind"],
                "ok": success,
                "detail": detail,
                "ttft_ms": None,
                "latency_ms": round(data["latency_s"] * 1000, 1),
                "prompt_tokens": int(usage.get("prompt_tokens") or 0),
                "completion_tokens": int(usage.get("completion_tokens") or 0),
                "decode_tok_s": None,
                "e2e_tok_s": round(
                    int(usage.get("completion_tokens") or 0) / max(data["latency_s"], 1e-6), 2
                ),
                "text_preview": json.dumps(message, ensure_ascii=False)[:220],
            }
        else:
            raise ValueError(f"unknown case kind: {case['kind']}")
        return result
    except Exception as exc:
        return {
            "case_id": case["id"],
            "kind": case["kind"],
            "ok": False,
            "detail": f"request failed: {exc}",
            "ttft_ms": None,
            "latency_ms": None,
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "decode_tok_s": None,
            "e2e_tok_s": None,
            "text_preview": "",
        }


def validate_identity(text: str) -> tuple[bool, str]:
    ok = ("白泽" in text) and ("通义千问" not in text) and ("阿里" not in text)
    return ok, "must identify as 白泽 and avoid model self-disclosure"


def validate_baize_rag(text: str) -> tuple[bool, str]:
    hits = sum(token in text for token in ["安防巡逻", "异常识别", "智能检测", "导览"])
    return hits >= 2, "should mention at least two core capabilities"


def validate_poi_nav(text: str) -> tuple[bool, str]:
    ok = ("光耀广场" in text) and ("星辰广场" in text)
    return ok, "should name both major south-wing entrances"


def validate_security_event(text: str) -> tuple[bool, str]:
    ok = ("120" in text) and any(token in text for token in ["救生圈", "长杆", "不要贸然下水"])
    return ok, "should mention emergency contact and safe rescue method"


def validate_multi_turn(text: str) -> tuple[bool, str]:
    ok = ("马术越野赛" in text) or ("第十五届全运会" in text)
    return ok, "should carry follow-up context across turns"


def validate_long_context(text: str) -> tuple[bool, str]:
    ok = ("地下停车场" in text) and ("955" in text)
    return ok, "should retrieve parking fact from long context"


def validate_action_json(text: str) -> tuple[bool, str]:
    try:
        obj = json.loads(text)
    except Exception:
        return False, "invalid JSON"
    required = {"action", "target", "priority", "safety_notice"}
    if not required.issubset(obj):
        return False, "missing required JSON keys"
    return True, "parseable action JSON with required keys"


def first_tool_call(message: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    tool_calls = message.get("tool_calls") or []
    if not tool_calls:
        return "", {}
    fn = ((tool_calls[0] or {}).get("function") or {}) if isinstance(tool_calls[0], dict) else {}
    name = str(fn.get("name") or "")
    raw_args = fn.get("arguments")
    if isinstance(raw_args, dict):
        return name, raw_args
    if isinstance(raw_args, str):
        try:
            return name, json.loads(raw_args) if raw_args.strip() else {}
        except Exception:
            return name, {}
    return name, {}


def validate_time_tool(message: dict[str, Any]) -> tuple[bool, str]:
    name, args = first_tool_call(message)
    ok = name == "resolve_time_query" and args.get("query_type") == "current_time"
    return ok, "must call resolve_time_query with query_type=current_time"


def validate_weather_tool(message: dict[str, Any]) -> tuple[bool, str]:
    name, args = first_tool_call(message)
    ok = (
        name == "get_shenzhen_weather"
        and args.get("city") == "深圳"
        and args.get("target_date") == "today"
    )
    return ok, "must call get_shenzhen_weather(city=深圳,target_date=today)"


def validate_image_smoke(text: str) -> tuple[bool, str]:
    return bool(text.strip()), "should return a non-empty visual description"


def concurrency_request(base_url: str, model: str, timeout: int) -> dict[str, Any]:
    payload = default_payload(
        model,
        [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": "请用一句中文说明你可以提供哪些服务。"},
        ],
    )
    payload["max_tokens"] = 96
    try:
        resp = requests.post(f"{base_url}/chat/completions", json=payload, timeout=timeout)
        resp.raise_for_status()
        data = resp.json()
        usage = data.get("usage") or {}
        text = str((((data.get("choices") or [{}])[0]).get("message") or {}).get("content") or "")
        return {
            "ok": bool(text.strip()),
            "completion_tokens": int(usage.get("completion_tokens") or 0),
            "prompt_tokens": int(usage.get("prompt_tokens") or 0),
            "error": "",
        }
    except Exception as exc:
        return {
            "ok": False,
            "completion_tokens": 0,
            "prompt_tokens": 0,
            "error": str(exc),
        }


def run_concurrency_sweep(
    base_url: str,
    model: str,
    timeout: int,
    levels: list[int],
) -> list[dict[str, Any]]:
    results = []
    for level in levels:
        start = time.time()
        with concurrent.futures.ThreadPoolExecutor(max_workers=level) as executor:
            futs = [
                executor.submit(concurrency_request, base_url=base_url, model=model, timeout=timeout)
                for _ in range(level)
            ]
            outputs = [f.result() for f in futs]
        elapsed = max(time.time() - start, 1e-6)
        ok_count = sum(1 for item in outputs if item["ok"])
        total_completion = sum(item["completion_tokens"] for item in outputs)
        total_prompt = sum(item["prompt_tokens"] for item in outputs)
        results.append(
            {
                "concurrency": level,
                "ok_count": ok_count,
                "fail_count": level - ok_count,
                "total_requests": level,
                "elapsed_s": round(elapsed, 3),
                "requests_s": round(level / elapsed, 2),
                "output_tok_s": round(total_completion / elapsed, 2),
                "avg_completion_tokens": round(total_completion / max(level, 1), 1),
                "avg_prompt_tokens": round(total_prompt / max(level, 1), 1),
            }
        )
    return results


def summarize(case_results: list[dict[str, Any]]) -> dict[str, Any]:
    ok_count = sum(1 for item in case_results if item["ok"])
    ttft_values = [item["ttft_ms"] for item in case_results if item["ttft_ms"] is not None]
    decode_values = [
        item["decode_tok_s"] for item in case_results if isinstance(item["decode_tok_s"], (int, float))
    ]
    return {
        "case_ok": ok_count,
        "case_total": len(case_results),
        "avg_ttft_ms": round(sum(ttft_values) / len(ttft_values), 1) if ttft_values else None,
        "avg_decode_tok_s": round(sum(decode_values) / len(decode_values), 2) if decode_values else None,
        "json_ok": any(item["case_id"] == "action_json" and item["ok"] for item in case_results),
        "tool_ok": all(
            item["ok"] for item in case_results if item["case_id"] in {"time_tool", "weather_tool"}
        ),
        "long_ctx_ok": any(item["case_id"] == "long_context_rag" and item["ok"] for item in case_results),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Benchmark and regression-check Qwen3.6 variants.")
    parser.add_argument("--base-url", required=True, help="OpenAI-compatible /v1 base URL")
    parser.add_argument("--model", required=True, help="Model name to send in requests")
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--long-repeat", type=int, default=6)
    parser.add_argument("--concurrency-levels", default="1,4,8,16")
    parser.add_argument("--skip-concurrency", action="store_true")
    parser.add_argument("--image-path", default="")
    parser.add_argument("--output", default="")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    base_url = args.base_url.rstrip("/")
    levels = [int(x) for x in args.concurrency_levels.split(",") if x.strip()]
    image_path = args.image_path.strip() or None
    cases = build_cases(args.long_repeat, image_path)
    case_results = [run_case(base_url, args.model, case, args.timeout) for case in cases]
    concurrency = [] if args.skip_concurrency else run_concurrency_sweep(base_url, args.model, args.timeout, levels)
    report = {
        "base_url": base_url,
        "model": args.model,
        "timestamp": int(time.time()),
        "summary": summarize(case_results),
        "cases": case_results,
        "concurrency": concurrency,
    }
    if args.output:
        Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
