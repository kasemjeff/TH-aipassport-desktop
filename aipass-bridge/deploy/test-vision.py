#!/usr/bin/env python3
"""
Test Vision / Multimodal capabilities for aipass-bridge
Supports:
1. Built-in Base64 image test (red circle / color detection)
2. Custom local image file: python3 test-vision.py /path/to/image.png
3. Remote image URL: python3 test-vision.py --url https://example.com/image.jpg
"""
import sys
import json
import base64
import argparse
import urllib.request

DEFAULT_BRIDGE = "http://127.0.0.1:8787"
DEFAULT_MODEL = "gemini-3.7-flash"

# Red canvas 100x100 PNG
SAMPLE_RED_PNG_B64 = (
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAAPklEQVR42u3BAQEAAACAkP6v"
    "7ggKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgDcb44AAAXv7aE4AAAAASUVORK5CYII="
)

def test_vision(bridge_url=DEFAULT_BRIDGE, model=DEFAULT_MODEL, image_source=None, prompt=None, stream=False):
    print("=" * 60)
    print("         🖼️  aipass-bridge Multimodal Vision Test         ")
    print("=" * 60)
    print(f"🌐 Bridge URL: {bridge_url}")
    print(f"🧠 Model:      {model}")
    print(f"⚡ Streaming:  {stream}")

    if image_source and image_source.startswith(("http://", "https://")):
        image_url = image_source
        print(f"📷 Image:      Remote URL ({image_url})")
    elif image_source:
        with open(image_source, "rb") as f:
            b64_data = base64.b64encode(f.read()).decode("utf-8")
        ext = image_source.lower().split(".")[-1]
        mime = f"image/{'jpeg' if ext in ('jpg', 'jpeg') else ext}"
        image_url = f"data:{mime};base64,{b64_data}"
        print(f"📷 Image:      Local file ({image_source}, {len(b64_data)} b64 chars)")
    else:
        image_url = SAMPLE_RED_PNG_B64
        print(f"📷 Image:      Built-in Sample PNG (Red Canvas)")

    default_prompt = "Describe what you see in this image, including the main color. Keep it brief (1-2 sentences)."
    user_prompt = prompt or default_prompt
    print(f"💬 Prompt:     \"{user_prompt}\"")
    print("-" * 60)

    payload = {
        "model": model,
        "stream": stream,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": user_prompt},
                    {"type": "image_url", "image_url": {"url": image_url}}
                ]
            }
        ]
    }

    req = urllib.request.Request(
        f"{bridge_url}/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            if stream:
                print("📥 Response (Streaming):")
                for raw_line in resp:
                    line = raw_line.decode("utf-8").strip()
                    if not line or line.startswith(":"):
                        continue
                    if line.startswith("data: "):
                        data_str = line[6:].strip()
                        if data_str == "[DONE]":
                            break
                        try:
                            chunk = json.loads(data_str)
                            delta = chunk.get("choices", [{}])[0].get("delta", {})
                            reasoning = delta.get("reasoning_content", "")
                            if reasoning:
                                print(f"\n🧠 {reasoning}", end="", flush=True)
                            content = delta.get("content", "")
                            if content:
                                print(content, end="", flush=True)
                        except Exception:
                            pass
                print("\n")
            else:
                body = resp.read().decode("utf-8")
                res_json = json.loads(body)
                print("📥 Response:")
                msg = res_json.get("choices", [{}])[0].get("message", {})
                reasoning = msg.get("reasoning_content", "")
                if reasoning:
                    print(f"🧠 Reasoning/Status:\n{reasoning}\n")
                content = msg.get("content", "")
                print(content)
                print("\n📊 Usage:", json.dumps(res_json.get("usage", {})))
        print("-" * 60)
        print("✅ Vision Test Completed Successfully!")
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        print(f"❌ HTTP Error {e.code}: {err_body}")
        sys.exit(1)
    except Exception as e:
        print(f"❌ Error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Test Vision capabilities of aipass-bridge")
    parser.add_argument("image", nargs="?", help="Local path to image file or leave empty for built-in sample")
    parser.add_argument("--url", help="Remote image URL")
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"Model ID (default: {DEFAULT_MODEL})")
    parser.add_argument("--bridge", default=DEFAULT_BRIDGE, help=f"Bridge Base URL (default: {DEFAULT_BRIDGE})")
    parser.add_argument("--prompt", help="Custom prompt text")
    parser.add_argument("--stream", action="store_true", help="Enable streaming mode")
    args = parser.parse_args()

    img = args.url if args.url else args.image
    test_vision(bridge_url=args.bridge, model=args.model, image_source=img, prompt=args.prompt, stream=args.stream)
